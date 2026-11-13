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
const noop = () => undefined
const compile = (file) =>
  ts.transpileModule(readFileSync(join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText

function setup() {
  let now = 100_000
  const timers = new Map()
  const windows = []
  const handles = new Map()
  const hotkeys = new Map()
  let cursor = { x: 1900, y: 1100 }
  class FakeWindow extends EventEmitter {
    visible = false
    topmost = true
    bounds = { x: 200, y: 200, width: 900, height: 670 }
    nativeTopmostCalls = 0
    moveTopCalls = 0
    opacity = 1
    sent = []
    webContents = { send: (...args) => this.sent.push(args) }
    constructor() {
      super()
      windows.push(this)
    }
    isDestroyed() {
      return false
    }
    isVisible() {
      return this.visible
    }
    isAlwaysOnTop() {
      return this.topmost
    }
    setAlwaysOnTop(value) {
      this.nativeTopmostCalls++
      this.topmost = value
    }
    moveTop() {
      this.moveTopCalls++
    }
    setBounds(bounds) {
      this.bounds = bounds
    }
    getBounds() {
      return this.bounds
    }
    getPosition() {
      return [this.bounds.x, this.bounds.y]
    }
    setPosition(x, y) {
      this.bounds.x = x
      this.bounds.y = y
    }
    setOpacity(value) {
      this.opacity = value
    }
    setIgnoreMouseEvents(value) {
      this.ignoreMouse = value
    }
    setMenuBarVisibility() {
      return undefined
    }
    setVisibleOnAllWorkspaces() {
      return undefined
    }
    setContentProtection() {
      return undefined
    }
    loadFile() {
      return undefined
    }
    showInactive() {
      this.visible = true
      this.emit('show')
    }
    hide() {
      this.visible = false
      this.emit('hide')
    }
  }
  class ClockDate extends Date {
    static now() {
      return now
    }
  }
  const addTimer = (fn, ms, repeat = 0) => {
    const id = { fn, at: now + ms, repeat }
    timers.set(id, id)
    return id
  }
  const mainWindow = new FakeWindow()
  const screen = {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 2000, height: 1200 } }),
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 2000, height: 1200 } }],
    getCursorScreenPoint: () => cursor
  }
  function load(file, dependencies) {
    const exports = {}
    runInNewContext(compile(file), {
      exports,
      require: (name) => {
        assert.ok(name in dependencies, name)
        return dependencies[name]
      },
      global: { mainWindow },
      process: { platform: 'win32', env: {} },
      __dirname: 'offline-test',
      Date: ClockDate,
      setInterval: (fn, ms) => addTimer(fn, ms, ms),
      clearInterval: (id) => timers.delete(id),
      setTimeout: (fn, ms) => addTimer(fn, ms),
      clearTimeout: (id) => timers.delete(id)
    })
    return exports
  }
  const toolbar = load('src/main/toolbar-window.ts', {
    electron: { BrowserWindow: FakeWindow, screen },
    'node:path': { join },
    '@electron-toolkit/utils': { is: { dev: false } },
    '../shared/toolbar-layout': load('src/shared/toolbar-layout.ts', {})
  })
  toolbar.createToolbarWindow(mainWindow)
  toolbar.setToolbarWanted(true)
  const bar = windows[1]
  load('src/main/shortcuts.ts', {
    electron: {
      globalShortcut: {
        register: (key, fn) => {
          hotkeys.set(key, fn)
          return true
        }
      },
      ipcMain: { handle: (name, fn) => handles.set(name, fn) },
      screen
    },
    'node:crypto': { randomUUID: () => 'unused' },
    './main-window': { applyContentProtection: noop },
    './toolbar-window': toolbar,
    './window-placement': {
      ensureWindowOnScreen: noop,
      clampPositionToDisplays: (x, y) => ({ x, y })
    },
    './take-screenshot': { cancelPendingCapture: () => {}, getCaptureError: () => undefined },
    './save-screenshot': {},
    './ai': {},
    '../shared/dual-answer': {},
    '../shared/interview-turn': {},
    './interview-record': {},
    './state': { state: { inCoderPage: true, ignoreMouse: true } },
    './native-overlay': { nativeAnswerEvent: () => {} },
    './settings': { settings: {} },
    './transcription': { setInterviewTriggerHandler: noop }
  })
  handles.get('initShortcuts')(null, { hideOrShowMainWindow: { key: 'Control+H' } })
  const advance = (ms) => {
    const end = now + ms
    for (;;) {
      const timer = [...timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!timer) break
      now = timer.at
      if (timer.repeat) timer.at += timer.repeat
      else timers.delete(timer)
      timer.fn()
    }
    now = end
  }
  return {
    mainWindow,
    bar,
    toolbar,
    advance,
    toggle: () => hotkeys.get('Control+H')(),
    moveCursor: (point) => {
      cursor = point
    }
  }
}

