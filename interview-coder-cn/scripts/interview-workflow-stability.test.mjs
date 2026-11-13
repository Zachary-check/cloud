import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
const noop = () => undefined
function load(relative, dependencies) {
  const exports = {}
  runInNewContext(compile(relative), {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, name)
      return dependencies[name]
    },
    Buffer,
    Error,
    AbortController,
    console: { error: noop, warn: noop },
    process: { platform: 'win32' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    global: dependencies.global
  })
  return exports
}

function setup(open) {
  const messages = []
  const files = new Map()
  const controls = { diskFull: false }
  const fs = {
    mkdir: async () => undefined,
    readdir: async () => [],
    stat: async (path) => {
      if (!files.has(path)) throw new Error('ENOENT')
      return {}
    },
    appendFile: async (path, content) => {
      if (controls.diskFull) throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' })
      files.set(path, (files.get(path) || '') + content)
    }
  }
  const recordFormat = load('src/shared/interview-record.ts', {})
  const record = load('src/main/interview-record.ts', {
    electron: { app: { getPath: () => 'offline-test-records' } },
    'node:fs/promises': fs,
    'node:path': { join },
    '../shared/interview-record': recordFormat
  })
  const handles = new Map()
  let interviewHandler
  let loading = false
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (...args) => {
        messages.push(args)
        if (args[0] === 'ai-loading-start') loading = true
        if (args[0] === 'ai-loading-end') loading = false
      }
    }
  }
  const settings = {
    workMode: 'interview',
    apiKey: 'synthetic-offline-key',
    interviewIncludeScreenshot: false
  }
  const state = { inCoderPage: true }
  const toolbar = Object.fromEntries(
    [
      'showToolbar',
      'hideToolbar',
      'setToolbarWanted',
      'reassertToolbarTopMost',
      'suspendCursorTracking',
      'resumeCursorTracking'
    ].map((name) => [name, noop])
  )
  toolbar.isToolbarAvailable = () => true
  load('src/main/shortcuts.ts', {
    'node:crypto': { randomUUID },
    electron: {
      globalShortcut: {},
      ipcMain: { handle: (name, fn) => handles.set(name, fn) },
      screen: {}
    },
    './main-window': { applyContentProtection: noop },
    './toolbar-window': toolbar,
    './window-placement': {},
    './take-screenshot': {
      cancelPendingCapture: () => {},
      getCaptureError: () => undefined,
      takeScreenshot: async () => undefined
    },
    './save-screenshot': { saveScreenshotToDisk: noop },
    './ai': {
      getGeneralStream: open,
      getFollowUpStream: (history, _question, signal) => open(history, signal),
      getInterviewKnowledgeSources: () => []
    },
    '../shared/dual-answer': load('src/shared/dual-answer.ts', {}),
    '../shared/interview-turn': load('src/shared/interview-turn.ts', {}),
    './interview-record': record,
    './native-overlay': { nativeAnswerEvent: () => {} },
    './settings': { settings },
    './state': { state },
    './transcription': {
      getTranscriptionText: () => '',
      clearTranscriptionText: noop,
      setInterviewTriggerHandler: (fn) => {
        interviewHandler = fn
      }
    },
    global: { mainWindow }
  })
  return {
    ask: (question) => interviewHandler(question),
    call: (name, ...args) => handles.get(name)(null, ...args),
    messages,
    files,
    controls,
    record,
    loading: () => loading
  }
}

test('180 sequential interview answers finish and persist without leaving a loading state', async () => {
  const h = setup(async function* () {
    yield '离线测试回答'
    yield '继续回答'
  })
  for (let i = 0; i < 180; i++) await h.ask(`离线测试提问 ${i}`)
  await h.record.finalizeInterviewRecord()
  assert.equal(h.loading(), false)
  assert.equal(h.messages.filter(([name]) => name === 'solution-complete').length, 180)
  assert.equal(h.messages.filter(([name]) => name === 'solution-error').length, 0)
  const text = [...h.files.values()].join('')
  assert.equal((text.match(/离线测试回答继续回答/g) || []).length, 180)
})

test('a failure halfway through an answer preserves partial text and the next question still works', async () => {
  let attempt = 0
  const h = setup(async function* () {
    yield '已收到的部分'
    if (++attempt === 1) throw new Error('Injected stream disconnect')
    yield '后续正常回答'
  })
  await h.ask('第一次提问')
  assert.equal(h.loading(), false)
  const firstEnd = h.messages.find(([name]) => name === 'interview-turn-end')[1]
  assert.equal(firstEnd.status, 'error')
  assert.equal(firstEnd.answer, '已收到的部分')
  await h.ask('第二次提问')
  assert.equal(h.loading(), false)
  assert.equal(h.messages.filter(([name]) => name === 'solution-complete').length, 1)
  await h.record.finalizeInterviewRecord()
  assert.ok([...h.files.values()].join('').includes('后续正常回答'))
})

function waitForAbort(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', resolve, { once: true })
  })
}

test('a new question interrupts a pending answer and receives its own completed turn', async () => {
  let attempt = 0
  const h = setup(async function* (_history, signal) {
    if (++attempt === 1) {
      yield '旧答案'
      await waitForAbort(signal)
      return
    }
    yield '新答案'
  })
  const first = h.ask('旧问题')
  await Promise.resolve()
  await Promise.resolve()
  await h.ask('新问题')
  await first
  const ended = h.messages.filter(([name]) => name === 'interview-turn-end').map(([, turn]) => turn)
  assert.equal(ended.length, 2)
  assert.ok(ended.some((turn) => turn.status === 'stopped'))
  assert.ok(ended.some((turn) => turn.status === 'done' && turn.answer === '新答案'))
  assert.equal(h.loading(), false)
  await h.record.finalizeInterviewRecord()
})

test('manual cancellation releases a pending answer and a later question can complete', async () => {
  let attempt = 0
  const h = setup(async function* (_history, signal) {
    if (++attempt === 1) {
      yield '部分答案'
      await waitForAbort(signal)
      return
    }
    yield '恢复回答'
  })
  const first = h.ask('离线取消测试')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.call('stopSolutionStream'), true)
  await first
  assert.equal(h.loading(), false)
  await h.ask('取消后的新问题')
  assert.ok(h.messages.some(([name]) => name === 'solution-complete'))
  await h.record.finalizeInterviewRecord()
})

test('disk full cannot abort a live answer or poison later record writes', async () => {
  const h = setup(async function* () {
    yield '离线磁盘故障测试回答'
  })
  h.controls.diskFull = true
  await h.ask('磁盘已满时的提问')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.loading(), false)
  assert.ok(h.messages.some(([name]) => name === 'solution-complete'))
  h.controls.diskFull = false
  await h.ask('磁盘恢复后的提问')
  await h.record.finalizeInterviewRecord()
  assert.ok([...h.files.values()].join('').includes('磁盘恢复后的提问'))
})

test('manual follow-up errors end the loading state and do not prevent further questions', async () => {
  let attempt = 0
  const h = setup(async function* () {
    if (++attempt === 2) throw new Error('Injected follow-up failure')
    yield '正常离线回答'
  })
  await h.ask('初始提问')
  await h.call('sendFollowUpQuestion', '手动追问')
  assert.equal(h.loading(), false)
  assert.ok(h.messages.some(([name]) => name === 'solution-error'))
  await h.ask('后续正常提问')
  assert.equal(h.messages.filter(([name]) => name === 'solution-complete').length, 2)
  await h.record.finalizeInterviewRecord()
})
