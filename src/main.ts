import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import type { ClaimedJob, JobDetails, OpenJob } from '../shared/jobs.ts'
import { createJobsClient } from './api.ts'

const mainContainer = { containerID: 1, containerName: 'main' }
const displayReloadKey = 'kerbcue-display-reload'
const exitHint = 'Double-tap to exit'
const startupText = `Kerbcue\n\nLoading jobs...\n\n${exitHint}`
const companion = document.querySelector('#app')
document.title = 'Kerbcue'

// Protobuf can omit event type 0 on a tap. An absent envelope is no event.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function shorten(value: string, limit = 24): string {
  const chars = [...value]
  return chars.length > limit ? chars.slice(0, limit - 3).join('') + '...' : value
}

function deliveryLines(job: JobDetails): string[] {
  return [`Pickup: ${shorten(job.pickup)}`, `Drop: ${shorten(job.drop)}`, `Pay: ${shorten(job.pay)}`]
}

interface Frame {
  text: string
  job?: OpenJob
}

function pageLayout(content: string) {
  return {
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({
      ...mainContainer,
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      content,
      isEventCapture: 1,
    })],
  }
}

async function start(): Promise<void> {
  const bridge = await waitForEvenAppBridge()
  const layout = pageLayout(startupText)
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(layout))
  if (result !== 0) {
    // A WebView reload can leave the native page alive. Restore its event
    // container so the new WebView can attach its listener to the page.
    const restored = await bridge.rebuildPageContainer(new RebuildPageContainer(layout))
    if (!restored) throw new Error(`Glasses startup failed (${result}).`)
    console.info(`Kerbcue restored the existing glasses page (startup result ${result}).`)
  }
  let displayed: Frame | undefined = { text: startupText }

  const lifetime = new AbortController()
  const stopped = () => lifetime.signal.aborted
  let session: Storage | undefined
  try {
    session = window.sessionStorage
  } catch {
    // Some WebView origins disallow storage.
  }
  let api: ReturnType<typeof createJobsClient> | undefined
  try {
    api = createJobsClient(lifetime.signal)
  } catch {
    console.error('Set the backend origin in app.json.')
  }

  let jobs: OpenJob[] = []
  let index = 0
  let courierName = ''
  let loaded = false
  let offline = false
  let claiming: OpenJob | undefined
  let confirmation: { job: ClaimedJob; until: number } | undefined
  let notice: { text: string; until: number } | undefined
  let painting = false
  let refreshVersion = 0
  let refreshing = false

  function frame(): Frame {
    const message = notice && notice.until > Date.now() ? notice.text : undefined
    if (confirmation && confirmation.until > Date.now()) {
      return {
        text: ['Kerbcue', '', ...deliveryLines(confirmation.job), '',
          `Claimed by ${shorten(confirmation.job.courierName, 19)}`,
          ...(jobs.length ? ['Swipe for next job'] : []),
        ].join('\n'),
      }
    }

    const job = claiming ?? jobs[index]
    if (!job) {
      const status = !api ? 'Check backend setup'
        : offline ? 'Offline. Retrying...'
          : loaded ? 'No open jobs' : 'Loading jobs...'
      return { text: ['Kerbcue', '', status, ...(message ? [message] : []), '', exitHint].join('\n') }
    }

    const title = claiming ? 'Kerbcue' : `Kerbcue  ${index + 1}/${jobs.length}`
    const status = claiming ? 'Claiming...' : 'Open | Tap to claim'
    const hint = !claiming && (message || (offline ? 'Offline. Retrying...' : undefined)
      || (jobs.length > 1 ? 'Swipe to browse' : undefined))
    return {
      job: claiming ? undefined : job,
      text: [title, '', ...deliveryLines(job), '',
        status, ...(hint ? [hint] : []),
      ].join('\n'),
    }
  }

  async function paint(): Promise<void> {
    if (painting || stopped()) return
    painting = true
    try {
      while (!stopped()) {
        const next = frame()
        if (companion) companion.textContent = next.text
        if (displayed?.text !== next.text) {
          const updated = displayed && await bridge.textContainerUpgrade(new TextContainerUpgrade({
            ...mainContainer,
            content: next.text,
          })).catch(() => false)
          if (stopped()) return
          if (!updated) {
            // The host can discard the page while the WebView is still running.
            displayed = undefined
            const rebuilt = await bridge.rebuildPageContainer(new RebuildPageContainer(pageLayout(next.text)))
              .catch(() => false)
            if (stopped()) return
            if (!rebuilt) {
              if (claiming) return
              if (session && !session.getItem(displayReloadKey)) {
                // A fresh launch can create the native page when no page remains to rebuild.
                session.setItem(displayReloadKey, '1')
                window.location.reload()
              } else {
                console.warn('Could not restore the glasses display.')
              }
              return
            }
          }
          session?.removeItem(displayReloadKey)
        }
        if (stopped()) return
        displayed = next
        const latest = frame()
        if (latest.text === next.text && latest.job?.id === next.job?.id) return
      }
    } catch {
      if (!stopped()) console.warn('Could not update the glasses display.')
    } finally {
      painting = false
    }
  }

  function setJobs(next: OpenJob[]): void {
    const selected = jobs[index]?.id
    const selectedIndex = next.findIndex(job => job.id === selected)
    index = selectedIndex < 0 ? index % (next.length || 1) : selectedIndex
    jobs = next
  }

  async function refresh(force = false): Promise<void> {
    if (!api || stopped() || claiming || (refreshing && !force)) return
    const version = ++refreshVersion
    refreshing = true
    try {
      const response = await api.list()
      if (stopped() || claiming || version !== refreshVersion) return
      setJobs(response.jobs)
      courierName = response.courierName
      loaded = true
      offline = false
    } catch {
      if (!stopped() && !claiming && version === refreshVersion) offline = true
    } finally {
      if (version === refreshVersion) refreshing = false
      void paint()
    }
  }

  function browse(direction: number): void {
    if (stopped() || claiming || jobs.length === 0) return
    if (confirmation && confirmation.until > Date.now()) {
      confirmation = undefined
    } else {
      index = (index + direction + jobs.length) % jobs.length
    }
    notice = undefined
    void paint()
  }

  async function claimVisibleJob(): Promise<void> {
    const job = displayed?.job
    if (!api || stopped() || claiming || !job) return
    claiming = job
    notice = undefined
    void paint()
    let refreshNow = false
    try {
      const result = await api.claim(job.id, courierName)
      if (stopped()) return
      setJobs(jobs.filter(open => open.id !== job.id))
      if (result === 'conflict') {
        notice = { text: 'Job already taken', until: Date.now() + 4000 }
      } else {
        confirmation = { job: result.job, until: Date.now() + 4500 }
        if (result.telegramSynced === true) console.info('Telegram card updated and reply posted.')
        if (result.telegramSynced === false) console.warn('The job was claimed, but Telegram updates failed.')
      }
      refreshNow = true
    } catch {
      if (!stopped()) notice = { text: 'Claim failed. Retry.', until: Date.now() + 4500 }
    } finally {
      claiming = undefined
      void paint()
      if (refreshNow) void refresh(true)
    }
  }

  const interval = window.setInterval(() => {
    void paint()
    void refresh()
  }, 3000)
  const unsubscribe = bridge.onEvenHubEvent(event => {
    const sysType = eventTypeOf(event.sysEvent)
    const textType = eventTypeOf(event.textEvent)
    const has = (type: OsEventTypeList) => sysType === type || textType === type

    if (has(OsEventTypeList.SYSTEM_EXIT_EVENT) || has(OsEventTypeList.ABNORMAL_EXIT_EVENT)) {
      lifetime.abort()
      window.clearInterval(interval)
      unsubscribe()
      return
    }
    if (has(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
      void bridge.shutDownPageContainer(1).catch(() => console.warn('Could not open the exit dialog.'))
      return
    }
    if (has(OsEventTypeList.SCROLL_TOP_EVENT)) {
      browse(-1)
      return
    }
    if (has(OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
      browse(1)
      return
    }
    // Right temple, left temple, R1 and simulator taps use the same action.
    if (has(OsEventTypeList.CLICK_EVENT)) void claimVisibleJob()
  })

  if (companion instanceof HTMLElement) companion.style.whiteSpace = 'pre-line'
  console.info('Kerbcue glasses page ready.')
  void paint()
  void refresh()
}

void start().catch(() => {
  if (companion) companion.textContent = 'Kerbcue could not start on the glasses.'
  console.error('Kerbcue glasses startup failed.')
})
