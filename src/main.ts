import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import {
  distanceLine,
  nextStatus,
  type AssignedJob,
  type Courier,
  type CourierStatus,
  type JobDetails,
  type LinkResponse,
  type OpenJob,
  type RouteEstimate,
} from '../shared/jobs.ts'
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

function deliveryLines(job: JobDetails & { route?: RouteEstimate }): string[] {
  const distance = distanceLine(job)
  return [
    `Pickup: ${shorten(job.pickup)}`,
    `Drop: ${shorten(job.drop)}`,
    `Pay: ${shorten(job.pay)}`,
    ...(distance ? [shorten(distance, 30)] : []),
  ]
}

// Each device keeps its own link. `?courier=b` gives a second simulator its own slot for demos.
const linkSlot = new URLSearchParams(window.location.search).get('courier')?.replace(/[^a-z\d]/gi, '').slice(0, 12)
const linkStorageKey = `kerbcue-link${linkSlot ? `-${linkSlot}` : ''}`

type Action = { kind: 'claim'; job: OpenJob } | { kind: 'advance'; job: AssignedJob; to: CourierStatus }

interface Frame {
  text: string
  action?: Action
  linkUrl?: string
}

function sameAction(a?: Action, b?: Action): boolean {
  return a?.kind === b?.kind && a?.job.id === b?.job.id && a?.job.status === b?.job.status
}

