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

const knownServers: [RegExp, string][] = [
  [/^https?:\/\/routing\.openstreetmap\.de\/routed-bike\/?$/i, 'bike'],
  [/^https?:\/\/routing\.openstreetmap\.de\/routed-foot\/?$/i, 'foot'],
  [/^https?:\/\/routing\.openstreetmap\.de\/routed-car\/?$/i, 'car'],
  [/^https?:\/\/router\.project-osrm\.org\/?$/i, 'car'],
]

/**
 * The label shown next to route estimates. An OSRM server routes with the one
 * profile it was built with and ignores the profile name in the request path,
 * so the label must come from the server, not from what we ask for. Known
 * public servers get their real mode, and a conflicting setting is an error.
 */
export function routingLabel(baseUrl: string, configured?: string): string {
  const known = knownServers.find(([pattern]) => pattern.test(baseUrl))?.[1]
  const wanted = configured?.trim().toLowerCase() || undefined
  if (wanted && !/^[a-z]{1,12}$/.test(wanted)) throw new Error('KERBCUE_ROUTING_PROFILE must be one short word, such as bike.')
  if (known && wanted && wanted !== known) {
    throw new Error(`KERBCUE_ROUTING_PROFILE=${wanted} does not match ${baseUrl}, which routes for ${known}.`)
  }
  return known ?? wanted ?? 'road'
}
