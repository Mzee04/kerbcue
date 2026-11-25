import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  nextStatus,
  type AssignedJob,
  type Coordinates,
  type Courier,
  type CourierStatus,
  type Job,
  type JobDetails,
  type OpenJob,
  type RouteEstimate,
} from '../../shared/jobs.ts'

export interface TelegramCard {
  telegramChatId: string
  telegramMessageId: number
  telegramThreadId?: number
}

/** `syncPending` marks a job whose latest state is not yet on its Telegram card. */
export type StoredJob = { job: Job; card?: TelegramCard; syncPending?: boolean }
type StoredDevice = { keyHash: string; courierId: string }
const jobCommand = /^\/job(?:@[a-z\d_]+)?\s+/i
const coordinateSuffix = /\s*@\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/
const linkAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const linkTtlMs = 15 * 60_000
const maxPendingLinks = 500

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim().replace(/\s+/g, ' ')
  return clean.length > 0 && clean.length <= maxLength ? clean : undefined
}

export function courierNameOf(value: unknown): string | undefined {
  return cleanText(value, 48)
}

export function coordinatesOf(value: unknown): Coordinates | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { lat, lng } = value as Record<string, unknown>
  if (typeof lat !== 'number' || typeof lng !== 'number') return undefined
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }
}

/** Splits "Central Station @ 40.0000, 10.0000" into a place name and coordinates. */
function placeOf(value: unknown): { name?: string; at?: Coordinates; invalid?: true } {
  if (typeof value !== 'string') return {}
  const match = coordinateSuffix.exec(value)
  if (!match) return { name: cleanText(value, 120) }
  const at = coordinatesOf({ lat: Number(match[1]), lng: Number(match[2]) })
  if (!at) return { invalid: true }
  return { name: cleanText(value.slice(0, match.index), 120), at }
}

export function jobDetailsOf(fields: Record<string, unknown>): JobDetails | undefined {
  const pickup = placeOf(fields.pickup)
  const drop = placeOf(fields.drop)
  const pay = cleanText(fields.pay, 32)
  const note = cleanText(fields.note, 300)
  if (!pickup.name || !drop.name || !pay || pickup.invalid || drop.invalid) return undefined
  if (fields.note !== undefined && !note) return undefined
  const pickupAt = pickup.at ?? (fields.pickupAt === undefined ? undefined : coordinatesOf(fields.pickupAt))
  const dropAt = drop.at ?? (fields.dropAt === undefined ? undefined : coordinatesOf(fields.dropAt))
  if ((fields.pickupAt !== undefined && !pickupAt) || (fields.dropAt !== undefined && !dropAt)) return undefined
  return {
    pickup: pickup.name,
    drop: drop.name,
    pay,
    ...(note ? { note } : {}),
    ...(pickupAt ? { pickupAt } : {}),
    ...(dropAt ? { dropAt } : {}),
  }
}

export function parseJob(text: string, requireCommand = false): JobDetails | undefined {
  const trimmed = text.trim()
  if (requireCommand && !jobCommand.test(trimmed)) return undefined
  const body = trimmed.replace(jobCommand, '')
  const fields: Record<string, unknown> = {}

  for (const field of body.split(/\s*\|\s*|\r?\n/)) {
    const match = /^(pickup|drop|pay|note)\s*:\s*(.+)$/i.exec(field.trim())
    if (!match) return undefined
    const key = match[1].toLowerCase()
    if (key in fields) return undefined
    fields[key] = match[2]
  }

  return jobDetailsOf(fields)
}

export function newJob(details: JobDetails): OpenJob {
  return { ...details, id: randomUUID(), status: 'open' }
}

export function hashDeviceKey(deviceKey: string): string {
  return createHash('sha256').update(deviceKey).digest('base64url')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))

function isRoute(value: unknown): boolean {
  return value === undefined || (isRecord(value) && typeof value.km === 'number' && value.km >= 0
    && typeof value.minutes === 'number' && value.minutes >= 0 && typeof value.profile === 'string')
}