function renderCompanion(frame: Frame): void {
  if (!companion) return
  companion.textContent = frame.text
  if (frame.linkUrl) {
    const anchor = document.createElement('a')
    anchor.href = frame.linkUrl
    anchor.textContent = '\n\nOpen Telegram to link'
    companion.append(anchor)
  }
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
  let link: LinkResponse | undefined
  const linkStore = {
    async load(): Promise<LinkResponse | undefined> {
      let raw = ''
      try {
        // Do not let a slow host bridge block startup.
        raw = await Promise.race([
          bridge.getLocalStorage(linkStorageKey),
          new Promise<string>(resolve => window.setTimeout(() => resolve(''), 1500)),
        ]) ?? ''
      } catch { /* Fall back to the WebView. */ }
      try { raw ||= window.localStorage.getItem(linkStorageKey) ?? '' } catch { /* Storage can be blocked. */ }
      try {
        const saved = JSON.parse(raw) as Partial<LinkResponse>
        return typeof saved.deviceKey === 'string' && typeof saved.code === 'string' ? saved as LinkResponse : undefined
      } catch {
        return undefined
      }
    },
    async save(value: LinkResponse): Promise<void> {
      const raw = JSON.stringify(value)
      await bridge.setLocalStorage(linkStorageKey, raw).catch(() => false)
      try { window.localStorage.setItem(linkStorageKey, raw) } catch { /* Kept in memory for this session. */ }
    },
  }
  link = await linkStore.load()

  let api: ReturnType<typeof createJobsClient> | undefined
  try {
    api = createJobsClient(lifetime.signal, () => link?.deviceKey)
  } catch {
    console.error('Set the backend origin in app.json.')
  }

  let jobs: OpenJob[] = []
  let active: AssignedJob[] = []
  let index = 0
  let courier: Courier | null = null
  let loaded = false
  let offline = false
  let linking = false
  let busy: Action | undefined
  let confirmation: { text: string; until: number } | undefined
  let notice: { text: string; until: number } | undefined
  let painting = false
  let refreshVersion = 0
  let refreshing = false

  function frame(): Frame {
    const now = Date.now()
    const message = notice && notice.until > now ? notice.text : undefined
    if (confirmation && confirmation.until > now) return { text: confirmation.text }

    if (!api || !loaded) {
      const status = !api ? 'Check backend setup' : offline ? 'Offline. Retrying...' : 'Loading jobs...'
      return { text: ['Kerbcue', '', status, '', exitHint].join('\n') }
    }

    if (!courier) {
      const bot = link?.link ? `@${new URL(link.link).pathname.slice(1)}` : 'the Kerbcue bot'
      const lines = link && !linking
        ? ['Link your Telegram', `Send /start ${link.code}`, `to ${bot}`]
        : [offline ? 'Offline. Retrying...' : 'Getting a link code...']
      return { text: ['Kerbcue', '', ...lines, '', exitHint].join('\n'), linkUrl: link?.link }
    }

    // A claimed job stays on screen until it is delivered.
    const current = busy?.kind === 'advance' ? busy.job : busy ? undefined : active[0]
    if (current) {
      const to = nextStatus[current.status]
      const state = current.status === 'claimed' ? `Claimed by ${shorten(current.courierName, 18)}` : 'Picked up'
      const hint = busy ? 'Saving...'
        : message ?? (offline ? 'Offline. Retrying...' : to === 'picked_up' ? 'Tap: mark picked up' : 'Tap: mark delivered')
      return {
        action: busy || !to ? undefined : { kind: 'advance', job: current, to },
        text: ['Kerbcue  My job', ...deliveryLines(current), '', state, hint].join('\n'),
      }
    }

    const job = busy?.kind === 'claim' ? busy.job : jobs[index]
    if (!job) {
      const status = offline ? 'Offline. Retrying...' : 'No open jobs'
      return { text: ['Kerbcue', '', status, ...(message ? [message] : []), '', exitHint].join('\n') }
    }

    const title = busy ? 'Kerbcue' : `Kerbcue  ${index + 1}/${jobs.length}`
    const status = busy ? 'Claiming...' : 'Open | Tap to claim'
    const hint = !busy && (message || (offline ? 'Offline. Retrying...' : undefined)
      || (jobs.length > 1 ? 'Swipe to browse' : undefined))
    return {
      action: busy ? undefined : { kind: 'claim', job },
      text: [title, ...deliveryLines(job), '', status, ...(hint ? [hint] : [])].join('\n'),
    }
  }

  async function paint(): Promise<void> {
    if (painting || stopped()) return
    painting = true
    try {
      while (!stopped()) {
        const next = frame()
        renderCompanion(next)
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
              if (busy) return
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
        if (latest.text === next.text && sameAction(latest.action, next.action)) return
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

  async function startLink(): Promise<void> {
    if (!api || linking || stopped()) return
    linking = true
    try {
      link = await api.link()
      await linkStore.save(link)
    } catch {
      if (!stopped()) offline = true
    } finally {
      linking = false
    }
  }

  async function refresh(force = false): Promise<void> {
    if (!api || stopped() || busy || (refreshing && !force)) return
    const version = ++refreshVersion
    refreshing = true
    try {
      const response = await api.list()
      if (stopped() || busy || version !== refreshVersion) return
      setJobs(response.jobs)
      active = response.active
      courier = response.courier
      loaded = true
      offline = false
      // No link yet, or the code expired before the courier sent /start.
      if (!courier && !response.linkPending) await startLink()
    } catch {
      if (!stopped() && !busy && version === refreshVersion) offline = true
    } finally {
      if (version === refreshVersion) refreshing = false
      void paint()
    }
  }

  function browse(direction: number): void {
    if (stopped() || busy || jobs.length === 0 || active.length > 0) return
    if (confirmation && confirmation.until > Date.now()) {
      confirmation = undefined
    } else {
      index = (index + direction + jobs.length) % jobs.length
    }
    notice = undefined
    void paint()
  }

  async function claim(job: OpenJob): Promise<void> {
    if (!api) return
    const result = await api.claim(job.id)
    if (stopped()) return
    setJobs(jobs.filter(open => open.id !== job.id))
    if (result === 'conflict') {
      notice = { text: 'Job already taken', until: Date.now() + 4000 }
    } else if (result === 'unlinked') {
      courier = null
    } else {
      active = [result.job, ...active.filter(mine => mine.id !== job.id)]
      if (result.telegramSynced === true) console.info('Telegram card updated and reply posted.')
      if (result.telegramSynced === false) console.warn('The job was claimed, but Telegram updates failed.')
    }
  }

  async function advance(job: AssignedJob, to: CourierStatus): Promise<void> {
    if (!api) return
    const result = await api.advance(job.id, to)
    if (stopped()) return
    if ('conflict' in result) {
      notice = { text: 'Already updated', until: Date.now() + 4000 }
    } else if ('forbidden' in result) {
      notice = { text: 'Not your job', until: Date.now() + 4000 }
    } else {
      const updated = result.job
      active = updated.status === 'delivered'
        ? active.filter(mine => mine.id !== updated.id)
        : active.map(mine => mine.id === updated.id ? updated : mine)
      if (updated.status === 'delivered') {
        confirmation = {
          // Only claim the dispatcher saw it when the Telegram card edit succeeded.
          text: ['Kerbcue', '', 'Delivered', shorten(updated.drop),
            ...(result.telegramSynced === true ? ['', 'Telegram card updated'] : [])].join('\n'),
          until: Date.now() + 4000,
        }
      }
      if (result.telegramSynced === false) console.warn('The status was saved, but the Telegram card update failed.')
    }
  }

  async function act(): Promise<void> {
    const action = displayed?.action
    if (!api || stopped() || busy || !action) return
    busy = action
    notice = undefined
    void paint()
    try {
      if (action.kind === 'claim') await claim(action.job)
      else await advance(action.job, action.to)
    } catch {
      if (!stopped()) {
        notice = { text: action.kind === 'claim' ? 'Claim failed. Retry.' : 'Update failed. Retry.', until: Date.now() + 4500 }
      }
    } finally {
      busy = undefined
      void paint()
      void refresh(true)
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
    if (has(OsEventTypeList.CLICK_EVENT)) void act()
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
