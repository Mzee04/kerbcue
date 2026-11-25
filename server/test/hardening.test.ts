import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ClaimResponse, OpenJobsResponse, StatusResponse } from '../../shared/jobs.ts'
import { deliveryConfirmMs, deliveryTap, isConfirming } from '../../src/confirm.ts'
import { createApi } from '../src/api.ts'
import { CardSync, cardSyncFor } from '../src/cardsync.ts'
import { JobStore, linkTtlMs, newJob } from '../src/jobs.ts'
import { routingLabel } from '../src/routing.ts'
import { pollTelegram, TelegramClient } from '../src/telegram.ts'

const groupId = '-1001234567890'
const webOrigin = 'http://localhost:5173'
const alex = { id: 'tg:1001', name: 'Alex' }
const bola = { id: 'tg:1002', name: 'Bola' }
const details = { pickup: 'Riverside Depot', drop: '12 Park Lane', pay: '15 USD' }
const card = { telegramChatId: groupId, telegramMessageId: 42 }
type Call = { method: string; body: Record<string, unknown> }
type Reply = (call: Call) => Response | Promise<Response | undefined> | undefined

function request(path: string, body?: unknown, deviceKey?: string): Request {
  const auth: Record<string, string> = deviceKey ? { Authorization: `Bearer ${deviceKey}` } : {}
  return new Request(`http://localhost:8787${path}`, body === undefined ? { headers: auth } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: webOrigin, ...auth },
    body: JSON.stringify(body),
  })
}

function linkDevice(jobs: JobStore, courier: { id: string; name: string }): string {
  const link = jobs.createLink()
  assert.ok(link)
  assert.equal(jobs.completeLink(link.code, courier), 'linked')
  return link.deviceKey
}

function fakeTelegram(reply: Reply = () => undefined) {
  const calls: Call[] = []
  const telegram = new TelegramClient('test-placeholder', async (input, init) => {
    const outgoing = new Request(input, init)
    const call = { method: new URL(outgoing.url).pathname.split('/').at(-1) ?? '', body: await outgoing.json() }
    calls.push(call)
    return await reply(call) ?? Response.json({ ok: true, result: call.method === 'getChatMember' ? { status: 'member' } : { message_id: 42 } })
  })
  return { telegram, calls }
}

const networkDown = () => { throw new TypeError('network down') }
const edits = (calls: Call[]) => calls.filter(call => call.method === 'editMessageText').map(call => String(call.body.text))

test('fix 1: GET /jobs hides open jobs from unlinked devices but still reports link status', async () => {
  const jobs = new JobStore()
  jobs.add(newJob(details))
  const api = createApi({ jobs, publicOrigin: webOrigin, demo: false })
  const anonymous = await (await api(request('/jobs'))).json() as OpenJobsResponse
  assert.deepEqual(anonymous, { jobs: [], active: [], courier: null, linkPending: false })

  const link = await (await api(request('/couriers/link', {}))).json() as { deviceKey: string; code: string }
  const pending = await (await api(request('/jobs', undefined, link.deviceKey))).json() as OpenJobsResponse
  assert.deepEqual(pending.jobs, [])
  assert.equal(pending.linkPending, true)

  jobs.completeLink(link.code, alex)
  const linked = await (await api(request('/jobs', undefined, link.deviceKey))).json() as OpenJobsResponse
  assert.equal(linked.jobs.length, 1)
  assert.equal(linked.jobs[0].pickup, 'Riverside Depot')
})

