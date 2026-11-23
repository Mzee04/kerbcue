import type { ClaimedJob, JobDetails, OpenJob } from '../../shared/jobs.ts'
import { randomUUID } from 'node:crypto'

export interface TelegramCard {
  telegramChatId: string
  telegramMessageId: number
  telegramThreadId?: number
}

type StoredJob = { job: OpenJob | ClaimedJob; card?: TelegramCard }

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

export function parseJob(text: string): JobDetails | undefined {
  const body = text.trim().replace(/^\/job(?:@[a-z\d_]+)?\s+/i, '')
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

export class JobStore {
  private readonly jobs = new Map<string, StoredJob>()

  add(job: OpenJob, card?: TelegramCard): void {
    this.jobs.set(job.id, { job, card })
  }

  listOpen(): OpenJob[] {
    return [...this.jobs.values()].flatMap(({ job }) => job.status === 'open' ? [job] : [])
  }

  claim(id: string, courierName: string) {
    const stored = this.jobs.get(id)
    if (!stored) return { status: 'missing' } as const
    if (stored.job.status === 'claimed') return { status: 'conflict' } as const

    const job: ClaimedJob = {
      ...stored.job,
      status: 'claimed',
      courierName,
      claimedAt: new Date().toISOString(),
    }
    // Reserve the job synchronously, before the HTTP handler awaits Telegram.
    this.jobs.set(id, { ...stored, job })
    return { status: 'claimed', job, card: stored.card } as const
  }
}
