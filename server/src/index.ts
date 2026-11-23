import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { createApi } from './api.ts'
import { courierNameOf, JobStore } from './jobs.ts'
import { pollTelegram, TelegramClient } from './telegram.ts'

const port = Number(process.env.PORT?.trim() || '8787')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.')

const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
const groupId = process.env.TELEGRAM_GROUP_CHAT_ID?.trim() || undefined
if (groupId && !/^-[1-9]\d*$/.test(groupId)) {
  throw new Error('TELEGRAM_GROUP_CHAT_ID must be a negative integer.')
}

const telegram = token ? new TelegramClient(token) : undefined
const jobs = new JobStore()
const demo = !telegram && process.env.NODE_ENV !== 'production'
const api = createApi({
  jobs,
  telegram,
  courierName: courierNameOf(process.env.COURIER_NAME) ?? 'Courier',
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
    const response = await api(request)
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
  if (telegram) {
    console.log(groupId ? 'Telegram polling enabled.' : 'Telegram polling for group chat ID discovery.')
    void pollTelegram(telegram, jobs, groupId, stop.signal)
  } else if (demo) {
    console.log('Demo job creation enabled at POST /jobs.')
  }
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stop.abort()
    server.close()
  })
}
