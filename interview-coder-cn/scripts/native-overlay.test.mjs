import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function setup() {
  const children = [],
    writes = [],
    actions = [],
    copied = []
  let reveals = 0
  class Child extends EventEmitter {
    constructor() {
      super()
      this.stdout = new EventEmitter()
      this.stderr = new EventEmitter()
      this.stdin = new EventEmitter()
      this.stdin.writable = true
      this.stdin.write = (line) => {
        writes.push(line)
        return true
      }
      this.stdin.end = () => {
        this.stdin.writable = false
        queueMicrotask(() => this.emit('close', 0))
      }
      this.kill = () => this.emit('close', 1)
    }
    event(value) {
      this.stdout.emit('data', JSON.stringify({ event: value }) + '\n')
    }
  }
  const dependencies = {
    'node:child_process': {
      spawn: (_exe, _args, options) => {
        assert.equal(options.windowsHide, true)
        assert.deepEqual(options.env, { SystemRoot: 'C:/Windows' })
        const child = new Child()
        children.push(child)
        return child
      }
    },
    'node:fs': { existsSync: () => true },
    'node:path': { join },
    './capture/native-environment': { nativeEnvironment: () => ({ SystemRoot: 'C:/Windows' }) },
    electron: {
      app: { isPackaged: false, getAppPath: () => '/app' },
      clipboard: { writeText: (text) => copied.push(text) }
    }
  }
  const exports = {}
  const code = ts.transpileModule(
    readFileSync(new URL('../src/main/native-overlay.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
  runInNewContext(code, {
    exports,
    Buffer,
    process: { platform: 'win32' },
    setTimeout,
    clearTimeout,
    Error,
    require: (name) => {
      assert.ok(name in dependencies, name)
      return dependencies[name]
    }
  })
  exports.initNativeOverlay(
    (action) => actions.push(action),
    () => reveals++
  )
  return { api: exports, children, writes, actions, copied, reveals: () => reveals }
}
test('native actions share the host workflow and copies use the current answer, without credentials', async () => {
  const h = setup()
  const pending = h.api.openNativeOverlay(1000)
  h.children[0].event('ready')
  await pending
  h.api.nativeAnswerEvent('clear')
  h.api.nativeAnswerEvent('chunk', '```cpp\nint main() {}\n```')
  h.children[0].event('capture')
  h.children[0].event('append')
  h.children[0].event('stop')
  h.children[0].event('copy')
  assert.deepEqual(h.actions, ['capture', 'append', 'stop'])
  assert.deepEqual(h.copied, ['int main() {}'])
  h.api.closeNativeOverlay()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.reveals(), 1)
  assert.equal(h.api.nativeOverlayActive(), false)
})
test('an early child-process exit rejects startup promptly instead of leaving it pending', async () => {
  const h = setup()
  const pending = h.api.openNativeOverlay(1000)
  h.children[0].emit('close', 1)
  await assert.rejects(pending, /退出/)
  assert.equal(h.api.nativeOverlayActive(), false)
  assert.equal(h.reveals(), 0)
})
test('concurrent open calls create one native window and app shutdown does not restore the workbench', async () => {
  const h = setup()
  const one = h.api.openNativeOverlay(1000),
    two = h.api.openNativeOverlay(1000)
  assert.equal(h.children.length, 1)
  h.children[0].event('ready')
  await Promise.all([one, two])
  h.api.closeNativeOverlay(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.reveals(), 0)
  // A user can cancel quitting and open the native window again.
  const reopened = h.api.openNativeOverlay(1000)
  h.children[1].event('ready')
  await reopened
  h.api.closeNativeOverlay()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.reveals(), 1)
})

test('a stalled native reader keeps only the latest status instead of accumulating writes', async () => {
  const h = setup()
  const pending = h.api.openNativeOverlay(0)
  h.children[0].event('ready')
  await pending
  const original = h.children[0].stdin.write
  h.children[0].stdin.write = (line) => {
    original(line)
    return false
  }
  const before = h.writes.length
  for (let i = 0; i < 500; i++) h.api.nativeAnswerEvent('status', `状态 ${i}`)
  assert.equal(h.writes.length, before + 1)
  h.children[0].stdin.write = original
  h.children[0].stdin.emit('drain')
  assert.equal(h.writes.length, before + 2)
  assert.equal(Buffer.from(h.writes.at(-1).split(' ')[1].trim(), 'base64').toString(), '状态 499')
  h.api.closeNativeOverlay()
})

test('a close-and-reopen race cannot let the old native process hide or replace the new session', async () => {
  const h = setup()
  const first = h.api.openNativeOverlay(1000)
  h.children[0].event('ready')
  await first
  h.api.closeNativeOverlay()
  const second = h.api.openNativeOverlay(1000)
  assert.equal(h.children.length, 2)
  h.children[0].event('ready')
  h.children[1].event('ready')
  await second
  assert.equal(h.api.nativeOverlayActive(), true)
  assert.equal(h.reveals(), 0)
  h.api.closeNativeOverlay()
})
