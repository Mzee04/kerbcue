import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { distanceLine, straightLineKm, type AssignedJob, type ClaimResponse, type OpenJobsResponse, type StatusResponse } from '../../shared/jobs.ts'
import { createApi } from '../src/api.ts'
import { JobStore, linkTtlMs, newJob, parseJob } from '../src/jobs.ts'
import { createOsrmRouter } from '../src/routing.ts'
import { cardText, pollTelegram, TelegramClient } from '../src/telegram.ts'

const groupId = '-1001234567890'
const webOrigin = 'http://localhost:5173'
const alex = { id: 'tg:1001', name: 'Alex Ade' }
const bola = { id: 'tg:1002', name: 'Bola' }
const details = { pickup: 'Central Station', drop: '42 Market Street', pay: '15 USD' }
const card = { telegramChatId: groupId, telegramMessageId: 42, telegramThreadId: 19 }

type Call = { method: string; body: Record<string, unknown> }

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

/** A fake Telegram that records calls. `reply` can override any method's response. */
function fakeTelegram(reply: (call: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = []
  const telegram = new TelegramClient('test-placeholder', async (input, init) => {
    const outgoing = new Request(input, init)
    const call = { method: new URL(outgoing.url).pathname.split('/').at(-1) ?? '', body: await outgoing.json() }
    calls.push(call)
    return reply(call) ?? Response.json({ ok: true, result: { message_id: 42 } })
  })
  return { telegram, calls }
}

function setup(telegramReply?: (call: Call) => Response | undefined) {
  const jobs = new JobStore()
  const job = newJob(details)
  jobs.add(job, card)
  const { telegram, calls } = fakeTelegram(telegramReply)
  const api = createApi({ jobs, telegram, publicOrigin: webOrigin, demo: false })
  return { jobs, job, telegram, calls, api, alexKey: linkDevice(jobs, alex), bolaKey: linkDevice(jobs, bola) }
}

test('two couriers race for one job: exactly one wins and the card names the winner', async () => {
  for (let round = 0; round < 25; round++) {
    const { job, api, calls, alexKey, bolaKey } = setup()
    const claimPath = `/jobs/${job.id}/claim`
    const [a, b] = await Promise.all([api(request(claimPath, {}, alexKey)), api(request(claimPath, {}, bolaKey))])
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
    const winner = (await (a.status === 200 ? a : b).json() as ClaimResponse).job
    const winnerName = a.status === 200 ? alex.name : bola.name
    assert.equal(winner.courierName, winnerName)
    const edits = calls.filter(call => call.method === 'editMessageText')
    assert.equal(edits.length, 1)
    assert.match(String(edits[0].body.text), new RegExp(`Status: Claimed by ${winnerName}\\n`))
  }
})

test('the claiming courier moves the job to picked up and delivered, editing the card in place', async () => {
  const { jobs, job, api, calls, alexKey } = setup()
  assert.equal((await api(request(`/jobs/${job.id}/claim`, {}, alexKey))).status, 200)
  const afterClaim = calls.length

  const picked = await api(request(`/jobs/${job.id}/status`, { status: 'picked_up' }, alexKey))
  assert.equal(picked.status, 200)
  const pickedJob = (await picked.json() as StatusResponse)
  assert.equal(pickedJob.job.status, 'picked_up')
  assert.equal(pickedJob.telegramSynced, true)
  assert.ok(Date.parse(pickedJob.job.pickedUpAt ?? '') > 0)
  const listed = await (await api(request('/jobs', undefined, alexKey))).json() as OpenJobsResponse
  assert.deepEqual(listed.active.map(mine => mine.status), ['picked_up'])

  const delivered = await api(request(`/jobs/${job.id}/status`, { status: 'delivered' }, alexKey))
  assert.equal(delivered.status, 200)
  const done = await delivered.json() as StatusResponse
  assert.equal(done.job.status, 'delivered')
  assert.equal(done.telegramSynced, true)

  const statusCalls = calls.slice(afterClaim)
  // Only edits of the original card. No new group messages for status changes.
  assert.deepEqual(statusCalls.map(call => call.method), ['editMessageText', 'editMessageText'])
  for (const call of statusCalls) {
    assert.equal(call.body.chat_id, groupId)
    assert.equal(call.body.message_id, 42)
  }
  assert.match(String(statusCalls[0].body.text), /Status: Picked up by Alex Ade\n/)
  const final = String(statusCalls[1].body.text)
  assert.match(final, /Status: Delivered by Alex Ade\n/)
  assert.match(final, /Claimed \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\nPicked up \d{2}:\d{2} UTC\nDelivered \d{2}:\d{2} UTC$/)
  const empty = await (await api(request('/jobs', undefined, alexKey))).json() as OpenJobsResponse
  assert.deepEqual(empty.active, [])
  assert.deepEqual(empty.jobs, [])
  assert.equal(jobs.get(job.id)?.job.status, 'delivered')
})

test('rejects status updates from other couriers, unlinked devices, and on open jobs', async () => {
  const { jobs, job, api, calls, alexKey, bolaKey } = setup()
  const statusPath = `/jobs/${job.id}/status`
  assert.equal((await api(request(statusPath, { status: 'picked_up' }, alexKey))).status, 403)
  assert.equal((await api(request(`/jobs/${job.id}/claim`, {}, alexKey))).status, 200)
  const writes = calls.length

  assert.equal((await api(request(statusPath, { status: 'picked_up' }, bolaKey))).status, 403)
  assert.equal((await api(request(statusPath, { status: 'picked_up' }))).status, 401)
  assert.equal((await api(request(statusPath, { status: 'picked_up' }, 'forged-device-key-0000'))).status, 401)
  assert.equal((await api(request(statusPath, { status: 'picked_up', courierName: 'Alex Ade' }, bolaKey))).status, 403)
  assert.equal((await api(request('/jobs/missing-job/status', { status: 'picked_up' }, alexKey))).status, 404)
  assert.equal(jobs.get(job.id)?.job.status, 'claimed')
  assert.equal(calls.length, writes)
})

test('rejects skipped, duplicate, backward, and unknown status transitions', async () => {
  const { jobs, job, api, calls, alexKey } = setup()
  const statusPath = `/jobs/${job.id}/status`
  assert.equal((await api(request(`/jobs/${job.id}/claim`, {}, alexKey))).status, 200)
  const writes = calls.length

  const skipped = await api(request(statusPath, { status: 'delivered' }, alexKey))
  assert.equal(skipped.status, 409)
  assert.equal((await skipped.json() as { job: AssignedJob }).job.status, 'claimed')
  assert.equal((await api(request(statusPath, { status: 'claimed' }, alexKey))).status, 400)
  assert.equal((await api(request(statusPath, { status: 'open' }, alexKey))).status, 400)
  assert.equal((await api(request(statusPath, {}, alexKey))).status, 400)
  assert.equal(calls.length, writes)

  assert.equal((await api(request(statusPath, { status: 'picked_up' }, alexKey))).status, 200)
  assert.equal((await api(request(statusPath, { status: 'picked_up' }, alexKey))).status, 409)
  assert.equal((await api(request(statusPath, { status: 'delivered' }, alexKey))).status, 200)
  assert.equal((await api(request(statusPath, { status: 'delivered' }, alexKey))).status, 409)
  assert.equal((await api(request(statusPath, { status: 'picked_up' }, alexKey))).status, 409)
  assert.equal(jobs.get(job.id)?.job.status, 'delivered')

  // Two simultaneous taps record one transition.
  const second = newJob(details)
  jobs.add(second)
  assert.equal((await api(request(`/jobs/${second.id}/claim`, {}, alexKey))).status, 200)
  const taps = await Promise.all([1, 2].map(() =>
    api(request(`/jobs/${second.id}/status`, { status: 'picked_up' }, alexKey))))
  assert.deepEqual(taps.map(tap => tap.status).sort(), [200, 409])
})

test('keeps the status change when the Telegram card edit fails', async t => {
  const errors = t.mock.method(console, 'error', () => {})
  let failEdits = false
  const { jobs, job, api, alexKey } = setup(call => failEdits && call.method === 'editMessageText'
    ? Response.json({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }, { status: 400 })
    : undefined)
  assert.equal((await api(request(`/jobs/${job.id}/claim`, {}, alexKey))).status, 200)
  failEdits = true

  const picked = await api(request(`/jobs/${job.id}/status`, { status: 'picked_up' }, alexKey))
  assert.equal(picked.status, 200)
  assert.equal((await picked.json() as StatusResponse).telegramSynced, false)
  assert.equal(jobs.get(job.id)?.job.status, 'picked_up')
  assert.match(String(errors.mock.calls[0].arguments[0]), /editMessageText failed \(HTTP 400/)
})

test('treats "message is not modified" as an up-to-date card', async t => {
  t.mock.method(console, 'error', () => {})
  const { telegram } = fakeTelegram(() =>
    Response.json({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }, { status: 400 }))
  const job: AssignedJob = { ...newJob(details), status: 'picked_up', courierId: alex.id, courierName: alex.name,
    claimedAt: '2026-11-25T19:00:00.000Z', pickedUpAt: '2026-11-25T19:10:00.000Z' }
  assert.equal(await telegram.syncCard(card, job), true)
})

test('parses coordinates, shows labelled straight-line distance, and omits it when coordinates are missing', () => {
  const parsed = parseJob('/job pickup: Central Station @ 6.4541, 3.3947 | drop: 42 Market Street @6.4281,3.4219 | pay: 15 USD')
  assert.deepEqual(parsed, {
    ...details, pickupAt: { lat: 6.4541, lng: 3.3947 }, dropAt: { lat: 6.4281, lng: 3.4219 },
  })
  assert.ok(parsed)
  assert.match(distanceLine(parsed) ?? '', /^\d+\.\d km straight-line$/)
  assert.ok(Math.abs(straightLineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111.2) < 0.1)
  assert.equal(distanceLine({ lat: 0, lng: 0 } as never), undefined)

  // Missing one or both points: no distance line, no invented number.
  const noCoords = parseJob('/job pickup: Central Station | drop: 42 Market Street | pay: 15 USD')
  assert.ok(noCoords)
  assert.equal(distanceLine(noCoords), undefined)
  const onlyPickup = parseJob('/job pickup: Central Station @ 6.4541, 3.3947 | drop: 42 Market Street | pay: 15 USD')
  assert.ok(onlyPickup)
  assert.equal(distanceLine(onlyPickup), undefined)
  assert.doesNotMatch(cardText(newJob(onlyPickup)), /Distance/)
  // Out-of-range coordinates reject the post instead of guessing.
  assert.equal(parseJob('/job pickup: Central Station @ 96.1, 3.3 | drop: 42 Market Street | pay: 15 USD'), undefined)
})

test('uses a route estimate when the router answers and falls back to straight-line when it fails', async () => {
  const routed = createOsrmRouter('https://router.example/', 'bike', async input => {
    assert.equal(String(input), 'https://router.example/route/v1/driving/3.3947,6.4541;3.4219,6.4281?overview=false')
    return Response.json({ code: 'Ok', routes: [{ distance: 6920.9, duration: 1721.2 }] })
  })
  const from = { lat: 6.4541, lng: 3.3947 }
  const to = { lat: 6.4281, lng: 3.4219 }
  const route = await routed(from, to)
  assert.deepEqual(route, { km: 6.9, minutes: 29, profile: 'bike' })
  assert.equal(distanceLine({ ...details, pickupAt: from, dropAt: to, route }), '6.9 km bike route, ~29 min')

  const failures = [
    async () => new Response('busy', { status: 503 }),
    async () => Response.json({ code: 'NoRoute', routes: [] }),
    async () => Response.json({ code: 'Ok', routes: [{ distance: 'far' }] }),
    async () => { throw new TypeError('network down') },
  ]
  for (const failure of failures) {
    assert.equal(await createOsrmRouter('https://router.example', 'bike', failure)(from, to), undefined)
  }
})

test('dispatcher location pins replying to a card set pickup then drop and edit the card', async () => {
  const jobs = new JobStore()
  const stop = new AbortController()
  const calls: Call[] = []
  const pin = (update_id: number, latitude: number, longitude: number, userId = 7) => ({
    update_id,
    message: {
      chat: { id: Number(groupId), type: 'supergroup' }, message_id: 100 + update_id,
      from: { id: userId }, location: { latitude, longitude }, reply_to_message: { message_id: 42 },
    },
  })
  const telegram = new TelegramClient('test-placeholder', async (input, init) => {
    const outgoing = new Request(input, init)
    const method = new URL(outgoing.url).pathname.split('/').at(-1) ?? ''
    const body = await outgoing.json()
    calls.push({ method, body })
    if (method === 'getUpdates') {
      if (body.offset === 0) {
        return Response.json({ ok: true, result: [
          { update_id: 1, message: { chat: { id: Number(groupId), type: 'supergroup' }, message_id: 5, from: { id: 7 },
            text: '/job pickup: Central Station | drop: 42 Market Street | pay: 15 USD' } },
          pin(2, 6.4541, 3.3947, 99),
          pin(3, 6.4541, 3.3947),
          pin(4, 6.4281, 3.4219),
          pin(5, 1, 1),
        ] })
      }
      stop.abort()
      return Response.json({ ok: true, result: [] })
    }
    return Response.json({ ok: true, result: { message_id: 42 } })
  })
  const router = async () => undefined
  await pollTelegram(telegram, jobs, groupId, stop.signal, new Set(['7']), router)

  const [job] = jobs.listOpen()
  assert.deepEqual(job.pickupAt, { lat: 6.4541, lng: 3.3947 })
  assert.deepEqual(job.dropAt, { lat: 6.4281, lng: 3.4219 })
  const edits = calls.filter(call => call.method === 'editMessageText')
  assert.equal(edits.length, 2)
  assert.doesNotMatch(String(edits[0].body.text), /Distance/)
  assert.match(String(edits[1].body.text), /Distance: \d+\.\d km straight-line\n/)
})

test('a group member links glasses with /start CODE and claims show their Telegram name', async t => {
  t.mock.method(console, 'error', () => {})
  const jobs = new JobStore()
  const stop = new AbortController()
  const replies: string[] = []
  const good = jobs.createLink()
  const outsider = jobs.createLink()
  assert.ok(good && outsider)
  const start = (update_id: number, text: string, from: Record<string, unknown>) => ({
    update_id, message: { chat: { id: Number(from.id), type: 'private' }, message_id: update_id, from, text },
  })
  const telegram = new TelegramClient('test-placeholder', async (input, init) => {
    const outgoing = new Request(input, init)
    const method = new URL(outgoing.url).pathname.split('/').at(-1) ?? ''
    const body = await outgoing.json()
    if (method === 'getUpdates') {
      if (body.offset === 0) {
        return Response.json({ ok: true, result: [
          start(1, `/start ${good.code.toLowerCase()}`, { id: 1001, first_name: 'Alex', last_name: 'Ade' }),
          start(2, `/start ${outsider.code}`, { id: 666, first_name: 'Mallory' }),
          start(3, `/start ${good.code}`, { id: 1002, first_name: 'Bola' }),
          start(4, '/start', { id: 1003, username: 'chidi' }),
        ] })
      }
      stop.abort()
      return Response.json({ ok: true, result: [] })
    }
    if (method === 'getChatMember') {
      assert.equal(body.chat_id, groupId)
      const status = body.user_id === 666 ? 'left' : 'member'
      return Response.json({ ok: true, result: { status } })
    }
    replies.push(String(body.text))
    return Response.json({ ok: true, result: { message_id: 1 } })
  })
  await pollTelegram(telegram, jobs, groupId, stop.signal)

  assert.deepEqual(jobs.courierFor(good.deviceKey), { id: 'tg:1001', name: 'Alex Ade' })
  assert.equal(jobs.courierFor(outsider.deviceKey), undefined)
  assert.match(replies[0], /Linked\. Your Kerbcue claims will show as Alex Ade\./)
  assert.match(replies[1], /Only members of the dispatch group/)
  assert.match(replies[2], /expired or was already used/)
  assert.match(replies[3], /Send \/start CODE/)

  const job = newJob(details)
  jobs.add(job)
  const api = createApi({ jobs, publicOrigin: webOrigin, demo: false })
  const claimed = await api(request(`/jobs/${job.id}/claim`, { courierName: 'Someone else' }, good.deviceKey))
  assert.equal((await claimed.json() as ClaimResponse).job.courierName, 'Alex Ade')
})

test('link codes expire', () => {
  const jobs = new JobStore()
  const link = jobs.createLink(1_000)
  assert.ok(link)
  assert.equal(jobs.isLinkPending(link.deviceKey, 1_000 + linkTtlMs - 1), true)
  assert.equal(jobs.completeLink(link.code, alex, 1_000 + linkTtlMs), 'missing')
  assert.equal(jobs.courierFor(link.deviceKey), undefined)
})

test('persists linked couriers and delivery history across restarts, and loads older data files', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kerbcue-lifecycle-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const dataFile = join(directory, 'kerbcue.json')
  const first = new JobStore(dataFile)
  const key = linkDevice(first, alex)
  const job = newJob({ ...details, pickupAt: { lat: 6.4541, lng: 3.3947 } })
  first.add(job, card)
  assert.equal(first.claim(job.id, alex).status, 'claimed')
  assert.equal(first.advance(job.id, alex.id, 'picked_up').status, 'advanced')

  const restarted = new JobStore(dataFile)
  assert.deepEqual(restarted.courierFor(key), alex)
  const [active] = restarted.listActive(alex.id)
  assert.equal(active.status, 'picked_up')
  assert.deepEqual(active.pickupAt, { lat: 6.4541, lng: 3.3947 })
  assert.equal(restarted.advance(job.id, bola.id, 'delivered').status, 'forbidden')
  assert.equal(restarted.advance(job.id, alex.id, 'delivered').status, 'advanced')
  assert.equal(new JobStore(dataFile).get(job.id)?.job.status, 'delivered')

  // A data file written before courier identity existed.
  const legacyFile = join(directory, 'legacy.json')
  writeFileSync(legacyFile, JSON.stringify({ telegramOffset: 9, jobs: [
    { job: { ...details, id: 'old', status: 'claimed', courierName: 'Courier', claimedAt: '2026-11-23T08:00:00.000Z' } },
  ] }))
  const legacy = new JobStore(legacyFile)
  assert.equal(legacy.getTelegramOffset(), 9)
  assert.equal(legacy.get('old')?.job.status, 'claimed')
  assert.equal(legacy.claim('old', alex).status, 'conflict')
})
