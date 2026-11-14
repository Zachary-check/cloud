import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const storeFile = fileURLToPath(
  new URL('../src/renderer/src/lib/store/settings.ts', import.meta.url)
)

function loadStore() {
  let options
  const load = (file) => {
    const exports = {}
    const dependencies = {
      zustand: {
        create: () => (initialize) =>
          initialize(
            () => {},
            () => ({})
          )
      },
      'zustand/middleware': {
        persist: (initialize, config) => {
          options = config
          return initialize
        }
      }
    }
    runInNewContext(
      ts.transpileModule(readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText,
      {
        exports,
        require: (name) => {
          if (name in dependencies) return dependencies[name]
          assert.ok(name.startsWith('.'), name)
          if (name.endsWith('?raw'))
            return {
              __esModule: true,
              default: readFileSync(resolve(dirname(file), name.slice(0, -4)), 'utf8')
            }
          return load(resolve(dirname(file), name + '.ts'))
        }
      }
    )
    return exports
  }
  const exports = load(storeFile)
  return { options, defaults: exports.useSettingsStore }
}

test('fresh settings use panel compatibility while retaining the optional transparent preference', () => {
  const { defaults, options } = loadStore()
  assert.equal(options.version, 15)
  assert.equal(defaults.windowCompatibilityMode, true)
  assert.equal(defaults.textOnlyAnswers, true)
  assert.equal(defaults.showScreenshotPreview, false)
})

test('2.2.0 and later settings migrate to compatibility without losing AI or preview preferences', () => {
  for (const version of [13, 14]) {
    const { defaults, options } = loadStore()
    const saved = {
      apiBaseURL: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'test-primary',
      fallbackModelEnabled: true,
      fallbackModel: 'test-backup',
      textOnlyAnswers: true,
      showScreenshotPreview: true,
      opacity: 0.7
    }
    const next = options.merge(options.migrate({ ...saved }, version), defaults)
    assert.equal(next.windowCompatibilityMode, true)
    for (const [key, value] of Object.entries(saved)) assert.equal(next[key], value, key)
  }
})

test('disabling compatibility remains disabled after restart and preserves text-only preferences', () => {
  const { defaults, options } = loadStore()
  for (const textOnlyAnswers of [true, false]) {
    const next = options.merge({ windowCompatibilityMode: false, textOnlyAnswers }, defaults)
    assert.equal(next.windowCompatibilityMode, false)
    assert.equal(next.textOnlyAnswers, textOnlyAnswers)
  }
})
