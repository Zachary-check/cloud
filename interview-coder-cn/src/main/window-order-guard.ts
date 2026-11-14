import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import { nativeEnvironment } from './capture/native-environment'
import { nativeExecutable } from './native-overlay'
import { getToolbarNativeHandle } from './toolbar-window'

export function initWindowOrderGuard(
  getTarget: () => BrowserWindow | null,
  repair: () => void
): void {
  if (process.platform !== 'win32') return
  let child: ChildProcessWithoutNullStreams | null = null
  let pending: ReturnType<typeof setTimeout> | null = null
  let input = ''
  let request = ''
  let retryAfter = 0
  const stop = () => {
    const current = child
    child = null
    if (pending) clearTimeout(pending)
    pending = null
    input = ''
    request = ''
    current?.kill()
  }
  const targetRequest = () => {
    const target = getTarget()
    if (!target || target.isDestroyed() || !target.isVisible()) return ''
    const handle = target.getNativeWindowHandle().readBigUInt64LE().toString()
    return `${handle} ${getToolbarNativeHandle() || '0'} auto\n`
  }
  const poll = () => {
    const next = targetRequest()
    if (!next) return stop()
    if (pending || Date.now() < retryAfter) return
    const executable = nativeExecutable('capture-helper')
    if (!existsSync(executable)) return
    try {
      if (!child) {
        const current = spawn(executable, ['--watch-window-order'], {
          windowsHide: true,
          env: nativeEnvironment(),
          stdio: ['pipe', 'pipe', 'pipe']
        })
        child = current
        const failed = () => {
          if (child !== current) return
          retryAfter = Date.now() + 5000
          stop()
        }
        current.on('error', failed)
        current.on('close', failed)
        current.stdin.on('error', failed)
        current.stderr.on('data', () => {})
        current.stdout.on('data', (data) => {
          if (child !== current) return
          input += String(data)
          if (input.length > 1024) return failed()
          const newline = input.indexOf('\n')
          if (newline < 0) return
          const line = input.slice(0, newline)
          input = input.slice(newline + 1)
          const observed = request
          if (pending) clearTimeout(pending)
          pending = null
          request = ''
          try {
            const result = JSON.parse(line)
            if (result.ok !== true || typeof result.covered !== 'boolean') return failed()
            // Visibility or window replacement invalidates a late observation.
            if (result.covered && observed && observed === targetRequest()) repair()
          } catch {
            failed()
          }
        })
      }
      request = next
      pending = setTimeout(() => {
        retryAfter = Date.now() + 5000
        stop()
      }, 1500)
      child.stdin.write(next)
    } catch {
      retryAfter = Date.now() + 5000
      stop()
    }
  }
  // The helper only reads native ordering; no screenshots, pixel work or focus calls.
  const timer = setInterval(poll, 700)
  timer.unref()
  app.on('before-quit', () => {
    clearInterval(timer)
    stop()
  })
}
