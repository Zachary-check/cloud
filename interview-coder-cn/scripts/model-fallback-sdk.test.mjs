/**
 * The failover depends on one assumption about the AI SDK: that a dead endpoint
 * either surfaces an error from the first read, or simply never answers — and
 * that cancelling an attempt actually releases the connection. Fakes cannot
 * prove that, so this runs the real SDK against three local endpoints.
 *
 * No credentials and no external network: everything is 127.0.0.1.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { streamWithFallback } from '../src/shared/model-fallback.ts'

/** Counts requests and connections closed before an answer was sent. */
function startServer(handler) {
  const state = { requests: 0, closedEarly: 0 }
  const server = createServer((req, res) => {
    state.requests += 1
    res.on('close', () => {
      if (!res.writableEnded) state.closedEarly += 1
    })
    handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ state, port: server.address().port, close: () => server.close() })
    })
  })
}

/** Accepts the request, then never answers — a hung provider. */
const hang = (req, res) => {
  req.resume()
  void res
}

/** Fails fast, the way an overloaded gateway does. */
const fail = (req, res) => {
  req.resume()
  res.writeHead(500, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'primary is down' } }))
}

/** A well-behaved OpenAI-compatible streaming endpoint. */
const answer = (req, res) => {
  req.resume()
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta) =>
    `data: ${JSON.stringify({
      id: 'chunk',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'stub',
      choices: [{ index: 0, delta, finish_reason: null }]
    })}\n\n`
  res.write(chunk({ role: 'assistant', content: '备用' }))
  res.write(chunk({ content: '回答' }))
  res.end('data: [DONE]\n\n')
}

function candidate(baseURL, model) {
  return { apiBaseURL: baseURL, apiKey: 'sk-test', model, isFallback: false }
}

function open(candidateRecord, signal) {
  const client = createOpenAI({
    baseURL: candidateRecord.apiBaseURL,
    apiKey: candidateRecord.apiKey
  })
  const { textStream } = streamText({
    model: client.chat(candidateRecord.model),
    messages: [{ role: 'user', content: '在吗' }],
    abortSignal: signal,
    // Mirrors main/ai.ts exactly. Both options matter: without onError the SDK
    // ends a failed stream silently with zero chunks, which would hide the very
    // failure this feature is meant to survive.
    maxRetries: 0,
    onError: (err) => {
      throw err.error ?? err
    }
  })
  return textStream
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('首选返回 5xx 时切到备用，并且真的拿到了备用的回答', async () => {
  const down = await startServer(fail)
  const up = await startServer(answer)
  try {
    const fallbacks = []
    const startedAt = Date.now()
    const chunks = await collect(
      streamWithFallback(
        [
          candidate(`http://127.0.0.1:${down.port}/v1`, 'dead'),
          candidate(`http://127.0.0.1:${up.port}/v1`, 'alive')
        ],
        {
          firstTokenTimeoutMs: 5000,
          open,
          onFallback: (taking, info) => fallbacks.push([taking.model, info.reason])
        }
      )
    )

    const elapsed = Date.now() - startedAt

    assert.deepEqual(chunks, ['备用', '回答'])
    assert.deepEqual(fallbacks, [['alive', 'error']])
    // With the SDK's own retries off, a 5xx must surface at once instead of
    // waiting out the retry backoff before the backup gets a turn.
    assert.equal(down.state.requests, 1, '不应自行重试已失败的端点')
    assert.ok(elapsed < 3000, `应快速切换，实际 ${elapsed}ms`)
    console.log(`[probe] 5xx 端点收到 ${down.state.requests} 次请求，切换耗时 ${elapsed}ms`)
  } finally {
    down.close()
    up.close()
  }
})

test('首选挂死不回包时按超时切换，并且连接被释放', async () => {
  const stuck = await startServer(hang)
  const up = await startServer(answer)
  try {
    const fallbacks = []
    const startedAt = Date.now()
    const chunks = await collect(
      streamWithFallback(
        [
          candidate(`http://127.0.0.1:${stuck.port}/v1`, 'stuck'),
          candidate(`http://127.0.0.1:${up.port}/v1`, 'alive')
        ],
        {
          firstTokenTimeoutMs: 1200,
          open,
          onFallback: (taking, info) => fallbacks.push([taking.model, info.reason])
        }
      )
    )
    const elapsed = Date.now() - startedAt

    assert.deepEqual(chunks, ['备用', '回答'])
    assert.deepEqual(fallbacks, [['alive', 'timeout']])
    assert.ok(elapsed >= 1200, `应至少等满超时时间，实际 ${elapsed}ms`)
    assert.ok(elapsed < 4000, `不应在超时后继续等，实际 ${elapsed}ms`)
    // Give the socket a moment to notice the abort.
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(stuck.state.closedEarly, 1, '超时后应断开首选请求的连接')
    console.log(`[probe] 挂死端点收到 ${stuck.state.requests} 次请求，切换耗时 ${elapsed}ms`)
  } finally {
    stuck.close()
    up.close()
  }
})

test('首选正常时不碰备用端点', async () => {
  const up = await startServer(answer)
  const spare = await startServer(answer)
  try {
    const chunks = await collect(
      streamWithFallback(
        [
          candidate(`http://127.0.0.1:${up.port}/v1`, 'alive'),
          candidate(`http://127.0.0.1:${spare.port}/v1`, 'spare')
        ],
        { firstTokenTimeoutMs: 5000, open }
      )
    )

    assert.deepEqual(chunks, ['备用', '回答'])
    assert.equal(up.state.requests, 1)
    assert.equal(spare.state.requests, 0, '备用端点不应被打扰')
  } finally {
    up.close()
    spare.close()
  }
})
