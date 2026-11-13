import 'dotenv/config'
import { app, BrowserWindow, desktopCapturer, globalShortcut, screen, session } from 'electron'

type AbortLikeError = {
  name?: string
  code?: string
  message?: unknown
}

// Swallow AbortError from user-initiated stream cancellations to keep console clean
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const err = error as AbortLikeError
  const message = typeof err.message === 'string' ? err.message : ''
  return err.name === 'AbortError' || err.code === 'ABORT_ERR' || /aborted/i.test(message)
}

process.on('unhandledRejection', (error) => {
  if (isAbortError(error)) return
  console.error(error)
})

process.on('uncaughtException', (error) => {
  if (isAbortError(error)) return
  console.error(error)
})
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { revealMainWindow } from './shortcuts'
import './transcription'
import './window-resize'
import { createWindow } from './main-window'
import { ensureWindowOnScreen } from './window-placement'
import { initAutoUpdater } from './auto-updater'
import { applyDockVisibility } from './settings'
import { finalizeInterviewRecord } from './interview-record'
import { scheduleCaptureProbe } from './take-screenshot'

// A second instance would fail to register the same global shortcuts and stack
// another always-on-top window over the first, hiding a window that can no
// longer be clicked. Keep a single instance and bring the existing one forward.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  revealMainWindow()
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // A second instance is already on its way out; it must not create a window
  if (!hasSingleInstanceLock) return

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Hide the dock icon up front until the renderer syncs the real preference.
  // The persisted `hideDockIcon` value lives in the renderer, so the main
  // process doesn't know it yet at startup. Starting hidden avoids a dock
  // flash for users who keep it hidden; if disabled, the renderer sync will
  // show it again once the window mounts.
  applyDockVisibility(true)

  // System audio does not need a desktop video source. The renderer immediately
  // stops its video track, so use its own frame and avoid starting screen capture.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (process.platform === 'win32') {
      callback(request.frame ? { video: request.frame, audio: 'loopback' } : {})
      return
    }
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        // The callback must always be invoked: a dropped request leaves
        // getDisplayMedia pending forever, so starting transcription would hang
        // with no error and no way to tell why.
        callback(sources.length > 0 ? { video: sources[0], audio: 'loopback' } : {})
      })
      .catch((error) => {
        console.error('Failed to enumerate screens for audio capture:', error)
        callback({})
      })
  })

  // Auto-approve microphone access so users can enumerate and select audio input devices
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (['media', 'microphone', 'audio'].includes(permission)) {
      callback(true)
    } else {
      callback(false)
    }
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // One-off capture benchmark (see take-screenshot.ts). It runs a few seconds
  // after the first launch, never more than once, so the numbers come from a
  // real machine instead of a guess.
  scheduleCaptureProbe()

  // A window stranded outside every display can no longer be clicked, and the
  // layout can change at any time (monitor unplugged, resolution lowered).
  // Pull it back as soon as that happens.
  const recoverWindowPosition = () => ensureWindowOnScreen(global.mainWindow)
  screen.on('display-removed', recoverWindowPosition)
  screen.on('display-metrics-changed', recoverWindowPosition)

  // 自动更新已断开，见 src/main/auto-updater.ts 的文件头说明。
  // 保留这次调用是为了让「重新启用」只需要改那一个文件。
  initAutoUpdater()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      // Covers a soft-hidden or stranded window, not just an invisible one
      revealMainWindow()
    }
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // Unregister all shortcuts when there is no window left
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/**
 * Save the interview before the process goes away. The transcript on screen is
 * memory-only, so a turn that was still streaming would be lost with it; this
 * writes whatever is open and waits for the queued writes to reach the disk.
 *
 * Naming the file is the window's job (see ./record-close-prompt), which by this
 * point has already settled the session; quitting without a window — the second
 * instance, or a renderer that never came up — lands here instead, and the
 * record stays under its default name.
 *
 * The app is held back for one flush only, and never longer than the deadline:
 * a write that hangs must not leave the user with a window they cannot close.
 */
const RECORD_FLUSH_DEADLINE_MS = 3000
let recordFlush: Promise<void> | null = null
let recordFlushed = false

function flushInterviewRecord(): Promise<void> {
  if (!recordFlush) {
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, RECORD_FLUSH_DEADLINE_MS))
    recordFlush = Promise.race([finalizeInterviewRecord(), deadline])
      .catch((error) => {
        console.error('Failed to save the interview record:', error)
      })
      .then(() => {
        recordFlushed = true
      })
      .finally(() => {
        recordFlush = null
      })
  }
  return recordFlush
}

app.on('before-quit', (event) => {
  // The second pass through here is the quit we asked for once the writes landed.
  if (recordFlushed) return
  event.preventDefault()
  flushInterviewRecord().finally(() => app.quit())
})
