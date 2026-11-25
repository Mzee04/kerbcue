import type { JobStore } from './jobs.ts'
import type { TelegramClient } from './telegram.ts'

const maxBackoffMs = 5 * 60_000

/**
 * Keeps each job's Telegram card in step with the stored job.
 *
 * Edits for one job run one at a time and always render the latest stored state,
 * so an older "Picked up" edit can never land after "Delivered". A job whose
 * card is behind keeps a persisted `syncPending` marker until an edit succeeds.
 * Failed edits are retried in the background with backoff, including after a restart.
 */
export class CardSync {
  private readonly telegram: TelegramClient
  private readonly jobs: JobStore
  private readonly chains = new Map<string, Promise<boolean>>()
  private readonly retries = new Map<string, { failures: number; nextAt: number }>()

  constructor(telegram: TelegramClient, jobs: JobStore) {
    this.telegram = telegram
    this.jobs = jobs
  }

  /** Brings the card up to date. Resolves true when the card shows the latest state. */
  sync(id: string): Promise<boolean> {
    const previous = this.chains.get(id) ?? Promise.resolve(true)
    const run = previous.catch(() => false).then(() => this.syncLatest(id))
    this.chains.set(id, run)
    // Catch on the cleanup chain so a rejected sync cannot become an unhandled rejection,
    // including when a caller uses `void sync()`. The returned `run` still rejects for awaiters.
    void run.catch(error => {
      console.error('Kerbcue could not finish a Telegram card sync.', error)
    }).finally(() => {
      if (this.chains.get(id) === run) this.chains.delete(id)
    })
    return run
  }

  private async syncLatest(id: string): Promise<boolean> {
    // Loop while the job changes during an edit, so the last edit is the newest state.
    for (let pass = 0; pass < 5; pass++) {
      const stored = this.jobs.get(id)
      if (!stored?.card || !stored.syncPending) return !!stored?.card
      const job = stored.job
      const result = await this.telegram.renderCard(stored.card, job)
      if (result === 'permanent') {
        // The card is gone or the bot lost access. Stop retrying; the stored state is still right.
        this.jobs.markSynced(id, job)
        this.retries.delete(id)
        console.warn(`Kerbcue gave up updating the Telegram card for job ${id}.`)
        return false
      }
      if (result === 'retry') {
        const failures = (this.retries.get(id)?.failures ?? 0) + 1
        this.retries.set(id, { failures, nextAt: Date.now() + Math.min(maxBackoffMs, 1000 * 2 ** failures) })
        return false
      }
      if (this.jobs.markSynced(id, job)) {
        this.retries.delete(id)
        return true
      }
    }
    return !this.jobs.get(id)?.syncPending
  }

  /** Retries every job whose card is behind and whose backoff has passed. */
  async retryDue(now = Date.now()): Promise<void> {
    const due = this.jobs.pendingSyncIds().filter(id =>
      !this.chains.has(id) && (this.retries.get(id)?.nextAt ?? 0) <= now)
    await Promise.all(due.map(id => this.sync(id)))
  }

  /** Runs once now, to recover syncs left over from before a restart, then every few seconds. */
  start(signal: AbortSignal, intervalMs = 3000): void {
    const tick = () => {
      if (signal.aborted) return
      void this.retryDue().catch(() => undefined).finally(() => {
        if (!signal.aborted) setTimeout(tick, intervalMs).unref()
      })
    }
    tick()
  }
}

const syncers = new WeakMap<JobStore, CardSync>()

/** One CardSync per job store, so the API, Telegram polling and retries share the per-job queue. */
export function cardSyncFor(telegram: TelegramClient, jobs: JobStore): CardSync {
  let syncer = syncers.get(jobs)
  if (!syncer) {
    syncer = new CardSync(telegram, jobs)
    syncers.set(jobs, syncer)
  }
  return syncer
}
