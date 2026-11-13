import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, useLocation } from 'react-router'
import { Toaster } from 'sonner'
import CoderPage from '@/coder'
import SettingsPage from '@/settings'
import HelpPage from '@/help'
import { OverlayToolbar } from '@/coder/OverlayToolbar'
import { PRESET_SCENE_PROMPTS, useSettingsStore } from '@/lib/store/settings'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { getCloneableFields } from '@/lib/utils'
import { WindowResizeHandles } from '@/components/WindowResizeHandles'
import { RecordSavePrompt } from '@/components/RecordSavePrompt'

export default function App() {
  const isToolbar = /^#\/?toolbar(?:[/?]|$)/.test(window.location.hash)
  const [initialized, setInitialized] = useState(false)
  const settingsStore = useSettingsStore()
  const { shortcuts } = useShortcutsStore()

  useEffect(() => {
    if (isToolbar) return
    window.api.getAppSettings().then((settings) => {
      const blankFields = Object.keys(settings).filter((key) => {
        const rendererValue = settingsStore[key]
        // Only fill genuinely uninitialized renderer fields from main. A
        // persisted false/0/empty array is a deliberate user setting.
        return (
          settings[key] !== undefined &&
          settings[key] !== null &&
          (rendererValue === undefined || rendererValue === null || rendererValue === '')
        )
      })
      settingsStore.syncSettings(
        blankFields.reduce(
          (acc, key) => {
            acc[key] = settings[key]
            return acc
          },
          {} as Partial<typeof settingsStore>
        )
      )
      setInitialized(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (initialized && !isToolbar) {
      const syncedSettings = getCloneableFields(settingsStore)
      if (settingsStore.workMode === 'interview') {
        const savedPrompt = settingsStore.scenes.find((scene) => scene.id === 'interview')?.prompt
        // Apply the current oral-answer format even when localStorage contains
        // an older preset. Preserve saved customizations and the written scene.
        syncedSettings.customPrompt = [...new Set([savedPrompt, PRESET_SCENE_PROMPTS.interview])]
          .filter(Boolean)
          .join('\n\n')
      }
      window.api.updateAppSettings(syncedSettings)
    }
  }, [initialized, settingsStore, isToolbar])

  useEffect(() => {
    if (isToolbar) return
    window.api.initShortcuts(shortcuts)
    window.api.getShortcuts().then((shortcutsStatus) => {
      console.log('Shortcuts registered:', shortcutsStatus) // DEBUG: 主进程状态
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <HashRouter>
        <ToolbarVisibilityController />
        <WindowResizeController />
        <WorkModeController />
        <Routes>
          <Route index element={<CoderPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="help" element={<HelpPage />} />
          <Route path="toolbar" element={<OverlayToolbar />} />
        </Routes>
      </HashRouter>

      <Toaster />
      {/* Only the main window is asked to name the record before it closes */}
      <RecordSavePrompt />
    </>
  )
}

/** Resize the main window through renderer edges, including the compact mode. */
function WindowResizeController() {
  const location = useLocation()
  const resizable = useSettingsStore((state) => state.resizable)

  if (location.pathname === '/toolbar') return null
  return <WindowResizeHandles enabled={resizable} />
}

/**
 * The toolbar's mode button only asks for a flip; the renderer picks the next
 * value from its own live store, which is the copy that gets persisted.
 */
function WorkModeController() {
  const location = useLocation()

  useEffect(() => {
    // The toolbar window renders this app too, and must not write to the store:
    // its copy is stale, and syncing it back would clobber the real settings.
    if (location.pathname === '/toolbar') return
    window.api.onToggleWorkMode(() => {
      const { workMode, updateSetting } = useSettingsStore.getState()
      updateSetting('workMode', workMode === 'interview' ? 'written' : 'interview')
    })
    return () => {
      window.api.removeToggleWorkModeListener()
    }
  }, [location.pathname])

  return null
}

function ToolbarVisibilityController() {
  const location = useLocation()
  const showOverlayToolbar = useSettingsStore((state) => state.showOverlayToolbar)

  useEffect(() => {
    // The toolbar window renders this app too, but must not drive its own visibility
    if (location.pathname === '/toolbar') return
    void window.api.setToolbarVisible(location.pathname === '/' && showOverlayToolbar)
  }, [location.pathname, showOverlayToolbar])

  return null
}