test('fix 2: a failed card edit is persisted, survives a restart, and is retried in the background', async t => {
  t.mock.method(console, 'error', () => {})
  const directory = mkdtempSync(join(tmpdir(), 'kerbcue-sync-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const dataFile = join(directory, 'kerbcue.json')

  const jobs = new JobStore(dataFile)
  const job = newJob(details)
  jobs.add(job, card)
  const down = fakeTelegram(call => call.method === 'editMessageText' ? networkDown() : undefined)
  const api = createApi({ jobs, telegram: down.telegram, publicOrigin: webOrigin, demo: false })
  const alexKey = linkDevice(jobs, alex)
  const claimed = await (await api(request(`/jobs/${job.id}/claim`, {}, alexKey))).json() as ClaimResponse
  assert.equal(claimed.telegramSynced, false)
  assert.equal(jobs.get(job.id)?.syncPending, true)

  // Backoff: an immediate retry is skipped, a later one runs.
  const sync = cardSyncFor(down.telegram, jobs)
  const before = edits(down.calls).length
  await sync.retryDue(Date.now())
  assert.equal(edits(down.calls).length, before)

  // Restart with Telegram back up. The marker came back from disk and startup recovers it.
  const restarted = new JobStore(dataFile)
  assert.deepEqual(restarted.pendingSyncIds(), [job.id])
  const up = fakeTelegram()
  const stop = new AbortController()
  new CardSync(up.telegram, restarted).start(stop.signal, 60_000)
  await new Promise(resolve => setTimeout(resolve, 50))
  stop.abort()
  assert.match(edits(up.calls).at(-1) ?? '', /Status: Claimed by Alex/)
  assert.deepEqual(restarted.pendingSyncIds(), [])
  assert.notEqual(new JobStore(dataFile).get(job.id)?.syncPending, true)
})

test('fix 2: a repeated claim or status request from the owner resyncs a stale card', async t => {
  t.mock.method(console, 'error', () => {})
  let failing = true
  const jobs = new JobStore()
  const job = newJob(details)
  jobs.add(job, card)
  const { telegram, calls } = fakeTelegram(call => failing && call.method === 'editMessageText' ? networkDown() : undefined)
  const api = createApi({ jobs, telegram, publicOrigin: webOrigin, demo: false })
  const alexKey = linkDevice(jobs, alex)
  assert.equal((await (await api(request(`/jobs/${job.id}/claim`, {}, alexKey))).json() as ClaimResponse).telegramSynced, false)

  failing = false
  const again = await (await api(request(`/jobs/${job.id}/claim`, {}, alexKey))).json() as ClaimResponse
  assert.equal(again.telegramSynced, true)
  assert.equal(jobs.get(job.id)?.syncPending, false)
  // A synced job does not repeat Telegram writes on a repeat claim.
  const count = calls.length
  assert.equal((await (await api(request(`/jobs/${job.id}/claim`, {}, alexKey))).json() as ClaimResponse).telegramSynced, null)
  assert.equal(calls.length, count)

  failing = true
  const picked = await (await api(request(`/jobs/${job.id}/status`, { status: 'picked_up' }, alexKey))).json() as StatusResponse
  assert.equal(picked.telegramSynced, false)
  failing = false
  const duplicate = await api(request(`/jobs/${job.id}/status`, { status: 'picked_up' }, alexKey))
  assert.equal(duplicate.status, 409)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.match(edits(calls).at(-1) ?? '', /Status: Picked up by Alex/)
  assert.equal(jobs.get(job.id)?.syncPending, false)
})

test('fix 2: a permanent Telegram rejection stops retries and reports false', async t => {
  t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'warn', () => {})
  const jobs = new JobStore()
  const job = newJob(details)
  jobs.add(job, card)
  const { telegram, calls } = fakeTelegram(call => call.method === 'editMessageText'
    ? Response.json({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }, { status: 400 })
    : undefined)
  jobs.claim(job.id, alex)
  assert.equal(await cardSyncFor(telegram, jobs).sync(job.id), false)
  assert.deepEqual(jobs.pendingSyncIds(), [])
  await cardSyncFor(telegram, jobs).retryDue(Date.now() + 10 * 60_000)
  assert.equal(edits(calls).length, 1)
})

test('fix 3: card edits are serialized per job and a stale Picked up never overwrites Delivered', async () => {
  const jobs = new JobStore()
  const job = newJob(details)
  jobs.add(job, card)
  const firstEdit = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let inFlight = 0
  let maxInFlight = 0
  const { telegram, calls } = fakeTelegram(async call => {
    if (call.method !== 'editMessageText') return undefined
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    if (edits(calls).length === 1) {
      firstEdit.resolve()
      await release.promise
    }
    inFlight -= 1
    return Response.json({ ok: true, result: { message_id: 42 } })
  })
  const api = createApi({ jobs, telegram, publicOrigin: webOrigin, demo: false })
  const alexKey = linkDevice(jobs, alex)
  jobs.claim(job.id, alex)
  jobs.markSynced(job.id, jobs.get(job.id)!.job)

  const picked = api(request(`/jobs/${job.id}/status`, { status: 'picked_up' }, alexKey))
  await firstEdit.promise
  const delivered = api(request(`/jobs/${job.id}/status`, { status: 'delivered' }, alexKey))
  await new Promise(resolve => setTimeout(resolve, 10))
  release.resolve()
  const [p, d] = await Promise.all([picked, delivered])
  assert.equal(p.status, 200)
  assert.equal(d.status, 200)

  const texts = edits(calls)
  assert.equal(maxInFlight, 1)
  assert.match(texts[0], /Status: Picked up by Alex/)
  assert.match(texts.at(-1) ?? '', /Status: Delivered by Alex/)
  assert.equal(texts.length, 2)
  assert.deepEqual(jobs.pendingSyncIds(), [])
})

test('fix 4: Delivered needs a second tap on the same job within the timeout', () => {
  const first = deliveryTap(undefined, 'job-1', 1000)
  assert.equal(first.send, false)
  assert.ok(isConfirming(first.pending, 'job-1', 1000))
  assert.equal(deliveryTap(first.pending, 'job-1', 1000 + deliveryConfirmMs - 1).send, true)
  // Too late: the prompt starts over.
  const late = deliveryTap(first.pending, 'job-1', 1000 + deliveryConfirmMs)
  assert.equal(late.send, false)
  // A tap for another job doesn't confirm this one.
  assert.equal(deliveryTap(first.pending, 'job-2', 1500).send, false)
  assert.equal(isConfirming(first.pending, 'job-2', 1500), false)
})

test('fix 5: link requests are rate limited per IP and in total, and expired codes are purged', async () => {
  const jobs = new JobStore()
  const api = createApi({ jobs, publicOrigin: webOrigin, demo: false, linkLimits: { perIp: 2, total: 3 } })
  const link = (ip: string) => api(request('/couriers/link', {}), { ip })
  assert.equal((await link('198.51.100.1')).status, 201)
  assert.equal((await link('198.51.100.1')).status, 201)
  const limited = await link('198.51.100.1')
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('Retry-After')) > 0)
  assert.equal((await link('198.51.100.2')).status, 201)
  assert.equal((await link('198.51.100.3')).status, 429)

  assert.equal(jobs.pendingLinkCount(), 3)
  assert.equal(jobs.purgeExpiredLinks(Date.now() + linkTtlMs + 1), 3)
  assert.equal(jobs.pendingLinkCount(), 0)
})

