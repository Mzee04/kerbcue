import type {
  ClaimResponse,
  Courier,
  CourierStatus,
  JobDetails,
  LinkResponse,
  OpenJobsResponse,
  StatusResponse,
} from '../../shared/jobs.ts'
import { courierNameOf, jobDetailsOf, newJob, type JobStore } from './jobs.ts'
import type { Router } from './routing.ts'
import { cardSyncFor } from './cardsync.ts'
import type { TelegramClient } from './telegram.ts'

const demoJob: JobDetails = {
  pickup: 'Central Station',
  drop: '42 Market Street',
  pay: '15 USD',
  note: 'Leave at reception',
}

interface ApiOptions {
  jobs: JobStore
  telegram?: TelegramClient
  /** Bot username for t.me deep links. */
  botUsername?: string
  router?: Router
  /** When set with a bot, job lists, claims and status updates re-check group membership. */
  groupId?: string
  publicOrigin: string
  demo: boolean
  /** Link-code limits per client IP and in total, per minute. */
  linkLimits?: { perIp: number; total: number }
}

/** Fixed one-minute windows. Enough to stop a script from flooding link codes. */
function createLinkLimiter({ perIp, total }: { perIp: number; total: number }) {
  let windowStart = 0
  let count = 0
  const perClient = new Map<string, number>()
  return (ip: string, now = Date.now()): number | undefined => {
    if (now - windowStart >= 60_000) {
      windowStart = now
      count = 0
      perClient.clear()
    }
    const used = perClient.get(ip) ?? 0
    if (used >= perIp || count >= total) return Math.ceil((windowStart + 60_000 - now) / 1000)
    perClient.set(ip, used + 1)
    count += 1
    return undefined
  }
}

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {}
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 4096) {
        void reader.cancel().catch(() => undefined)
        throw new HttpError(413, 'Request body too large.')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }

  if (!text.trim()) return {}
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // Respond with the same error for malformed JSON and non-object input.
  }
  throw new HttpError(400, 'Expected a JSON object.')
}

function deviceKeyOf(request: Request): string | undefined {
  const match = /^Bearer ([A-Za-z\d_-]{16,128})$/.exec(request.headers.get('Authorization') ?? '')
  return match?.[1]
}

