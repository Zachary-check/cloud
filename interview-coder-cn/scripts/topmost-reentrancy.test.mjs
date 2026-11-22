import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

test('a synchronous refusal of always-on-top cannot recurse into a renderer crash', () => {
  const source = ts.createSourceFile(
    'main-window.ts',
    readFileSync(new URL('../src/main/main-window.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const create = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'createWindow'
  )
  let calls = 0
  class FakeWindow extends EventEmitter {
    static instances = []
    constructor() {
      super()
      FakeWindow.instances.push(this)
    }
    webContents = {
      setWindowOpenHandler() {
        return undefined
      }
    }
    setMenuBarVisibility() {
      return undefined
    }
    loadFile() {
      return undefined
    }
    show() {
      return undefined
    }
    setAlwaysOnTop() {
      calls++
      this.emit('always-on-top-changed', {}, false)
    }
    setVisibleOnAllWorkspaces() {
      return undefined
    }
    setContentProtection() {
      return undefined
    }
    isVisible() {
      return true
    }
    isDestroyed() {
      return false
    }
  }
  const exports = {}
  const code = ts.transpileModule(create.getText(source), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(code, {
    exports,
    BrowserWindow: FakeWindow,
    global: {},
    process: { platform: 'win32', env: {} },
    join: () => '',
    __dirname: '',
    createToolbarWindow() {
      return undefined
    },
    installRecordClosePrompt() {
      return undefined
    },
    applyContentProtection() {
      return undefined
    },
    is: { dev: false }
  })
  exports.createWindow()
  const window = FakeWindow.instances[0]
  window.emit('ready-to-show')
  calls = 0
  window.emit('always-on-top-changed', {}, false)
  assert.equal(calls, 1)
})
