import { setTimeout as delay } from 'node:timers/promises'
import { Agent, fetch } from 'undici'
import type { ClaimedJob, OpenJob } from '../../shared/jobs.ts'
import { newJob, parseJob, type JobStore, type TelegramCard } from './jobs.ts'

interface TelegramMessage {
  message_id: number
  message_thread_id?: number
  is_topic_message?: boolean
  chat: { id: number; type: string }
  from?: { id?: number; is_bot?: boolean }
  sender_chat?: { id: number }
  text?: string
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

type TelegramMethod = 'getUpdates' | 'sendMessage' | 'editMessageText'
type TelegramReply<T> = { ok: true; result: T } | {
  ok: false
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

interface TelegramRejection {
  status?: number
  retryAfter?: number
}

class TelegramError extends Error {
  readonly rejection?: TelegramRejection

  constructor(method: TelegramMethod, reason: string, rejection?: TelegramRejection) {
    super(`Telegram ${method} failed (${reason}).`)
    this.rejection = rejection
  }
}

function safeDescription(description: unknown, token: string): string | undefined {
  if (typeof description !== 'string') return undefined
  const redacted = token ? description.replaceAll(token, '[redacted]') : description
  return redacted
    .replace(/(?:https?:\/\/|\bapi\.telegram\.org)\S*/gi, '[redacted]')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
    .slice(0, 180) || undefined
}

function requestErrorReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error.cause as NodeJS.ErrnoException | undefined)?.code ?? (error as NodeJS.ErrnoException).code
    if (typeof code === 'string' && /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+)$/.test(code)) return code
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return error.name
  }
  return 'Network error'
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
  private readonly request?: typeof globalThis.fetch
  private agent?: Agent

  constructor(token: string, request?: typeof globalThis.fetch) {
    this.token = token
    this.request = request
    if (!request) this.agent = new Agent()
  }

  resetTransport(): void {
    const previous = this.agent
    if (!previous) return
    this.agent = new Agent()
    // Let any in-flight claim notifications finish on the old pool.
    void previous.close().catch(() => undefined)
  }

  private async call<T>(method: TelegramMethod, body: object, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? 35_000 : 6_000)
    try {
      const url = `https://api.telegram.org/bot${this.token}/${method}`
      const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }
      const response = this.request
        ? await this.request(url, init)
        : await fetch(url, { ...init, dispatcher: this.agent })
      const reply = await response.json().catch((error: unknown) => {
        if (response.ok) throw error
        // The HTTP status still identifies a rejection if the error body cannot be read.
        return undefined
      }) as TelegramReply<T> | undefined
      if (!response.ok || reply?.ok === false) {
        const failure = reply?.ok === false ? reply : undefined
        const code = response.ok ? failure?.error_code : response.status
        const status = typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599
          ? code
          : undefined
        const retryAfter = failure?.parameters?.retry_after
        const reason = [
          status ? `HTTP ${status}` : undefined,
          safeDescription(failure?.description, this.token),
          method === 'getUpdates' && status === 409
            ? 'another backend instance may be polling with the same bot token'
            : undefined,
        ].filter(Boolean).join(', ') || 'Telegram rejected the request'
        throw new TelegramError(method, reason, {
          status,
          retryAfter: typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter >= 0
            ? retryAfter
            : undefined,
        })
      }
      if (reply?.ok !== true || reply.result === undefined) throw new TelegramError(method, 'Invalid response')
      return reply.result
    } catch (error) {
      // Fetch errors may contain the URL, which embeds the secret.
      if (error instanceof TelegramError) throw error
      const reason = safeDescription(requestErrorReason(error), this.token) ?? 'Network error'
      throw new TelegramError(method, reason)
    }
  }

  async getUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    const updates = await this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, signal)
    if (!Array.isArray(updates)) throw new TelegramError('getUpdates', 'Invalid response')
    return updates
  }

  sendOpenCard(chatId: string, job: OpenJob, threadId?: number, signal?: AbortSignal): Promise<TelegramMessage> {
    return this.call('sendMessage', {
      chat_id: chatId,
      message_thread_id: threadId,
      text: cardText(job),
    }, signal)
  }

  private async notifyClaim(method: 'editMessageText' | 'sendMessage', body: object): Promise<unknown> {
    try {
      return await this.call(method, body)
    } catch (error) {
      const rejection = error instanceof TelegramError ? error.rejection : undefined
      const status = rejection?.status
      const retryAfter = rejection?.retryAfter
      const wait = status === 429 && retryAfter !== undefined
        ? Math.min(5000, retryAfter * 1000)
        : status !== undefined && status >= 500 ? 500 : undefined
      if (wait === undefined) throw error
      if (wait > 0) await delay(wait)
      return this.call(method, body)
    }
  }

  async syncClaim(card: TelegramCard, job: ClaimedJob): Promise<boolean> {
    const [edit, reply] = await Promise.all([
      this.notifyClaim('editMessageText', {
        chat_id: card.telegramChatId,
        message_id: card.telegramMessageId,
        text: cardText(job),
      }).catch(reportTelegramFailure),
      this.notifyClaim('sendMessage', {
        chat_id: card.telegramChatId,
        message_thread_id: card.telegramThreadId,
        reply_parameters: { message_id: card.telegramMessageId, allow_sending_without_reply: true },
        text: `${job.courierName} claimed the delivery.`,
      }).catch(reportTelegramFailure),
    ])

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
  signal?: AbortSignal,
  dispatcherIds?: ReadonlySet<string>,
): Promise<void> {
  const message = update.message
  if (!message || !['group', 'supergroup'].includes(message.chat.type)) return

  const chatId = String(message.chat.id)
  if (!groupId && !seenGroups.has(chatId)) {
    seenGroups.add(chatId)
    console.log(`Telegram group chat ID: ${chatId}`)
  }
  const isAnonymousAdmin = message.sender_chat?.id === message.chat.id
  if (chatId !== groupId || (message.from?.is_bot && !isAnonymousAdmin) || !message.text) return
  const requireDispatcher = dispatcherIds !== undefined && !isAnonymousAdmin
  if (requireDispatcher && !dispatcherIds.has(String(message.from?.id))) return

  const details = parseJob(message.text, requireDispatcher)
  if (!details) return

  const job = newJob(details)
  const threadId = message.is_topic_message ? message.message_thread_id : undefined
  const nextOffset = update.update_id + 1
  const maxRetries = 3
  let sent: TelegramMessage | undefined
  for (let retry = 0; retry <= maxRetries && !signal?.aborted; retry++) {
    try {
      sent = await telegram.sendOpenCard(chatId, job, threadId, signal)
      break
    } catch (error) {
      if (signal?.aborted) break
      reportTelegramFailure(error)
      const rejection = error instanceof TelegramError ? error.rejection : undefined
      // Only retry a definite rejection. A network failure may follow a successful post.
      if (!rejection || retry === maxRetries) break
      const retryAfter = rejection.status === 429 ? rejection.retryAfter : undefined
      const wait = retryAfter === undefined ? 250 * 2 ** retry : retryAfter * 1000
      if (wait > 0) await delay(wait, undefined, { signal }).catch(() => undefined)
    }
  }
  if (sent) {
    jobs.add(job, {
      telegramChatId: chatId,
      telegramMessageId: sent.message_id,
      telegramThreadId: threadId,
    }, nextOffset)
    return
  }
  jobs.add(job, undefined, nextOffset)
  console.warn(`Kerbcue job ${job.id} added without a Telegram card.`)
}

