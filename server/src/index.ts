import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { createApi } from './api.ts'
import { dataFileFromEnv, JobStore } from './jobs.ts'
import { cardSyncFor } from './cardsync.ts'
import { createOsrmRouter, routingLabel } from './routing.ts'
import { pollTelegram, TelegramClient } from './telegram.ts'

const port = Number(process.env.PORT?.trim() || '8787')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.')

const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
const groupId = process.env.TELEGRAM_GROUP_CHAT_ID?.trim() || undefined
if (groupId && !/^-[1-9]\d*$/.test(groupId)) {
  throw new Error('TELEGRAM_GROUP_CHAT_ID must be a negative integer.')
}

const dispatcherSetting = process.env.TELEGRAM_DISPATCHER_IDS?.trim()
const dispatcherIds = dispatcherSetting
  ? new Set(dispatcherSetting.split(',').map(id => id.trim()))
  : undefined
if (dispatcherIds && [...dispatcherIds].some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
  throw new Error('TELEGRAM_DISPATCHER_IDS must be a comma-separated list of positive integer Telegram user IDs.')
}

const routingUrl = process.env.KERBCUE_ROUTING_URL?.trim() || undefined
if (routingUrl && !/^https?:\/\/[^\s?#]+$/.test(routingUrl)) {
  throw new Error('KERBCUE_ROUTING_URL must be an http(s) base URL of an OSRM-compatible server.')
}
const routingProfile = routingUrl ? routingLabel(routingUrl, process.env.KERBCUE_ROUTING_PROFILE) : 'road'
const router = routingUrl ? createOsrmRouter(routingUrl, routingProfile) : undefined

const telegram = token ? new TelegramClient(token) : undefined
const botUsername = telegram ? await telegram.getUsername() : undefined
const dataFile = dataFileFromEnv()
const jobs = new JobStore(dataFile)
const demo = !telegram && process.env.NODE_ENV !== 'production'
const api = createApi({
  jobs,
  telegram,
  botUsername,
  router,
  groupId,
  publicOrigin: process.env.PUBLIC_ORIGIN?.trim() || '*',
  demo,
})

const server = createServer(async (incoming, outgoing) => {
  try {
    const method = incoming.method ?? 'GET'
    const headers = new Headers()
    for (const [name, values] of Object.entries(incoming.headersDistinct)) {
      for (const value of values ?? []) headers.append(name, value)
    }
    const init: RequestInit & { duplex?: 'half' } = { method, headers }
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>
      init.duplex = 'half'
    }
    const request = new Request(new URL(incoming.url ?? '/', 'http://localhost'), init)
    const response = await api(request, { ip: incoming.socket.remoteAddress })
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined)
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(400, { 'Content-Type': 'application/json' })
    outgoing.end(JSON.stringify({ error: 'Invalid HTTP request.' }))
  }
})

const stop = new AbortController()
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`Kerbcue server could not listen on port ${port} (${error.code ?? 'unknown error'}).`)
  stop.abort()
  process.exitCode = 1
})
server.listen(port, '0.0.0.0', () => {
  console.log(`Kerbcue API listening on port ${port}.`)
  console.log(dataFile ? `Job data: ${dataFile}` : 'Job data: in-memory (reset on restart).')
  if (telegram) {
    console.log(groupId ? 'Telegram polling enabled.' : 'Telegram polling for group chat ID discovery.')
    void pollTelegram(telegram, jobs, groupId, stop.signal, dispatcherIds, router)
    // Retries card edits that failed earlier, including ones saved before a restart.
    cardSyncFor(telegram, jobs).start(stop.signal)
    if (!groupId) console.log('Courier linking stays off until TELEGRAM_GROUP_CHAT_ID is set.')
  } else if (demo) {
    console.log('Demo mode: POST /jobs adds jobs and POST /couriers/demo-link links a courier.')
  }
  console.log(router ? `Route estimates enabled (${routingProfile}).` : 'Route estimates off. Cards show straight-line distance.')
})

setInterval(() => jobs.purgeExpiredLinks(), 60_000).unref()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stop.abort()
    server.close()
  })
}
