import { permissions } from '../app.json'
import type { ClaimResponse, CourierStatus, LinkResponse, OpenJobsResponse, StatusResponse } from '../shared/jobs.ts'

function backendOrigin(): string {
  const configured = permissions.find(permission => permission.name === 'network')?.whitelist[0]
  if (!configured) throw new Error('Add the backend origin to app.json.')
  const url = new URL(configured)
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || url.origin !== configured
  ) {
    throw new Error('Use a full backend origin in app.json.')
  }
  return url.origin
}

export type StatusResult = StatusResponse | { conflict: true } | { forbidden: true }

export function createJobsClient(signal: AbortSignal, deviceKey: () => string | undefined) {
  const origin = backendOrigin()
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    const key = deviceKey()
    if (key) headers.set('Authorization', `Bearer ${key}`)
    return fetch(`${origin}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
  }
  const post = (path: string, body: unknown = {}) => request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  return {
    async list(): Promise<OpenJobsResponse> {
      const response = await request('/jobs')
      if (!response.ok) throw new Error('Could not load jobs.')
      return response.json()
    },
    async link(): Promise<LinkResponse> {
      const response = await post('/couriers/link')
      if (!response.ok) throw new Error('Could not start linking.')
      return response.json()
    },
    async claim(id: string): Promise<ClaimResponse | 'conflict' | 'unlinked'> {
      const response = await post(`/jobs/${encodeURIComponent(id)}/claim`)
      if (response.status === 409) return 'conflict'
      if (response.status === 401) return 'unlinked'
      if (!response.ok) throw new Error('Could not claim job.')
      return response.json()
    },
    async advance(id: string, status: CourierStatus): Promise<StatusResult> {
      const response = await post(`/jobs/${encodeURIComponent(id)}/status`, { status })
      if (response.status === 409) return { conflict: true }
      if (response.status === 401 || response.status === 403) return { forbidden: true }
      if (!response.ok) throw new Error('Could not update job.')
      return response.json()
    },
  }
}
