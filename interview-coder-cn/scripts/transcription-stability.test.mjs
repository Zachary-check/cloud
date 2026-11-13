import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = process.env.INTERVIEW_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const ts = require('typescript')
const compile = (relative) =>
  ts.transpileModule(readFileSync(join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
const compiled = compile('src/main/transcription.ts')
const shared = { exports: {} }
runInNewContext(compile('src/shared/interview-trigger.ts'), { exports: shared.exports })

function setup(options = {}) {
  let now = 1_000_000
  const timers = new Map()
  const errors = []
  const messages = []
  const logs = []
  const handles = new Map()
  const listeners = new Map()
  const sockets = []
  function addTimer(callback, delay, interval = 0) {
    const timer = {
      callback,
      at: now + delay,
      interval,
      unref() {
        return undefined
      }
    }
    timers.set(timer, timer)
    return timer
  }
  function advance(ms) {
    const end = now + ms
    let steps = 0
    while (true) {
      const timer = [...timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!timer) break
      assert.ok(++steps < 100_000, 'Timer loop did not settle')
      now = timer.at
      if (timer.interval) timer.at += timer.interval
      else timers.delete(timer)
      try {
        timer.callback()
      } catch (error) {
        errors.push(error)
      }
    }
    now = end
  }
  class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readyState = 0
    bufferedAmount = 0
    frames = []
    sentAudioBytes = 0
    blocked = false
    constructor() {
      super()
      if (options.constructorFails) throw new Error('Injected socket initialization failure')
      sockets.push(this)
    }
    open() {
      this.readyState = 1
      this.emit('open')
    }
    message(event, payload = {}) {
      this.emit('message', Buffer.from(JSON.stringify({ header: { event }, payload })))
    }
    result(text, final = true) {
      this.message('result-generated', { output: { sentence: { text, sentence_end: final } } })
    }
    send(data) {
      if (this.readyState !== 1) throw new Error('Socket not open')
      if (typeof data === 'string') this.frames.push(JSON.parse(data))
      else {
        this.sentAudioBytes += data.length
        if (this.blocked) this.bufferedAmount += data.length
      }
    }
    close() {
      const connecting = this.readyState === 0
      this.readyState = 3
      // Mirrors ws abortHandshake: closing CONNECTING emits an asynchronous error.
      addTimer(() => {
        if (connecting)
          this.emit(
            'error',
            new Error('WebSocket was closed before the connection was established')
          )
        this.emit('close')
      }, 0)
    }
    terminate() {
      this.close()
    }
    disconnect() {
      this.readyState = 3
      this.emit('close')
    }
  }
  class ClockDate extends Date {
    static now() {
      return now
    }
  }
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (...args) => messages.push(args) }
  }
  const dependencies = {
    electron: {
      app: { getPath: () => 'unused-test-user-data' },
      ipcMain: {
        handle: (name, fn) => handles.set(name, fn),
        on: (name, fn) => listeners.set(name, fn)
      }
    },
    ws: FakeWebSocket,
    'node:fs': { appendFileSync: (_file, text) => logs.push(text) },
    'node:path': { join },
    'node:crypto': { randomUUID: () => `task-${sockets.length}` },
    '../shared/interview-trigger': shared.exports
  }
  const exports = {}
  runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, name)
      return dependencies[name]
    },
    Buffer,
    ArrayBuffer,
    Date: ClockDate,
    Promise,
    Error,
    global: { mainWindow },
    setTimeout: (fn, ms) => addTimer(fn, ms),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => addTimer(fn, ms, ms),
    clearInterval: (id) => timers.delete(id),
    console: {
      error() {
        return undefined
      },
      warn() {
        return undefined
      }
    }
  })
  const call = (name, ...args) => handles.get(name)(null, ...args)
  const start = () => {
    exports.setTranscriptionWorkMode('interview')
    assert.equal(call('start-transcription', 'offline-test-key'), true)
    return sockets.at(-1)
  }
  const audio = () => listeners.get('transcription-audio-chunk')(null, new ArrayBuffer(3200))
  return { exports, start, call, sockets, messages, timers, errors, advance, audio, logs }
}

const stopped = (h) => h.messages.some(([name]) => name === 'transcription-stopped')
const errored = (h) => h.messages.some(([name]) => name === 'transcription-error')

test('stopping during the WebSocket handshake never leaves an unhandled error', () => {
  const h = setup()
  h.start()
  h.call('stop-transcription')
  h.advance(1)
  assert.deepEqual(h.errors, [])
  assert.equal(h.timers.size, 0)
})

test('socket initialization failure releases startup state so a later attempt can start', () => {
  const options = { constructorFails: true }
  const h = setup(options)
  h.exports.setTranscriptionWorkMode('interview')
  assert.equal(h.call('start-transcription', 'synthetic-offline-key'), false)
  assert.ok(stopped(h) && errored(h))
  assert.equal(h.timers.size, 0)
  options.constructorFails = false
  assert.equal(h.call('start-transcription', 'synthetic-offline-key'), true)
  assert.equal(h.sockets.length, 1)
  h.call('stop-transcription')
  h.advance(1)
  assert.deepEqual(h.errors, [])
})

test('a task that never acknowledges startup cannot leave recognition frozen forever', () => {
  const h = setup()
  h.start().open()
  for (let i = 0; i < 20; i++) h.audio()
  h.advance(15_000)
  assert.ok(
    h.sockets.length > 1 || (stopped(h) && errored(h)),
    'Socket opened but ASR task never started; UI still claims recognition is running'
  )
  h.call('stop-transcription')
  h.advance(1)
  assert.deepEqual(h.errors, [])
})

