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
const compiled = ts.transpileModule(
  readFileSync(join(root, 'src/renderer/src/coder/OverlayToolbar.tsx'), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX
    }
  }
).outputText
const noop = () => undefined

function setup(action = 'decreaseOpacity', workMode = 'written') {
  const effects = []
  const effectDependencies = []
  const cleanups = []
  const listeners = new Map()
  const timers = new Map()
  const actions = []
  let cursorHandler
  let now = 0
  let opacity = 0.65
  let stateIndex = 0
  class ButtonElement {
    dataset = { toolbarAction: action }
    closest() {
      return this
    }
  }
  const button = new ButtonElement()
  const document = {
    elementFromPoint: (x, y) => (x >= 10 && x < 40 && y >= 5 && y < 35 ? button : null),
    addEventListener: (event, handler) => listeners.set(event, handler),
    removeEventListener: (event) => listeners.delete(event)
  }
  const api = {
    getAppSettings: async () => ({ toolbarHoverDelay: 1000, workMode: 'written' }),
    onSyncToolbarSettings: noop,
    removeSyncToolbarSettingsListener: noop,
    getBackgroundTheme: async () => 'light',
    onBackgroundTheme: noop,
    removeBackgroundThemeListener: noop,
    onToolbarCursor: (handler) => {
      cursorHandler = handler
    },
    removeToolbarCursorListener: () => {
      cursorHandler = undefined
    },
    triggerAction: async (name) => {
      actions.push(name)
      opacity = Math.max(
        0.1,
        Math.min(1, Math.round((opacity + (name === 'increaseOpacity' ? 0.05 : -0.05)) * 100) / 100)
      )
    }
  }
  const dependencies = {
    react: {
      useEffect: (effect, dependencies) => {
        effects.push(effect)
        effectDependencies.push(dependencies)
      },
      useState: (initial) => [stateIndex++ === 1 ? workMode : initial, noop]
    },
    'react/jsx-runtime': { jsx: noop, jsxs: noop },
    '@/components/ui/button': { Button: noop },
    '@/lib/toolbar-actions': { getToolbarActions: () => [], resolveToolbarAction: noop }
  }
  const exports = {}
  runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, name)
      return dependencies[name]
    },
    document,
    window: { api },
    HTMLElement: ButtonElement,
    setTimeout: (callback, delay) => {
      const timer = { callback, at: now + delay }
      timers.set(timer, timer)
      return timer
    },
    clearTimeout: (timer) => timers.delete(timer)
  })
  exports.OverlayToolbar()
  for (const effect of effects) cleanups.push(effect())
  const advance = (ms) => {
    const end = now + ms
    while (true) {
      const timer = [...timers.values()]
        .filter((value) => value.at <= end)
        .sort((a, b) => a.at - b.at)[0]
      if (!timer) break
      now = timer.at
      timers.delete(timer)
      timer.callback()
    }
    now = end
  }
  return {
    point: (point) => cursorHandler?.(point),
    forwardedLeave: () => listeners.get('mouseleave')?.(),
    forwardedMove: (x, y) => listeners.get('mousemove')?.({ clientX: x, clientY: y }),
    actions,
    hoverDependencies: Array.from(effectDependencies.at(-1)),
    advance,
    opacity: () => opacity,
    pendingTimers: () => timers.size,
    dispose: () => {
      for (const cleanup of cleanups) cleanup?.()
    }
  }
}

test('stationary hover changes opacity once despite repeated native leave notifications', () => {
  const h = setup()
  // The OS reports the same real position throughout. Native notifications from
  // a click-through window must not unlock an already executed action.
  for (let tick = 0; tick < 600; tick++) {
    h.point({ x: 20, y: 20 })
    h.advance(100)
    if (tick % 20 === 19) h.forwardedLeave()
  }
  assert.equal(h.actions.length, 1, `Stationary pointer triggered ${h.actions.length} times`)
  assert.equal(h.opacity(), 0.6)
  h.dispose()
})

test('forwarded coordinates cannot arm a button while the OS cursor is elsewhere', () => {
  const h = setup('increaseOpacity')
  h.point(null)
  h.forwardedMove(20, 20)
  h.advance(1500)
  assert.equal(h.actions.length, 0)
  h.dispose()
})

test('OS-confirmed departure cancels a pending hover', () => {
  const h = setup()
  h.point({ x: 20, y: 20 })
  h.advance(900)
  h.point(null)
  h.advance(2000)
  assert.equal(h.actions.length, 0)
  assert.equal(h.pendingTimers(), 0)
  h.dispose()
})

test('leaving and returning intentionally allows one more opacity step', () => {
  const h = setup('increaseOpacity')
  h.point({ x: 20, y: 20 })
  h.advance(1000)
  for (let i = 0; i < 20; i++) {
    h.point({ x: 20, y: 20 })
    h.advance(100)
  }
  assert.equal(h.actions.length, 1)
  h.point(null)
  h.point({ x: 20, y: 20 })
  h.advance(1000)
  assert.equal(h.actions.length, 2)
  assert.equal(h.opacity(), 0.75)
  h.dispose()
})

test('moving within the bar outside a button also releases its hover lock', () => {
  const h = setup()
  h.point({ x: 20, y: 20 })
  h.advance(1000)
  h.point({ x: 5, y: 20 })
  h.point({ x: 20, y: 20 })
  h.advance(1000)
  assert.equal(h.actions.length, 2)
  h.dispose()
})

test('unmount cancels a pending action and detaches cursor input', () => {
  const h = setup()
  h.point({ x: 20, y: 20 })
  h.advance(900)
  h.dispose()
  h.advance(2000)
  h.point({ x: 20, y: 20 })
  h.advance(2000)
  assert.equal(h.actions.length, 0)
  assert.equal(h.pendingTimers(), 0)
})

test('dual screenshot and scroll actions remain usable from OS samples without DOM mouse events', () => {
  for (const action of ['takeScreenshot', 'pageUp', 'pageDown', 'ignoreOrEnableMouse']) {
    const h = setup(action, 'dual')
    h.point({ x: 20, y: 20 })
    h.advance(1000)
    assert.deepEqual(h.actions, [action])
    h.point({ x: 20, y: 20 })
    h.advance(3000)
    assert.deepEqual(h.actions, [action])
    h.point(null)
    h.point({ x: 20, y: 20 })
    h.advance(1000)
    assert.deepEqual(h.actions, [action, action])
    h.dispose()
  }
})

test('written/interview toggles keep the hover lock while entering dual resets the changed layout', () => {
  const written = setup('toggleWorkMode', 'written')
  const interview = setup('toggleWorkMode', 'interview')
  const dual = setup('takeScreenshot', 'dual')
  assert.deepEqual(written.hoverDependencies, interview.hoverDependencies)
  assert.notDeepEqual(written.hoverDependencies, dual.hoverDependencies)
  written.dispose()
  interview.dispose()
  dual.dispose()
})
