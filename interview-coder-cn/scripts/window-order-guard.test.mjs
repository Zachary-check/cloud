import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function setup(platform = 'win32') {
  const children = [],
    writes = [],
    timeouts = new Map()
  let tick,
    quit,
    repairs = 0,
    now = 10000,
    handle = 123n,
    toolbarHandle = '456'
  let visible = true
  const target = {
    isDestroyed: () => false,
    isVisible: () => visible,
    getNativeWindowHandle: () => {
      const buffer = Buffer.alloc(8)
      buffer.writeBigUInt64LE(handle)
      return buffer
    }
  }
  class Child extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), {
      write: (line) => {
        writes.push(line)
        return true
      }
    })
    kill() {
      this.killed = true
      this.emit('close')
    }
    reply(value) {
      this.stdout.emit('data', JSON.stringify(value) + '\n')
    }
  }
  const dependencies = {
    'node:child_process': {
      spawn: (_file, args, options) => {
        assert.deepEqual(Array.from(args), ['--watch-window-order'])
        assert.equal(options.windowsHide, true)
        assert.equal(options.env.API_KEY, undefined)
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
      }
    },
    './capture/native-environment': { nativeEnvironment: () => ({ SystemRoot: 'C:/Windows' }) },
    './native-overlay': { nativeExecutable: () => '/app/helper.exe' },
    './toolbar-window': { getToolbarNativeHandle: () => toolbarHandle }
  }
  const exports = {}
  class Clock extends Date {
    static now() {
      return now
    }
  }
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../src/main/window-order-guard.ts', import.meta.url), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
    ).outputText,
    {
      exports,
      require: (name) => {
        assert.ok(name in dependencies, name)
        return dependencies[name]
      },
      process: { platform },
      Date: Clock,
      setInterval: (callback) => {
        tick = callback
        return { unref: () => undefined }
      },
      clearInterval: () => {
        tick = undefined
      },
      setTimeout: (callback) => {
        const id = {}
        timeouts.set(id, callback)
        return id
      },
      clearTimeout: (id) => timeouts.delete(id)
    }
  )
  exports.initWindowOrderGuard(
    () => (visible ? target : null),
    () => {
      repairs++
    }
  )
  return {
    children,
    writes,
    timeouts,
    tick: () => tick?.(),
    quit: () => quit?.(),
    advance: (ms) => {
      now += ms
    },
    repairs: () => repairs,
    show: (value) => {
      visible = value
    },
    replaceWindow: () => {
      handle = 789n
    },
    hideToolbar: () => {
      toolbarHandle = null
    }
  }
}

test('normal ordering is read without restacking and outstanding observations stay bounded', () => {
  const h = setup()
  h.tick()
  for (let i = 0; i < 100; i++) h.tick()
  assert.deepEqual(h.writes, ['123 456 auto\n'])
  assert.equal(h.children.length, 1)
  h.children[0].reply({ ok: true, covered: false })
  assert.equal(h.repairs(), 0)
  h.tick()
  h.children[0].reply({ ok: true, covered: true })
  assert.equal(h.repairs(), 1)
  assert.equal(h.timeouts.size, 0)
  h.quit()
})

test('late observations cannot reveal hidden windows or repair replaced window handles', () => {
  for (const change of ['show', 'replaceWindow', 'hideToolbar']) {
    const h = setup()
    h.tick()
    h[change](false)
    h.children[0].reply({ ok: true, covered: true })
    assert.equal(h.repairs(), 0, change)
    h.quit()
  }
})

test('hidden windows stop their helper and visible windows can resume later', () => {
  const h = setup()
  h.tick()
  h.show(false)
  h.tick()
  assert.equal(h.children[0].killed, true)
  assert.equal(h.timeouts.size, 0)
  for (let i = 0; i < 100; i++) h.tick()
  assert.equal(h.children.length, 1)
  h.show(true)
  h.tick()
  assert.equal(h.children.length, 2)
  h.quit()
  assert.equal(h.children[1].killed, true)
})

test('timeouts and malformed helper responses back off instead of restarting in a tight loop', () => {
  for (const fail of ['timeout', 'malformed', 'close']) {
    const h = setup()
    h.tick()
    if (fail === 'timeout') [...h.timeouts.values()][0]()
    else if (fail === 'malformed') h.children[0].reply({ ok: true, covered: 'yes' })
    else h.children[0].emit('close')
    for (let i = 0; i < 100; i++) h.tick()
    assert.equal(h.children.length, 1, fail)
    assert.equal(h.repairs(), 0)
    h.advance(5000)
    h.tick()
    assert.equal(h.children.length, 2)
    h.quit()
  }
})

test('non-Windows startup never creates a helper or polling interval', () => {
  const h = setup('linux')
  h.tick()
  assert.equal(h.children.length, 0)
  assert.equal(h.timeouts.size, 0)
})
