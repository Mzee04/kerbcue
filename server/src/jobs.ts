import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ClaimedJob, JobDetails, OpenJob } from '../../shared/jobs.ts'

export interface TelegramCard {
  telegramChatId: string
  telegramMessageId: number
  telegramThreadId?: number
}

type StoredJob = { job: OpenJob | ClaimedJob; card?: TelegramCard }
const jobCommand = /^\/job(?:@[a-z\d_]+)?\s+/i

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim().replace(/\s+/g, ' ')
  return clean.length > 0 && clean.length <= maxLength ? clean : undefined
}

export function courierNameOf(value: unknown): string | undefined {
  return cleanText(value, 48)
}

export function jobDetailsOf(fields: Record<string, unknown>): JobDetails | undefined {
  const pickup = cleanText(fields.pickup, 120)
  const drop = cleanText(fields.drop, 120)
  const pay = cleanText(fields.pay, 32)
  const note = cleanText(fields.note, 300)
  if (!pickup || !drop || !pay || (fields.note !== undefined && !note)) return undefined
  return { pickup, drop, pay, ...(note ? { note } : {}) }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoredJob(value: unknown): value is StoredJob {
  if (!isRecord(value) || !isRecord(value.job)) return false
  const { job, card } = value
  if (typeof job.id !== 'string' || !job.id || !jobDetailsOf(job)) return false
  if (
    job.status !== 'open' && (job.status !== 'claimed' || !courierNameOf(job.courierName)
      || typeof job.claimedAt !== 'string' || !Number.isFinite(Date.parse(job.claimedAt)))
  ) return false
  return card === undefined || (isRecord(card)
    && typeof card.telegramChatId === 'string'
    && Number.isSafeInteger(card.telegramMessageId)
    && (card.telegramThreadId === undefined || Number.isSafeInteger(card.telegramThreadId)))
}

export class JobStore {
  private jobs = new Map<string, StoredJob>()
  private readonly dataFile?: string
  private telegramOffset = 0

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
      const state: unknown = JSON.parse(contents)
      if (!isRecord(state) || typeof state.telegramOffset !== 'number'
        || !Number.isSafeInteger(state.telegramOffset) || state.telegramOffset < 0
        || !Array.isArray(state.jobs) || !state.jobs.every(isStoredJob)) {
        throw new Error('Invalid job data.')
      }
      this.jobs = new Map(state.jobs.map(stored => [stored.job.id, stored]))
      this.telegramOffset = state.telegramOffset
    } catch {
      console.warn('Kerbcue job data is corrupt. Starting with an empty job store.')
    }
  }

  private save(jobs: Map<string, StoredJob>, telegramOffset: number): void {
    if (!this.dataFile) return
    mkdirSync(dirname(this.dataFile), { recursive: true })
    const temp = `${this.dataFile}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify({ jobs: [...jobs.values()], telegramOffset }) + '\n', {
        flag: 'wx',
        mode: 0o600,
      })
      renameSync(temp, this.dataFile)
    } catch (error) {
      try { rmSync(temp, { force: true }) } catch { /* Preserve the original write error. */ }
      throw error
    }
  }

  private store(stored: StoredJob, telegramOffset = this.telegramOffset): void {
    if (this.dataFile) {
      const next = new Map(this.jobs)
      next.set(stored.job.id, stored)
      this.save(next, telegramOffset)
      this.jobs = next
    } else {
      this.jobs.set(stored.job.id, stored)
    }
    this.telegramOffset = telegramOffset
  }

  getTelegramOffset(): number {
    return this.telegramOffset
  }

  setTelegramOffset(offset: number): void {
    if (offset <= this.telegramOffset) return
    this.save(this.jobs, offset)
    this.telegramOffset = offset
  }

  add(job: OpenJob, card?: TelegramCard, telegramOffset = this.telegramOffset): void {
    this.store({ job, card }, Math.max(telegramOffset, this.telegramOffset))
  }

  listOpen(): OpenJob[] {
    return [...this.jobs.values()].flatMap(({ job }) => job.status === 'open' ? [job] : [])
  }

  claim(id: string, courierName: string) {
    const stored = this.jobs.get(id)
    if (!stored) return { status: 'missing' } as const
    if (stored.job.status === 'claimed') {
      if (stored.job.courierName === courierName) {
        return { status: 'already', job: stored.job, card: stored.card } as const
      }
      return { status: 'conflict' } as const
    }

    const job: ClaimedJob = {
      ...stored.job,
      status: 'claimed',
      courierName,
      claimedAt: new Date().toISOString(),
    }
    // Reserve the job synchronously, before the HTTP handler awaits Telegram.
    this.store({ ...stored, job })
    return { status: 'claimed', job, card: stored.card } as const
  }
}
