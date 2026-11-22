import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const cache = new Map()
const require = createRequire(import.meta.url)
function load(relative) {
  const filename = resolve(root, relative)
  if (cache.has(filename)) return cache.get(filename)
  const exports = {}
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(code, {
    exports,
    Buffer,
    AbortController,
    Date,
    Error,
    TypeError,
    require: (name) =>
      name.startsWith('.')
        ? load(resolve(dirname(filename), name + '.ts'))
        : name.startsWith('node:')
          ? require(name)
          : assert.fail(name)
  })
  cache.set(filename, exports)
  return exports
}
const { inspectFrame } = load('src/main/capture/quality.ts')
const { capturePlan, selectPlatform, normalizeCaptureSettings } = load('src/shared/capture.ts')
const { createCaptureService } = load('src/main/capture/service.ts')
const frame = (color, width = 100, height = 100) => ({
  pixels: Buffer.alloc(width * height * 4, color),
  width,
  height,
  stride: width * 4
})
const methods = ['gdi', 'sharedSurface', 'gpuChild', 'printWindow']

test('image diagnosis handles blank, dark detailed, inset-black and strided frames', () => {
  assert.equal(inspectFrame(frame(0)).status, 'blank')
  assert.equal(inspectFrame(frame(255)).status, 'usable')
  const dark = frame(0)
  for (let y = 0; y < 100; y += 10)
    for (let x = 0; x < 100; x += 10)
      dark.pixels.fill(255, (y * 100 + x) * 4, (y * 100 + x) * 4 + 3)
  assert.equal(inspectFrame(dark).status, 'usable')
  const inset = frame(255)
  for (let y = 5; y < 95; y++) inset.pixels.fill(0, (y * 100 + 5) * 4, (y * 100 + 95) * 4)
  assert.equal(inspectFrame(inset).status, 'obscured')
  assert.throws(() => inspectFrame({ pixels: Buffer.alloc(1), width: 10, height: 10 }), /Invalid/)
  assert.equal(inspectFrame(frame(255, 1920, 1080)).sampledWidth, 480)
})
test('manual choice wins, exact eligible processes are recognized, unknown settings normalize', () => {
  const windows = [{ process: '国考云.exe', foreground: true }]
  assert.equal(selectPlatform('general', windows).id, 'general')
  assert.equal(selectPlatform('auto', windows).id, 'iguokao')
  assert.equal(
    selectPlatform('auto', [{ process: 'ShixizhiClient.EXE', protected: true }]).id,
    'shixizhi'
  )
  assert.equal(
    selectPlatform('auto', [{ process: 'shixizhiclient-helper.exe', fullscreen: true }]).id,
    'general'
  )
  assert.equal(selectPlatform('auto', [{ process: 'eztest.exe' }]).id, 'general')
  assert.equal(
    normalizeCaptureSettings({ capturePlatform: 'invalid', captureMethod: 'invalid' })
      .capturePlatform,
    'auto'
  )
})
test('available capture routes follow the platform and Windows build', () => {
  const caps = { windowsBuild: 22631, methods }
  assert.equal(capturePlan(selectPlatform('iguokao'), caps)[0], 'sharedSurface')
  assert.equal(capturePlan(selectPlatform('shixizhi'), caps)[0], 'gpuChild')
  assert.equal(
    capturePlan(selectPlatform('shixizhi'), { ...caps, windowsBuild: 19045 })[0],
    'sharedSurface'
  )
  assert.deepEqual(Array.from(capturePlan(selectPlatform('eztest'), { methods: ['gdi'] })), ['gdi'])
})
function fixture(capture) {
  const attempts = [],
    encoded = [],
    logs = []
  const backend = {
    capabilities: async () => ({ methods, windowsBuild: 22631 }),
    snapshot: async () => ({ windows: [{ process: '国考云.exe', foreground: true }] }),
    capture: async (request) => {
      attempts.push(request.mode)
      return capture(request)
    }
  }
  const service = createCaptureService({
    backend,
    encode: async (image) => {
      encoded.push(image)
      return 'png'
    },
    getSettings: async () => normalizeCaptureSettings({}),
    log: (entry) => logs.push(entry)
  })
  return { service, attempts, encoded, logs }
}
test('black frames retry; only usable pixels are encoded and mode caching recovers after failure', async () => {
  let failed = false
  const f = fixture(async ({ mode }) => frame(mode === 'gpuChild' && !failed ? 255 : 0))
  assert.equal((await f.service.capture()).mode, 'gpuChild')
  assert.deepEqual(f.attempts, ['sharedSurface', 'gpuChild'])
  f.attempts.length = 0
  await f.service.capture()
  assert.deepEqual(f.attempts, ['gpuChild'])
  failed = true
  await assert.rejects(f.service.capture(), (error) => error.code === 'NO_READABLE_FRAME')
  assert.equal(f.encoded.length, 2)
  assert.ok(f.logs.every((entry) => !('pixels' in entry) && !('image' in entry)))
})
test('cancellation rejects stale frames and unresolved protected targets cannot pass as a plain desktop', async () => {
  let release
  const f = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const pending = f.service.capture()
  await new Promise((resolve) => setImmediate(resolve))
  f.service.cancel()
  release(frame(255))
  await assert.rejects(pending, (error) => error.code === 'CANCELLED')
  assert.equal(f.encoded.length, 0)
  const g = fixture(() => ({ ...frame(255), candidates: 1, reconstructed: 0 }))
  await assert.rejects(g.service.capture(), (error) => error.code === 'NO_READABLE_FRAME')
  assert.equal(g.encoded.length, 0)
})

const { validateFrame } = load('src/main/capture/native-backend.ts')
const { nativeEnvironment } = load('src/main/capture/native-environment.ts')
test('native frames reject truncated data, huge allocations and inconsistent stride', () => {
  validateFrame({ width: 40, height: 30, stride: 160 }, 4800)
  assert.throws(() => validateFrame({ width: 40, height: 30, stride: 160 }, 4799))
  assert.throws(() => validateFrame({ width: 32768, height: 32768, stride: 131072 }, 4294967296))
  assert.throws(() => validateFrame({ width: 40, height: 30, stride: 100 }, 3000))
})
test('native processes receive only required OS variables, not AI credentials or arbitrary secrets', () => {
  const env = nativeEnvironment({
    SystemRoot: 'C:/Windows',
    TEMP: 'temp',
    API_KEY: 'synthetic',
    MODEL: 'test-model',
    TOKEN: 'synthetic'
  })
  assert.deepEqual(Object.keys(env).sort(), ['SystemRoot', 'TEMP'])
  assert.equal(env.SystemRoot, 'C:/Windows')
})
