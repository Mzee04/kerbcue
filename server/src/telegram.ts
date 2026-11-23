import { setTimeout as delay } from 'node:timers/promises'
import type { ClaimedJob, OpenJob } from '../../shared/jobs.ts'
import { newJob, parseJob, type JobStore, type TelegramCard } from './jobs.ts'

interface TelegramMessage {
  message_id: number
  message_thread_id?: number
  is_topic_message?: boolean
  chat: { id: number; type: string }
  from?: { is_bot?: boolean }
  text?: string
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

type TelegramMethod = 'getUpdates' | 'sendMessage' | 'editMessageText'

class TelegramError extends Error {
  constructor(method: TelegramMethod, status?: number) {
    super(`Telegram ${method} failed${status ? ` (HTTP ${status})` : ''}.`)
  }
}

function cardText(job: OpenJob | ClaimedJob): string {
  const status = job.status === 'open'
    ? 'Open'
    : `Claimed by ${job.courierName} at ${job.claimedAt.slice(0, 16).replace('T', ' ')} UTC`
  return [
    `Kerbcue job ${job.id}`,
    status,
    `Pickup: ${job.pickup}`,
    `Drop: ${job.drop}`,
    `Pay: ${job.pay}`,
    ...(job.note ? [`Note: ${job.note}`] : []),
  ].join('\n')
}

export class TelegramClient {
  private readonly token: string
  private readonly request: typeof fetch

  constructor(token: string, request: typeof fetch = fetch) {
    this.token = token
    this.request = request
  }

  private async call<T>(method: TelegramMethod, body: object, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? 35_000 : 6_000)
    try {
      const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!response.ok) throw new TelegramError(method, response.status)
      const reply = await response.json() as { ok: boolean; result: T }
      if (!reply.ok) throw new TelegramError(method)
      return reply.result
    } catch (error) {
      // Fetch errors may contain the URL, which embeds the secret.
      throw error instanceof TelegramError ? error : new TelegramError(method)
    }
  }

  getUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, signal)
  }

  sendOpenCard(chatId: string, job: OpenJob, threadId?: number): Promise<TelegramMessage> {
    return this.call('sendMessage', {
      chat_id: chatId,
      message_thread_id: threadId,
      text: cardText(job),
    })
  }

  async syncClaim(card: TelegramCard, job: ClaimedJob): Promise<boolean> {
    const edit = await this.call('editMessageText', {
      chat_id: card.telegramChatId,
      message_id: card.telegramMessageId,
      text: cardText(job),
    }).catch(reportTelegramFailure)

    const reply = await this.call('sendMessage', {
      chat_id: card.telegramChatId,
      message_thread_id: card.telegramThreadId,
      reply_parameters: { message_id: card.telegramMessageId },
      text: `${job.courierName} claimed the delivery.`,
    }).catch(reportTelegramFailure)

    return edit !== null && reply !== null
  }
}

function reportTelegramFailure(error: unknown): null {
  console.error(error instanceof TelegramError ? error.message : 'Telegram update failed.')
  return null
}

export async function ingestUpdate(
  telegram: TelegramClient,
  jobs: JobStore,
  groupId: string | undefined,
  update: TelegramUpdate,
  seenGroups: Set<string>,
): Promise<void> {
  const message = update.message
  if (!message || !['group', 'supergroup'].includes(message.chat.type)) return

  const chatId = String(message.chat.id)
  if (!groupId && !seenGroups.has(chatId)) {
    seenGroups.add(chatId)
    console.log(`Telegram group chat ID: ${chatId}`)
  }
  if (chatId !== groupId || message.from?.is_bot || !message.text) return

  const details = parseJob(message.text)
  if (!details) return

  const job = newJob(details)
  const threadId = message.is_topic_message ? message.message_thread_id : undefined
  const sent = await telegram.sendOpenCard(chatId, job, threadId)
  jobs.add(job, {
    telegramChatId: chatId,
    telegramMessageId: sent.message_id,
    telegramThreadId: threadId,
  })
}

export async function pollTelegram(
  telegram: TelegramClient,
  jobs: JobStore,
  groupId: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  let offset = 0
  const seenGroups = new Set<string>()

  while (!signal.aborted) {
    try {
      const updates = await telegram.getUpdates(offset, signal)
      for (const update of updates) {
        if (signal.aborted) return
        if (update.update_id < offset) continue
        // A failed card send could have reached Telegram. Skip this update to
        // avoid reposting the card when Telegram's delivery outcome is unknown.
        await ingestUpdate(telegram, jobs, groupId, update, seenGroups).catch(reportTelegramFailure)
        offset = update.update_id + 1
      }
    } catch (error) {
      if (signal.aborted) return
      reportTelegramFailure(error)
      await delay(3000, undefined, { signal }).catch(() => undefined)
    }
  }
}
