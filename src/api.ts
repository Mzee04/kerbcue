import { permissions } from '../app.json'
import type { ClaimResponse, OpenJobsResponse } from '../shared/jobs.ts'

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

export function createJobsClient(signal: AbortSignal) {
  const origin = backendOrigin()
  const request = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })

  return {
    async list(): Promise<OpenJobsResponse> {
      const response = await request('/jobs')
      if (!response.ok) throw new Error('Could not load jobs.')
      return response.json()
    },
    async claim(id: string, courierName: string): Promise<ClaimResponse | 'conflict'> {
      const response = await request(`/jobs/${encodeURIComponent(id)}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courierName }),
      })
      if (response.status === 409) return 'conflict'
      if (!response.ok) throw new Error('Could not claim job.')
      return response.json()
    },
  }
}
