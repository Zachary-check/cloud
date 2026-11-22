export const CAPTURE_PLATFORMS = [
  { id: 'general', name: '通用', aliases: [], processes: [], nativeWindow: false },
  {
    id: 'shixizhi',
    name: '华为时习知',
    aliases: ['时习知', 'ilearning', '华为机考', 'huawei'],
    processes: ['shixizhiclient'],
    nativeWindow: false
  },
  {
    id: 'iguokao',
    name: '国考云',
    aliases: ['iguokao', '国聘', '国考云客户端'],
    processes: ['国考云'],
    nativeWindow: false
  },
  {
    id: 'eztest',
    name: '易考锁屏客户端',
    aliases: ['易考', 'eztest', '易考锁屏', 'ata 易考'],
    processes: ['eztest'],
    nativeWindow: true
  }
] as const

export type PlatformId = (typeof CAPTURE_PLATFORMS)[number]['id']
export type CaptureMethod = 'gdi' | 'sharedSurface' | 'gpuChild' | 'printWindow'
export interface CaptureWindow {
  process: string
  foreground?: boolean
  fullscreen?: boolean
  protected?: boolean
}
export interface CaptureCapabilities {
  methods: CaptureMethod[]
  windowsBuild: number
  native: boolean
  displays?: { id: string; name: string; width: number; height: number }[]
}
export interface PlatformSelection {
  id: PlatformId
  name: string
  nativeWindow: boolean
  source: 'chosen' | 'detected' | 'general'
}
export interface CaptureSettings {
  capturePlatform: 'auto' | PlatformId
  captureMethod: 'auto' | CaptureMethod
  captureDisplay: string
}
export interface CaptureFrame {
  pixels: Uint8Array
  width: number
  height: number
  stride: number
  candidates?: number
  reconstructed?: number
}
export interface FrameQuality {
  status: 'blank' | 'obscured' | 'usable'
  blackRatio: number
  edgeRatio: number
  rectangleRatio: number
  sampledWidth: number
  sampledHeight: number
}
export interface CaptureAttempt {
  mode: CaptureMethod
  platform: PlatformId
  status: string
  durationMs: number
  message?: string
}
export interface CaptureStatus {
  platform?: PlatformSelection
  method?: CaptureMethod
  attempts: CaptureAttempt[]
  error?: string
  running: boolean
  nativeWindow: boolean
}

export function normalizeCaptureSettings(input: Partial<CaptureSettings>): CaptureSettings {
  const platform = input.capturePlatform
  const method = input.captureMethod
  return {
    capturePlatform:
      platform === 'auto' || CAPTURE_PLATFORMS.some((item) => item.id === platform)
        ? platform!
        : 'auto',
    captureMethod:
      method && ['auto', 'gdi', 'sharedSurface', 'gpuChild', 'printWindow'].includes(method)
        ? method
        : 'auto',
    captureDisplay:
      typeof input.captureDisplay === 'string' && input.captureDisplay.length <= 80
        ? input.captureDisplay
        : 'primary'
  }
}

export function selectPlatform(
  selection: CaptureSettings['capturePlatform'],
  windows: CaptureWindow[] = []
): PlatformSelection {
  if (selection && selection !== 'auto') {
    const item = CAPTURE_PLATFORMS.find((item) => item.id === selection) ?? CAPTURE_PLATFORMS[0]
    return { id: item.id, name: item.name, nativeWindow: item.nativeWindow, source: 'chosen' }
  }
  for (const window of windows) {
    if (!(window.foreground || window.fullscreen || window.protected)) continue
    const process = String(window.process ?? '')
      .trim()
      .toLowerCase()
      .replace(/\.exe$/, '')
    const item = CAPTURE_PLATFORMS.find((item) =>
      (item.processes as readonly string[]).includes(process)
    )
    if (item)
      return { id: item.id, name: item.name, nativeWindow: item.nativeWindow, source: 'detected' }
  }
  return { id: 'general', name: '通用', nativeWindow: false, source: 'general' }
}

export function capturePlan(
  platform: PlatformSelection,
  capabilities: CaptureCapabilities,
  manualMode: CaptureSettings['captureMethod'] = 'auto'
): CaptureMethod[] {
  const available = new Set(capabilities.methods)
  const preferred: CaptureMethod =
    manualMode !== 'auto'
      ? manualMode
      : platform.id === 'shixizhi' &&
          capabilities.windowsBuild >= 22000 &&
          available.has('gpuChild')
        ? 'gpuChild'
        : platform.id === 'general'
          ? 'gdi'
          : 'sharedSurface'
  return [
    ...new Set<CaptureMethod>([preferred, 'sharedSurface', 'gpuChild', 'printWindow', 'gdi'])
  ].filter((method) => available.has(method))
}
