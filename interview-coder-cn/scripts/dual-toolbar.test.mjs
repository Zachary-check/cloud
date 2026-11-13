import assert from 'node:assert/strict'
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

function load(source, dependencies = {}) {
  const exports = {}
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX
      }
    }).outputText,
    {
      exports,
      require: (name) => {
        assert.ok(name in dependencies, name)
        return dependencies[name]
      }
    }
  )
  return exports
}
const layout = load(readFileSync(join(root, 'src/shared/toolbar-layout.ts'), 'utf8'))
const actions = load(readFileSync(join(root, 'src/renderer/src/lib/toolbar-actions.ts'), 'utf8'), {
  'lucide-react': new Proxy({}, { get: (_target, name) => name }),
  '../../../shared/toolbar-layout': layout
})

test('dual toolbar exposes screenshot, scrolling, and a way to restore mouse control in compact order', () => {
  const selected = actions.getToolbarActions('dual')
  assert.deepEqual(
    Array.from(selected, (entry) => entry.action),
    ['takeScreenshot', 'pageUp', 'pageDown', 'ignoreOrEnableMouse']
  )
  assert.equal(layout.DUAL_TOOLBAR_WIDTH, selected.length * 28 + (selected.length - 1) * 2 + 16)
})

test('written and interview retain the full set of toolbar actions', () => {
  assert.equal(actions.getToolbarActions('written'), actions.TOOLBAR_ACTIONS)
  assert.equal(actions.getToolbarActions('interview'), actions.TOOLBAR_ACTIONS)
})

test('dual mode no longer hides an enabled hover toolbar; settings and help still hide it', () => {
  const file = ts.createSourceFile(
    'App.tsx',
    readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const controller = file.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ToolbarVisibilityController'
  )
  assert.ok(controller)
  const source = 'exports.run = ' + controller.getText(file)
  for (const mode of ['dual', 'written', 'interview']) {
    for (const [path, enabled, expected] of [
      ['/', true, true],
      ['/', false, false],
      ['/settings', true, false],
      ['/help', true, false],
      ['/toolbar', true, undefined]
    ]) {
      const calls = []
      const exports = {}
      runInNewContext(
        ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
          .outputText,
        {
          exports,
          useEffect: (effect) => effect(),
          useLocation: () => ({ pathname: path }),
          useSettingsStore: (select) => select({ showOverlayToolbar: enabled, workMode: mode }),
          window: { api: { setToolbarVisible: (visible) => calls.push(visible) } }
        }
      )
      exports.run()
      assert.deepEqual(
        calls,
        expected === undefined ? [] : [expected],
        `${mode}:${path}:${enabled}`
      )
    }
  }
})

test('scroll controls target the nested dual answer and fall back to the normal page', () => {
  const file = ts.createSourceFile(
    'AppContent.tsx',
    readFileSync(join(root, 'src/renderer/src/coder/AppContent.tsx'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const effects = []
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect') {
      const source = node.getText(file)
      if (source.includes('onScrollPageUp(') || source.includes('onScrollPageDown('))
        effects.push(source)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.equal(effects.length, 2)
  const helper = file.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'scrollAnswerContent'
  )
  assert.ok(helper)
  const compiled = ts.transpileModule(helper.getText(file) + '\n' + effects.join(';\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText

  function box(height, fullHeight, top = 0) {
    return {
      clientHeight: height,
      scrollHeight: fullHeight,
      scrollTop: top,
      scrollBy({ top, behavior }) {
        assert.equal(behavior, 'auto')
        this.scrollTop = Math.min(
          Math.max(0, this.scrollTop + top),
          this.scrollHeight - this.clientHeight
        )
      }
    }
  }
  for (const dual of [true, false]) {
    const callbacks = {}
    const followLatest = { current: true }
    const outer = dual ? box(134, 134) : box(634, 2000, 200)
    const inner = dual ? box(110, 2880, 200) : null
    const actual = inner ?? outer
    runInNewContext(compiled, {
      useEffect: (effect) => effect(),
      followLatest,
      document: { getElementById: (id) => (id === 'dual-answer-content' ? inner : outer) },
      window: {
        api: {
          onScrollPageUp: (callback) => {
            callbacks.up = callback
          },
          onScrollPageDown: (callback) => {
            callbacks.down = callback
          },
          removeScrollPageUpListener: noop,
          removeScrollPageDownListener: noop
        }
      }
    })
    callbacks.down()
    assert.ok(actual.scrollTop > 200)
    assert.equal(followLatest.current, false)
    if (dual) assert.equal(outer.scrollTop, 0)
    callbacks.up()
    assert.equal(actual.scrollTop, 200)
    actual.scrollTop = 0
    callbacks.up()
    assert.equal(actual.scrollTop, 0)
    actual.scrollTop = actual.scrollHeight - actual.clientHeight
    callbacks.down()
    assert.equal(actual.scrollTop, actual.scrollHeight - actual.clientHeight)
  }
})
