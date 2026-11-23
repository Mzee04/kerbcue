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

function makeUpdate(update_id: number, chatId: string, text: string, senderChatId?: number) {
  return {
    update_id,
    message: {
      chat: { id: Number(chatId), type: 'supergroup' },
      message_id: 7,
      message_thread_id: 19,
      is_topic_message: true,
      text,
      ...(senderChatId === undefined ? {} : { from: { is_bot: true }, sender_chat: { id: senderChatId } }),
    },
  }
}

async function pollBatch(
  updates: ReturnType<typeof makeUpdate>[],
  sendCard: (body: Record<string, unknown>) => Response,
) {
  const jobs = new JobStore()
  const stop = new AbortController()
  const offsets: number[] = []
  const telegram = new TelegramClient('test-placeholder', async (input, init) => {
    const outgoing = new Request(input, init)
    const method = new URL(outgoing.url).pathname.split('/').at(-1)
    const body = await outgoing.json()
    if (method === 'getUpdates') {
      offsets.push(body.offset)
      if (offsets.length === 1) return Response.json({ ok: true, result: updates })
      stop.abort()
      return Response.json({ ok: true, result: [] })
    }
    assert.equal(method, 'sendMessage')
    return sendCard(body)
  })

  await pollTelegram(telegram, jobs, groupId, stop.signal)
  return { jobs, offsets }
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
  const replyStarted = Promise.withResolvers<void>()
  const finishEdit = Promise.withResolvers<void>()

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
    if (method === 'sendMessage' && body.reply_parameters) replyStarted.resolve()
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
    await Promise.all([editStarted.promise, replyStarted.promise])
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
  const claimCalls = calls.slice(3)
  assert.equal(claimCalls.length, 2)
  const edit = claimCalls.find(({ method }) => method === 'editMessageText')
  const reply = claimCalls.find(({ method }) => method === 'sendMessage')
  assert.ok(edit && reply)
  assert.equal(edit.body.chat_id, groupId)
  assert.equal(edit.body.message_id, 42)
  assert.match(String(edit.body.text), /Claimed by Alex at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)
  assert.deepEqual(reply.body, {
    chat_id: groupId,
    message_thread_id: 19,
    reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    text: 'Alex claimed the delivery.',
  })
})

test('keeps a card-less job and confirms the update after an uncertain network failure', async t => {
  t.mock.method(console, 'error', () => {})
  const warnings = t.mock.method(console, 'warn', () => {})
  let posts = 0
  const { jobs, offsets } = await pollBatch([makeUpdate(40, groupId, demoText)], () => {
    posts += 1
    throw new TypeError('Connection lost after sending the request')
  })

  assert.equal(posts, 1)
  assert.deepEqual(offsets, [0, 41])
  const open = jobs.listOpen()
  assert.equal(open.length, 1)
  const [job] = open
  assert.deepEqual(job, { ...details, id: job.id, status: 'open' })
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [
    [`Kerbcue job ${job.id} added without a Telegram card.`],
  ])
  const api = createApi({ jobs, courierName: 'Courier', publicOrigin: webOrigin, demo: false })
  const claimed = await api(request(`/jobs/${job.id}/claim`, {}))
  assert.equal(claimed.status, 200)
  assert.equal((await claimed.json() as ClaimResponse).telegramSynced, null)
})

test('retries a Telegram 429 and stores the posted card once', async t => {
  const errors = t.mock.method(console, 'error', () => {})
  const posts: Record<string, unknown>[] = []
  const { jobs, offsets } = await pollBatch([makeUpdate(50, groupId, demoText)], body => {
    posts.push(body)
    if (posts.length === 1) {
      return Response.json({
        ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 },
      }, { status: 429 })
    }
    return Response.json({ ok: true, result: { message_id: 73 } })
  })

  assert.equal(posts.length, 2)
  assert.deepEqual(posts[0], posts[1])
  assert.deepEqual(offsets, [0, 51])
  assert.match(errors.mock.calls[0].arguments[0], /HTTP 429, Too Many Requests/)
  const open = jobs.listOpen()
  assert.equal(open.length, 1)
  const result = jobs.claim(open[0].id, 'Alex')
  assert.equal(result.status, 'claimed')
  assert.deepEqual(result.card, { telegramChatId: groupId, telegramMessageId: 73, telegramThreadId: 19 })
})

test('logs a safe reason after getUpdates fails and resumes when Telegram responds', {
  timeout: 4000,
}, async t => {
  const errors = t.mock.method(console, 'error', () => {})
  const recovery = t.mock.method(console, 'log', () => {})
  const stop = new AbortController()
  const token = '123456:private-test-token'
  let attempts = 0
  const telegram = new TelegramClient(token, async input => {
    attempts += 1
    if (attempts === 1) {
      throw new TypeError(`Fetch exploded at ${input}`, { cause: { code: 'ECONNRESET' } })
    }
    if (attempts === 3) stop.abort()
    return Response.json({ ok: true, result: [] })
  })

  await pollTelegram(telegram, new JobStore(), groupId, stop.signal)

  assert.equal(attempts, 3)
  const logged = errors.mock.calls.map(call => call.arguments.join(' ')).join('\n')
  assert.match(logged, /Telegram getUpdates failed \(ECONNRESET\)/)
  assert.ok(!logged.includes(token))
  assert.doesNotMatch(logged, /api\.telegram\.org|Fetch exploded/)
  assert.deepEqual(recovery.mock.calls.map(call => call.arguments), [['Telegram polling recovered after 1 failure.']])
})

test('accepts an anonymous admin posting as the configured group and ignores other bots', async () => {
  let posts = 0
  const { jobs, offsets } = await pollBatch([
    makeUpdate(60, groupId, demoText, -2000),
    makeUpdate(61, groupId, demoText, Number(groupId)),
  ], () => {
    posts += 1
    return Response.json({ ok: true, result: { message_id: 74 } })
  })

  assert.equal(posts, 1)
  assert.equal(jobs.listOpen().length, 1)
  assert.deepEqual(offsets, [0, 62])
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
