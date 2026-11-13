import { useEffect, useRef } from 'react'
import { Camera, HelpCircle, SettingsIcon, X } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/lib/store/app'
import { useSettingsStore } from '@/lib/store/settings'

export function AppHeader() {
  const navigate = useNavigate()
  const { ignoreMouse } = useAppStore()
  const workMode = useSettingsStore((state) => state.workMode)
  const toolbarHoverDelay = useSettingsStore((state) => state.toolbarHoverDelay)
  const isDualMode = workMode === 'dual'
  const screenshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelScreenshotTimer = () => {
    if (!screenshotTimer.current) return
    clearTimeout(screenshotTimer.current)
    screenshotTimer.current = null
  }

  useEffect(() => cancelScreenshotTimer, [])

  const startScreenshotTimer = () => {
    if (!toolbarHoverDelay) return
    cancelScreenshotTimer()
    screenshotTimer.current = setTimeout(() => {
      screenshotTimer.current = null
      void window.api.triggerAction('takeScreenshot')
    }, toolbarHoverDelay)
  }

  return (
    <div id="app-header" className="flex items-center text-white">
      <div className={isDualMode ? 'flex-1' : 'mx-auto'}>{!isDualMode && '截屏解题助手'}</div>
      <div className={`actions ${ignoreMouse ? 'pointer-events-none' : ''}`}>
        {isDualMode && (
          <Button
            variant="ghost"
            className="size-8 cursor-pointer text-gray-100 hover:text-white"
            onMouseEnter={startScreenshotTimer}
            onMouseLeave={cancelScreenshotTimer}
            onClick={() => {
              cancelScreenshotTimer()
              void window.api.triggerAction('takeScreenshot')
            }}
            aria-label="截图答题"
          >
            <Camera />
          </Button>
        )}
        <Button
          variant="ghost"
          className="size-8 cursor-pointer hover:opacity-50"
          onClick={() => navigate('/settings')}
        >
          <SettingsIcon />
        </Button>
        {!isDualMode && (
          <Button
            variant="ghost"
            className="size-8 cursor-pointer hover:opacity-50"
            onClick={() => navigate('/help')}
          >
            <HelpCircle />
          </Button>
        )}
        <Button
          variant="ghost"
          className="size-8 cursor-pointer hover:opacity-50 hover:text-red-500"
          onClick={() => window.close()}
        >
          <X />
        </Button>
      </div>
    </div>
  )
}
