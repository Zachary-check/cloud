import { join } from 'node:path'
import { shell, BrowserWindow, ipcMain, screen, type Rectangle } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createToolbarWindow } from './toolbar-window'
import { installRecordClosePrompt } from './record-close-prompt'
import { clampPositionToDisplays, ensureWindowOnScreen } from './window-placement'

const COMPACT_WIDTH = 520
const COMPACT_HEIGHT = 170
let normalWindowBounds: Rectangle | null = null

ipcMain.handle('setCompactMode', (event, compact: boolean) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return

  if (compact) {
    if (normalWindowBounds) return
    normalWindowBounds = window.getBounds()
    const { workArea } = screen.getDisplayMatching(normalWindowBounds)
    // The corner is computed in DIP, so at fractional display scaling it can
    // fall outside the work area; clamp it like every other placement in this
    // app does, or the compact window ends up somewhere it cannot be reached.
    const corner = clampPositionToDisplays(
      workArea.x + 16,
      workArea.y + workArea.height - COMPACT_HEIGHT - 16,
      COMPACT_WIDTH,
      COMPACT_HEIGHT
    )
    window.setBounds({
      x: corner.x,
      y: corner.y,
      width: COMPACT_WIDTH,
      height: COMPACT_HEIGHT
    })
    // Last line of defence: a compact window parked outside every display could
    // never be dragged back, and nothing on screen would show it had happened.
    ensureWindowOnScreen(window)
    return
  }

  if (normalWindowBounds) {
    window.setBounds(normalWindowBounds)
    normalWindowBounds = null
  }
})

export function applyContentProtection(window: BrowserWindow, forceReset = false): void {
  if (!window || window.isDestroyed()) return

  if (forceReset && process.platform === 'win32') {
    window.setContentProtection(false)
  }

  window.setContentProtection(true)
}

export function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    title: '',
    frame: false,
    transparent: true,
    hasShadow: false,
    // Native resize toggling breaks transparency on Windows; renderer handles own resizing.
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Soft-hide parks the window off-screen, which makes Windows report it as
      // occluded; with throttling on the renderer freezes until the window is
      // focused again, so IPC sent while hidden (shortcut feedback, toolbar
      // hover dwell handled in the renderer) is queued instead of applied.
      backgroundThrottling: false
    }
  })

  // Store reference to mainWindow globally
  global.mainWindow = mainWindow
  // The toolbar follows the main window's position and visibility on its own
  createToolbarWindow(mainWindow)

  // A run that recorded an interview asks for a file name on the way out. It
  // holds the close open, so this has to be installed before the window can be
  // closed at all.
  installRecordClosePrompt(mainWindow)

  mainWindow.setMenuBarVisibility(false)

  // Keep the native window title empty. Chromium's window picker (Edge/Chrome
  // "share a window") enumerates windows with WebRTC's kIgnoreUntitled flag and
  // drops the ones whose title is empty, so an untitled window never shows up in
  // the list. setContentProtection only blanks the pixels; it does not hide the
  // window from enumeration. The window is frameless, so no title is ever drawn.
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow.setTitle('')
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Dock visibility is handled at startup (index.ts) and via renderer sync
    // (settings.ts); the window's own show event must not force it back on.
    applyContentProtection(mainWindow)

    // Reclaim top position when other apps steal it
    let restoringTopmost = false
    mainWindow.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
      if (
        !restoringTopmost &&
        !isAlwaysOnTop &&
        mainWindow.isVisible() &&
        !mainWindow.isDestroyed()
      ) {
        // Only re-set the flag; avoid moveTop() to not disturb other window focus
        // Some window managers synchronously reject the change and emit false
        // again. The background guard can retry later; this handler must not recurse.
        restoringTopmost = true
        try {
          mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
        } finally {
          restoringTopmost = false
        }
      }
    })
  })

  mainWindow.on('show', () => {
    applyContentProtection(mainWindow)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
