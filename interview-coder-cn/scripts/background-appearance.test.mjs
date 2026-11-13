import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function setup() {
  const children = [],
    commands = [],
    answers = [],
    toolbar = [],
    timeouts = new Map()
  let handler, tick, quit
  let toolbarTheme = 'light'
  const settings = { textOnlyAnswers: true }
  const webContents = { send: (_name, value) => answers.push(value) }
  const window = {
    webContents,
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => ({ x: 100, y: 200, width: 900, height: 670 })
  }
  class Child extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), {
      write: (line) => {
        commands.push(line)
        return true
      }
    })
    kill() {
      this.killed = true
      this.emit('close')
    }
    reply(theme) {
      this.stdout.emit('data', JSON.stringify({ ok: true, theme }) + '\n')
    }
  }
  const dependencies = {
    'node:child_process': {
      spawn: () => {
        const child = new Child()
        children.push(child)
        return child
      }
    },
    'node:fs': { existsSync: () => true },
    electron: {
      app: {
        on: (_event, callback) => {
          quit = callback
        }
      },
      ipcMain: {
        handle: (_name, callback) => {
          handler = callback
        }
      },
      screen: {
        dipToScreenRect: (_window, r) => ({
          x: r.x * 2,
          y: r.y * 2,
          width: r.width * 2,
          height: r.height * 2
        })
      }
    },
    './native-overlay': { nativeExecutable: () => '/app/helper.exe' },
    './capture/native-environment': { nativeEnvironment: () => ({}) },
    './settings': { settings },
    './state': { state: { inCoderPage: true } },
    './toolbar-window': {
      getToolbarBackgroundTheme: () => toolbarTheme,
      syncToolbarBackgroundTheme: (theme) => {
        toolbarTheme = theme
        toolbar.push(theme)
      },
      getToolbarSampleRegion: () => ({ x: 200, y: 304, width: 808, height: 88 })
    }
  }
  const exports = {}
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../src/main/background-appearance.ts', import.meta.url), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
    ).outputText,
    {
      exports,
      require: (name) => {
        assert.ok(name in dependencies, name)
        return dependencies[name]
      },
      global: { mainWindow: window },
      process: { platform: 'win32' },
      setInterval: (fn) => {
        tick = fn
        return { unref: () => undefined }
      },
      clearInterval: () => undefined,
      setTimeout: (fn) => {
        const id = {}
        timeouts.set(id, fn)
        return id
      },
      clearTimeout: (id) => timeouts.delete(id)
    }
  )
  exports.initBackgroundAppearance()
  return {
    children,
    commands,
    answers,
    toolbar,
    timeouts,
    settings,
    read: (main = true) => handler({ sender: main ? webContents : {} }),
    tick: () => tick(),
    quit: () => quit()
  }
}

test('answer and toolbar use separate physical regions and independent cached colours', () => {
  const h = setup()
  assert.equal(h.read(), 'light')
  assert.equal(h.commands[0], '200 480 1800 1180\n')
  for (let i = 0; i < 20; i++) h.tick()
  assert.equal(h.commands.length, 1, 'at most one sampler request may be outstanding')
  h.children[0].reply('dark')
  assert.deepEqual(h.answers, ['dark'])
  assert.equal(h.commands[1], '200 304 808 88\n')
  h.children[0].reply('light')
  assert.deepEqual(h.toolbar, ['light'])
  assert.equal(h.read(), 'dark')
  assert.equal(h.read(false), 'light')
  h.settings.textOnlyAnswers = false
  h.tick()
  const before = h.answers.length
  h.children[0].reply('light')
  assert.equal(h.answers.length, before, 'a stopped sampler cannot overwrite current colours')
  assert.equal(h.timeouts.size, 0)
  h.quit()
})

test('a stalled sampler is terminated and retries are bounded', () => {
  const h = setup()
  h.read()
  const timeout = [...h.timeouts.values()][0]
  timeout()
  assert.equal(h.children[0].killed, true)
  for (let i = 0; i < 20; i++) h.tick()
  assert.equal(h.children.length, 1)
  assert.equal(h.timeouts.size, 0)
  h.quit()
})
