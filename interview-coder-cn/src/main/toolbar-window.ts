import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import { DUAL_TOOLBAR_WIDTH } from '../shared/toolbar-layout'

const TOOLBAR_WIDTH = 404
const TOOLBAR_HEIGHT = 44
const TOOLBAR_INSET = 4
/** Mirrors the renderer's default opacity setting, until the renderer syncs the real one */
const DEFAULT_OPACITY = 0.8

let toolbarWindow: BrowserWindow | null = null
let ownerWindow: BrowserWindow | null = null
/** Whether the renderer wants the toolbar on screen (main page + enabled in settings) */
let isToolbarWanted = false
let toolbarOpacity = DEFAULT_OPACITY
let toolbarWorkMode: 'written' | 'interview' | 'dual' = 'written'
/**
 * The size the user dragged the toolbar to, tracked here instead of being read
 * back off the window. Windows encloses in both directions of the DIP <-> pixel
 * conversion, so at fractional display scaling (125% / 150% / 175%) a
 * getBounds() -> setBounds() round trip returns a window one pixel larger.
 * syncToolbarBounds runs on every move event of a window drag, which turned
 * that into unbounded growth: the bar inflates until it covers the screen,
 * swallowing clicks and wrecking screenshots.
 */
let toolbarSize = { width: TOOLBAR_WIDTH, height: TOOLBAR_HEIGHT }
/**
 * How often the pointer position is sampled for the toolbar. The window is
 * mouse-transparent and the forwarded mousemove stream is a Chromium nicety we
 * do not want to bet the feature on, so the position is read from the OS
 * instead: both this and the window bounds are in DIP, which makes the
 * subtraction below meaningful at any display scaling.
 */
const CURSOR_POLL_MS = 100
let cursorTimer: NodeJS.Timeout | null = null

/**
 * Click-through alternative to the global shortcuts: a small always-on-top
 * window of buttons, glued above the main window and hidden along with it.
 */
