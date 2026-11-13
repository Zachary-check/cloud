import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function load(file, dependencies, globals = {}) {
  const compiled = ts.transpileModule(
    readFileSync(new URL(`../src/main/${file}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const exports = {}
  runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    Buffer,
    process: { platform: 'win32', env: { SystemRoot: 'C:/Windows' } },
    ...globals
  })
  return exports
}

function helper(execFile) {
  return load('windows-screenshot', {
    'node:child_process': { execFile },
    'node:path': { join },
    './capture/native-environment': { nativeEnvironment: () => ({}) }
  })
}

const image = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64')
const result = { image, preview: image, captureMs: 10, resizeMs: 5, encodeMs: 5, previewMs: 2 }

test('invalid dimensions never start a capture process', async () => {
  const capture = helper(() => assert.fail('Must not start a process'))
  for (const size of [
    [0, 1],
    [1, -1],
    [1.5, 10],
    [32769, 10],
    [NaN, 1]
  ]) {
    await assert.rejects(capture.takeWindowsScreenshot(...size), /Invalid screenshot dimensions/)
  }
})

test('capture runs hidden with a bounded lifetime and returns the image with its preview', async () => {
  const capture = helper((executable, args, options, callback) => {
    assert.ok(executable.endsWith('powershell.exe'))
    assert.equal(options.windowsHide, true)
    assert.equal(options.timeout, 15000)
    assert.equal(args[args.indexOf('-WindowStyle') + 1], 'Hidden')
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
    assert.ok(script.includes('2195'))
    assert.ok(script.includes('1235'))
    assert.ok(!script.includes('__WIDTH__'))
    assert.ok(!script.includes('__HEIGHT__'))
    callback(null, JSON.stringify(result))
  })
  assert.deepEqual({ ...(await capture.takeWindowsScreenshot(2195, 1235)) }, result)
})

test('subprocess errors are reported without exposing image output', async () => {
  const capture = helper((_executable, _args, _options, callback) => {
    callback({ code: 'ETIMEDOUT' }, 'private-image-output')
  })
  await assert.rejects(capture.takeWindowsScreenshot(2195, 1235), (error) => {
    assert.ok(error.message.includes('ETIMEDOUT'))
    assert.ok(!error.message.includes('private-image-output'))
    return true
  })
})

test('malformed or missing images are rejected', async () => {
  for (const output of ['not json', '{}', JSON.stringify({ image, preview: 'invalid' })]) {
    const capture = helper((_executable, _args, _options, callback) => callback(null, output))
    await assert.rejects(capture.takeWindowsScreenshot(2195, 1235), /invalid image data/)
  }
})

function screenshotModule(capture) {
  return load(
    'take-screenshot',
    {
      'node:fs': { appendFileSync: () => {}, readFileSync: () => assert.fail('No capture probe') },
      'node:path': { join },
      './capture/native-environment': { nativeEnvironment: () => ({}) },
      electron: {
        app: { getPath: () => 'unused' },
        screen: { getPrimaryDisplay: () => ({ size: { width: 2195, height: 1235 } }) },
        desktopCapturer: { getSources: () => assert.fail('No Electron capture on Windows') },
        nativeImage: {
          createFromBuffer: () => ({
            getSize: () => ({ width: 320 }),
            resize: () => ({ toPNG: () => Buffer.from('preview') })
          })
        }
      },
      './capture-controller': {
        captureWindowsScreen: async () => (await capture(2195, 1235))?.image
      }
    },
    {
      global: { mainWindow: { isDestroyed: () => false } },
      console: { error: () => {} },
      setTimeout: () => assert.fail('No legacy probe timer on Windows')
    }
  )
}

test('Windows capture uses the compatibility controller and keeps preview data valid', async () => {
  const capture = screenshotModule(async (width, height) => {
    assert.equal(width, 2195)
    assert.equal(height, 1235)
    return { ...result, preview: 'cached-preview' }
  })
  assert.equal(await capture.takeScreenshot(), image)
  assert.equal(capture.toDisplayThumbnail(image), image)
  assert.equal(capture.toDisplayThumbnail(image), image)
  capture.scheduleCaptureProbe()
})

test('failed Windows capture reports failure without repeating the slow Electron capture', async () => {
  const capture = screenshotModule(async () => undefined)
  assert.equal(await capture.takeScreenshot(), undefined)
})
