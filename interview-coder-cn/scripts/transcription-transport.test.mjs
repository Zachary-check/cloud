import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = process.env.INTERVIEW_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const ts = require('typescript')
const WebSocket = require('ws')
const compiled = (path) =>
  ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
const source = compiled('src/main/transcription.ts')
const trigger = { exports: {} }
runInNewContext(compiled('src/shared/interview-trigger.ts'), { exports: trigger.exports })
const noop = () => undefined

async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('Offline transport did not reach the expected state within 2 seconds')
}

async function setup(onTask) {
  const server = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  const url = `ws://127.0.0.1:${server.address().port}`
  const clients = []
  let connections = 0
  let audioBytes = 0
  server.on('connection', (socket) => {
    const number = ++connections
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        audioBytes += data.length
        return
      }
      const request = JSON.parse(data.toString())
      if (request.header.action === 'run-task') onTask(socket, request, number)
    })
  })
  class LocalClient extends WebSocket {
    constructor() {
      super(url)
      clients.push(this)
    }
    emit(name, ...args) {
      if (name === 'error' && this.listenerCount('error') === 0) {
        unhandled.push(args[0])
        return false
      }
      return super.emit(name, ...args)
    }
  }
  const handles = new Map()
  const listeners = new Map()
  const messages = []
  const unhandled = []
  const dependencies = {
    electron: {
      app: { getPath: () => 'unused-test-user-data' },
      ipcMain: {
        handle: (name, fn) => handles.set(name, fn),
        on: (name, fn) => listeners.set(name, fn)
      }
    },
    ws: LocalClient,
    'node:fs': { appendFileSync: noop },
    'node:path': { join },
    'node:crypto': { randomUUID },
    '../shared/interview-trigger': trigger.exports
  }
  const exports = {}
  runInNewContext(source, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, name)
      return dependencies[name]
    },
    Buffer,
    ArrayBuffer,
    Promise,
    Error,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    global: {
      mainWindow: {
        isDestroyed: () => false,
        webContents: { send: (...args) => messages.push(args) }
      }
    },
    console: { warn: noop, error: noop }
  })
  const call = (name, ...args) => handles.get(name)(null, ...args)
  exports.setTranscriptionWorkMode('interview')
  const close = async () => {
    call('stop-transcription')
    for (const socket of server.clients) socket.terminate()
    await new Promise((resolve) => server.close(resolve))
    await delay(20)
  }
  return {
    start: () => call('start-transcription', 'synthetic-offline-key'),
    close,
    clients,
    messages,
    unhandled,
    audio: () => listeners.get('transcription-audio-chunk')(null, new ArrayBuffer(3200)),
    stats: () => ({ connections, audioBytes })
  }
}

const acknowledge = (socket, request) =>
  socket.send(
    JSON.stringify({ header: { event: 'task-started', task_id: request.header.task_id } })
  )

test('real ws reconnects after a dropped connection and delivers synthetic PCM again', async () => {
  const h = await setup((socket, request, number) => {
    acknowledge(socket, request)
    if (number === 1) setTimeout(() => socket.terminate(), 20)
  })
  try {
    assert.equal(h.start(), true)
    await waitFor(() => h.stats().connections === 2)
    for (let i = 0; i < 10; i++) {
      h.audio()
      await delay(10)
    }
    await waitFor(() => h.stats().audioBytes > 0)
    assert.equal(
      h.messages.some(([name]) => name === 'transcription-stopped'),
      false
    )
    assert.deepEqual(h.unhandled, [])
  } finally {
    await h.close()
  }
})

test('real ws handshake cancellation has an error listener until shutdown finishes', async () => {
  const h = await setup(acknowledge)
  h.start()
  await h.close()
  assert.deepEqual(h.unhandled, [])
  assert.ok(h.clients.every((socket) => socket.readyState === WebSocket.CLOSED))
})

test('real ws reports an authentication failure once without repeated requests', async () => {
  const h = await setup((socket) =>
    socket.send(
      JSON.stringify({
        header: { event: 'task-failed', error_message: 'Offline authentication failure' }
      })
    )
  )
  try {
    h.start()
    await waitFor(() => h.messages.some(([name]) => name === 'transcription-stopped'))
    await delay(700)
    assert.equal(h.stats().connections, 1)
    assert.equal(h.messages.filter(([name]) => name === 'transcription-error').length, 1)
    assert.deepEqual(h.unhandled, [])
  } finally {
    await h.close()
  }
})
