import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AppSettings } from '../main/settings'
import type { AppState } from '../main/state'
import type { InterviewKnowledgeDocument } from '../shared/interview-knowledge'
import type { InterviewTurnEnd, InterviewTurnStart } from '../shared/interview-turn'

// Custom APIs for renderer
const api = {
  // Get app settings
  getAppSettings: () => ipcRenderer.invoke('getAppSettings'),
  // Update app settings
  updateAppSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke('updateAppSettings', settings),

  // Resize transparent frameless windows without toggling Electron's native resizable style
  startWindowResize: (direction: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw') =>
    ipcRenderer.send('window-resize-start', direction),
  stopWindowResize: () => ipcRenderer.send('window-resize-stop'),
  setCompactMode: (compact: boolean) => ipcRenderer.invoke('setCompactMode', compact),

  // Update app state
  updateAppState: (state: Partial<AppState>) => ipcRenderer.invoke('updateAppState', state),
  // Authoritative state from main, used when the renderer (re)mounts
  getAppState: () => ipcRenderer.invoke('getAppState') as Promise<AppState>,
  // Listen for app state
  onSyncAppState: (callback: (state: AppState) => void) => {
    ipcRenderer.on('sync-app-state', (_event, state) => {
      callback(state)
    })
  },
  // Remove app state listener
  removeSyncAppStateListener: () => {
    ipcRenderer.removeAllListeners('sync-app-state')
  },

  // Init shortcuts
  initShortcuts: (shortcuts: Record<string, { action: string; key: string }>) =>
    ipcRenderer.invoke('initShortcuts', shortcuts),
  // Get shortcuts
  getShortcuts: () => ipcRenderer.invoke('getShortcuts'),
  // Update shortcuts
  updateShortcuts: (shortcuts: { action: string; key: string }[]) =>
    ipcRenderer.invoke('updateShortcuts', shortcuts),

  // Trigger the small set of user-facing actions exposed by the overlay toolbar.
  triggerAction: (
    action:
      | 'takeScreenshot'
      | 'appendScreenshot'
      | 'stopSolutionStream'
      | 'ignoreOrEnableMouse'
      | 'increaseOpacity'
      | 'decreaseOpacity'
      | 'pageUp'
      | 'pageDown'
      | 'moveMainWindowUp'
      | 'moveMainWindowDown'
      | 'moveMainWindowLeft'
      | 'moveMainWindowRight'
      | 'toggleTranscription'
      | 'toggleWorkMode'
      | 'clearTranscription'
  ) => ipcRenderer.invoke('triggerAction', action),
  setToolbarVisible: (visible: boolean) => ipcRenderer.invoke('setToolbarVisible', visible),

  // Settings the toolbar window needs, pushed from main (its own store is a separate copy)
  onSyncToolbarSettings: (
    callback: (settings: { hoverDelay: number; workMode: 'written' | 'interview' | 'dual' }) => void
  ) => {
    ipcRenderer.on('sync-toolbar-settings', (_event, settings) => {
      callback(settings)
    })
  },
  removeSyncToolbarSettingsListener: () => {
    ipcRenderer.removeAllListeners('sync-toolbar-settings')
  },

  // Pointer position inside the toolbar window, sampled by main because that
  // window is click-through and therefore receives no mouse events of its own
  onToolbarCursor: (callback: (point: { x: number; y: number } | null) => void) => {
    ipcRenderer.on('toolbar-cursor', (_event, point) => {
      callback(point)
    })
  },
  removeToolbarCursorListener: () => {
    ipcRenderer.removeAllListeners('toolbar-cursor')
  },

  // Listen for window opacity adjustments triggered by shortcuts
  onAdjustOpacity: (callback: (delta: number) => void) => {
    ipcRenderer.on('adjust-opacity', (_event, delta) => {
      callback(delta)
    })
  },
  removeAdjustOpacityListener: () => {
    ipcRenderer.removeAllListeners('adjust-opacity')
  },

  // Listen for screenshot events
  onScreenshotTaken: (callback: (screenshotData: string) => void) => {
    ipcRenderer.on('screenshot-taken', (_event, screenshotData) => {
      callback(screenshotData)
    })
  },
  // Remove screenshot listener
  removeScreenshotListener: () => {
    ipcRenderer.removeAllListeners('screenshot-taken')
  },

  // Listen for solution chunks
  onSolutionChunk: (callback: (chunk: string) => void) => {
    ipcRenderer.on('solution-chunk', (_event, chunk) => {
      callback(chunk)
    })
  },
  // Remove solution chunk listener
  removeSolutionChunkListener: () => {
    ipcRenderer.removeAllListeners('solution-chunk')
  },

  // Listen for the knowledge-base documents included in the latest interview prompt
  onKnowledgeSources: (callback: (sources: string[]) => void) => {
    ipcRenderer.on('knowledge-sources', (_event, sources) => {
      callback(Array.isArray(sources) ? sources : [])
    })
  },
  removeKnowledgeSourcesListener: () => {
    ipcRenderer.removeAllListeners('knowledge-sources')
  },

  // Stop solution stream
  stopSolutionStream: () => ipcRenderer.invoke('stopSolutionStream'),

  // Send follow-up question
  sendFollowUpQuestion: (question: string) => ipcRenderer.invoke('sendFollowUpQuestion', question),

  // Listen for solution completion
  onSolutionComplete: (callback: () => void) => {
    ipcRenderer.on('solution-complete', callback)
  },
  removeSolutionCompleteListener: () => {
    ipcRenderer.removeAllListeners('solution-complete')
  },

  onSolutionStopped: (callback: () => void) => {
    ipcRenderer.on('solution-stopped', callback)
  },
  removeSolutionStoppedListener: () => {
    ipcRenderer.removeAllListeners('solution-stopped')
  },

  onSolutionError: (callback: (message: string) => void) => {
    ipcRenderer.on('solution-error', (_event, message) => {
      callback(message)
    })
  },
  removeSolutionErrorListener: () => {
    ipcRenderer.removeAllListeners('solution-error')
  },

  // Told when a request fell back to the backup model, and why
  onModelFallback: (callback: (info: { model: string; reason: string }) => void) => {
    ipcRenderer.on('model-fallback', (_event, info) => callback(info))
  },
  removeModelFallbackListener: () => {
    ipcRenderer.removeAllListeners('model-fallback')
  },

  // Listen for scroll page up
  onScrollPageUp: (callback: () => void) => {
    ipcRenderer.on('scroll-page-up', callback)
  },
  // Remove scroll page up listener
  removeScrollPageUpListener: () => {
    ipcRenderer.removeAllListeners('scroll-page-up')
  },

  // Listen for screenshots-updated (gallery)
  onScreenshotsUpdated: (callback: (screenshots: string[]) => void) => {
    ipcRenderer.on('screenshots-updated', (_event, screenshots) => {
      callback(screenshots)
    })
  },
  removeScreenshotsUpdatedListener: () => {
    ipcRenderer.removeAllListeners('screenshots-updated')
  },

  // Listen for scroll page down
  onScrollPageDown: (callback: () => void) => {
    ipcRenderer.on('scroll-page-down', callback)
  },
  // Remove scroll page down listener
  removeScrollPageDownListener: () => {
    ipcRenderer.removeAllListeners('scroll-page-down')
  },

  // AI loading events
  onAiLoadingStart: (callback: () => void) => {
    ipcRenderer.on('ai-loading-start', callback)
  },
  onAiLoadingEnd: (callback: () => void) => {
    ipcRenderer.on('ai-loading-end', callback)
  },
  removeAiLoadingStartListener: () => {
    ipcRenderer.removeAllListeners('ai-loading-start')
  },
  removeAiLoadingEndListener: () => {
    ipcRenderer.removeAllListeners('ai-loading-end')
  },

  // Solution clear event (new session)
  onSolutionClear: (callback: () => void) => {
    ipcRenderer.on('solution-clear', callback)
  },
  removeSolutionClearListener: () => {
    ipcRenderer.removeAllListeners('solution-clear')
  },

  // Interview transcript: one turn per question, so previous answers stay visible
  onInterviewTurnStart: (callback: (turn: InterviewTurnStart) => void) => {
    ipcRenderer.on('interview-turn-start', (_event, turn) => callback(turn))
  },
  removeInterviewTurnStartListener: () => {
    ipcRenderer.removeAllListeners('interview-turn-start')
  },
  onInterviewTurnEnd: (callback: (turn: InterviewTurnEnd) => void) => {
    ipcRenderer.on('interview-turn-end', (_event, turn) => callback(turn))
  },
  removeInterviewTurnEndListener: () => {
    ipcRenderer.removeAllListeners('interview-turn-end')
  },
  onInterviewTurnsClear: (callback: () => void) => {
    ipcRenderer.on('interview-turns-clear', callback)
  },
  removeInterviewTurnsClearListener: () => {
    ipcRenderer.removeAllListeners('interview-turns-clear')
  },

  // Select screenshot save directory
  selectScreenshotDir: () => ipcRenderer.invoke('selectScreenshotDir') as Promise<string | null>,
  // Select where the interview Markdown transcript is written
  selectRecordDir: () => ipcRenderer.invoke('selectRecordDir') as Promise<string | null>,
  // Asked before the window closes, once this run recorded at least one turn
  onInterviewRecordCloseRequest: (callback: (session: { name: string; dir: string }) => void) => {
    ipcRenderer.on('interview-record-close-request', (_event, session) => callback(session))
  },
  removeInterviewRecordCloseRequestListener: () => {
    ipcRenderer.removeAllListeners('interview-record-close-request')
  },
  /** Keep the record under this name and let the app exit. */
  saveInterviewRecord: (name: string) =>
    ipcRenderer.invoke('interviewRecordSave', name) as Promise<
      { ok: true; name: string; path: string } | { ok: false; reason: string }
    >,
  /** Drop this run's record and let the app exit. */
  discardInterviewRecord: () =>
    ipcRenderer.invoke('interviewRecordDiscard') as Promise<{ ok: boolean }>,
  /** Back out of closing: the interview continues and the record keeps growing. */
  cancelInterviewRecordClose: () =>
    ipcRenderer.invoke('interviewRecordCancelClose') as Promise<{ ok: boolean }>,
  // Select Markdown files for the interview knowledge base
  selectInterviewKnowledgeFiles: (existingCount: number) =>
    ipcRenderer.invoke('selectInterviewKnowledgeFiles', existingCount) as Promise<
      InterviewKnowledgeDocument[]
    >,

  // Transcription
  startTranscription: (apiKey: string) =>
    ipcRenderer.invoke('start-transcription', apiKey) as Promise<boolean>,
  stopTranscription: () => ipcRenderer.invoke('stop-transcription'),
  transcriptionRendererReady: () => ipcRenderer.send('transcription-renderer-ready'),
  sendTranscriptionAudioChunk: (chunk: ArrayBuffer) =>
    ipcRenderer.send('transcription-audio-chunk', chunk),
  getTranscriptionText: () => ipcRenderer.invoke('get-transcription-text') as Promise<string>,

  onToggleTranscription: (callback: () => void) => {
    ipcRenderer.on('toggle-transcription', callback)
  },
  removeToggleTranscriptionListener: () => {
    ipcRenderer.removeAllListeners('toggle-transcription')
  },
  onTranscriptionText: (callback: (data: { text: string; isPartial: boolean }) => void) => {
    ipcRenderer.on('transcription-text', (_event, data) => callback(data))
  },
  removeTranscriptionTextListener: () => {
    ipcRenderer.removeAllListeners('transcription-text')
  },
  onTranscriptionError: (callback: (message: string) => void) => {
    ipcRenderer.on('transcription-error', (_event, message) => callback(message))
  },
  removeTranscriptionErrorListener: () => {
    ipcRenderer.removeAllListeners('transcription-error')
  },
  onTranscriptionStopped: (callback: () => void) => {
    ipcRenderer.on('transcription-stopped', callback)
  },
  removeTranscriptionStoppedListener: () => {
    ipcRenderer.removeAllListeners('transcription-stopped')
  },
  onTranscriptionCleared: (callback: () => void) => {
    ipcRenderer.on('transcription-cleared', callback)
  },
  removeTranscriptionClearedListener: () => {
    ipcRenderer.removeAllListeners('transcription-cleared')
  },
  onTranscriptionModeChange: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on('transcription-mode-change', (_event, enabled) => callback(enabled))
  },
  removeTranscriptionModeChangeListener: () => {
    ipcRenderer.removeAllListeners('transcription-mode-change')
  },
  /** The toolbar asked to flip the work mode; the renderer owns that setting */
  onToggleWorkMode: (callback: () => void) => {
    ipcRenderer.on('toggle-work-mode', callback)
  },
  removeToggleWorkModeListener: () => {
    ipcRenderer.removeAllListeners('toggle-work-mode')
  }
}

export type MainAPI = typeof api

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
