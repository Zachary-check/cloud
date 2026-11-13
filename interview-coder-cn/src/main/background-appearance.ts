import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { app, ipcMain, screen } from 'electron'
import { nativeExecutable } from './native-overlay'
import { nativeEnvironment } from './capture/native-environment'
import { settings } from './settings'
import { state } from './state'

let theme: 'light' | 'dark' = 'light'
let child: ChildProcessWithoutNullStreams | null = null
let pending: ReturnType<typeof setTimeout> | null = null
let retryAfter = 0
let input = ''

function stop(): void {
  const current = child
  child = null
  if (pending) clearTimeout(pending)
  pending = null
  input = ''
  current?.kill()
}

function sample(): void {
  const window = global.mainWindow
  if (
    !settings.textOnlyAnswers ||
    !state.inCoderPage ||
    !window ||
    window.isDestroyed() ||
    !window.isVisible()
  ) {
    stop()
    return
  }
  if (process.platform !== 'win32' || pending || Date.now() < retryAfter) return
  const executable = nativeExecutable('capture-helper')
  if (!existsSync(executable)) return
  try {
    if (!child) {
      const current = spawn(executable, ['--watch-background'], {
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
        if (pending) clearTimeout(pending)
        pending = null
        try {
          const result = JSON.parse(line)
          if (result.ok && (result.theme === 'light' || result.theme === 'dark')) {
            theme = result.theme
            const target = global.mainWindow
            if (target && !target.isDestroyed()) target.webContents.send('background-theme', theme)
          }
        } catch {
          failed()
        }
      })
    }
    const bounds = window.getBounds()
    // Exclude the controls; sample the answer surface in physical screen pixels.
    const region = screen.dipToScreenRect(window, {
      x: bounds.x,
      y: bounds.y + 40,
      width: bounds.width,
      height: Math.max(1, bounds.height - 80)
    })
    pending = setTimeout(() => {
      retryAfter = Date.now() + 5000
      stop()
    }, 1500)
    child.stdin.write(`${region.x} ${region.y} ${region.width} ${region.height}\n`)
  } catch {
    retryAfter = Date.now() + 5000
    stop()
  }
}

export function initBackgroundAppearance(): void {
  ipcMain.handle('appearance:theme', () => {
    sample()
    return theme
  })
  const timer = setInterval(sample, 1200)
  timer.unref()
  app.on('before-quit', () => {
    clearInterval(timer)
    stop()
  })
}