test('fix 5: dispatchers and couriers can unlink devices from Telegram', async t => {
  t.mock.method(console, 'error', () => {})
  const jobs = new JobStore()
  const alexKey = linkDevice(jobs, alex)
  const alexSpare = linkDevice(jobs, alex)
  const bolaKey = linkDevice(jobs, bola)
  const chidiKey = linkDevice(jobs, { id: 'tg:1003', name: 'Chidi' })
  const stop = new AbortController()
  const replies: string[] = []
  const group = (update_id: number, text: string, fromId: number, replyTo?: number) => ({
    update_id,
    message: {
      chat: { id: Number(groupId), type: 'supergroup' }, message_id: update_id, from: { id: fromId }, text,
      ...(replyTo ? { reply_to_message: { message_id: 1, from: { id: replyTo } } } : {}),
    },
  })
  const telegram = new TelegramClient('test-placeholder', async (input, init) => {
    const outgoing = new Request(input, init)
    const method = new URL(outgoing.url).pathname.split('/').at(-1) ?? ''
    const body = await outgoing.json()
    if (method === 'getUpdates') {
      if (body.offset === 0) {
        return Response.json({ ok: true, result: [
          group(1, '/unlink Alex', 1002),
          group(2, '/unlink Alex', 9),
          group(3, '/unlink', 9, 1002),
          { update_id: 4, message: { chat: { id: 1003, type: 'private' }, message_id: 4, from: { id: 1003 }, text: '/unlink' } },
        ] })
      }
      stop.abort()
      return Response.json({ ok: true, result: [] })
    }
    if (method === 'getChatMember') {
      return Response.json({ ok: true, result: { status: body.user_id === 9 ? 'administrator' : 'member' } })
    }
    replies.push(String(body.text))
    return Response.json({ ok: true, result: { message_id: 5 } })
  })
  await pollTelegram(telegram, jobs, groupId, stop.signal)

  // A plain member can't unlink anyone. The admin's commands and the courier's own /unlink work.
  assert.equal(jobs.courierFor(alexKey), undefined)
  assert.equal(jobs.courierFor(alexSpare), undefined)
  assert.equal(jobs.courierFor(bolaKey), undefined)
  assert.equal(jobs.courierFor(chidiKey), undefined)
  assert.deepEqual(replies, [
    'Unlinked Alex from 2 devices.',
    'Unlinked Bola from 1 device.',
    'Unlinked 1 device. Reopen Kerbcue on your glasses to link again.',
  ])
  const api = createApi({ jobs, publicOrigin: webOrigin, demo: false })
  const job = newJob(details)
  jobs.add(job)
  assert.equal((await api(request(`/jobs/${job.id}/claim`, {}, alexKey))).status, 401)
})

