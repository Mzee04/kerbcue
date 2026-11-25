export interface Coordinates {
  lat: number
  lng: number
}

export interface JobDetails {
  pickup: string
  drop: string
  pay: string
  note?: string
  pickupAt?: Coordinates
  dropAt?: Coordinates
}

/** Route data from an optional OSRM-compatible router. Absent when routing is off or failed. */
export interface RouteEstimate {
  km: number
  minutes: number
  profile: string
}

export type JobStatus = 'open' | 'claimed' | 'picked_up' | 'delivered'
export type CourierStatus = 'picked_up' | 'delivered'

export interface OpenJob extends JobDetails {
  id: string
  status: 'open'
  route?: RouteEstimate
}

export interface AssignedJob extends JobDetails {
  id: string
  status: 'claimed' | 'picked_up' | 'delivered'
  courierId: string
  courierName: string
  claimedAt: string
  pickedUpAt?: string
  deliveredAt?: string
  route?: RouteEstimate
}

/** Kept for older imports. A claimed job is any job assigned to a courier. */
export type ClaimedJob = AssignedJob
export type Job = OpenJob | AssignedJob

export interface Courier {
  id: string
  name: string
}

export interface OpenJobsResponse {
  jobs: OpenJob[]
  /** Jobs the calling courier has claimed and not yet delivered. */
  active: AssignedJob[]
  courier: Courier | null
  /** True while this device's link code waits for the courier's Telegram /start. */
  linkPending: boolean
}

export interface ClaimResponse {
  job: AssignedJob
  telegramSynced: boolean | null
}

export interface StatusResponse {
  job: AssignedJob
  telegramSynced: boolean | null
}

export interface LinkResponse {
  code: string
  deviceKey: string
  expiresAt: string
  /** Telegram deep link, present when the backend knows its bot username. */
  link?: string
}

export const nextStatus: Record<JobStatus, CourierStatus | undefined> = {
  open: undefined,
  claimed: 'picked_up',
  picked_up: 'delivered',
  delivered: undefined,
}

export const statusLabel: Record<JobStatus, string> = {
  open: 'Available',
  claimed: 'Claimed',
  picked_up: 'Picked up',
  delivered: 'Delivered',
}

/** Great-circle distance in km. This is a straight line, not a road distance. */
export function straightLineKm(from: Coordinates, to: Coordinates): number {
  const rad = (deg: number) => deg * Math.PI / 180
  const dLat = rad(to.lat - from.lat)
  const dLng = rad(to.lng - from.lng)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatKm(km: number): string {
  return km < 10 ? km.toFixed(1) : String(Math.round(km))
}

/** One short glanceable line, or undefined when the dispatcher gave no coordinates. */
export function distanceLine(job: JobDetails & { route?: RouteEstimate }): string | undefined {
  if (job.route) return `${formatKm(job.route.km)} km ${job.route.profile} route, ~${job.route.minutes} min`
  if (!job.pickupAt || !job.dropAt) return undefined
  return `${formatKm(straightLineKm(job.pickupAt, job.dropAt))} km straight-line`
}
