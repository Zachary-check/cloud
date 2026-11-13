import { screen, type BrowserWindow, type Rectangle } from 'electron'

/**
 * Smallest overlap with a display that still lets the user grab the window.
 * A window parked fully outside every display cannot be reached with the mouse
 * again — the app looks frozen even though it is running fine.
 */
const MIN_VISIBLE = 48

function clampAxis(value: number, areaStart: number, areaSize: number, size: number): number {
  const lowest = areaStart - size + MIN_VISIBLE
  const highest = areaStart + areaSize - MIN_VISIBLE
  // Window larger than the screen: pin it to the work-area origin
  if (lowest > highest) return areaStart
  return Math.min(Math.max(value, lowest), highest)
}

/**
 * Pull a window position back onto the display it belongs to, keeping at least
 * MIN_VISIBLE pixels of it on screen on both axes. Partially off-screen
 * placement stays allowed; only the unreachable state is corrected.
 */
export function clampPositionToDisplays(
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number } {
  const target: Rectangle = screen.getDisplayMatching({ x, y, width, height }).workArea
  return {
    x: Math.round(clampAxis(x, target.x, target.width, width)),
    y: Math.round(clampAxis(y, target.y, target.height, height))
  }
}

/**
 * Recover a window whose position no longer overlaps any display — after the
 * monitors were rearranged, a display was unplugged, or it was moved too far by
 * the move shortcuts. Position only: setBounds() would round-trip the size
 * through the DIP conversion and inflate the window at fractional scaling.
 */
export function ensureWindowOnScreen(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return

  const bounds = window.getBounds()
  const next = clampPositionToDisplays(bounds.x, bounds.y, bounds.width, bounds.height)
  if (next.x === bounds.x && next.y === bounds.y) return

  window.setPosition(next.x, next.y)
}
