import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const compiled = ts.transpileModule(
  readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText

// Exercise the real startup registration with local stubs. No device is opened.
async function setup(platform, getSources = () => assert.fail('No screen enumeration on Windows')) {
  let handler
  const noop = () => {}
  const app = {
    on: noop,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve()
  }
  const dependencies = {
    'dotenv/config': {},
    electron: {
      app,
      BrowserWindow: {},
      desktopCapturer: { getSources },
      globalShortcut: {},
      screen: { on: noop },
      session: {
        defaultSession: {
          setDisplayMediaRequestHandler: (value) => {
            handler = value
          },
          setPermissionRequestHandler: noop
        }
      }
    },
    '@electron-toolkit/utils': {
      electronApp: { setAppUserModelId: noop },
      optimizer: { watchWindowShortcuts: noop }
    },
    './shortcuts': { revealMainWindow: noop },
    './transcription': {},
    './window-resize': {},
    './main-window': { createWindow: noop },
    './window-placement': { ensureWindowOnScreen: noop },
    './auto-updater': { initAutoUpdater: noop },
    './settings': { applyDockVisibility: noop },
    './interview-record': { finalizeInterviewRecord: noop },
    './take-screenshot': { scheduleCaptureProbe: noop }
  }
  runInNewContext(compiled, {
    exports: {},
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    process: { on: noop, platform },
    console: { error: noop }
  })
  await Promise.resolve()
  assert.equal(typeof handler, 'function')
  return handler
}

test('Windows loopback uses the requesting frame without screen enumeration', async () => {
  const handler = await setup('win32')
  const frame = { id: 'requesting-frame' }
  const replies = []
  handler({ frame, audioRequested: true, videoRequested: true }, (streams) => replies.push(streams))
  assert.equal(replies.length, 1)
  assert.equal(replies[0].video, frame)
  assert.equal(replies[0].audio, 'loopback')
})

test('a destroyed Windows frame resolves the request without starting screen capture', async () => {
  const handler = await setup('win32')
  const replies = []
  handler({ frame: null, audioRequested: true, videoRequested: true }, (streams) =>
    replies.push(streams)
  )
  assert.equal(replies.length, 1)
  assert.deepEqual(Object.keys(replies[0]), [])
})

test('other platforms retain their existing desktop source selection', async () => {
  const source = { id: 'screen:0:0', name: 'screen' }
  const handler = await setup('linux', async (options) => {
    assert.deepEqual(Array.from(options.types), ['screen'])
    return [source]
  })
  const replies = []
  handler({ frame: {} }, (streams) => replies.push(streams))
  await Promise.resolve()
  assert.equal(replies.length, 1)
  assert.equal(replies[0].video, source)
  assert.equal(replies[0].audio, 'loopback')
})

test('an empty source list resolves the request instead of leaving it pending', async () => {
  const handler = await setup('linux', async () => [])
  const replies = []
  handler({ frame: {} }, (streams) => replies.push(streams))
  await Promise.resolve()
  assert.equal(replies.length, 1)
  assert.deepEqual(Object.keys(replies[0]), [])
})

test('failed enumeration resolves the request instead of leaving it pending', async () => {
  const handler = await setup('linux', async () => {
    throw new Error('No capture device')
  })
  const replies = []
  handler({ frame: {} }, (streams) => replies.push(streams))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(replies.length, 1)
  assert.deepEqual(Object.keys(replies[0]), [])
})
