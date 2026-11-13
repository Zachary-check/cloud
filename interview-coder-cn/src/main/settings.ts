import { app, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { setToolbarOpacity, syncToolbarSettings } from './toolbar-window'
import {
  setInterviewTriggerDelayMs,
  setInterviewTriggerMuteMs,
  setTranscriptionWorkMode
} from './transcription'
import { setInterviewRecordDir } from './interview-record'
import {
  MAX_INTERVIEW_KNOWLEDGE_DOCUMENT_CHARS,
  MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS,
  MAX_INTERVIEW_KNOWLEDGE_TOTAL_CHARS,
  type InterviewKnowledgeDocument
} from '../shared/interview-knowledge'
import type { PinnedProjectRule } from '../shared/pinned-project'
import { DEFAULT_INTERVIEW_TRIGGER_MUTE_MS } from '../shared/interview-trigger'
import { normalizeCaptureSettings } from '../shared/capture'
import { setNativeOverlayAppearance } from './native-overlay'

ipcMain.handle('getAppSettings', () => {
  return settings
})

ipcMain.handle('updateAppSettings', (_event, _settings) => {
  const previousWorkMode = settings.workMode
  const previousDashscopeApiKey = settings.dashscopeApiKey
  Object.assign(settings, _settings)
  Object.assign(settings, normalizeCaptureSettings(settings))
  settings.textOnlyAnswers = settings.textOnlyAnswers !== false
  settings.showScreenshotPreview = settings.showScreenshotPreview === true
  if ('textOnlyAnswers' in _settings) setNativeOverlayAppearance(settings.textOnlyAnswers)
  if ('hideDockIcon' in _settings) {
    applyDockVisibility(settings.hideDockIcon)
  }
  if ('opacity' in _settings) {
    setToolbarOpacity(settings.opacity)
  }
  if ('toolbarHoverDelay' in _settings || settings.workMode !== previousWorkMode) {
    syncToolbarSettings(settings.toolbarHoverDelay, settings.workMode)
  }
  if ('interviewTriggerDelayMs' in _settings) {
    setInterviewTriggerDelayMs(settings.interviewTriggerDelayMs)
  }
  if ('interviewTriggerMuteMs' in _settings) {
    setInterviewTriggerMuteMs(settings.interviewTriggerMuteMs)
  }
  if ('recordDir' in _settings) {
    setInterviewRecordDir(settings.recordDir)
  }
  if (
    settings.workMode !== previousWorkMode ||
    settings.dashscopeApiKey !== previousDashscopeApiKey
  ) {
    setTranscriptionWorkMode(settings.workMode)
  }
})

/** Show/hide the macOS dock icon. No-op on other platforms. */
export function applyDockVisibility(hidden: boolean): void {
  if (process.platform !== 'darwin') return
  if (hidden) {
    app.dock?.hide()
  } else {
    app.dock?.show()
  }
}

ipcMain.handle('selectScreenshotDir', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: '选择截图保存目录'
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

ipcMain.handle('selectRecordDir', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: '选择面试记录保存目录'
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

ipcMain.handle(
  'selectInterviewKnowledgeFiles',
  async (_event, existingCount: number): Promise<InterviewKnowledgeDocument[]> => {
    const usedCount = Number.isFinite(existingCount) ? Math.max(0, Math.floor(existingCount)) : 0
    const remaining = MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS - usedCount
    if (remaining <= 0) return []

    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: '选择面试知识库 Markdown 文件',
      filters: [{ name: 'Markdown 文件', extensions: ['md', 'markdown'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return []

    const documents: InterviewKnowledgeDocument[] = []
    let usedChars = 0
    for (const filePath of result.filePaths.slice(0, remaining)) {
      const extension = extname(filePath).toLowerCase()
      if (extension !== '.md' && extension !== '.markdown') continue
      try {
        const content = (await readFile(filePath, 'utf8'))
          .replace(/^\uFEFF/, '')
          .replace(/\r\n/g, '\n')
          .trim()
        if (!content) continue
        const availableChars = MAX_INTERVIEW_KNOWLEDGE_TOTAL_CHARS - usedChars
        if (availableChars <= 0) break
        const clipped = content.slice(
          0,
          Math.min(MAX_INTERVIEW_KNOWLEDGE_DOCUMENT_CHARS, availableChars)
        )
        documents.push({
          id: randomUUID(),
          name: basename(filePath).slice(0, 160),
          content: clipped,
          enabled: true
        })
        usedChars += clipped.length
      } catch (error) {
        console.warn('Failed to read interview knowledge file:', filePath, error)
      }
    }
    return documents
  }
)

export const settings = {
  ...normalizeCaptureSettings({}),
  apiBaseURL: process.env.API_BASE_URL || '',
  apiKey: process.env.API_KEY || '',
  model: process.env.MODEL || '',
  /** Second endpoint, used only when the preferred one fails before answering. */
  fallbackModelEnabled: false,
  fallbackApiBaseURL: '',
  fallbackApiKey: '',
  fallbackModel: '',
  customPrompt: '',
  workMode: 'written' as 'written' | 'interview' | 'dual',
  interviewIncludeScreenshot: false,
  interviewContext: '',
  interviewKnowledgeBase: [] as InterviewKnowledgeDocument[],
  interviewKnowledgeBaseEnabled: true,
  shareInterviewContextWithAI: false,
  /** Force a specific project for "pick a project" questions; injected verbatim */
  pinnedProjectRules: [] as PinnedProjectRule[],
  /** Code language used when the question names none; '' turns the rule off */
  codeLanguage: '',
  /** Kept in sync with the renderer so the overlay toolbar can match the main window */
  opacity: 0.8,
  textOnlyAnswers: true,
  showScreenshotPreview: false,
  /**
   * Dwell time in ms before hovering a toolbar button fires it; 0 disables hover
   * triggering. The real default lives in the renderer store: App.tsx fills blank
   * renderer fields from here, so a truthy default would overwrite a user's "off".
   */
  toolbarHoverDelay: 0,
  screenshotAutoSave: false,
  screenshotDir: '',
  /**
   * Where the interview transcript (one Markdown file per day) is written.
   * Blank means `<documents>/interview`; the renderer owns the persisted value
   * and syncs it, so this only has to seed the main process at startup.
   */
  recordDir: '',
  dashscopeApiKey: '',
  hideDockIcon: false,
  /**
   * Quiet window before a final recognized sentence is submitted as the question.
   * The renderer owns the real default (see shared/interview-trigger); 0 means
   * "not synced yet" and normalizes back to that default.
   */
  interviewTriggerDelayMs: 0,
  /**
   * Recognition suppressed for this long after a question is submitted. Seeded
   * with the real default rather than 0: here 0 is a legitimate value ("off"),
   * so it cannot double as the "not synced yet" sentinel the delay field uses.
   */
  interviewTriggerMuteMs: DEFAULT_INTERVIEW_TRIGGER_MUTE_MS,
  audioCaptureSource: 'system' as 'system' | 'microphone',
  transcriptionInputGain: 1.5,
  audioInputDeviceId: '',
  audioOutputDeviceId: ''
}

export type AppSettings = typeof settings

// The renderer only syncs after it mounts, and a record can be written from the
// very first question, so seed the directory now and let the sync refine it.
setInterviewRecordDir(settings.recordDir)
