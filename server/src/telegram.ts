import { setTimeout as delay } from 'node:timers/promises'
import { Agent, fetch } from 'undici'
import { distanceLine, type AssignedJob, type Job, type OpenJob } from '../../shared/jobs.ts'
import { courierNameOf, coordinatesOf, newJob, parseJob, type JobStore, type TelegramCard } from './jobs.ts'
import type { Router } from './routing.ts'
import { cardSyncFor } from './cardsync.ts'

interface TelegramMessage {
  message_id: number
  message_thread_id?: number
  is_topic_message?: boolean
  chat: { id: number; type: string }
  from?: { id?: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
  sender_chat?: { id: number }
  text?: string
  location?: { latitude: number; longitude: number }
  reply_to_message?: { message_id: number; from?: { id?: number; is_bot?: boolean } }
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

type TelegramMethod = 'getUpdates' | 'sendMessage' | 'editMessageText' | 'getMe' | 'getChatMember'
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

function utcTime(iso: string): string {
  return iso.slice(11, 16) + ' UTC'
}

export function cardText(job: Job): string {
  const status = job.status === 'open' ? 'Available'
    : job.status === 'claimed' ? `Claimed by ${job.courierName}`
      : job.status === 'picked_up' ? `Picked up by ${job.courierName}`
        : `Delivered by ${job.courierName}`
  const distance = distanceLine(job)
  const history = job.status === 'open' ? [] : [
    '',
    `Claimed ${job.claimedAt.slice(0, 10)} ${utcTime(job.claimedAt)}`,
    ...(job.pickedUpAt ? [`Picked up ${utcTime(job.pickedUpAt)}`] : []),
    ...(job.deliveredAt ? [`Delivered ${utcTime(job.deliveredAt)}`] : []),
  ]
  return [
    `Kerbcue job ${job.id}`,
    `Status: ${status}`,
    `Pickup: ${job.pickup}`,
    `Drop: ${job.drop}`,
    ...(distance ? [`Distance: ${distance}`] : []),
    `Pay: ${job.pay}`,
    ...(job.note ? [`Note: ${job.note}`] : []),
    ...history,
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

  /** The bot username, used to build t.me deep links for courier linking. */
  async getUsername(): Promise<string | undefined> {
    try {
      const me = await this.call<{ username?: unknown }>('getMe', {})
      return typeof me.username === 'string' && /^[a-z\d_]{3,64}$/i.test(me.username) ? me.username : undefined
    } catch (error) {
      reportTelegramFailure(error)
      return undefined
    }
  }

  private readonly members = new Map<string, { role: MemberRole; until: number }>()

  /**
   * The user's role in a chat, cached for five minutes. Returns undefined when
   * Telegram can't be reached, so callers can tell "unknown" from "not a member".
   */
  async memberRole(chatId: string, userId: number, now = Date.now()): Promise<MemberRole | undefined> {
    const key = `${chatId}:${userId}`
    const cached = this.members.get(key)
    if (cached && cached.until > now) return cached.role
    try {
      const member = await this.call<{ status?: string; is_member?: boolean }>('getChatMember', { chat_id: chatId, user_id: userId })
      const role: MemberRole = member.status === 'creator' || member.status === 'administrator' ? 'admin'
        : member.status === 'member' || (member.status === 'restricted' && member.is_member === true) ? 'member'
          : 'none'
      if (this.members.size > 5000) this.members.clear()
      this.members.set(key, { role, until: now + 5 * 60_000 })
      return role
    } catch (error) {
      reportTelegramFailure(error)
      return undefined
    }
  }

  async isGroupMember(chatId: string, userId: number): Promise<boolean> {
    const role = await this.memberRole(chatId, userId)
    return role === 'admin' || role === 'member'
  }

  sendText(chatId: string | number, text: string, signal?: AbortSignal, threadId?: number): Promise<TelegramMessage> {
    return this.call('sendMessage', { chat_id: chatId, message_thread_id: threadId, text }, signal)
  }

  sendOpenCard(chatId: string, job: OpenJob, threadId?: number, signal?: AbortSignal): Promise<TelegramMessage> {
    return this.call('sendMessage', {
      chat_id: chatId,
      message_thread_id: threadId,
      text: cardText(job),
    }, signal)
  }

  private async notify(method: 'editMessageText' | 'sendMessage', body: object): Promise<unknown> {
    try {
      return await this.call(method, body)
    } catch (error) {
      const rejection = error instanceof TelegramError ? error.rejection : undefined
      // Telegram rejects an edit that would not change the text. The card is already right.
      if (method === 'editMessageText' && error instanceof TelegramError && /message is not modified/i.test(error.message)) {
        return true
      }
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

  private editCard(card: TelegramCard, job: Job): Promise<unknown> {
    return this.notify('editMessageText', {
      chat_id: card.telegramChatId,
      message_id: card.telegramMessageId,
      text: cardText(job),
    })
  }

  async syncClaim(card: TelegramCard, job: AssignedJob): Promise<boolean> {
    const [edit, reply] = await Promise.all([
      this.editCard(card, job).catch(reportTelegramFailure),
      this.notify('sendMessage', {
        chat_id: card.telegramChatId,
        message_thread_id: card.telegramThreadId,
        reply_parameters: { message_id: card.telegramMessageId, allow_sending_without_reply: true },
        text: `${job.courierName} claimed the delivery.`,
      }).catch(reportTelegramFailure),
    ])

    return edit !== null && reply !== null
  }

  /** Status changes and new pins edit the original card in place. No new group messages. */
  async syncCard(card: TelegramCard, job: Job): Promise<boolean> {
    return await this.renderCard(card, job) === 'ok'
  }

  /** Edits the card and says whether a failure is worth retrying later. */
  async renderCard(card: TelegramCard, job: Job): Promise<'ok' | 'retry' | 'permanent'> {
    try {
      await this.editCard(card, job)
      return 'ok'
    } catch (error) {
      reportTelegramFailure(error)
      const status = error instanceof TelegramError ? error.rejection?.status : undefined
      // Network errors, rate limits and server errors can clear up. A deleted card or a removed bot won't.
      return status === undefined || status === 429 || status >= 500 ? 'retry' : 'permanent'
    }
  }

  async sendClaimReply(card: TelegramCard, job: AssignedJob): Promise<boolean> {
    return await this.notify('sendMessage', {
      chat_id: card.telegramChatId,
      message_thread_id: card.telegramThreadId,
      reply_parameters: { message_id: card.telegramMessageId, allow_sending_without_reply: true },
      text: `${job.courierName} claimed the delivery.`,
    }).catch(reportTelegramFailure) !== null
  }
}

export type MemberRole = 'admin' | 'member' | 'none'

function reportTelegramFailure(error: unknown): null {
  console.error(error instanceof TelegramError ? error.message : 'Telegram update failed.')
  return null
}

function courierNameFrom(from: NonNullable<TelegramMessage['from']>): string {
  const full = courierNameOf([from.first_name, from.last_name].filter(Boolean).join(' '))
  return full ?? courierNameOf(from.username ? `@${from.username}` : undefined) ?? `Courier ${from.id}`
}

/** A courier sends /start CODE to the bot in a private chat to link their glasses. */
async function linkCourier(
  telegram: TelegramClient,
  jobs: JobStore,
  groupId: string | undefined,
  message: TelegramMessage,
  signal?: AbortSignal,
): Promise<void> {
  const text = message.text?.trim() ?? ''
  if (!message.from?.id || message.from.is_bot) return
  const reply = (text: string) => telegram.sendText(message.chat.id, text, signal).catch(reportTelegramFailure)
  if (/^\/unlink(?:@[a-z\d_]+)?\s*$/i.test(text)) {
    const removed = jobs.unlinkCourier(`tg:${message.from.id}`)
    await reply(removed > 0
      ? `Unlinked ${removed} ${removed === 1 ? 'device' : 'devices'}. Reopen Kerbcue on your glasses to link again.`
      : 'No Kerbcue glasses are linked to your account.')
    return
  }
  const match = /^\/start(?:@[a-z\d_]+)?(?:\s+([A-Za-z\d]{4,16}))?\s*$/i.exec(text)
  if (!match) return
  if (!match[1]) {
    await reply('Open Kerbcue on your glasses. It shows a link code. Send /start CODE here to link them.')
    return
  }
  if (!groupId || !await telegram.isGroupMember(groupId, message.from.id)) {
    await reply('Only members of the dispatch group can link Kerbcue glasses.')
    return
  }
  const name = courierNameFrom(message.from)
  const result = jobs.completeLink(match[1], { id: `tg:${message.from.id}`, name })
  await reply(result === 'linked'
    ? `Linked. Your Kerbcue claims will show as ${name}.`
    : 'That code has expired or was already used. Reopen Kerbcue on your glasses for a new code.')
}

async function routeAndSync(telegram: TelegramClient, jobs: JobStore, id: string, router?: Router): Promise<void> {
  const job = jobs.get(id)?.job
  if (router && job?.pickupAt && job.dropAt && !job.route) {
    const route = await router(job.pickupAt, job.dropAt)
    if (route) jobs.setRoute(id, route)
  }
  await cardSyncFor(telegram, jobs).sync(id)
}

/**
 * `/unlink <name, @username or Telegram user ID>` in the group, or `/unlink` as a reply
 * to the courier's message. Only listed dispatchers or group admins can use it.
 */
async function unlinkFromGroup(
  telegram: TelegramClient,
  jobs: JobStore,
  message: TelegramMessage,
  isAnonymousAdmin: boolean,
  dispatcherIds: ReadonlySet<string> | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  const match = /^\/unlink(?:@[a-z\d_]+)?(?:\s+(.{1,64}))?$/i.exec(message.text?.trim() ?? '')
  if (!match) return false
  const chatId = String(message.chat.id)
  const threadId = message.is_topic_message ? message.message_thread_id : undefined
  const reply = (text: string) => telegram.sendText(chatId, text, signal, threadId).catch(reportTelegramFailure)
  const senderId = message.from?.id
  const allowed = isAnonymousAdmin || (senderId !== undefined && (dispatcherIds
    ? dispatcherIds.has(String(senderId))
    : await telegram.memberRole(chatId, senderId) === 'admin'))
  if (!allowed) return true

  const repliedTo = message.reply_to_message?.from
  const courier = match[1] ? jobs.findCourier(match[1])
    : repliedTo?.id && !repliedTo.is_bot ? jobs.findCourier(String(repliedTo.id)) : undefined
  if (!courier) {
    await reply('No linked courier matches. Use /unlink <name or Telegram user ID>, or reply /unlink to their message.')
    return true
  }
  const removed = jobs.unlinkCourier(courier.id)
  await reply(`Unlinked ${courier.name} from ${removed} ${removed === 1 ? 'device' : 'devices'}.`)
  return true
}

export interface IngestOptions {
  signal?: AbortSignal
  dispatcherIds?: ReadonlySet<string>
  router?: Router
}

export async function ingestUpdate(
  telegram: TelegramClient,
  jobs: JobStore,
  groupId: string | undefined,
  update: TelegramUpdate,
  seenGroups: Set<string>,
  { signal, dispatcherIds, router }: IngestOptions = {},
): Promise<void> {
  const message = update.message
  if (message?.chat.type === 'private') {
    await linkCourier(telegram, jobs, groupId, message, signal)
    return
  }
  if (!message || !['group', 'supergroup'].includes(message.chat.type)) return

  const chatId = String(message.chat.id)
  if (!groupId && !seenGroups.has(chatId)) {
    seenGroups.add(chatId)
    console.log(`Telegram group chat ID: ${chatId}`)
  }
  const isAnonymousAdmin = message.sender_chat?.id === message.chat.id
  if (chatId !== groupId || (message.from?.is_bot && !isAnonymousAdmin)) return
  if (await unlinkFromGroup(telegram, jobs, message, isAnonymousAdmin, dispatcherIds, signal)) return
  const requireDispatcher = dispatcherIds !== undefined && !isAnonymousAdmin
  if (requireDispatcher && !dispatcherIds.has(String(message.from?.id))) return

  // A location pin sent as a reply to a job card sets pickup, then drop.
  if (message.location && message.reply_to_message) {
    const target = jobs.findByCard(chatId, message.reply_to_message.message_id)
    const at = coordinatesOf({ lat: message.location.latitude, lng: message.location.longitude })
    if (target && at && jobs.addPin(target.job.id, at)) await routeAndSync(telegram, jobs, target.job.id, router)
    return
  }
  if (!message.text) return

  const details = parseJob(message.text, requireDispatcher)
  if (!details) return

  let job = newJob(details)
  if (router && job.pickupAt && job.dropAt) {
    const route = await router(job.pickupAt, job.dropAt)
    if (route) job = { ...job, route }
  }
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
  router?: Router,
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
        await ingestUpdate(telegram, jobs, groupId, update, seenGroups, { signal, dispatcherIds, router })
        jobs.setTelegramOffset(nextOffset)
      } catch {
        console.error('Kerbcue could not save the Telegram update. Polling stopped.')
        return
      }
      offset = nextOffset
    }
  }
}
