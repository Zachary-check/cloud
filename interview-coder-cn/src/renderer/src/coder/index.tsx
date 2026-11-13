import { useEffect, useRef } from 'react'
import { useSettingsStore } from '@/lib/store/settings'
import { useAppStore } from '@/lib/store/app'
import { useTranscriptionStore } from '@/lib/store/transcription'
import { useSolutionStore } from '@/lib/store/solution'
import { startAudioCapture, stopAudioCapture } from '@/lib/audio-capture'

import { AppHeader } from './AppHeader'
import { AppContent } from './AppContent'
import { AppStatusBar } from './AppStatusBar'
import { PrerequisitesChecker } from './PrerequisitesChecker'
import { TranscriptionBar } from './TranscriptionBar'

export default function CoderPage() {
  const { opacity, apiKey, dashscopeApiKey, workMode } = useSettingsStore()
  const { syncAppState } = useAppStore()
  const { setIsTranscribing, setTranscriptionText, clearText } = useTranscriptionStore()
  const { setErrorMessage } = useSolutionStore()
  const isStartingTranscription = useRef(false)

  useEffect(() => {
    // Every mode obeys the opacity setting, dual included. Dual mode already
    // makes both of its surfaces transparent (.dual-mode in main.css), so the
    // extra 20% written into the body left the window with no opaque pixel at
    // all — it read as "the window is gone" — and it overrode the setting, so
    // the opacity controls were dead exactly where they were needed.
    document.body.style.opacity = opacity.toString()
    return () => {
      document.body.style.opacity = ''
    }
  }, [opacity])

  useEffect(() => {
    const compact = workMode === 'dual' && Boolean(apiKey)
    void window.api.setCompactMode(compact)
    return () => {
      if (compact) void window.api.setCompactMode(false)
    }
  }, [workMode, apiKey])

  useEffect(() => {
    window.api.onAdjustOpacity((delta) => {
      useSettingsStore.getState().adjustOpacity(delta)
    })
    return () => {
      window.api.removeAdjustOpacityListener()
    }
  }, [])

  useEffect(() => {
    // The native click-through flag belongs to the main process and survives a
    // renderer reload; adopt its value rather than assuming the default, or the
    // UI and the window would disagree about whether clicks go through.
    void window.api.getAppState().then((state) => {
      syncAppState(state)
    })
    window.api.updateAppState({ inCoderPage: true })
    return () => {
      window.api.updateAppState({ inCoderPage: false })
    }
  }, [syncAppState])

  useEffect(() => {
    window.api.onSyncAppState((state) => {
      syncAppState(state)
    })
    return () => {
      window.api.removeSyncAppStateListener()
    }
  }, [syncAppState])

  useEffect(() => {
    let disposed = false
    let transcriptionRequest = 0

    const setTranscriptionEnabled = async (enabled: boolean) => {
      const currentlyTranscribing = useTranscriptionStore.getState().isTranscribing

      if (!enabled) {
        transcriptionRequest += 1
        stopAudioCapture()
        await window.api.stopTranscription()
        setIsTranscribing(false)
        return
      }

      if (currentlyTranscribing || isStartingTranscription.current) return

      const currentSettings = useSettingsStore.getState()
      if (!currentSettings.apiKey) {
        setErrorMessage('面试模式需要先配置 AI API Key')
        return
      }
      if (!currentSettings.dashscopeApiKey) {
        setErrorMessage('面试模式需要先在设置中配置百炼平台 API Key')
        return
      }

      isStartingTranscription.current = true
      const request = ++transcriptionRequest
      let started = false
      try {
        // Establish the ASR task first. Audio capture may produce its first
        // frames while the WebSocket is handshaking; the main process keeps a
        // short lead-in queue so those words are not lost.
        started = await window.api.startTranscription(currentSettings.dashscopeApiKey)
        if (!started || disposed || request !== transcriptionRequest) {
          if (started) await window.api.stopTranscription()
          return
        }

        const captured = await startAudioCapture((message) => {
          setIsTranscribing(false)
          setErrorMessage(message)
          void window.api.stopTranscription().catch((error) => {
            console.error('Failed to stop interrupted transcription:', error)
          })
        })
        if (!captured || disposed || request !== transcriptionRequest) {
          stopAudioCapture()
          await window.api.stopTranscription()
          return
        }

        setIsTranscribing(true)
        setErrorMessage(null)
      } catch (err) {
        console.error('Failed to start transcription:', err)
        stopAudioCapture()
        if (started) await window.api.stopTranscription()
        const detail = err instanceof Error ? err.message : '请检查音频权限'
        setErrorMessage(`启动语音转录失败：${detail}`)
      } finally {
        isStartingTranscription.current = false
      }
    }

    const handleToggle = () => {
      void setTranscriptionEnabled(!useTranscriptionStore.getState().isTranscribing)
    }

    window.api.onToggleTranscription(handleToggle)
    window.api.onTranscriptionModeChange((enabled) => {
      void setTranscriptionEnabled(enabled)
    })
    window.api.transcriptionRendererReady()

    return () => {
      disposed = true
      window.api.removeToggleTranscriptionListener()
      window.api.removeTranscriptionModeChangeListener()
      stopAudioCapture()
      void window.api.stopTranscription()
      setIsTranscribing(false)
    }
  }, [apiKey, dashscopeApiKey, setIsTranscribing, setErrorMessage])

  useEffect(() => {
    window.api.onTranscriptionText((data) => {
      setTranscriptionText(data.text)
    })
    window.api.onTranscriptionError((message) => {
      setErrorMessage(message)
      setIsTranscribing(false)
      stopAudioCapture()
    })
    window.api.onTranscriptionStopped(() => {
      setIsTranscribing(false)
      stopAudioCapture()
    })
    window.api.onTranscriptionCleared(() => {
      clearText()
    })

    return () => {
      window.api.removeTranscriptionTextListener()
      window.api.removeTranscriptionErrorListener()
      window.api.removeTranscriptionStoppedListener()
      window.api.removeTranscriptionClearedListener()
    }
  }, [setTranscriptionText, setErrorMessage, setIsTranscribing, clearText])

  return (
    <div
      className={`relative h-screen ${workMode === 'dual' ? 'dual-mode' : workMode === 'interview' ? 'interview-mode' : ''}`}
    >
      <AppHeader />
      {workMode === 'interview' && <TranscriptionBar />}
      <AppContent />
      {workMode === 'written' && <TranscriptionBar />}
      {workMode !== 'dual' && <AppStatusBar />}
      <PrerequisitesChecker />
    </div>
  )
}
