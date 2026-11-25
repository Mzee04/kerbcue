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
  publicOrigin: string
  demo: boolean
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

export function createApi({ jobs, telegram, botUsername, router, publicOrigin, demo }: ApiOptions) {
  return async (request: Request): Promise<Response> => {
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

    try {
      const { pathname } = new URL(request.url)
      if (pathname === '/jobs' && request.method === 'GET') {
        const courier = jobs.courierFor(deviceKey) ?? null
        return json({
          jobs: jobs.listOpen(),
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
        const result = jobs.claim(claimPath[1], courier)
        if (result.status === 'missing') throw new HttpError(404, 'Job not found.')
        if (result.status === 'conflict') throw new HttpError(409, 'Job already claimed.')

        const telegramSynced = result.status === 'claimed' && result.card && telegram
          ? await telegram.syncClaim(result.card, result.job)
          : null
        return json({ job: result.job, telegramSynced } satisfies ClaimResponse)
      }

      const statusPath = /^\/jobs\/([a-z\d-]+)\/status$/i.exec(pathname)
      if (statusPath && request.method === 'POST') {
        const courier = requireCourier()
        const body = await readJson(request)
        if (body.status !== 'picked_up' && body.status !== 'delivered') {
          throw new HttpError(400, 'Status must be picked_up or delivered.')
        }
        const result = jobs.advance(statusPath[1], courier.id, body.status as CourierStatus)
        if (result.status === 'missing') throw new HttpError(404, 'Job not found.')
        if (result.status === 'forbidden') throw new HttpError(403, 'Only the courier who claimed this job can update it.')
        if (result.status === 'invalid') {
          return json({ error: `Job is already ${result.job.status}.`, job: result.job }, 409)
        }
        const telegramSynced = result.card && telegram ? await telegram.syncCard(result.card, result.job) : null
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
