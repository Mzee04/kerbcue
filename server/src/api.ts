import type { ClaimResponse, JobDetails, OpenJobsResponse } from '../../shared/jobs.ts'
import { courierNameOf, jobDetailsOf, newJob, type JobStore } from './jobs.ts'
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
  courierName: string
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

export function createApi({ jobs, telegram, courierName, publicOrigin, demo }: ApiOptions) {
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    if (publicOrigin !== '*') headers.set('Vary', 'Origin')
    if (publicOrigin === '*' || request.headers.get('Origin') === publicOrigin) {
      headers.set('Access-Control-Allow-Origin', publicOrigin)
    }
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers })

    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      headers.set('Access-Control-Allow-Headers', 'Content-Type')
      return new Response(null, { status: 204, headers })
    }

    try {
      const { pathname } = new URL(request.url)
      if (pathname === '/jobs' && request.method === 'GET') {
        return json({ jobs: jobs.listOpen(), courierName } satisfies OpenJobsResponse)
      }
      if (pathname === '/jobs' && request.method === 'POST' && demo) {
        const body = await readJson(request)
        const details = Object.keys(body).length === 0 ? demoJob : jobDetailsOf(body)
        if (!details) throw new HttpError(400, 'Pickup, drop and pay are required.')
        const job = newJob(details)
        jobs.add(job)
        return json({ job }, 201)
      }

      const claimPath = /^\/jobs\/([a-z\d-]+)\/claim$/i.exec(pathname)
      if (claimPath && request.method === 'POST') {
        const body = await readJson(request)
        const name = body.courierName === undefined ? courierName : courierNameOf(body.courierName)
        if (!name) throw new HttpError(400, 'Provide a courier name up to 48 characters.')

        const result = jobs.claim(claimPath[1], name)
        if (result.status === 'missing') throw new HttpError(404, 'Job not found.')
        if (result.status === 'conflict') throw new HttpError(409, 'Job already claimed.')

        const telegramSynced = result.status === 'claimed' && result.card && telegram
          ? await telegram.syncClaim(result.card, result.job)
          : null
        return json({ job: result.job, telegramSynced } satisfies ClaimResponse)
      }

      throw new HttpError(404, 'Route not found.')
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status)
      console.error('Kerbcue could not process a request.')
      return json({ error: 'Internal server error.' }, 500)
    }
  }
}