export function createApi({
  jobs, telegram, botUsername, router, groupId, publicOrigin, demo, linkLimits = { perIp: 10, total: 120 },
}: ApiOptions) {
  const limitLinks = createLinkLimiter(linkLimits)
  const cards = telegram ? cardSyncFor(telegram, jobs) : undefined

  return async (request: Request, client: { ip?: string } = {}): Promise<Response> => {
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    if (publicOrigin !== '*') headers.set('Vary', 'Origin')
    if (publicOrigin === '*' || request.headers.get('Origin') === publicOrigin) {
      headers.set('Access-Control-Allow-Origin', publicOrigin)
    }
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers })

    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      return new Response(null, { status: 204, headers })
    }

    const deviceKey = deviceKeyOf(request)
    const requireCourier = (): Courier => {
      const courier = jobs.courierFor(deviceKey)
      if (!courier) throw new HttpError(401, 'Link this device to Telegram first.')
      return courier
    }
    // Cached for five minutes. Only a definite "not a member" blocks, not a Telegram outage.
    const requireGroupMember = async (courier: Courier): Promise<void> => {
      const telegramUserId = /^tg:(\d+)$/.exec(courier.id)?.[1]
      if (!telegram || !groupId || !telegramUserId) return
      if (await telegram.memberRole(groupId, Number(telegramUserId)) === 'none') {
        jobs.unlinkCourier(courier.id)
        throw new HttpError(403, 'This Telegram account is no longer in the dispatch group.')
      }
    }

    try {
      const { pathname } = new URL(request.url)
      if (pathname === '/jobs' && request.method === 'GET') {
        const courier = jobs.courierFor(deviceKey) ?? null
        // Addresses are only for linked couriers still in the group. Unlinked devices just get their link status.
        if (courier) await requireGroupMember(courier)
        return json({
          jobs: courier ? jobs.listOpen() : [],
          active: courier ? jobs.listActive(courier.id) : [],
          courier,
          linkPending: !courier && jobs.isLinkPending(deviceKey),
        } satisfies OpenJobsResponse)
      }
      if (pathname === '/jobs' && request.method === 'POST' && demo) {
        const body = await readJson(request)
        const details = Object.keys(body).length === 0 ? demoJob : jobDetailsOf(body)
        if (!details) throw new HttpError(400, 'Pickup, drop and pay are required.')
        let job = newJob(details)
        if (router && job.pickupAt && job.dropAt) {
          const route = await router(job.pickupAt, job.dropAt)
          if (route) job = { ...job, route }
        }
        jobs.add(job)
        return json({ job }, 201)
      }

      if (pathname === '/couriers/link' && request.method === 'POST') {
        const retryAfter = limitLinks(client.ip ?? 'unknown')
        if (retryAfter !== undefined) {
          headers.set('Retry-After', String(retryAfter))
          throw new HttpError(429, 'Too many link requests. Try again shortly.')
        }
        const link = jobs.createLink()
        if (!link) throw new HttpError(503, 'Too many pending links. Try again later.')
        return json({
          ...link,
          ...(botUsername ? { link: `https://t.me/${botUsername}?start=${link.code}` } : {}),
        } satisfies LinkResponse, 201)
      }
      // Stands in for the Telegram /start step when the backend runs without a bot token.
      if (pathname === '/couriers/demo-link' && request.method === 'POST' && demo) {
        const body = await readJson(request)
        const name = courierNameOf(body.name)
        if (!name || typeof body.code !== 'string') throw new HttpError(400, 'Provide a code and a name up to 48 characters.')
        const id = `demo:${name.toLowerCase()}`
        if (jobs.completeLink(body.code, { id, name }) === 'missing') throw new HttpError(404, 'Link code not found or expired.')
        return json({ courier: { id, name } })
      }

      const claimPath = /^\/jobs\/([a-z\d-]+)\/claim$/i.exec(pathname)
      if (claimPath && request.method === 'POST') {
        const courier = requireCourier()
        await requireGroupMember(courier)
        const id = claimPath[1]
        const pendingBefore = jobs.get(id)?.syncPending === true
        const result = jobs.claim(id, courier)
        if (result.status === 'missing') throw new HttpError(404, 'Job not found.')
        if (result.status === 'conflict') throw new HttpError(409, 'Job already claimed.')

        let telegramSynced: boolean | null = null
        if (result.card && cards && telegram) {
          if (result.status === 'claimed') {
            const [edit, reply] = await Promise.all([cards.sync(id), telegram.sendClaimReply(result.card, result.job)])
            telegramSynced = edit && reply
          } else if (pendingBefore) {
            // The owner asking again is a good moment to repair a card that fell behind.
            telegramSynced = await cards.sync(id)
          }
        }
        return json({ job: result.job, telegramSynced } satisfies ClaimResponse)
      }

      const statusPath = /^\/jobs\/([a-z\d-]+)\/status$/i.exec(pathname)
      if (statusPath && request.method === 'POST') {
        const courier = requireCourier()
        await requireGroupMember(courier)
        const body = await readJson(request)
        if (body.status !== 'picked_up' && body.status !== 'delivered') {
          throw new HttpError(400, 'Status must be picked_up or delivered.')
        }
        const result = jobs.advance(statusPath[1], courier.id, body.status as CourierStatus)
        if (result.status === 'missing') throw new HttpError(404, 'Job not found.')
        if (result.status === 'forbidden') throw new HttpError(403, 'Only the courier who claimed this job can update it.')
        if (result.status === 'invalid') {
          if (cards && jobs.get(result.job.id)?.syncPending) void cards.sync(result.job.id)
          return json({ error: `Job is already ${result.job.status}.`, job: result.job }, 409)
        }
        const telegramSynced = result.card && cards ? await cards.sync(result.job.id) : null
        return json({ job: result.job, telegramSynced } satisfies StatusResponse)
      }

      throw new HttpError(404, 'Route not found.')
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status)
      console.error('Kerbcue could not process a request.')
      return json({ error: 'Internal server error.' }, 500)
    }
  }
}
