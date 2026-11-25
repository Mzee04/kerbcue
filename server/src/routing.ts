import type { Coordinates, RouteEstimate } from '../../shared/jobs.ts'

export type Router = (from: Coordinates, to: Coordinates) => Promise<RouteEstimate | undefined>

/**
 * Uses an OSRM-compatible /route endpoint, such as a public OSRM demo server.
 * Returns undefined on any failure so callers fall back to straight-line distance.
 */
export function createOsrmRouter(
  baseUrl: string,
  profile: string,
  request: typeof globalThis.fetch = globalThis.fetch,
): Router {
  const base = baseUrl.replace(/\/+$/, '')
  return async (from, to) => {
    try {
      const path = `/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`
      const response = await request(base + path, {
        headers: { 'User-Agent': 'Kerbcue (hackathon demo)' },
        signal: AbortSignal.timeout(4000),
      })
      if (!response.ok) return undefined
      const data = await response.json() as { code?: string; routes?: { distance?: unknown; duration?: unknown }[] }
      const route = data.code === 'Ok' ? data.routes?.[0] : undefined
      if (typeof route?.distance !== 'number' || typeof route.duration !== 'number') return undefined
      if (!Number.isFinite(route.distance) || !Number.isFinite(route.duration) || route.distance < 0 || route.duration < 0) {
        return undefined
      }
      return {
        km: Math.round(route.distance / 100) / 10,
        minutes: Math.max(1, Math.round(route.duration / 60)),
        profile,
      }
    } catch {
      return undefined
    }
  }
}