test('idle guards never restack windows that are already always-on-top', async () => {
  const h = setup()
  await h.toggle()
  const mainCalls = h.mainWindow.nativeTopmostCalls
  const barCalls = h.bar.nativeTopmostCalls
  const mainMoves = h.mainWindow.moveTopCalls
  const barMoves = h.bar.moveTopCalls
  h.advance(60_000)
  assert.equal(
    h.mainWindow.nativeTopmostCalls,
    mainCalls,
    'Idle guard kept rewriting main window stacking'
  )
  assert.equal(h.bar.nativeTopmostCalls, barCalls, 'Idle guard kept rewriting toolbar stacking')
  assert.equal(
    h.mainWindow.moveTopCalls,
    mainMoves,
    'A timer kept forcing the main window above other windows'
  )
  assert.equal(h.bar.moveTopCalls, barMoves)
})

test('guards still recover a lost topmost flag for either visible window', async () => {
  const h = setup()
  await h.toggle()
  h.advance(10_000)
  h.mainWindow.topmost = false
  h.bar.topmost = false
  const mainCalls = h.mainWindow.nativeTopmostCalls
  const barCalls = h.bar.nativeTopmostCalls
  h.advance(2100)
  assert.equal(h.mainWindow.topmost, true)
  assert.equal(h.bar.topmost, true)
  assert.equal(h.mainWindow.nativeTopmostCalls, mainCalls + 1)
  assert.equal(h.bar.nativeTopmostCalls, barCalls + 1)
})

test('hidden toolbar is never raised by a background guard', async () => {
  const h = setup()
  await h.toggle()
  h.toolbar.hideToolbar()
  const calls = h.bar.nativeTopmostCalls
  h.advance(20_000)
  assert.equal(h.bar.nativeTopmostCalls, calls)
  assert.equal(h.bar.visible, false)
})

test('explicit hide and restore still preserve their intended opacity', async () => {
  const h = setup()
  await h.toggle()
  await h.toggle()
  assert.equal(h.mainWindow.opacity, 0)
  assert.equal(h.bar.visible, false)
  await h.toggle()
  assert.equal(h.mainWindow.opacity, 1)
  assert.equal(h.bar.visible, true)
})

test('dual toolbar becomes compact and returns to full width on mode changes without growing', async () => {
  const h = setup()
  await h.toggle()
  for (let round = 0; round < 20; round++) {
    h.toolbar.syncToolbarSettings(500, 'dual')
    assert.equal(h.bar.bounds.width, 134)
    assert.equal(h.bar.visible, true)
    h.toolbar.syncToolbarSettings(500, 'written')
    assert.equal(h.bar.bounds.width, 404)
  }
})

test('compact toolbar still publishes OS hover samples while native mouse input is ignored', async () => {
  const h = setup()
  await h.toggle()
  h.toolbar.syncToolbarSettings(500, 'dual')
  assert.equal(h.bar.ignoreMouse, true)
  h.moveCursor({ x: h.bar.bounds.x + 20, y: h.bar.bounds.y + 20 })
  h.advance(100)
  const sample = h.bar.sent.filter(([name]) => name === 'toolbar-cursor').at(-1)[1]
  assert.equal(sample.x, 20)
  assert.equal(sample.y, 20)
  h.moveCursor({ x: h.bar.bounds.x + 140, y: h.bar.bounds.y + 20 })
  h.advance(100)
  assert.equal(h.bar.sent.filter(([name]) => name === 'toolbar-cursor').at(-1)[1], null)
})
