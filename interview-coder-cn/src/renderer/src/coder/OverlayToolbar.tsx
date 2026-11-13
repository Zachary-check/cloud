import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  getToolbarActions,
  resolveToolbarAction,
  type ToolbarActionName
} from '@/lib/toolbar-actions'
import type { WorkMode } from '@/lib/store/settings'
import type { LucideIcon } from 'lucide-react'

/**
 * Dwell time used when the stored setting is 0. The window is mouse-transparent
 * (see main/toolbar-window.ts), so hovering is the only trigger it has — a
 * "clicks only" setting would leave the bar completely inert.
 */
const FALLBACK_DWELL_MS = 1000

/**
 * Toolbar rendered in its own always-on-top window above the main window.
 *
 * That window never receives mouse events: it is mouse-transparent so Windows
 * keeps the cursor shape of whatever is underneath (a hand stays a hand), which
 * is the whole point — the main window is hidden from screen capture but the
 * cursor is not, so a cursor that snaps back to an arrow would give the bar
 * away. The consequences shape this file:
 *
 * - no clicks and no synthetic mouseenter: dwell uses only the OS cursor
 *   samples from main plus coordinate hit testing, never per-button handlers;
 * - no resize handles: a drag cannot start without a pointerdown;
 * - buttons carry no `title`: a native tooltip would be drawn outside the
 *   window and therefore not covered by its content protection.
 */
export function OverlayToolbar() {
  const [hoverDelay, setHoverDelay] = useState(0)
  // The mode button draws a different icon per mode, and this window never sees
  // the settings store updates made in the main window
  const [workMode, setWorkMode] = useState<WorkMode>('written')
  const [textOnly, setTextOnly] = useState(true)
  const [backgroundTheme, setBackgroundTheme] = useState<'light' | 'dark'>('light')
  const [dwelling, setDwelling] = useState<ToolbarActionName | null>(null)
  /** Bumped on every arm so the progress bar restarts, even on the same button */
  const [dwellRound, setDwellRound] = useState(0)

  // This window has its own settings store copy, so main pushes the live value
  useEffect(() => {
    let disposed = false
    let receivedSettings = false
    let receivedTheme = false
    window.api.onSyncToolbarSettings(({ hoverDelay, workMode, textOnlyAnswers }) => {
      receivedSettings = true
      setHoverDelay(hoverDelay || 0)
      setWorkMode(workMode)
      setTextOnly(textOnlyAnswers)
    })
    window.api.onBackgroundTheme((theme) => {
      receivedTheme = true
      setBackgroundTheme(theme)
    })
    void window.api
      .getAppSettings()
      .then((settings) => {
        if (disposed || receivedSettings) return
        setHoverDelay(settings.toolbarHoverDelay || 0)
        setWorkMode(settings.workMode)
        setTextOnly(settings.textOnlyAnswers !== false)
      })
      .catch(() => {})
    void window.api
      .getBackgroundTheme()
      .then((theme) => {
        if (!disposed && !receivedTheme) setBackgroundTheme(theme)
      })
      .catch(() => {})
    return () => {
      disposed = true
      window.api.removeSyncToolbarSettingsListener()
      window.api.removeBackgroundThemeListener()
    }
  }, [])

  const delay = hoverDelay > 0 ? hoverDelay : FALLBACK_DWELL_MS
  const isDualMode = workMode === 'dual'

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let counting: ToolbarActionName | null = null
    // Set once a button has fired; it stays inert until the pointer leaves it,
    // so parking the mouse there cannot fire it over and over
    let fired: ToolbarActionName | null = null

    const cancel = () => {
      if (timer) clearTimeout(timer)
      timer = null
      counting = null
      setDwelling(null)
    }

    const actionAt = (x: number, y: number): ToolbarActionName | null => {
      const element = document.elementFromPoint(x, y)
      const host = element?.closest('[data-toolbar-action]')
      const action = host instanceof HTMLElement ? host.dataset.toolbarAction : undefined
      return (action as ToolbarActionName | undefined) ?? null
    }

    const applyPoint = (x: number, y: number) => {
      const action = actionAt(x, y)
      if (!action) {
        cancel()
        fired = null
        return
      }
      if (fired === action || counting === action) return

      cancel()
      fired = null
      counting = action
      setDwelling(action)
      setDwellRound((round) => round + 1)
      timer = setTimeout(() => {
        timer = null
        counting = null
        fired = action
        setDwelling(null)
        void window.api.triggerAction(action)
      }, delay)
    }

    // The OS sampler also sends null outside the toolbar. Use that single
    // source for both entry and exit: a forwarded DOM mouseleave can arrive
    // while the OS still reports the pointer over this click-through window,
    // unlock the fired action, and repeatedly step opacity without movement.
    window.api.onToolbarCursor((point) => {
      if (point) applyPoint(point.x, point.y)
      else {
        cancel()
        fired = null
      }
    })
    return () => {
      cancel()
      window.api.removeToolbarCursorListener()
    }
  }, [delay, isDualMode])

  return (
    <div
      className={`overlay-toolbar overlay-toolbar-root ${textOnly ? 'text-only-mode' : ''}`}
      data-background-theme={backgroundTheme}
    >
      {getToolbarActions(workMode).map((entry) => {
        const { action, Icon, label } = resolveToolbarAction(entry, workMode)
        return (
          <ToolbarButton
            key={action}
            action={action}
            Icon={Icon}
            label={label}
            isDwelling={dwelling === action}
            dwellRound={dwellRound}
            dwellMs={delay}
          />
        )
      })}
    </div>
  )
}

/** Painted only: it never receives a click — see the dwell loop in OverlayToolbar */
function ToolbarButton({
  action,
  Icon,
  label,
  isDwelling,
  dwellRound,
  dwellMs
}: {
  action: ToolbarActionName
  Icon: LucideIcon
  label: string
  isDwelling: boolean
  dwellRound: number
  dwellMs: number
}) {
  return (
    <Button variant="ghost" size="icon" data-toolbar-action={action} aria-label={label}>
      <Icon />
      {isDwelling && (
        <span
          key={dwellRound}
          className="dwell-progress"
          style={{ animationDuration: `${dwellMs}ms` }}
        />
      )}
    </Button>
  )
}
