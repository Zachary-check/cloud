import { app, ipcMain, nativeImage } from 'electron'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createNativeBackend } from './capture/native-backend'
import { createCaptureService, type CaptureBackend } from './capture/service'
import { settings } from './settings'
import {
  normalizeCaptureSettings,
  type CaptureCapabilities,
  type CaptureStatus
} from '../shared/capture'
import { takeWindowsScreenshot } from './windows-screenshot'
import {
  closeNativeOverlay,
  nativeAnswerEvent,
  nativeExecutable,
  nativeOverlayActive,
  openNativeOverlay
} from './native-overlay'

let status: CaptureStatus = { attempts: [], running: false, nativeWindow: false }
let engine: ReturnType<typeof createCaptureService> | null = null
let backend: CaptureBackend | null = null
let sequence = 0

function getBackend(): CaptureBackend {
  if (backend) return backend
  const native = createNativeBackend(nativeExecutable('capture-helper'))
  let nativeAvailable = existsSync(nativeExecutable('capture-helper'))
  let lastProbe = 0
  backend = {
    async capabilities() {
      if (
        nativeAvailable ||
        (existsSync(nativeExecutable('capture-helper')) && Date.now() - lastProbe > 5000)
      ) {
        lastProbe = Date.now()
        try {
          const capabilities = await native.capabilities()
          nativeAvailable = true
          return capabilities
        } catch {
          nativeAvailable = false
        }
      }
      return { native: false, windowsBuild: 0, methods: ['gdi'] }
    },
    async snapshot(signal) {
      return nativeAvailable ? native.snapshot(signal) : { windows: [] }
    },
    async capture(request) {
      if (nativeAvailable) return native.capture(request)
      if (request.display !== 'primary')
        throw new Error('当前采集组件不可用，请先将题目屏幕设为主显示器')
      const { screen } = await import('electron')
      const { width, height } = screen.getPrimaryDisplay().size
      const result = await takeWindowsScreenshot(width, height)
      const image = nativeImage.createFromBuffer(Buffer.from(result.image, 'base64'))
      const size = image.getSize()
      return {
        pixels: image.toBitmap(),
        width: size.width,
        height: size.height,
        stride: size.width * 4
      }
    }
  }
  return backend
}
function getEngine() {
  engine ??= createCaptureService({
    backend: getBackend(),
    getSettings: async () => normalizeCaptureSettings(settings),
    async encode(frame) {
      return nativeImage
        .createFromBitmap(Buffer.from(frame.pixels), {
          width: frame.width,
          height: frame.height,
          scaleFactor: 1
        })
        .toPNG()
        .toString('base64')
    },
    log(attempt) {
      try {
        appendFileSync(
          join(app.getPath('userData'), 'capture.log'),
          JSON.stringify({ at: new Date().toISOString(), ...attempt }) + '\n'
        )
      } catch {
        /* Diagnostics must never break capture. */
      }
    }
  })
  return engine
}
export function cancelPendingCapture(): void {
  sequence++
  engine?.cancel()
  status.running = false
}
export function getCaptureError(): string | undefined {
  return status.error
}
export async function captureWindowsScreen(): Promise<string | void> {
  const request = ++sequence
  status = { ...status, error: undefined, attempts: [], running: true }
  nativeAnswerEvent('status', '正在截取题目…')
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 20000)
  try {
    const result = await getEngine().capture({ signal: controller.signal })
    if (request !== sequence) return
    status = {
      platform: result.platform,
      method: result.mode,
      attempts: result.diagnostics,
      running: false,
      nativeWindow: nativeOverlayActive()
    }
    nativeAnswerEvent('status', `${result.platform.name} · 已获取题目画面，等待 AI`)
    return result.image
  } catch (error) {
    const failure = error as {
      code?: string
      message?: string
      diagnostics?: CaptureStatus['attempts']
    }
    if (request === sequence) {
      status = {
        attempts: failure.diagnostics ?? [],
        error:
          failure.code === 'CANCELLED'
            ? '截图超时，请重试或切换采集方式'
            : failure.message || '截图失败',
        running: false,
        nativeWindow: nativeOverlayActive()
      }
      nativeAnswerEvent('status', status.error)
    }
    return undefined
  } finally {
    clearTimeout(deadline)
    if (request === sequence) status.running = false
  }
}
export function initCaptureController(): void {
  ipcMain.handle(
    'capture:info',
    async (): Promise<{ capabilities: CaptureCapabilities; status: CaptureStatus }> => ({
      capabilities:
        process.platform === 'win32'
          ? await getBackend().capabilities()
          : { native: false, windowsBuild: 0, methods: ['gdi'] },
      status: { ...status, nativeWindow: nativeOverlayActive() }
    })
  )
  ipcMain.handle('capture:open-native', async () => {
    if (!settings.apiKey) throw new Error('请先填写 AI API Key')
    await openNativeOverlay(settings.toolbarHoverDelay)
    global.mainWindow?.hide()
  })
  ipcMain.handle('capture:close-native', () => closeNativeOverlay())
  app.on('before-quit', () => {
    cancelPendingCapture()
    closeNativeOverlay(true)
  })
}