export async function pollTelegram(
  telegram: TelegramClient,
  jobs: JobStore,
  groupId: string | undefined,
  signal: AbortSignal,
  dispatcherIds?: ReadonlySet<string>,
): Promise<void> {
  let offset = jobs.getTelegramOffset()
  let failures = 0
  const seenGroups = new Set<string>()

  while (!signal.aborted) {
    let updates: TelegramUpdate[]
    try {
      updates = await telegram.getUpdates(offset, signal)
    } catch (error) {
      if (signal.aborted) return
      reportTelegramFailure(error)
      failures += 1
      if (failures % 3 === 0) telegram.resetTransport()
      const backoff = Math.min(30_000, 1000 * 2 ** (failures - 1))
      const jittered = Math.min(30_000, Math.round(backoff * (0.9 + Math.random() * 0.2)))
      await delay(jittered, undefined, { signal }).catch(() => undefined)
      continue
    }
    if (failures > 0) {
      console.log(`Telegram polling recovered after ${failures} ${failures === 1 ? 'failure' : 'failures'}.`)
      failures = 0
    }
    for (const update of updates) {
      if (signal.aborted) return
      if (update.update_id < offset) continue
      const nextOffset = update.update_id + 1
      try {
        await ingestUpdate(telegram, jobs, groupId, update, seenGroups, signal, dispatcherIds)
        jobs.setTelegramOffset(nextOffset)
      } catch {
        console.error('Kerbcue could not save the Telegram update. Polling stopped.')
        return
      }
      offset = nextOffset
    }
  }
}