/** Upgrades a stored job from older data files, or returns undefined when it is invalid. */
function storedJobOf(value: unknown): StoredJob | undefined {
  if (!isRecord(value) || !isRecord(value.job)) return undefined
  const { job, card } = value
  if (typeof job.id !== 'string' || !job.id || !jobDetailsOf(job) || !isRoute(job.route)) return undefined
  if (value.syncPending !== undefined && typeof value.syncPending !== 'boolean') return undefined
  if (card !== undefined && !(isRecord(card)
    && typeof card.telegramChatId === 'string'
    && Number.isSafeInteger(card.telegramMessageId)
    && (card.telegramThreadId === undefined || Number.isSafeInteger(card.telegramThreadId)))) return undefined
  if (job.status === 'open') return value as StoredJob
  if (!['claimed', 'picked_up', 'delivered'].includes(job.status as string)) return undefined
  if (!courierNameOf(job.courierName) || !isTime(job.claimedAt)) return undefined
  if (job.status !== 'claimed' && !isTime(job.pickedUpAt)) return undefined
  if (job.status === 'delivered' && !isTime(job.deliveredAt)) return undefined
  // Data files from before Telegram identity stored only a courier name.
  const courierId = typeof job.courierId === 'string' && job.courierId ? job.courierId : `name:${job.courierName}`
  return {
    job: { ...job, courierId } as AssignedJob,
    card: card as TelegramCard | undefined,
    ...(value.syncPending ? { syncPending: true } : {}),
  }
}

function isCourier(value: unknown): value is Courier {
  return isRecord(value) && typeof value.id === 'string' && !!value.id && !!courierNameOf(value.name)
}

function isDevice(value: unknown): value is StoredDevice {
  return isRecord(value) && typeof value.keyHash === 'string' && typeof value.courierId === 'string'
}

function newLinkCode(): string {
  const bytes = randomBytes(8)
  return [...bytes].map(byte => linkAlphabet[byte % linkAlphabet.length]).join('')
}

interface State {
  jobs: Map<string, StoredJob>
  couriers: Map<string, Courier>
  devices: Map<string, string>
  telegramOffset: number
}

export class JobStore {
  private state: State = { jobs: new Map(), couriers: new Map(), devices: new Map(), telegramOffset: 0 }
  private readonly pendingLinks = new Map<string, { keyHash: string; expiresAt: number }>()
  private readonly dataFile?: string

