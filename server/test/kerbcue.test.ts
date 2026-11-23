import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ClaimedJob, ClaimResponse, OpenJob, OpenJobsResponse } from '../../shared/jobs.ts'
import { createApi } from '../src/api.ts'
import { JobStore, newJob, parseJob } from '../src/jobs.ts'
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
const card = { telegramChatId: groupId, telegramMessageId: 42, telegramThreadId: 19 }
const claimedJob: ClaimedJob = {
  ...details, id: 'test-claim', status: 'claimed', courierName: 'Alex', claimedAt: '2026-11-23T08:00:00.000Z',
}

function request(path: string, body?: unknown): Request {
  return new Request(`http://localhost:8787${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: webOrigin },
    body: JSON.stringify(body),
  })
}

function makeUpdate(update_id: number, chatId: string, text: string, senderChatId?: number, userId?: number) {
  return {
    update_id,
    message: {
      chat: { id: Number(chatId), type: 'supergroup' },
      message_id: 7,
      message_thread_id: 19,
      is_topic_message: true,
      text,
      from: senderChatId === undefined ? { id: userId } : { is_bot: true },
      ...(senderChatId === undefined ? {} : { sender_chat: { id: senderChatId } }),
    },
  }
}

async function pollBatch(
  updates: ReturnType<typeof makeUpdate>[],
  sendCard: (body: Record<string, unknown>) => Response,
  { jobs = new JobStore(), dispatcherIds }: { jobs?: JobStore; dispatcherIds?: ReadonlySet<string> } = {},
) {
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

  await pollTelegram(telegram, jobs, groupId, stop.signal, dispatcherIds)
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

test('limits dispatchers to listed users and anonymous admins when configured', async () => {
  let posts = 0
  const { jobs, offsets } = await pollBatch([
    makeUpdate(70, groupId, demoText, undefined, 1001),
    makeUpdate(71, groupId, demoText.replace('Central Station', 'Private Office'), undefined, 1002),
    makeUpdate(72, groupId, demoText.slice(5), undefined, 1001),
    makeUpdate(73, groupId, demoText.slice(5).replace('Central Station', 'Public Library'), Number(groupId)),
  ], () => {
    posts += 1
    return Response.json({ ok: true, result: { message_id: posts } })
  }, { dispatcherIds: new Set(['1001']) })

  assert.equal(posts, 2)
  assert.deepEqual(jobs.listOpen().map(job => job.pickup), ['Central Station', 'Public Library'])
  assert.deepEqual(offsets, [0, 74])
})

test('persists open and claimed jobs, Telegram cards, and the polling offset across restarts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kerbcue-state-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const dataFile = join(directory, 'data', 'kerbcue.json')
  const initial = new JobStore(dataFile)
  const first = newJob(details)
  const open = newJob({ ...details, pickup: 'Public Library' })
  initial.add(first, card)
  const claim = initial.claim(first.id, 'Alex')
  assert.equal(claim.status, 'claimed')
  initial.add(open)
  initial.setTelegramOffset(81)

  const restarted = new JobStore(dataFile)
  assert.deepEqual(restarted.listOpen(), [open])
  assert.deepEqual(restarted.claim(first.id, 'Alex'), { ...claim, status: 'already' })
  assert.equal(restarted.getTelegramOffset(), 81)

  let posts = 0
  const { offsets } = await pollBatch([
    makeUpdate(80, groupId, demoText),
    makeUpdate(81, groupId, demoText),
    makeUpdate(82, groupId, 'Hello dispatch'),
  ], () => {
    posts += 1
    return Response.json({ ok: true, result: { message_id: 84 } })
  }, { jobs: restarted })
  assert.deepEqual(offsets, [81, 83])
  assert.equal(posts, 1)

  const latest = new JobStore(dataFile)
  assert.equal(latest.getTelegramOffset(), 83)
  assert.deepEqual(latest.listOpen().map(job => job.pickup), ['Public Library', 'Central Station'])
  assert.deepEqual(latest.claim(first.id, 'Alex'), { ...claim, status: 'already' })
})

test('starts empty and logs once for a corrupt data file', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kerbcue-corrupt-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const dataFile = join(directory, 'kerbcue.json')
  writeFileSync(dataFile, '{"jobs":[{}],"telegramOffset":15}')
  const warning = t.mock.method(console, 'warn', () => {})
  const jobs = new JobStore(dataFile)

  assert.deepEqual(jobs.listOpen(), [])
  assert.equal(jobs.getTelegramOffset(), 0)
  assert.equal(warning.mock.callCount(), 1)
})

test('returns the existing claim to the same courier and rejects any other courier', async () => {
  const jobs = new JobStore()
  const job = newJob(details)
  jobs.add(job, card)
  let calls = 0
  const telegram = new TelegramClient('test-placeholder', async () => {
    calls += 1
    return Response.json({ ok: true, result: { message_id: 42 } })
  })
  const api = createApi({ jobs, telegram, courierName: 'Courier', publicOrigin: webOrigin, demo: false })
  const claimPath = `/jobs/${job.id}/claim`
  const first = await api(request(claimPath, { courierName: 'Alex' }))
  assert.equal(first.status, 200)
  const claimed = await first.json() as ClaimResponse
  assert.equal(claimed.telegramSynced, true)

  const repeat = await api(request(claimPath, { courierName: 'Alex' }))
  assert.equal(repeat.status, 200)
  assert.deepEqual(await repeat.json(), { job: claimed.job, telegramSynced: null })
  assert.equal((await api(request(claimPath, { courierName: 'Another courier' }))).status, 409)
  assert.equal(calls, 2)
})

test('retries the rate-limited claim notification once without repeating the other call', async t => {
  t.mock.method(console, 'error', () => {})
  const edits: unknown[] = []
  let replies = 0
  const telegram = new TelegramClient('test-placeholder', async (input, init) => {
    const outgoing = new Request(input, init)
    if (new URL(outgoing.url).pathname.endsWith('/editMessageText')) {
      edits.push(await outgoing.json())
      return Response.json({
        ok: false, error_code: 429, parameters: { retry_after: 0 },
      }, { status: 429 })
    }
    replies += 1
    return Response.json({ ok: true, result: { message_id: 43 } })
  })

  assert.equal(await telegram.syncClaim(card, claimedJob), false)
  assert.equal(edits.length, 2)
  assert.deepEqual(edits[0], edits[1])
  assert.equal(replies, 1)
})

test('retries claim notifications rejected with a Telegram server error', async () => {
  let edits = 0
  let replies = 0
  const telegram = new TelegramClient('test-placeholder', async input => {
    if (new URL(String(input)).pathname.endsWith('/sendMessage')) {
      replies += 1
      if (replies === 1) return new Response(null, { status: 503 })
    } else {
      edits += 1
    }
    return Response.json({ ok: true, result: { message_id: 43 } })
  })

  assert.equal(await telegram.syncClaim(card, claimedJob), true)
  assert.equal(edits, 1)
  assert.equal(replies, 2)
})

test('does not retry a claim reply when a network error leaves delivery uncertain', async t => {
  t.mock.method(console, 'error', () => {})
  let edits = 0
  let replies = 0
  const telegram = new TelegramClient('test-placeholder', async input => {
    if (new URL(String(input)).pathname.endsWith('/sendMessage')) {
      replies += 1
      throw new TypeError('Connection lost after sending the request')
    }
    edits += 1
    return Response.json({ ok: true, result: { message_id: 42 } })
  })

  assert.equal(await telegram.syncClaim(card, claimedJob), false)
  assert.equal(edits, 1)
  assert.equal(replies, 1)
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
  assert.match(preflight.headers.get('Access-Control-Allow-Headers') ?? '', /Content-Type/i)
  assert.equal((await api(request(claimPath, { courierName: '' }))).status, 400)

  const claimed = await api(request(claimPath, {}))
  assert.equal(claimed.status, 200)
  const response = await claimed.json() as ClaimResponse
  assert.equal(response.job.courierName, 'Demo Courier')
  assert.equal(response.telegramSynced, null)
  assert.equal((await api(request(claimPath, { courierName: 'Another courier' }))).status, 409)
})
