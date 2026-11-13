import { inspectFrame } from './quality'
import { capturePlan, selectPlatform } from '../../shared/capture'
import type {
  CaptureAttempt,
  CaptureCapabilities,
  CaptureFrame,
  CaptureMethod,
  CaptureSettings,
  CaptureWindow,
  PlatformId
} from '../../shared/capture'

export interface CaptureBackend {
  capabilities(): Promise<CaptureCapabilities>
  snapshot(signal?: AbortSignal): Promise<{ windows: CaptureWindow[] }>
  capture(request: {
    mode: CaptureMethod
    platform: PlatformId
    display: string
    signal: AbortSignal
  }): Promise<CaptureFrame>
}

export class CaptureError extends Error {
  constructor(
    public code: 'CANCELLED' | 'NO_READABLE_FRAME',
    message: string,
    public diagnostics: CaptureAttempt[]
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}

export function createCaptureService({
  backend,
  encode,
  getSettings,
  log = () => {}
}: {
  backend: CaptureBackend
  encode(frame: CaptureFrame): Promise<string>
  getSettings(): Promise<CaptureSettings>
  log?(entry: CaptureAttempt): void
}) {
  let active: AbortController | null = null
  let generation = 0
  const preferred = new Map<string, CaptureMethod>()
  const checkCurrent = (id: number, signal: AbortSignal) => {
    if (signal.aborted || id !== generation)
      throw new CaptureError('CANCELLED', '本次截图已取消', [])
  }
  return {
    cancel() {
      generation++
      active?.abort()
      active = null
    },
    reset() {
      preferred.clear()
    },
    async capture({ signal: parentSignal }: { signal?: AbortSignal } = {}) {
      const id = ++generation
      active?.abort()
      const controller = new AbortController()
      active = controller
      const { signal } = controller
      const onAbort = () => controller.abort()
      if (parentSignal?.aborted) controller.abort()
      parentSignal?.addEventListener('abort', onAbort, { once: true })
      const diagnostics: CaptureAttempt[] = []
      try {
        checkCurrent(id, signal)
        const settings = await getSettings()
        const [capabilities, snapshot] = await Promise.all([
          backend.capabilities(),
          backend.snapshot(signal).catch(() => ({ windows: [] }))
        ])
        checkCurrent(id, signal)
        const platform = selectPlatform(settings.capturePlatform, snapshot.windows)
        const cacheKey = `${platform.id}:${settings.captureDisplay}:${capabilities.windowsBuild}`
        const plan = capturePlan(platform, capabilities, settings.captureMethod)
        const cached = settings.captureMethod === 'auto' ? preferred.get(cacheKey) : null
        const routes =
          cached && plan.includes(cached)
            ? [cached, ...plan.filter((route) => route !== cached)]
            : plan
        let unreadableCandidate = false
        for (const mode of routes) {
          checkCurrent(id, signal)
          const started = Date.now()
          try {
            const frame = await backend.capture({
              mode,
              platform: platform.id,
              display: settings.captureDisplay,
              signal
            })
            checkCurrent(id, signal)
            const quality = inspectFrame(frame)
            const unresolved =
              mode !== 'gdi' && (frame.candidates ?? 0) > 0 && frame.reconstructed === 0
            unreadableCandidate ||= unresolved
            // A desktop-only fallback cannot establish that a protected target was read.
            const rejected =
              unresolved ||
              (mode === 'gdi' && unreadableCandidate && settings.captureMethod !== 'gdi')
            const attempt = {
              mode,
              platform: platform.id,
              status: rejected ? 'window-unreadable' : quality.status,
              durationMs: Date.now() - started
            }
            diagnostics.push(attempt)
            log(attempt)
            if (quality.status !== 'usable' || rejected) {
              if (preferred.get(cacheKey) === mode) preferred.delete(cacheKey)
              continue
            }
            const image = await encode(frame)
            checkCurrent(id, signal)
            preferred.set(cacheKey, mode)
            return { image, mode, platform, quality, diagnostics }
          } catch (error) {
            checkCurrent(id, signal)
            const attempt = {
              mode,
              platform: platform.id,
              status: 'error',
              durationMs: Date.now() - started,
              message: error instanceof Error ? error.message : '采集失败'
            }
            diagnostics.push(attempt)
            log(attempt)
            if (preferred.get(cacheKey) === mode) preferred.delete(cacheKey)
          }
        }
        throw new CaptureError(
          'NO_READABLE_FRAME',
          '未能读取清晰题目画面；已尝试可用采集方式，未提交给 AI。请查看采集诊断。',
          diagnostics
        )
      } finally {
        parentSignal?.removeEventListener('abort', onAbort)
        if (active === controller) active = null
      }
    }
  }
}