export function createToolbarWindow(parent: BrowserWindow): void {
  toolbarWindow = new BrowserWindow({
    width: TOOLBAR_WIDTH,
    height: TOOLBAR_HEIGHT,
    frame: false,
    transparent: true,
    hasShadow: false,
    // Native resize toggling breaks transparency on Windows; renderer handles own resizing.
    resizable: false,
    // Clicking a button must never pull focus away from what the user is doing
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    parent,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Hover dwell runs on setTimeout in this renderer; soft-hiding the main
      // window parks it off-screen, which makes Windows report the toolbar as
      // occluded, and with throttling on Chromium freezes it until it is
      // focused again — so the dwell timer never fires.
      backgroundThrottling: false
    }
  })
  ownerWindow = parent

  toolbarWindow.setMenuBarVisibility(false)
  toolbarWindow.setOpacity(toolbarOpacity)
  toolbarWindow.setAlwaysOnTop(true, 'screen-saver', 2)
  toolbarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  toolbarWindow.setContentProtection(true)
  // Mouse-transparent, always. Windows answers WM_SETCURSOR from the window the
  // pointer actually hits, so a bar that accepts the mouse has to answer for
  // itself and snaps the pointer back to an arrow — a visible tell on a shared
  // screen, where the window is not captured but the cursor is. Clicking is gone
  // by design; hover uses only the cursor poller below. Forwarded DOM events
  // must not compete with OS samples to unlock an already executed action.
  toolbarWindow.setIgnoreMouseEvents(true, { forward: true })

  parent.on('move', syncToolbarBounds)
  parent.on('resize', syncToolbarBounds)
  parent.on('show', showToolbar)
  parent.on('hide', hideToolbar)
  parent.on('closed', () => {
    stopCursorTracking()
    if (toolbarWindow && !toolbarWindow.isDestroyed()) toolbarWindow.close()
    toolbarWindow = null
    ownerWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    toolbarWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/toolbar`)
  } else {
    toolbarWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'toolbar' })
  }
}

/** Park the toolbar right above the main window, kept inside the current display */
function syncToolbarBounds(): void {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return
  if (!ownerWindow || ownerWindow.isDestroyed()) return

  const mainBounds = ownerWindow.getBounds()
  const workArea = screen.getDisplayMatching(mainBounds).workArea
  // Keep whatever size the user dragged it to — but never read it back off the
  // window; that round trip is what inflates the toolbar (see toolbarSize)
  const width = Math.min(
    toolbarWorkMode === 'dual' ? DUAL_TOOLBAR_WIDTH : toolbarSize.width,
    workArea.width
  )
  const height = Math.min(toolbarSize.height, workArea.height)
  toolbarWindow.setBounds({
    x: Math.min(Math.max(mainBounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.max(workArea.y, mainBounds.y - height - TOOLBAR_INSET),
    width,
    height
  })
}

/**
 * Record a size the user dragged the toolbar to, so that syncToolbarBounds can
 * reapply it without ever reading it back from the window.
 */
export function noteToolbarResize(window: BrowserWindow, width: number, height: number): void {
  if (window !== toolbarWindow) return
  toolbarSize = { width, height }
}

/**
 * Feed the toolbar renderer the pointer position, relative to its own bounds
 * (null while the pointer is elsewhere). Nothing in that window can receive a
 * mouse event — it is click-through — so this is what makes hover-to-trigger
 * work at all.
 */
function startCursorTracking(): void {
  if (cursorTimer) return
  cursorTimer = setInterval(() => {
    if (!toolbarWindow || toolbarWindow.isDestroyed() || !toolbarWindow.isVisible()) return
    const point = screen.getCursorScreenPoint()
    const bounds = toolbarWindow.getBounds()
    const inside =
      point.x >= bounds.x &&
      point.y >= bounds.y &&
      point.x < bounds.x + bounds.width &&
      point.y < bounds.y + bounds.height
    toolbarWindow.webContents.send(
      'toolbar-cursor',
      inside ? { x: point.x - bounds.x, y: point.y - bounds.y } : null
    )
  }, CURSOR_POLL_MS)
}

function stopCursorTracking(): void {
  if (!cursorTimer) return
  clearInterval(cursorTimer)
  cursorTimer = null
}

/**
 * Stop sampling while the main process is busy. Encoding a full-screen capture
 * blocks this thread for a few hundred milliseconds; samples taken meanwhile
 * queue up on the interval and then arrive in one burst, which the renderer sees
 * as a stutter right after a hover-triggered screenshot.
 */
export function suspendCursorTracking(): void {
  stopCursorTracking()
}

/** Resume sampling, unless the toolbar is not on screen anymore */
export function resumeCursorTracking(): void {
  if (!toolbarWindow || toolbarWindow.isDestroyed() || !toolbarWindow.isVisible()) return
  startCursorTracking()
}

/** Show the toolbar only if the renderer asked for it and the main window is on screen */
export function showToolbar(): void {
  if (!isToolbarWanted) return
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return
  if (!ownerWindow || ownerWindow.isDestroyed() || !ownerWindow.isVisible()) return

  syncToolbarBounds()
  toolbarWindow.showInactive()
  startCursorTracking()
}

/**
 * Whether a click on the toolbar would actually land: the renderer wants it,
 * the window exists, and the main window is on screen. Used to check that the
 * user keeps an escape route before click-through is enabled.
 */
export function isToolbarAvailable(): boolean {
  return (
    isToolbarWanted &&
    !!toolbarWindow &&
    !toolbarWindow.isDestroyed() &&
    !!ownerWindow &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.isVisible()
  )
}

export function hideToolbar(): void {
  // Stop before hiding: the poller stops itself once the window is invisible,
  // but leaving the interval running until the next tick is pointless work
  stopCursorTracking()
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return
  toolbarWindow.hide()
}

/**
 * The renderer owns whether the toolbar belongs on screen (main page + the
 * `showOverlayToolbar` setting); main only decides when it can actually show.
 */
export function setToolbarWanted(wanted: boolean): void {
  isToolbarWanted = wanted
  if (wanted) {
    showToolbar()
  } else {
    hideToolbar()
  }
}

/**
 * Keep the toolbar as translucent as the main window. The main window applies
 * opacity to its body via CSS; the toolbar is nothing but that bar, so the same
 * value is applied to the whole window (no-op on Linux).
 */
export function setToolbarOpacity(opacity: number): void {
  toolbarOpacity = opacity
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return
  toolbarWindow.setOpacity(opacity)
}

/**
 * The toolbar lives in its own renderer, so it never sees the settings store
 * updates made in the main window; push the ones it needs over IPC instead. The
 * work mode is one of them: its button draws a different icon per mode.
 */
export function syncToolbarSettings(
  hoverDelay: number,
  workMode: 'written' | 'interview' | 'dual'
): void {
  const modeChanged = toolbarWorkMode !== workMode
  toolbarWorkMode = workMode
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return
  if (modeChanged && toolbarWindow.isVisible()) syncToolbarBounds()
  toolbarWindow.webContents.send('sync-toolbar-settings', { hoverDelay, workMode })
}

/** Reclaim the top spot alongside the main window, without ever revealing a hidden toolbar */
export function reassertToolbarTopMost(level: number, aggressive: boolean): void {
  if (!toolbarWindow || toolbarWindow.isDestroyed() || !toolbarWindow.isVisible()) return
  if (aggressive || !toolbarWindow.isAlwaysOnTop()) {
    toolbarWindow.setAlwaysOnTop(true, 'screen-saver', level)
  }
  if (aggressive) toolbarWindow.moveTop()
}
