import { useCallback, useEffect, useState } from 'react'
import { Camera, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/lib/store/settings'
import {
  CAPTURE_PLATFORMS,
  type CaptureCapabilities,
  type CaptureMethod,
  type CaptureStatus,
  type PlatformId
} from '../../../shared/capture'

const METHOD_NAMES: Record<CaptureMethod, string> = {
  gdi: '常规截图',
  sharedSurface: '共享表面',
  gpuChild: 'GPU 子窗口',
  printWindow: '窗口绘制'
}
export function CaptureSettingsCard() {
  const { capturePlatform, captureMethod, captureDisplay, updateSetting } = useSettingsStore()
  const [info, setInfo] = useState<{
    capabilities: CaptureCapabilities
    status: CaptureStatus
  } | null>(null)
  const [message, setMessage] = useState('')
  const [opening, setOpening] = useState(false)
  const refresh = useCallback(async () => {
    try {
      setInfo(await window.api.getCaptureInfo())
    } catch {
      setMessage('无法读取采集组件状态，请重启客户端后重试')
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  async function openNative() {
    setOpening(true)
    setMessage('')
    try {
      updateSetting('workMode', 'written')
      await window.api.updateAppSettings({ workMode: 'written' })
      await window.api.openNativeAnswer()
      window.location.hash = '/'
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method [^:]*: /, '')
          : '原生答题窗启动失败'
      )
    } finally {
      setOpening(false)
    }
  }
  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-5 space-y-4"
      aria-label="截图与客户端兼容"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <Camera className="h-4 w-4" />
          截图与客户端兼容
        </h2>
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          刷新诊断
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          考试平台
          <select
            aria-label="考试平台"
            className="block w-full rounded border border-gray-300 bg-white px-3 py-2"
            value={capturePlatform}
            onChange={(event) =>
              updateSetting('capturePlatform', event.target.value as 'auto' | PlatformId)
            }
          >
            <option value="auto">自动识别</option>
            {CAPTURE_PLATFORMS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          优先采集方式
          <select
            aria-label="优先采集方式"
            className="block w-full rounded border border-gray-300 bg-white px-3 py-2"
            value={captureMethod}
            onChange={(event) =>
              updateSetting('captureMethod', event.target.value as 'auto' | CaptureMethod)
            }
          >
            <option value="auto">按平台自动选择</option>
            {Object.entries(METHOD_NAMES).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        题目所在屏幕
        <select
          aria-label="题目所在屏幕"
          className="block w-full rounded border border-gray-300 bg-white px-3 py-2"
          value={captureDisplay}
          onChange={(event) => updateSetting('captureDisplay', event.target.value)}
        >
          <option value="primary">主显示器</option>
          {info?.capabilities.displays?.map((display, index) => (
            <option key={display.id} value={display.id}>
              显示器 {index + 1} · {display.width} × {display.height}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs leading-relaxed text-gray-500">
        时习知优先匹配系统支持的 GPU
        采集，国考云与易考优先尝试共享表面。遇到黑屏会自动尝试其他方式，仍无法读取时会停止本次 AI
        请求。兼容效果需要在对应客户端和电脑上实际验证。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={opening || !info?.capabilities.native}
          onClick={() => void openNative()}
        >
          {opening ? '正在启动…' : '打开原生笔试窗'}
        </Button>
        <span className="text-xs text-gray-500">
          易考锁屏场景可选；悬停或点击原生按钮截题、加页、复制和翻页。
        </span>
      </div>
      <p className="text-xs text-gray-500">
        采集组件：{info?.capabilities.native ? 'Windows 原生组件' : '系统通用方式'}
        {info?.capabilities.windowsBuild
          ? ` · Windows build ${info.capabilities.windowsBuild}`
          : ''}
      </p>
      {info?.status.method && (
        <p className="text-sm">
          最近成功：{info.status.platform?.name} · {METHOD_NAMES[info.status.method]}
        </p>
      )}
      {(message || info?.status.error) && (
        <p role="alert" className="text-sm text-amber-700">
          {message || info?.status.error}
        </p>
      )}
      {!!info?.status.attempts.length && (
        <ul className="space-y-1 text-xs text-gray-500">
          {info.status.attempts.map((attempt, index) => (
            <li key={index}>
              {METHOD_NAMES[attempt.mode]} ·{' '}
              {attempt.status === 'usable'
                ? '成功'
                : attempt.status === 'blank' || attempt.status === 'obscured'
                  ? '画面为空或被遮挡'
                  : attempt.status === 'window-unreadable'
                    ? '目标窗口未能读取'
                    : '采集失败'}{' '}
              · {attempt.durationMs} ms
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