  constructor(dataFile?: string) {
    this.dataFile = dataFile
    if (!dataFile) return

    let contents: string
    try {
      contents = readFileSync(dataFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    try {
      const saved: unknown = JSON.parse(contents)
      if (!isRecord(saved) || typeof saved.telegramOffset !== 'number'
        || !Number.isSafeInteger(saved.telegramOffset) || saved.telegramOffset < 0
        || !Array.isArray(saved.jobs)) {
        throw new Error('Invalid job data.')
      }
      const jobs = saved.jobs.map(storedJobOf)
      if (!jobs.every(stored => stored !== undefined)) throw new Error('Invalid job data.')
      const couriers = saved.couriers ?? []
      const devices = saved.devices ?? []
      if (!Array.isArray(couriers) || !couriers.every(isCourier)
        || !Array.isArray(devices) || !devices.every(isDevice)) {
        throw new Error('Invalid courier data.')
      }
      this.state = {
        jobs: new Map(jobs.map(stored => [stored.job.id, stored])),
        couriers: new Map(couriers.map(courier => [courier.id, { id: courier.id, name: courier.name }])),
        devices: new Map(devices.map(device => [device.keyHash, device.courierId])),
        telegramOffset: saved.telegramOffset,
      }
    } catch {
      // Keep the bad file for inspection instead of overwriting it on the next save.
      const kept = `${dataFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
      try {
        renameSync(dataFile, kept)
        console.warn(`Kerbcue job data is corrupt. Moved it to ${kept} and started with an empty job store.`)
      } catch {
        console.warn('Kerbcue job data is corrupt and could not be moved. Starting with an empty job store.')
      }
    }
  }

  /** Writes the next state to disk first, then swaps it in, so a failed write changes nothing. */
  private commit(next: State): void {
    if (this.dataFile) {
      mkdirSync(dirname(this.dataFile), { recursive: true })
      const temp = `${this.dataFile}.${randomUUID()}.tmp`
      const data = {
        jobs: [...next.jobs.values()],
        couriers: [...next.couriers.values()],
        devices: [...next.devices].map(([keyHash, courierId]) => ({ keyHash, courierId })),
        telegramOffset: next.telegramOffset,
      }
      try {
        writeFileSync(temp, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 })
        renameSync(temp, this.dataFile)
      } catch (error) {
        try { rmSync(temp, { force: true }) } catch { /* Preserve the original write error. */ }
        throw error
      }
    }
    this.state = next
  }

  private storeJob(stored: StoredJob, telegramOffset = this.state.telegramOffset): void {
    const jobs = new Map(this.state.jobs)
    jobs.set(stored.job.id, stored)
    this.commit({ ...this.state, jobs, telegramOffset })
  }

  getTelegramOffset(): number {
    return this.state.telegramOffset
  }

  setTelegramOffset(offset: number): void {
    if (offset <= this.state.telegramOffset) return
    this.commit({ ...this.state, telegramOffset: offset })
  }

  add(job: OpenJob, card?: TelegramCard, telegramOffset = this.state.telegramOffset): void {
    this.storeJob({ job, card }, Math.max(telegramOffset, this.state.telegramOffset))
  }

  get(id: string): StoredJob | undefined {
    return this.state.jobs.get(id)
  }

  listOpen(): OpenJob[] {
    return [...this.state.jobs.values()].flatMap(({ job }) => job.status === 'open' ? [job] : [])
  }

  listActive(courierId: string): AssignedJob[] {
    return [...this.state.jobs.values()].flatMap(({ job }) =>
      job.status !== 'open' && job.status !== 'delivered' && job.courierId === courierId ? [job] : [])
  }

  // Courier identity -------------------------------------------------------

  /** Starts a link for a new device. Only a hash of the device key is kept. */
  /** Drops expired link codes. Runs on every link call and on a timer. */
  purgeExpiredLinks(now = Date.now()): number {
    let removed = 0
    for (const [code, pending] of this.pendingLinks) {
      if (pending.expiresAt <= now) {
        this.pendingLinks.delete(code)
        removed += 1
      }
    }
    return removed
  }

  pendingLinkCount(): number {
    return this.pendingLinks.size
  }

  createLink(now = Date.now()) {
    this.purgeExpiredLinks(now)
    if (this.pendingLinks.size >= maxPendingLinks) return undefined
    let code = newLinkCode()
    while (this.pendingLinks.has(code)) code = newLinkCode()
    const deviceKey = randomBytes(24).toString('base64url')
    const expiresAt = now + linkTtlMs
    this.pendingLinks.set(code, { keyHash: hashDeviceKey(deviceKey), expiresAt })
    return { code, deviceKey, expiresAt: new Date(expiresAt).toISOString() }
  }

  /** Binds the device that owns `code` to a courier. Telegram supplies the courier. */
  completeLink(code: string, courier: Courier, now = Date.now()): 'linked' | 'missing' {
    const key = code.trim().toUpperCase()
    const pending = this.pendingLinks.get(key)
    if (!pending || pending.expiresAt <= now) {
      this.pendingLinks.delete(key)
      return 'missing'
    }
    const couriers = new Map(this.state.couriers)
    couriers.set(courier.id, courier)
    const devices = new Map(this.state.devices)
    devices.set(pending.keyHash, courier.id)
    this.commit({ ...this.state, couriers, devices })
    this.pendingLinks.delete(key)
    return 'linked'
  }

  /** Removes every device linked to a courier. Their jobs keep the name for history. */
  unlinkCourier(courierId: string): number {
    const devices = new Map([...this.state.devices].filter(([, id]) => id !== courierId))
    const removed = this.state.devices.size - devices.size
    if (removed > 0) this.commit({ ...this.state, devices })
    return removed
  }

  findCourier(query: string): Courier | undefined {
    const wanted = query.trim().replace(/^@/, '').toLowerCase()
    const couriers = [...this.state.couriers.values()]
    return couriers.find(courier => courier.id === `tg:${wanted}`)
      ?? couriers.find(courier => courier.name.toLowerCase() === wanted || courier.name.toLowerCase() === `@${wanted}`)
  }

  courierFor(deviceKey: string | undefined): Courier | undefined {
    if (!deviceKey) return undefined
    const courierId = this.state.devices.get(hashDeviceKey(deviceKey))
    return courierId ? this.state.couriers.get(courierId) : undefined
  }

  isLinkPending(deviceKey: string | undefined, now = Date.now()): boolean {
    if (!deviceKey) return false
    const keyHash = hashDeviceKey(deviceKey)
    return [...this.pendingLinks.values()].some(pending => pending.keyHash === keyHash && pending.expiresAt > now)
  }

  // Job lifecycle ----------------------------------------------------------

  claim(id: string, courier: Courier) {
    const stored = this.state.jobs.get(id)
    if (!stored) return { status: 'missing' } as const
    if (stored.job.status !== 'open') {
      if (stored.job.courierId === courier.id) {
        return { status: 'already', job: stored.job, card: stored.card } as const
      }
      return { status: 'conflict' } as const
    }

    const job: AssignedJob = {
      ...stored.job,
      status: 'claimed',
      courierId: courier.id,
      courierName: courier.name,
      claimedAt: new Date().toISOString(),
    }
    // Reserve the job synchronously, before the HTTP handler awaits Telegram.
    this.storeJob({ ...stored, job, syncPending: !!stored.card })
    return { status: 'claimed', job, card: stored.card } as const
  }

  /** Moves a job one step forward. Only the claiming courier can do this. */
  advance(id: string, courierId: string, to: CourierStatus) {
    const stored = this.state.jobs.get(id)
    if (!stored) return { status: 'missing' } as const
    const { job } = stored
    if (job.status === 'open' || job.courierId !== courierId) return { status: 'forbidden' } as const
    if (nextStatus[job.status] !== to) return { status: 'invalid', job } as const

    const at = new Date().toISOString()
    const next: AssignedJob = to === 'picked_up'
      ? { ...job, status: 'picked_up', pickedUpAt: at }
      : { ...job, status: 'delivered', deliveredAt: at }
    this.storeJob({ ...stored, job: next, syncPending: !!stored.card })
    return { status: 'advanced', job: next, card: stored.card } as const
  }

  // Locations --------------------------------------------------------------

  findByCard(chatId: string, messageId: number): StoredJob | undefined {
    return [...this.state.jobs.values()].find(({ card }) =>
      card?.telegramChatId === chatId && card.telegramMessageId === messageId)
  }

  /** A dispatcher pin fills pickup first, then drop. Returns undefined when nothing changed. */
  addPin(id: string, at: Coordinates): StoredJob | undefined {
    const stored = this.state.jobs.get(id)
    if (!stored || stored.job.status === 'delivered') return undefined
    const field = !stored.job.pickupAt ? 'pickupAt' : !stored.job.dropAt ? 'dropAt' : undefined
    if (!field) return undefined
    const next = { ...stored, job: { ...stored.job, [field]: at } as Job, syncPending: !!stored.card }
    this.storeJob(next)
    return next
  }

  setRoute(id: string, route: RouteEstimate): StoredJob | undefined {
    const stored = this.state.jobs.get(id)
    if (!stored) return undefined
    const next = { ...stored, job: { ...stored.job, route } as Job, syncPending: !!stored.card }
    this.storeJob(next)
    return next
  }

  // Telegram card sync -----------------------------------------------------

  pendingSyncIds(): string[] {
    return [...this.state.jobs.values()].flatMap(stored => stored.syncPending && stored.card ? [stored.job.id] : [])
  }

  /** Clears the marker only if `job` is still the latest state, so a newer change stays pending. */
  markSynced(id: string, job: Job): boolean {
    const stored = this.state.jobs.get(id)
    if (!stored || stored.job !== job) return false
    if (stored.syncPending) this.storeJob({ ...stored, syncPending: false })
    return true
  }
}
