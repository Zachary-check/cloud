import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { turnStatusFor } from '../src/shared/interview-turn.ts'

// Exercise the actual orchestration with in-memory Electron/AI boundaries.
// No screenshots, credentials, network calls, or user settings are accessed.
const compiled = ts.transpileModule(
  readFileSync(new URL('../src/main/shortcuts.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText

function setup() {
  const events = []
  const requests = []
  const record = []
  const handlers = new Map()
  const settings = {
    workMode: 'interview',
    apiKey: 'test-only',
    interviewIncludeScreenshot: false
  }
  let turnSequence = 0
  let handleTranscript
  async function* stream(messages) {
    requests.push(JSON.parse(JSON.stringify(messages)))
    yield `回答${requests.length}`
  }
  const dependencies = {
    // Deterministic ids so the assertions can name the turn they expect.
    'node:crypto': { randomUUID: () => `turn-${(turnSequence += 1)}` },
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      globalShortcut: {},
      screen: {}
    },
    './main-window': {},
    './toolbar-window': {},
    './window-placement': {
      clampPositionToDisplays: (x, y) => ({ x, y }),
      ensureWindowOnScreen: (window) => window
    },
    './take-screenshot': {
      cancelPendingCapture: () => {},
      getCaptureError: () => undefined,
      takeScreenshot: async () => 'test-image',
      // shortcuts.ts downscales previews before sending them to the renderer
      toDisplayThumbnail: (data) => data
    },
    './save-screenshot': { saveScreenshotToDisk: () => {} },
    './ai': {
      getSolutionStream: stream,
      getGeneralStream: stream,
      getFollowUpStream: (messages, question) =>
        stream([...messages, { role: 'user', content: question }]),
      getInterviewKnowledgeSources: () => ['项目.md']
    },
    '../shared/dual-answer': {},
    '../shared/interview-turn': { turnStatusFor },
    './interview-record': {
      beginRecordedTurn: (id, kind, question) => record.push(['begin', id, kind, question]),
      appendRecordedAnswer: (id, chunk) => record.push(['chunk', id, chunk]),
      finishRecordedTurn: (id, answer, status) => record.push(['end', id, answer, status]),
      noteRecordSources: (sources) => record.push(['sources', ...sources]),
      recordSessionBreak: () => record.push(['break'])
    },
    './native-overlay': { nativeAnswerEvent: () => {} },
    './settings': { settings },
    './state': { state: { inCoderPage: true } },
    './transcription': {
      getTranscriptionText: () => '',
      clearTranscriptionText: () => {},
      setInterviewTriggerHandler: (handler) => (handleTranscript = handler)
    }
  }
  runInNewContext(compiled, {
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    exports: {},
    global: {
      mainWindow: {
        isDestroyed: () => false,
        webContents: { send: (channel, ...args) => events.push([channel, ...args]) }
      }
    },
    AbortController,
    console,
    // Scheduled work (background top-most guard, auto-resume after an answer) is
    // deliberately inert here: a timer firing mid-test would mutate state between
    // assertions. Those callbacks are covered where they are defined.
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {}
  })
  return { events, requests, record, handlers, settings, ask: (text) => handleTranscript(text) }
}

test('each interview question replaces the visible answer while retaining conversation context', async () => {
  const app = setup()
  await app.ask('介绍一下你的项目')
  app.events.length = 0
  await app.ask('刚才的项目怎么处理重试？')

  const channels = app.events.map(([channel]) => channel)
  assert.equal(channels.filter((channel) => channel === 'solution-clear').length, 1)
  assert.ok(channels.indexOf('solution-clear') < channels.indexOf('solution-chunk'))
  assert.deepEqual(
    app.events.filter(([channel]) => channel === 'solution-chunk'),
    [['solution-chunk', '回答2']]
  )
  assert.equal(app.requests[1].length, 3)
  assert.equal(app.requests[1][1].role, 'assistant')
  assert.equal(app.requests[1][1].content, '回答1')
  assert.match(app.requests[1][2].content[0].text, /刚才的项目/)
  assert.ok(channels.includes('knowledge-sources'))
  assert.ok(channels.includes('solution-complete'))
})

test('optional screenshots only show the latest question while prior images remain in context', async () => {
  const app = setup()
  app.settings.interviewIncludeScreenshot = true
  await app.ask('第一张截图的问题')
  app.events.length = 0
  await app.ask('第二张截图的问题')
  const gallery = app.events.find(([channel]) => channel === 'screenshots-updated')[1]
  assert.equal(gallery.length, 1)
  assert.equal(app.requests[1][0].content[1].type, 'image')
  assert.equal(app.requests[1][2].content[1].type, 'image')
})

test('manual interview follow-up replaces the answer; written follow-up retains append behavior', async () => {
  const app = setup()
  await app.ask('介绍一下线程池')
  app.events.length = 0
  await app.handlers.get('sendFollowUpQuestion')({}, '拒绝策略呢？')
  assert.equal(app.events[0][0], 'solution-clear')
  assert.ok(app.events.some(([channel]) => channel === 'ai-loading-start'))
  assert.equal(app.requests[1][1].content, '回答1')
  assert.deepEqual(
    app.events.filter(([channel]) => channel === 'solution-chunk'),
    [['solution-chunk', '回答2']]
  )

  app.settings.workMode = 'written'
  app.events.length = 0
  app.record.length = 0
  await app.handlers.get('sendFollowUpQuestion')({}, '继续解释')
  assert.ok(!app.events.some(([channel]) => channel === 'solution-clear'))
  assert.deepEqual(app.events[0], ['solution-chunk', '\n\n---\n\n'])
  // Written mode has no transcript on screen, so it must not grow the log.
  assert.deepEqual(
    app.record.filter(([event]) => event === 'begin' || event === 'end'),
    []
  )
})

test('every turn is written to the local Markdown record and closed with its answer', async () => {
  const app = setup()
  await app.ask('介绍一下你的项目')

  assert.deepEqual(
    app.record.filter(([event]) => event === 'begin'),
    [['begin', 'turn-1', 'question', '介绍一下你的项目']]
  )
  assert.deepEqual(
    app.record.filter(([event]) => event === 'end'),
    [['end', 'turn-1', '回答1', 'done']]
  )
  // The streamed text is mirrored into the open turn as it arrives, so a turn
  // the app closes mid-answer still keeps what the user had already read.
  assert.deepEqual(
    app.record.filter(([event]) => event === 'chunk'),
    [['chunk', 'turn-1', '回答1']]
  )
  // The knowledge base belongs to the turn that used it, whichever order the
  // two broadcasts happen in.
  assert.deepEqual(
    app.record.find(([event]) => event === 'sources'),
    ['sources', '项目.md']
  )
})

test('a manual follow-up is recorded as its own turn, not merged into the question', async () => {
  const app = setup()
  await app.ask('介绍一下线程池')
  app.record.length = 0
  await app.handlers.get('sendFollowUpQuestion')({}, '拒绝策略呢？')

  assert.deepEqual(
    app.record.filter(([event]) => event === 'begin'),
    [['begin', 'turn-2', 'followup', '拒绝策略呢？']]
  )
  assert.deepEqual(
    app.record.filter(([event]) => event === 'end'),
    [['end', 'turn-2', '回答2', 'done']]
  )
})