test('a transient network error recovers without requiring a mid-interview manual restart', () => {
  const h = setup()
  const socket = h.start()
  socket.open()
  socket.message('task-started')
  socket.emit('error', new Error('ECONNRESET'))
  h.advance(2000)
  assert.ok(h.sockets.length > 1, 'Transient transport error permanently stopped recognition')
  assert.equal(stopped(h), false)
  h.call('stop-transcription')
  h.advance(1)
  assert.deepEqual(h.errors, [])
})

test('an unexpected task finish recovers instead of silently ending interview audio', () => {
  const h = setup()
  const socket = h.start()
  socket.open()
  socket.message('task-started')
  socket.message('task-finished')
  h.advance(2000)
  assert.ok(h.sockets.length > 1, 'Server ended the task; interview audio remained stopped')
  h.call('stop-transcription')
  h.advance(1)
  assert.deepEqual(h.errors, [])
})

test('a blocked audio connection cannot accumulate an unbounded send queue', () => {
  const h = setup()
  const socket = h.start()
  socket.open()
  socket.message('task-started')
  socket.blocked = true
  // Five minutes of 16kHz mono PCM; the fake stores a byte counter, not audio.
  for (let i = 0; i < 3000; i++) h.audio()
  h.advance(2000)
  assert.ok(
    socket.bufferedAmount <= 1_048_576,
    `Queued ${socket.bufferedAmount} bytes on a blocked socket`
  )
  assert.ok(h.sockets.length > 1 || (stopped(h) && errored(h)))
  h.call('stop-transcription')
  h.advance(1)
  assert.deepEqual(h.errors, [])
})

test('bad credentials fail visibly and never enter an automatic retry loop', () => {
  const h = setup()
  const socket = h.start()
  socket.open()
  socket.message('task-failed')
  h.advance(60_000)
  assert.equal(h.sockets.length, 1)
  assert.ok(stopped(h) && errored(h))
  assert.equal(h.timers.size, 0)
  assert.deepEqual(h.errors, [])
})

test('repeated connection failures exhaust a bounded budget and release all timers', () => {
  const h = setup()
  h.start()
  for (let i = 0; i < 8; i++) {
    const socket = h.sockets.at(-1)
    if (socket.readyState === 3) break
    socket.open()
    socket.message('task-started')
    socket.disconnect()
    h.advance(2000)
  }
  assert.equal(h.sockets.length, 6)
  assert.ok(stopped(h) && errored(h))
  assert.equal(h.timers.size, 0)
  assert.deepEqual(h.errors, [])
})

test('90 simulated minutes keep recognition alive and submit 180 questions once each', async () => {
  const h = setup()
  const answers = []
  h.exports.setInterviewTriggerMuteMs(0)
  h.exports.setInterviewTriggerHandler((text) => answers.push(text))
  const socket = h.start()
  socket.open()
  socket.message('task-started')
  for (let turn = 0; turn < 180; turn++) {
    for (let packet = 0; packet < 300; packet++) h.audio()
    socket.result(`请解释离线测试问题 ${turn} 的处理过程`)
    socket.result(`请解释离线测试问题 ${turn} 的处理过程`)
    h.advance(30_000)
    await Promise.resolve()
  }
  assert.equal(answers.length, 180)
  assert.equal(new Set(answers).size, 180)
  assert.equal(socket.sentAudioBytes, 172_800_000)
  assert.equal(h.sockets.length, 1)
  assert.equal(stopped(h), false)
  assert.deepEqual(h.errors, [])
  h.call('stop-transcription')
  h.advance(1)
  assert.equal(h.timers.size, 0)
})

test('manual stop cancels a pending reconnect and never reopens the microphone session', () => {
  const h = setup()
  const socket = h.start()
  socket.open()
  socket.message('task-started')
  socket.disconnect()
  h.call('stop-transcription')
  h.advance(60_000)
  assert.equal(h.sockets.length, 1)
  assert.equal(h.timers.size, 0)
  assert.deepEqual(h.errors, [])
})

test('an unavailable endpoint exhausts retries instead of keeping startup timers alive', () => {
  const h = setup()
  h.start()
  h.advance(70_000)
  assert.equal(h.sockets.length, 6)
  assert.ok(stopped(h) && errored(h))
  assert.equal(h.timers.size, 0)
  assert.deepEqual(h.errors, [])
})

test('pre-start audio remains bounded and recognition resumes after the acknowledgement', () => {
  const h = setup()
  const socket = h.start()
  socket.open()
  for (let i = 0; i < 1000; i++) h.audio()
  assert.equal(socket.sentAudioBytes, 0)
  socket.message('task-started')
  assert.equal(socket.sentAudioBytes, 20 * 3200)
  h.audio()
  assert.equal(socket.sentAudioBytes, 21 * 3200)
  h.call('stop-transcription')
  h.advance(1)
  assert.equal(h.timers.size, 0)
})

test('a synchronous answer failure is reported instead of escaping a trigger timer', async () => {
  const h = setup()
  h.exports.setInterviewTriggerHandler(() => {
    throw new Error('Offline injected answer failure')
  })
  const socket = h.start()
  socket.open()
  socket.message('task-started')
  socket.result('请解释离线测试问题的处理过程')
  h.advance(5000)
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(h.errors, [])
  assert.ok(h.messages.some(([name]) => name === 'solution-error'))
  h.call('stop-transcription')
  h.advance(1)
})
