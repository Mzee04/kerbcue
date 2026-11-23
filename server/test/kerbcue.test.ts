import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClaimResponse, OpenJob, OpenJobsResponse } from '../../shared/jobs.ts'
import { createApi } from '../src/api.ts'
import { JobStore, parseJob } from '../src/jobs.ts'
import { pollTelegram, TelegramClient } from '../src/telegram.ts'

const groupId = '-1001234567890'
const webOrigin = 'http://localhost:5173'
const demoText = '/job pickup: Central Station | drop: 42 Market Street | pay: 15 USD | note: leave at reception'
const details = {
  pickup: 'Central Station',
  drop: '42 Market Street',
  pay: '15 USD',
  note: 'leave at reception',
}

function request(path: string, body?: unknown): Request {
  return new Request(`http://localhost:8787${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: webOrigin },
    body: JSON.stringify(body),
  })
}

test('parses a /job command and clear plain-text blocks, and ignores other chat', () => {
  assert.deepEqual(parseJob(demoText), details)
  assert.deepEqual(parseJob(demoText.slice(5)), details)
  assert.deepEqual(parseJob('Pickup: Central Station\r\nDrop: 42 Market Street\r\nPay: 15 USD'), {
    pickup: details.pickup, drop: details.drop, pay: details.pay,
  })
  assert.equal(parseJob('Meet me at Central Station.'), undefined)
  assert.equal(parseJob('/job pickup: Central Station | drop: 42 Market Street'), undefined)
  assert.equal(parseJob('/job pickup: Central Station | pickup: Public Library | drop: 42 Market Street | pay: 15 USD'), undefined)
})

test('polls only the configured group and replies to the canonical Telegram card after one atomic claim', {
  timeout: 3000,
}, async () => {
  const jobs = new JobStore()
  const stop = new AbortController()
  const calls: { method: string; body: Record<string, unknown> }[] = []
  const editStarted = Promise.withResolvers<void>()
  const finishEdit = Promise.withResolvers<void>()
  const makeUpdate = (update_id: number, chatId: string, text: string) => ({
    update_id,
    message: {
      chat: { id: Number(chatId), type: 'supergroup' },
      message_id: 7,
      message_thread_id: 19,
      is_topic_message: true,
      text,
    },
  })

  const telegram = new TelegramClient('test-placeholder', async (input, init) => {
    const outgoing = new Request(input, init)
    const url = new URL(outgoing.url)
    assert.equal(url.origin, 'https://api.telegram.org')
    assert.equal(outgoing.method, 'POST')
    assert.equal(outgoing.headers.get('content-type'), 'application/json')
    const method = url.pathname.split('/').at(-1) ?? ''
    const body = await outgoing.json()
    calls.push({ method, body })
    if (method === 'getUpdates') {
      if (body.offset === 0) {
        return Response.json({ ok: true, result: [
          makeUpdate(100, '-2000', demoText),
          makeUpdate(101, groupId, 'Hello dispatch'),
          makeUpdate(102, groupId, demoText),
          makeUpdate(102, groupId, demoText),
        ] })
      }
      stop.abort()
      return Response.json({ ok: true, result: [] })
    }
    if (method === 'editMessageText') {
      editStarted.resolve()
      await finishEdit.promise
    }
    return Response.json({ ok: true, result: { message_id: 42 } })
  })

  const api = createApi({ jobs, telegram, courierName: 'Courier', publicOrigin: webOrigin, demo: false })
  await pollTelegram(telegram, jobs, groupId, stop.signal)
  assert.deepEqual(calls.map(({ method }) => method), ['getUpdates', 'sendMessage', 'getUpdates'])
  assert.deepEqual(calls[2].body, { offset: 103, timeout: 25, allowed_updates: ['message'] })
  const listed = await api(request('/jobs'))
  assert.equal(listed.status, 200)
  const open = await listed.json() as OpenJobsResponse
  assert.equal(open.jobs.length, 1)
  const [job] = open.jobs
  assert.deepEqual(job, { ...details, id: job.id, status: 'open' })
  assert.equal(calls[1].body.chat_id, groupId)
  assert.equal(calls[1].body.message_thread_id, 19)
  assert.match(String(calls[1].body.text), /Open\nPickup: Central Station/)
  assert.ok(String(calls[1].body.text).includes(job.id))
  assert.equal((await api(request('/jobs', {}))).status, 404)

  const claimPath = `/jobs/${job.id}/claim`
  const first = api(request(claimPath, { courierName: 'Alex' }))
  try {
    await editStarted.promise
    assert.equal((await api(request(claimPath, { courierName: 'Second courier' }))).status, 409)
    assert.deepEqual((await (await api(request('/jobs'))).json()).jobs, [])
  } finally {
    finishEdit.resolve()
  }
  const claimed = await first
  assert.equal(claimed.status, 200)
  const response = await claimed.json() as ClaimResponse
  assert.equal(response.job.status, 'claimed')
  assert.equal(response.job.courierName, 'Alex')
  assert.equal(response.telegramSynced, true)
  assert.ok(Date.parse(response.job.claimedAt) > 0)
  assert.deepEqual(calls.slice(3).map(({ method }) => method), ['editMessageText', 'sendMessage'])
  assert.equal(calls[3].body.chat_id, groupId)
  assert.equal(calls[3].body.message_id, 42)
  assert.match(String(calls[3].body.text), /Claimed by Alex at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)
  assert.deepEqual(calls[4].body, {
    chat_id: groupId,
    message_thread_id: 19,
    reply_parameters: { message_id: 42 },
    text: 'Alex claimed the delivery.',
  })
})

test('creates and claims a token-free demo job with the configured courier and CORS preflight', async () => {
  const api = createApi({ jobs: new JobStore(), courierName: 'Demo Courier', publicOrigin: webOrigin, demo: true })
  const created = await api(request('/jobs', {}))
  assert.equal(created.status, 201)
  const { job } = await created.json() as { job: OpenJob }
  assert.deepEqual(job, { ...details, note: 'Leave at reception', id: job.id, status: 'open' })
  const claimPath = `/jobs/${job.id}/claim`

  const preflight = await api(new Request(`http://localhost:8787${claimPath}`, {
    method: 'OPTIONS',
    headers: { Origin: webOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' },
  }))
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), webOrigin)
  assert.match(preflight.headers.get('Access-Control-Allow-Methods') ?? '', /POST/)
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type')
  assert.equal((await api(request(claimPath, { courierName: '' }))).status, 400)

  const claimed = await api(request(claimPath, {}))
  assert.equal(claimed.status, 200)
  const response = await claimed.json() as ClaimResponse
  assert.equal(response.job.courierName, 'Demo Courier')
  assert.equal(response.telegramSynced, null)
  assert.equal((await api(request(claimPath, {}))).status, 409)
})
