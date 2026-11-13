import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, desktopCapturer, nativeImage, screen } from 'electron'
import { captureWindowsScreen } from './capture-controller'
export { cancelPendingCapture, getCaptureError } from './capture-controller'

/**
 * desktopCapturer can hang (a wedged capture session, a display being hot-plugged
 * at that moment). Every screenshot consumer awaits this before it can send any
 * feedback, so a promise that never settles leaves the app looking frozen with
 * no error. Always settle.
 */
const CAPTURE_TIMEOUT_MS = 15_000

/** Width of the copy handed to the renderer for on-screen previews. */
const DISPLAY_THUMBNAIL_WIDTH = 640

/** Marker that the one-off capture benchmark has already run */
const PROBE_MARKER = 'probe DONE'

let cachedPreview: { image: string; preview: string } | null = null

function perfLogPath(): string {
  return join(app.getPath('userData'), 'perf.log')
}

/**
 * Keep backend and phase timings so capture latency can be checked in a
 * packaged build. Never log image data.
 */
function traceCapture(message: string): void {
  try {
    appendFileSync(perfLogPath(), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Diagnostics only — never let logging break a screenshot
  }
}

/**
 * The preview in the main window is a couple of hundred pixels wide, so sending
 * it the full-screen base64 costs a multi-megabyte IPC serialisation plus a
 * full-resolution bitmap decode for something that renders as a thumbnail. The
 * model still receives the original image from `conversationMessages`; only the
 * preview is downscaled. Kept as PNG so the renderer's `data:image/png` prefix
 * stays correct.
 */
export function toDisplayThumbnail(base64Data: string): string {
  if (cachedPreview?.image === base64Data) return cachedPreview.preview
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(base64Data, 'base64'))
    const { width } = image.getSize()
    if (!width || width <= DISPLAY_THUMBNAIL_WIDTH) return base64Data
    const preview = image.resize({ width: DISPLAY_THUMBNAIL_WIDTH }).toPNG().toString('base64')
    cachedPreview = { image: base64Data, preview }
    return preview
  } catch {
    return base64Data
  }
}

export function takeScreenshot(): Promise<string | void> {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve()

  // Get the primary display's size.
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.size

  const startedAt = Date.now()
  if (process.platform === 'win32') {
    return captureWindowsScreen()
  }
  const capture = desktopCapturer
    .getSources({ types: ['screen'], thumbnailSize: { width, height } })
    .then((sources) => {
      const grabbedAt = Date.now()
      if (!sources.length) {
        traceCapture(`capture ${width}x${height} getSources=${grabbedAt - startedAt}ms empty`)
        return undefined
      }
      const screenshot = sources[0]?.thumbnail.toPNG()
      const encodedAt = Date.now()
      const base64Data = screenshot.toString('base64')
      const convertedAt = Date.now()
      traceCapture(
        `capture ${width}x${height} getSources=${grabbedAt - startedAt}ms ` +
          `toPNG=${encodedAt - grabbedAt}ms base64=${convertedAt - encodedAt}ms ` +
          `bytes=${screenshot.length} total=${convertedAt - startedAt}ms`
      )
      return base64Data
    })
    .catch((error) => {
      traceCapture(`capture failed after ${Date.now() - startedAt}ms: ${String(error)}`)
      console.error('Error taking screenshot:', error)
      return undefined
    })

  return new Promise<string | void>((resolve) => {
    const timer = setTimeout(() => {
      console.error('Screenshot timed out after', CAPTURE_TIMEOUT_MS, 'ms')
      traceCapture(`capture timed out after ${Date.now() - startedAt}ms`)
      resolve(undefined)
    }, CAPTURE_TIMEOUT_MS)

    capture.then((result) => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

/**
 * Measure what a capture actually costs, once, a few seconds after startup.
 *
 * The legacy backend is only used outside Windows. Elapsed capture timings do
 * not by themselves measure how long the main thread was blocked.
 */
export function scheduleCaptureProbe(): void {
  if (process.platform === 'win32') return
  try {
    if (readFileSync(perfLogPath(), 'utf8').includes(PROBE_MARKER)) return
  } catch {
    // No log yet: this is the first launch, which is exactly when to measure
  }
  setTimeout(() => {
    void runCaptureProbe()
  }, 4000)
}

async function runCaptureProbe(): Promise<void> {
  let width = 0
  let height = 0
  try {
    const size = screen.getPrimaryDisplay().size
    width = size.width
    height = size.height
  } catch (error) {
    traceCapture(`probe display failed: ${String(error)}`)
    return
  }

  const variants: Array<[string, { width: number; height: number }]> = [
    ['full', { width, height }],
    ['half', { width: Math.round(width / 2), height: Math.round(height / 2) }],
    ['zero', { width: 0, height: 0 }]
  ]

  for (const [label, size] of variants) {
    const startedAt = Date.now()
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
      const thumb = sources[0]?.thumbnail.getSize()
      traceCapture(
        `probe ${label} getSources=${Date.now() - startedAt}ms sources=${sources.length} ` +
          `thumb=${thumb ? `${thumb.width}x${thumb.height}` : 'none'}`
      )
    } catch (error) {
      traceCapture(`probe ${label} failed: ${String(error)}`)
    }
  }

  traceCapture(PROBE_MARKER)
}