test('fix 5: claims re-check group membership with a cache and only block on a definite answer', async t => {
  t.mock.method(console, 'error', () => {})
  let status: string | 'down' = 'member'
  const jobs = new JobStore()
  const { telegram, calls } = fakeTelegram(call => {
    if (call.method !== 'getChatMember') return undefined
    if (status === 'down') networkDown()
    return Response.json({ ok: true, result: { status } })
  })
  const api = createApi({ jobs, telegram, groupId, publicOrigin: webOrigin, demo: false })
  const alexKey = linkDevice(jobs, alex)
  const bolaKey = linkDevice(jobs, bola)
  const add = () => { const job = newJob(details); jobs.add(job); return job.id }

  assert.equal((await api(request(`/jobs/${add()}/claim`, {}, alexKey))).status, 200)
  assert.equal((await api(request(`/jobs/${add()}/claim`, {}, alexKey))).status, 200)
  assert.equal(calls.filter(call => call.method === 'getChatMember').length, 1)

  status = 'left'
  const blocked = await api(request(`/jobs/${add()}/claim`, {}, bolaKey))
  assert.equal(blocked.status, 403)
  status = 'down'
  assert.equal((await api(request(`/jobs/${add()}/claim`, {}, linkDevice(jobs, { id: 'tg:1004', name: 'Dee' })))).status, 200)
})

test('fix 6: a corrupt data file is kept as .corrupt-<timestamp> before starting empty', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kerbcue-corrupt-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const dataFile = join(directory, 'kerbcue.json')
  writeFileSync(dataFile, '{not json')
  const warning = t.mock.method(console, 'warn', () => {})
  const jobs = new JobStore(dataFile)
  assert.deepEqual(jobs.listOpen(), [])
  assert.equal(existsSync(dataFile), false)
  const kept = readdirSync(directory).filter(name => /^kerbcue\.json\.corrupt-\d{4}-\d{2}-\d{2}T/.test(name))
  assert.equal(kept.length, 1)
  assert.match(String(warning.mock.calls[0].arguments[0]), /Moved it to .*corrupt-/)
  jobs.add(newJob(details))
  assert.equal(new JobStore(dataFile).listOpen().length, 1)
})

test('fix 8: the route label comes from the server, not the request path', () => {
  assert.equal(routingLabel('https://routing.openstreetmap.de/routed-bike'), 'bike')
  assert.equal(routingLabel('https://routing.openstreetmap.de/routed-bike/', 'BIKE'), 'bike')
  assert.equal(routingLabel('https://routing.openstreetmap.de/routed-foot'), 'foot')
  assert.equal(routingLabel('https://router.project-osrm.org'), 'car')
  assert.throws(() => routingLabel('https://router.project-osrm.org', 'bike'), /routes for car/)
  assert.equal(routingLabel('https://osrm.internal.example'), 'road')
  assert.equal(routingLabel('https://osrm.internal.example', 'bike'), 'bike')
  assert.throws(() => routingLabel('https://osrm.internal.example', 'bike route'), /one short word/)
})
