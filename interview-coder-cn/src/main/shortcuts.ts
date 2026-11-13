import { randomUUID } from 'node:crypto'
import { globalShortcut, ipcMain, screen } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ModelMessage } from 'ai'
import { applyContentProtection } from './main-window'
import {
  showToolbar,
  hideToolbar,
  setToolbarWanted,
  reassertToolbarTopMost,
  isToolbarAvailable,
  suspendCursorTracking,
  resumeCursorTracking
} from './toolbar-window'
import { clampPositionToDisplays, ensureWindowOnScreen } from './window-placement'
import { takeScreenshot, toDisplayThumbnail } from './take-screenshot'
import { saveScreenshotToDisk } from './save-screenshot'
import {
  getSolutionStream,
  getFollowUpStream,
  getGeneralStream,
  getInterviewKnowledgeSources
} from './ai'
import { formatDualAnswer } from '../shared/dual-answer'
import {
  turnStatusFor,
  type InterviewTurnKind,
  type InterviewTurnStatus
} from '../shared/interview-turn'
import {
  appendRecordedAnswer,
  beginRecordedTurn,
  finishRecordedTurn,
  noteRecordSources,
  recordSessionBreak
} from './interview-record'
import { state } from './state'
import { settings } from './settings'
import {
  getTranscriptionText,
  clearTranscriptionText,
  setInterviewTriggerHandler
} from './transcription'

/**
 * Extract meaningful error message from API errors
 */
function extractErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error) || '未知错误'
  }

  // Try to extract responseBody from AI SDK errors
  const apiError = error as Error & {
    responseBody?: string
    statusCode?: number
    data?: unknown
  }

  // Try to parse responseBody for detailed message
  if (apiError.responseBody) {
    try {
      const body = JSON.parse(apiError.responseBody)
      if (body.message) {
        return body.message
      }
      if (body.error?.message) {
        return body.error.message
      }
    } catch {
      // If parsing fails, use responseBody as is
      if (typeof apiError.responseBody === 'string' && apiError.responseBody.length < 200) {
        return apiError.responseBody
      }
    }
  }

  // Fallback to error message
  return error.message || '未知错误'
}

type Shortcut = {
  action: string
  key: string
  status: ShortcutStatus
  registeredKeys: string[]
}

enum ShortcutStatus {
  Registered = 'registered',
  Failed = 'failed',
  /** Shortcut is available to register but not registered. */
  Available = 'available'
}

const MOVE_STEP = 200
/** Opacity delta per shortcut press, matching the settings slider step */
const OPACITY_STEP = 0.05
const shortcuts: Record<string, Shortcut> = {}

type AbortReason = 'user' | 'new-request'

interface StreamContext {
  controller: AbortController
  reason: AbortReason | null
}

let currentStreamContext: StreamContext | null = null

/**
 * Open a transcript turn. The id links the start to its end, and the renderer
 * streams the answer into the turn it just opened — so this must be sent before
 * the answer's first chunk and before anything describing that answer.
 */
function sendTurnStart(
  mainWindow: BrowserWindow,
  id: string,
  kind: InterviewTurnKind,
  question: string
): void {
  // Only interview mode shows a transcript, so only interview mode has a
  // session to review later. Without this gate a dual- or written-mode
  // screenshot would land in the log with nothing on screen to compare it to.
  if (settings.workMode === 'interview') beginRecordedTurn(id, kind, question)
  if (mainWindow.isDestroyed()) return
  mainWindow.webContents.send('interview-turn-start', { id, kind, question })
}

/**
 * Close a transcript turn. Kept beside `sendTurnStart` so the on-disk record and
 * the on-screen transcript open and close in exactly the same places.
 */
function sendTurnEnd(
  mainWindow: BrowserWindow,
  id: string,
  answer: string,
  status: InterviewTurnStatus
): void {
  finishRecordedTurn(id, answer, status)
  if (mainWindow.isDestroyed()) return
  mainWindow.webContents.send('interview-turn-end', { id, answer, status })
}

/**
 * Tell the renderer that a request moved to the backup model. Without this the
 * user cannot tell a degraded answer from a bad one.
 */
function notifyModelFallback(mainWindow: BrowserWindow, model: string, reason: string): void {
  if (mainWindow.isDestroyed()) return
  mainWindow.webContents.send('model-fallback', { model, reason })
}

// Conversation history tracking
let conversationMessages: ModelMessage[] = []
let recentScreenshots: string[] = [] // 最近截图，水平预览 (限5张)
let hasAppendSeparator = false
let conversationWorkMode: 'written' | 'interview' | 'dual' | null = null
let interviewRequestSequence = 0

const FRONT_REASSERT_DURATION = 8000
const FRONT_REASSERT_INTERVAL = 100
const FRONT_RELATIVE_LEVEL = 100
const BACKGROUND_GUARD_INTERVAL = 2000
let frontReassertTimer: NodeJS.Timeout | null = null
let backgroundGuardTimer: NodeJS.Timeout | null = null
let isWindowSoftHidden = false
/** Position only: restoring through setBounds() would round-trip the window size */
let softHiddenPosition: { x: number; y: number } | null = null

/**
 * Reassert always-on-top. `aggressive` also calls moveTop() which
 * brings the window above everything — only use on explicit user actions
 * (show, screenshot, etc.) to avoid disturbing interaction with other apps.
 */
/**
 * The toolbar follows the main window's stacking. Timer checks only repair a
 * lost topmost flag; forcing an already pinned transparent window through
 * native stacking again can disturb its composition. Explicit user actions
 * may still raise both windows once.
 */
const TOOLBAR_REASSERT_MIN_INTERVAL = 500
let lastToolbarReassertAt = 0

function applyTopMost(win: BrowserWindow, aggressive = true) {
  if (!win || win.isDestroyed()) return
  if (aggressive || !win.isAlwaysOnTop()) {
    win.setAlwaysOnTop(true, 'screen-saver', FRONT_RELATIVE_LEVEL)
  }
  if (aggressive) win.moveTop()

  if (state.ignoreMouse) {
    const now = Date.now()
    if (now - lastToolbarReassertAt >= TOOLBAR_REASSERT_MIN_INTERVAL) {
      lastToolbarReassertAt = now
      reassertToolbarTopMost(FRONT_RELATIVE_LEVEL + 1, aggressive)
    }
  }
}

/**
 * Check for a lost topmost flag while visible, without continuously rewriting
 * native window stacking when nothing changed.
 */
function startBackgroundGuard(window: BrowserWindow) {
  if (backgroundGuardTimer) return // already running
  backgroundGuardTimer = setInterval(() => {
    if (!window || window.isDestroyed() || !window.isVisible()) {
      stopBackgroundGuard()
      return
    }
    applyTopMost(window, false)
  }, BACKGROUND_GUARD_INTERVAL)
}

function stopBackgroundGuard() {
  if (backgroundGuardTimer) {
    clearInterval(backgroundGuardTimer)
    backgroundGuardTimer = null
  }
}

function stopFrontReassert() {
  if (frontReassertTimer) {
    clearInterval(frontReassertTimer)
    frontReassertTimer = null
  }
}

/**
 * Off-screen parking spot used to "hide" the window without hiding it. Position
 * only, deliberately: setBounds() would round-trip the window *size* through the
 * DIP <-> physical pixel conversion, which grows the window by a pixel per cycle
 * at fractional display scaling — the same trap toolbar-window.ts documents.
 */
function getOffscreenPosition(): { x: number; y: number } {
  const displays = screen.getAllDisplays()
  const maxRight = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width))
  const topMost = Math.min(...displays.map((display) => display.bounds.y))

  return { x: maxRight + 2000, y: topMost }
}

function softHideWindow(window: BrowserWindow) {
  if (isWindowSoftHidden || window.isDestroyed()) return

  stopFrontReassert()
  stopBackgroundGuard()
  const [x, y] = window.getPosition()
  softHiddenPosition = { x, y }
  isWindowSoftHidden = true

  window.setOpacity(0)
  window.setIgnoreMouseEvents(true)
  const offscreen = getOffscreenPosition()
  window.setPosition(offscreen.x, offscreen.y)
  hideToolbar()
}

function restoreSoftHiddenWindow(window: BrowserWindow) {
  if (!isWindowSoftHidden || window.isDestroyed()) return

  // Never restore into a position that no longer exists: the display layout can
  // change (monitor unplugged, resolution lowered) while the window is parked
  // off-screen, and a window restored outside every display can never be
  // clicked again — it looks frozen with no way back.
  const { x, y, width, height } = window.getBounds()
  const saved = softHiddenPosition ?? { x, y }
  const target = clampPositionToDisplays(saved.x, saved.y, width, height)

  applyContentProtection(window, true)
  window.setPosition(target.x, target.y)
  window.setIgnoreMouseEvents(state.ignoreMouse)
  window.setOpacity(1)

  isWindowSoftHidden = false
  softHiddenPosition = null
  showToolbar()
  keepWindowInFront(window)
}

/**
 * Bring the window back from any hidden or off-screen state. Used by the
 * second-instance handler and app activation, where the caller cannot know
 * whether the window is soft-hidden, merely invisible, or stranded.
 */
export function revealMainWindow(): void {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return

  if (isWindowSoftHidden) {
    restoreSoftHiddenWindow(mainWindow)
    return
  }
  if (!mainWindow.isVisible()) {
    showMainWindow(mainWindow)
    return
  }

  ensureWindowOnScreen(mainWindow)
  mainWindow.moveTop()
}

function showMainWindow(window: BrowserWindow) {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    window.showInactive()
  } else {
    window.show()
  }

  applyContentProtection(window, process.platform === 'win32')
  showToolbar()
  keepWindowInFront(window)
}

function keepWindowInFront(window: BrowserWindow) {
  if (!window || window.isDestroyed()) return
  if (frontReassertTimer) {
    clearInterval(frontReassertTimer)
    frontReassertTimer = null
  }

  const start = Date.now()
  const reassert = (aggressive = false) => {
    if (!window.isVisible() || window.isDestroyed()) return false
    applyTopMost(window, aggressive)
    return true
  }

  if (!reassert(true)) return

  // Watch more often just after showing, but only repair a lost flag. Repeated
  // moveTop() calls here would force redraws throughout the first eight seconds.
  frontReassertTimer = setInterval(() => {
    const shouldStop = Date.now() - start > FRONT_REASSERT_DURATION
    if (shouldStop || !reassert()) {
      if (frontReassertTimer) {
        clearInterval(frontReassertTimer)
        frontReassertTimer = null
      }
    }
  }, FRONT_REASSERT_INTERVAL)

  // Ensure background guard is running for persistent protection
  startBackgroundGuard(window)
}

/**
 * Opacity is owned by the renderer settings store (persisted + synced back to
 * main), so the shortcut only asks the renderer to step it.
 */
function adjustOpacity(delta: number) {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
  mainWindow.webContents.send('adjust-opacity', delta)
}

function abortCurrentStream(reason: AbortReason) {
  if (!currentStreamContext) return
  currentStreamContext.reason = reason
  currentStreamContext.controller.abort()
}

/**
 * Click-through leaves the main window unable to receive a single click, so at
 * least one escape route has to exist before it may be enabled: a toolbar the
 * user can still reach (hovering fires it), or a registered toggle shortcut.
 */
function canRecoverFromClickThrough(): boolean {
  if (isToolbarAvailable()) return true
  return shortcuts.ignoreOrEnableMouse?.status === ShortcutStatus.Registered
}

/** Move the main window, keeping a grabbable part of it on screen */
function moveMainWindowBy(dx: number, dy: number) {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return

  const { x, y, width, height } = mainWindow.getBounds()
  const next = clampPositionToDisplays(x + dx, y + dy, width, height)
  if (next.x === x && next.y === y) return
  mainWindow.setPosition(next.x, next.y)
}

/** Send the exact knowledge-base documents selected for the current request. */
function sendKnowledgeSources(mainWindow: BrowserWindow, query?: string) {
  const sources = settings.workMode === 'interview' ? getInterviewKnowledgeSources(query) : []
  // Noted before the window guard: the record wants these even if nothing is on screen.
  noteRecordSources(sources)
  if (mainWindow.isDestroyed()) return
  mainWindow.webContents.send('knowledge-sources', sources)
}

/**
 * A screenshot is a base64 PNG of a whole display — several megabytes each — and
 * an interview session appends one per question. Left uncapped, the conversation
 * and every request built from it grow without bound: memory climbs, the request
 * body balloons, and the model call eventually stalls. Keep the most recent
 * images in history and replace older ones with a placeholder, so the text
 * context survives while the payload stays bounded.
 */
const MAX_HISTORY_IMAGES = 4

type MessagePart = { type?: string } & Record<string, unknown>

function trimConversationHistory(): void {
  let imagesKept = 0

  for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
    const message = conversationMessages[index]
    if (!Array.isArray(message.content)) continue

    const parts = message.content as unknown as MessagePart[]
    const imageCount = parts.filter((part) => part?.type === 'image').length
    if (imageCount === 0) continue

    const budget = Math.max(0, MAX_HISTORY_IMAGES - imagesKept)
    if (imageCount <= budget) {
      imagesKept += imageCount
      continue
    }

    let keptInMessage = 0
    const nextParts: MessagePart[] = []
    for (const part of parts) {
      if (part?.type !== 'image') {
        nextParts.push(part)
        continue
      }
      if (keptInMessage < budget) {
        keptInMessage += 1
        nextParts.push(part)
        continue
      }
      // Keep the placeholder inside the neighbouring text part so the message
      // never ends up with two adjacent text parts
      const previous = nextParts[nextParts.length - 1]
      if (previous?.type === 'text' && typeof previous.text === 'string') {
        previous.text = `${previous.text}\n[此处的历史截图已省略]`
      } else {
        nextParts.push({ type: 'text', text: '[此处的历史截图已省略]' })
      }
    }

    ;(message as { content: unknown }).content = nextParts
    imagesKept += keptInMessage
  }
}

async function handleInterviewTranscript(transcript: string) {
  const requestSequence = ++interviewRequestSequence
  const mainWindow = global.mainWindow
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !state.inCoderPage ||
    settings.workMode !== 'interview'
  ) {
    return
  }
  if (!settings.apiKey) {
    mainWindow.webContents.send('solution-error', '请先在设置中配置 AI API Key')
    return
  }

  abortCurrentStream('new-request')
  currentStreamContext = null
  // Replace the visible answer for every question, but keep conversationMessages
  // so follow-up questions still have the preceding project/interview context.
  mainWindow.webContents.send('solution-clear')
  recentScreenshots = []
  hasAppendSeparator = false

  let screenshotData: string | null = null
  if (settings.interviewIncludeScreenshot) {
    const capturedScreenshot = await takeScreenshot()
    if (capturedScreenshot) {
      screenshotData = capturedScreenshot
      saveScreenshotToDisk(screenshotData)
    }
  }

  if (
    requestSequence !== interviewRequestSequence ||
    mainWindow.isDestroyed() ||
    !state.inCoderPage ||
    settings.workMode !== 'interview'
  ) {
    return
  }

  const startsNewConversation =
    conversationWorkMode !== 'interview' || conversationMessages.length === 0
  if (startsNewConversation) {
    conversationMessages = []
    conversationWorkMode = 'interview'
  }

  const userMessage: ModelMessage = screenshotData
    ? {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `这是面试官的语音提问：\n${transcript}\n\n请结合当前屏幕内容给出适合面试场景的回答。`
          },
          {
            type: 'image',
            image: screenshotData
          }
        ]
      }
    : {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `这是面试官的语音提问：\n${transcript}\n\n请直接给出适合面试场景的回答。`
          }
        ]
      }
  conversationMessages.push(userMessage)
  trimConversationHistory()

  if (screenshotData) {
    // Previews go out downscaled: the model already has the full image
    const displayShot = toDisplayThumbnail(screenshotData)
    recentScreenshots.push(displayShot)
    recentScreenshots = recentScreenshots.slice(-5)
    mainWindow.webContents.send('screenshot-taken', displayShot)
    mainWindow.webContents.send('screenshots-updated', recentScreenshots)
  }

  sendKnowledgeSources(mainWindow, transcript)

  // Open the visible turn before the loading state and the first chunk, so the
  // answer has a turn to stream into and keeps the previous ones on screen.
  const turnId = randomUUID()
  sendTurnStart(mainWindow, turnId, 'question', transcript)

  mainWindow.webContents.send('ai-loading-start')

  const streamContext: StreamContext = {
    controller: new AbortController(),
    reason: null
  }
  currentStreamContext = streamContext
  let endedNaturally = true
  let streamStarted = false
  let assistantResponse = ''

  try {
    const solutionStream = getGeneralStream(
      conversationMessages,
      streamContext.controller.signal,
      transcript,
      (model, reason) => notifyModelFallback(mainWindow, model, reason)
    )
    streamStarted = true
    try {
      for await (const chunk of solutionStream) {
        if (streamContext.controller.signal.aborted) {
          endedNaturally = false
          break
        }
        assistantResponse += chunk
        if (turnId) appendRecordedAnswer(turnId, chunk)
        mainWindow.webContents.send('solution-chunk', chunk)
      }
    } catch (error) {
      if (!streamContext.controller.signal.aborted) {
        endedNaturally = false
        console.error('Error streaming interview response:', error)
        mainWindow.webContents.send('solution-error', extractErrorMessage(error))
      } else {
        endedNaturally = false
      }
    }

    if (streamContext.controller.signal.aborted) {
      if (streamContext.reason === 'user') {
        mainWindow.webContents.send('solution-stopped')
      }
    } else if (endedNaturally) {
      if (assistantResponse) {
        conversationMessages.push({
          role: 'assistant',
          content: assistantResponse
        })
      }
      mainWindow.webContents.send('solution-complete')
    }
  } catch (error) {
    if (streamContext.controller.signal.aborted) {
      if (streamContext.reason === 'user') {
        mainWindow.webContents.send('solution-stopped')
      }
    } else {
      endedNaturally = false
      console.error('Error starting interview response:', error)
      mainWindow.webContents.send('solution-error', extractErrorMessage(error))
    }
  } finally {
    const isLatestStream = currentStreamContext === streamContext
    if (isLatestStream) {
      currentStreamContext = null
    }
    if (!streamStarted && streamContext.reason === 'user') {
      mainWindow.webContents.send('solution-stopped')
    }
    if (!mainWindow.isDestroyed()) {
      // Sent even when the stream was superseded: the turn is on screen and must
      // stop reading as "streaming". The superseded answer keeps its partial text.
      sendTurnEnd(
        mainWindow,
        turnId,
        assistantResponse,
        turnStatusFor(streamContext.controller.signal.aborted, endedNaturally)
      )
    }
    if (isLatestStream && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai-loading-end')
    }
  }
}

setInterviewTriggerHandler(handleInterviewTranscript)
const callbacks: Record<string, () => void> = {
  hideOrShowMainWindow: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return

    if (process.platform === 'win32') {
      if (isWindowSoftHidden) {
        restoreSoftHiddenWindow(mainWindow)
        return
      }

      if (!mainWindow.isVisible()) {
        showMainWindow(mainWindow)
        return
      }

      softHideWindow(mainWindow)
      return
    }

    if (mainWindow.isVisible()) {
      stopBackgroundGuard()
      mainWindow.hide()
    } else {
      // 重新显示时不断重申置顶属性，抵消其他前台软件持续抢占
      showMainWindow(mainWindow)
    }
  },

  takeScreenshot: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage || !settings.apiKey) return

    abortCurrentStream('new-request')
    const isDualMode = settings.workMode === 'dual'
    // The capture is encoded on this thread, so show the spinner *before*
    // awaiting it: a hover-triggered screenshot otherwise looks like the bar did
    // nothing at all, while the app is in fact blocked for that whole time.
    mainWindow.webContents.send('ai-loading-start')
    // Already on, so the finally block below has to close it on every path
    const loadingStarted = true
    // Samples taken while the main thread is blocked would arrive in one burst
    suspendCursorTracking()
    let screenshotData: string | void
    try {
      screenshotData = await takeScreenshot()
    } finally {
      resumeCursorTracking()
    }
    if (!screenshotData) {
      // Never fail silently: the shortcut would look like it did nothing at all
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('solution-error', '截图失败：未能获取屏幕内容，请重试')
        mainWindow.webContents.send('ai-loading-end')
      }
      return
    }
    if (screenshotData && mainWindow && !mainWindow.isDestroyed()) {
      saveScreenshotToDisk(screenshotData)
      const transcriptionText = getTranscriptionText()
      if (transcriptionText) {
        clearTranscriptionText()
        mainWindow.webContents.send('transcription-cleared')
      }
      conversationMessages = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: transcriptionText
                ? `这是语音转录内容：\n${transcriptionText}\n\n同时附上屏幕截图：`
                : '这是屏幕截图'
            },
            {
              type: 'image',
              image: screenshotData
            }
          ]
        }
      ]
      conversationWorkMode = settings.workMode
      trimConversationHistory()

      const streamContext: StreamContext = {
        controller: new AbortController(),
        reason: null
      }
      currentStreamContext = streamContext
      recentScreenshots = [toDisplayThumbnail(screenshotData)]
      hasAppendSeparator = false
      mainWindow.webContents.send('solution-clear')
      // This action is labelled "新开对话" and resets the model-side history just
      // above, so the visible transcript has to start over along with it.
      mainWindow.webContents.send('interview-turns-clear')
      if (settings.workMode === 'interview') recordSessionBreak()
      mainWindow.webContents.send('screenshots-updated', recentScreenshots)
      mainWindow.webContents.send('screenshot-taken', toDisplayThumbnail(screenshotData))
      // The spinner was raised before the capture so the wait is visible, but
      // 'solution-clear' resets the renderer's loading flag — it has to be
      // raised again here, or the whole answer streams with no spinner and the
      // app looks as if it never called the model at all.
      mainWindow.webContents.send('ai-loading-start')
      sendKnowledgeSources(mainWindow, transcriptionText || undefined)
      const turnId = randomUUID()
      sendTurnStart(mainWindow, turnId, 'screenshot', transcriptionText || '屏幕截图分析')
      let endedNaturally = true
      let streamStarted = false
      let assistantResponse = ''
      try {
        const solutionStream = getSolutionStream(
          conversationMessages,
          streamContext.controller.signal,
          transcriptionText || undefined,
          (model, reason) => notifyModelFallback(mainWindow, model, reason)
        )
        streamStarted = true
        try {
          for await (const chunk of solutionStream) {
            if (streamContext.controller.signal.aborted) {
              endedNaturally = false
              break
            }
            assistantResponse += chunk
            if (turnId) appendRecordedAnswer(turnId, chunk)
            if (!isDualMode) mainWindow.webContents.send('solution-chunk', chunk)
          }
        } catch (error) {
          if (!streamContext.controller.signal.aborted) {
            endedNaturally = false
            console.error('Error streaming solution:', error)
            mainWindow.webContents.send('solution-error', extractErrorMessage(error))
          } else {
            endedNaturally = false
          }
        }

        if (streamContext.controller.signal.aborted) {
          if (streamContext.reason === 'user') {
            mainWindow.webContents.send('solution-stopped')
          }
        } else if (endedNaturally) {
          // Add assistant response to conversation history
          if (isDualMode) {
            assistantResponse = formatDualAnswer(assistantResponse)
            mainWindow.webContents.send('solution-chunk', assistantResponse)
          }
          if (assistantResponse) {
            conversationMessages.push({
              role: 'assistant',
              content: assistantResponse
            })
          }
          mainWindow.webContents.send('solution-complete')
        }
      } catch (error) {
        if (streamContext.controller.signal.aborted) {
          if (streamContext.reason === 'user') {
            mainWindow.webContents.send('solution-stopped')
          }
        } else {
          endedNaturally = false
          console.error('Error streaming solution:', error)
          mainWindow.webContents.send('solution-error', extractErrorMessage(error))
        }
      } finally {
        if (currentStreamContext === streamContext) {
          currentStreamContext = null
        }
        if (!streamStarted && streamContext.reason === 'user') {
          mainWindow.webContents.send('solution-stopped')
        }
        if (loadingStarted && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ai-loading-end')
        }
        sendTurnEnd(
          mainWindow,
          turnId,
          assistantResponse,
          turnStatusFor(streamContext.controller.signal.aborted, endedNaturally)
        )
      }
    }
  },

  // Append screenshot for continuous capture (if conversation exists)
  appendScreenshot: async () => {
    if (settings.workMode === 'dual') {
      callbacks.takeScreenshot()
      return
    }
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage || !settings.apiKey) return

    // Fallback to first screenshot if no conversation
    if (conversationMessages.length === 0) {
      callbacks.takeScreenshot()
      return
    }

    abortCurrentStream('new-request')
    // Same reason as takeScreenshot: the capture blocks this thread for about a
    // second, so the spinner has to be up *before* awaiting it — otherwise an
    // append looks like the shortcut did nothing until the answer starts.
    mainWindow.webContents.send('ai-loading-start')
    // Already on, so every failure path below owes an ai-loading-end
    const loadingStarted = true

    suspendCursorTracking()
    let screenshotData: string | void
    try {
      screenshotData = await takeScreenshot()
    } finally {
      resumeCursorTracking()
    }
    if (!screenshotData) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('solution-error', '截图失败：未能获取屏幕内容，请重试')
        mainWindow.webContents.send('ai-loading-end')
      }
      return
    }
    if (screenshotData && mainWindow && !mainWindow.isDestroyed()) {
      saveScreenshotToDisk(screenshotData)
      const transcriptionText = getTranscriptionText()
      if (transcriptionText) {
        clearTranscriptionText()
        mainWindow.webContents.send('transcription-cleared')
      }
      // Append new image message to conversation
      const newUserMessage: ModelMessage = {
        role: 'user',
        content: [
          {
            type: 'text',
            text: transcriptionText
              ? `这是下一部分截图和语音转录内容：\n${transcriptionText}\n请结合之前所有截图和分析，继续分析解答，不要遗漏任何信息。`
              : '这是下一部分截图，请结合之前所有截图和分析，继续分析解答，不要遗漏任何信息。'
          },
          {
            type: 'image',
            image: screenshotData
          }
        ]
      }
      conversationMessages.push(newUserMessage)
      trimConversationHistory()

      const streamContext: StreamContext = {
        controller: new AbortController(),
        reason: null
      }
      currentStreamContext = streamContext

      const displayShot = toDisplayThumbnail(screenshotData)
      recentScreenshots.push(displayShot)
      recentScreenshots = recentScreenshots.slice(-5) // 限5张
      if (settings.workMode === 'interview') {
        mainWindow.webContents.send('solution-clear')
      }
      mainWindow.webContents.send('screenshot-taken', displayShot)
      mainWindow.webContents.send('screenshots-updated', recentScreenshots)
      sendKnowledgeSources(mainWindow, transcriptionText || undefined)
      // In interview mode a supplementary screenshot re-answers the question, so
      // it gets its own visible turn instead of overwriting the previous answer.
      // Other modes keep appending into a single answer and need no turn.
      const turnId = settings.workMode === 'interview' ? randomUUID() : null
      if (turnId) {
        sendTurnStart(
          mainWindow,
          turnId,
          'screenshot',
          transcriptionText ? `${transcriptionText}（补充截图）` : '补充截图，继续分析'
        )
      }
      if (settings.workMode === 'interview') {
        hasAppendSeparator = false
      } else if (!hasAppendSeparator) {
        mainWindow.webContents.send('solution-chunk', '\n\n---\n\n')
        hasAppendSeparator = true
      } else {
        mainWindow.webContents.send('solution-chunk', '\n\n')
      }
      // Raised before the capture already; 'solution-clear' above resets the
      // renderer's flag in interview mode, so raise it again for the answer.
      mainWindow.webContents.send('ai-loading-start')

      let endedNaturally = true
      let streamStarted = false
      let assistantResponse = ''
      try {
        const solutionStream = getGeneralStream(
          conversationMessages,
          streamContext.controller.signal,
          transcriptionText || undefined,
          (model, reason) => notifyModelFallback(mainWindow, model, reason)
        )
        streamStarted = true
        try {
          for await (const chunk of solutionStream) {
            if (streamContext.controller.signal.aborted) {
              endedNaturally = false
              break
            }
            assistantResponse += chunk
            if (turnId) appendRecordedAnswer(turnId, chunk)
            mainWindow.webContents.send('solution-chunk', chunk)
          }
        } catch (error) {
          if (!streamContext.controller.signal.aborted) {
            endedNaturally = false
            console.error('Error streaming continuous solution:', error)
            mainWindow.webContents.send('solution-error', extractErrorMessage(error))
          } else {
            endedNaturally = false
          }
        }

        if (streamContext.controller.signal.aborted) {
          if (streamContext.reason === 'user') {
            mainWindow.webContents.send('solution-stopped')
          }
        } else if (endedNaturally) {
          // Add assistant response to conversation history
          if (assistantResponse) {
            conversationMessages.push({
              role: 'assistant',
              content: assistantResponse
            })
          }
          mainWindow.webContents.send('solution-complete')
        }
      } catch (error) {
        if (streamContext.controller.signal.aborted) {
          if (streamContext.reason === 'user') {
            mainWindow.webContents.send('solution-stopped')
          }
        } else {
          endedNaturally = false
          console.error('Error streaming continuous solution:', error)
          mainWindow.webContents.send('solution-error', extractErrorMessage(error))
        }
      } finally {
        if (currentStreamContext === streamContext) {
          currentStreamContext = null
        }
        if (!streamStarted && streamContext.reason === 'user') {
          mainWindow.webContents.send('solution-stopped')
        }
        if (loadingStarted && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ai-loading-end')
        }
        if (turnId) {
          sendTurnEnd(
            mainWindow,
            turnId,
            assistantResponse,
            turnStatusFor(streamContext.controller.signal.aborted, endedNaturally)
          )
        }
      }
    }
  },

  // Stop current AI solution stream
  stopSolutionStream: () => {
    abortCurrentStream('user')
  },

  ignoreOrEnableMouse: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return

    // Turning click-through OFF must work from any page: it is the only way
    // back into a window that no longer accepts the mouse, so it must never
    // depend on the coder page being mounted.
    if (!state.ignoreMouse && !state.inCoderPage) return

    if (!state.ignoreMouse && !canRecoverFromClickThrough()) {
      // Refuse to enter a state the user cannot leave
      mainWindow.webContents.send(
        'solution-error',
        '无法开启鼠标穿透：切换快捷键未注册，且悬浮工具条不可用，将无法再点回窗口'
      )
      return
    }

    state.ignoreMouse = !state.ignoreMouse
    mainWindow.setIgnoreMouseEvents(state.ignoreMouse)
    // Showing the toolbar positions it relative to the main window; while the
    // window is parked off-screen that would place it off-screen too
    if (!isWindowSoftHidden) showToolbar()
    mainWindow.webContents.send('sync-app-state', state)
  },

  increaseOpacity: () => {
    adjustOpacity(OPACITY_STEP)
  },

  decreaseOpacity: () => {
    adjustOpacity(-OPACITY_STEP)
  },

  pageUp: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    mainWindow.webContents.send('scroll-page-up')
  },

  pageDown: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    mainWindow.webContents.send('scroll-page-down')
  },

  moveMainWindowUp: () => {
    moveMainWindowBy(0, -MOVE_STEP)
  },

  moveMainWindowDown: () => {
    moveMainWindowBy(0, MOVE_STEP)
  },

  moveMainWindowLeft: () => {
    moveMainWindowBy(-MOVE_STEP, 0)
  },

  moveMainWindowRight: () => {
    moveMainWindowBy(MOVE_STEP, 0)
  },

  toggleTranscription: () => {
    const mainWindow = global.mainWindow
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      !state.inCoderPage ||
      settings.workMode !== 'interview'
    ) {
      return
    }
    mainWindow.webContents.send('toggle-transcription')
  },

  /**
   * Flip between the written test and the interview. The toolbar hides itself in
   * dual mode, so those two are the only ones reachable from here.
   *
   * The next value is left to the renderer: it owns that setting and reads its
   * own live copy, whereas deciding here would race with the round trip that
   * writes the previous flip back.
   */
  toggleWorkMode: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    mainWindow.webContents.send('toggle-work-mode')
  },

  clearTranscription: () => {
    const mainWindow = global.mainWindow
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      !state.inCoderPage ||
      settings.workMode !== 'interview'
    ) {
      return
    }
    clearTranscriptionText()
    mainWindow.webContents.send('transcription-cleared')
  }
}

const clickableActions = new Set([
  'takeScreenshot',
  'appendScreenshot',
  'stopSolutionStream',
  'ignoreOrEnableMouse',
  'increaseOpacity',
  'decreaseOpacity',
  'pageUp',
  'pageDown',
  'moveMainWindowUp',
  'moveMainWindowDown',
  'moveMainWindowLeft',
  'moveMainWindowRight',
  'toggleTranscription',
  'toggleWorkMode',
  'clearTranscription'
])

function unregisterShortcut(action: string) {
  const shortcut = shortcuts[action]
  if (!shortcut) return
  if (shortcut.registeredKeys.length) {
    shortcut.registeredKeys.forEach((registeredKey) => {
      globalShortcut.unregister(registeredKey)
    })
  } else {
    globalShortcut.unregister(shortcut.key)
  }
  shortcut.status = ShortcutStatus.Available
  shortcut.registeredKeys = []
}

function getShortcutRegistrationKeys(key: string) {
  const keys = [key]
  if (process.platform !== 'win32') {
    return keys
  }
  const parts = key.split('+')
  const hasAlt = parts.includes('Alt')
  const hasCtrl = parts.includes('CommandOrControl') || parts.includes('Control')
  if (hasAlt && !hasCtrl) {
    const aliasParts = [...parts]
    const altIndex = aliasParts.indexOf('Alt')
    if (altIndex >= 0) {
      aliasParts.splice(altIndex, 0, 'CommandOrControl')
      const aliasKey = aliasParts.join('+')
      if (!keys.includes(aliasKey)) {
        keys.push(aliasKey)
      }
    }
  }
  return keys
}

function registerShortcut(action: string, key: string) {
  if (shortcuts[action]) {
    unregisterShortcut(action)
  }

  const keysToRegister = getShortcutRegistrationKeys(key)
  const registeredKeys: string[] = []
  keysToRegister.forEach((shortcutKey) => {
    if (globalShortcut.register(shortcutKey, callbacks[action])) {
      registeredKeys.push(shortcutKey)
    }
  })

  shortcuts[action] = {
    action,
    key,
    status: registeredKeys.length ? ShortcutStatus.Registered : ShortcutStatus.Failed,
    registeredKeys
  }
}

ipcMain.handle('getShortcuts', () => shortcuts)

ipcMain.handle(
  'initShortcuts',
  (_event, shortcuts: Record<string, { action: string; key: string }>) => {
    Object.entries(shortcuts).forEach(([action, { key }]) => {
      registerShortcut(action, key)
    })
  }
)

ipcMain.handle('updateShortcuts', (_event, _shortcuts: { action: string; key: string }[]) => {
  _shortcuts.forEach((shortcut) => {
    if (shortcuts[shortcut.action]?.key !== shortcut.key) {
      registerShortcut(shortcut.action, shortcut.key)
    }
  })
})

ipcMain.handle('stopSolutionStream', () => {
  if (!currentStreamContext) return false
  abortCurrentStream('user')
  return true
})

ipcMain.handle('triggerAction', (_event, action: string) => {
  if (!clickableActions.has(action)) return false
  callbacks[action]?.()
  return true
})

ipcMain.handle('setToolbarVisible', (_event, visible: boolean) => {
  setToolbarWanted(visible)
})

ipcMain.handle('sendFollowUpQuestion', async (_event, question: string) => {
  const mainWindow = global.mainWindow
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !state.inCoderPage ||
    !settings.apiKey ||
    settings.workMode === 'dual'
  ) {
    return { success: false, error: 'Invalid state' }
  }

  // Validate that there's an active conversation
  if (conversationMessages.length === 0) {
    return { success: false, error: 'No active conversation' }
  }

  abortCurrentStream('new-request')
  const streamContext: StreamContext = {
    controller: new AbortController(),
    reason: null
  }
  currentStreamContext = streamContext

  if (settings.workMode === 'interview') {
    mainWindow.webContents.send('solution-clear')
    mainWindow.webContents.send('ai-loading-start')
  } else {
    mainWindow.webContents.send('solution-chunk', '\n\n---\n\n')
  }
  // The typed follow-up is a turn of its own in interview mode, so the question
  // and the answer it produced stay together in the transcript.
  const turnId = settings.workMode === 'interview' ? randomUUID() : null
  if (turnId) sendTurnStart(mainWindow, turnId, 'followup', question)
  sendKnowledgeSources(mainWindow, settings.workMode === 'interview' ? question : undefined)

  let endedNaturally = true
  let streamStarted = false
  let assistantResponse = ''

  try {
    const followUpStream = getFollowUpStream(
      conversationMessages,
      question,
      streamContext.controller.signal,
      settings.workMode === 'interview' ? question : undefined,
      (model, reason) => notifyModelFallback(mainWindow, model, reason)
    )
    streamStarted = true

    try {
      for await (const chunk of followUpStream) {
        if (streamContext.controller.signal.aborted) {
          endedNaturally = false
          break
        }
        assistantResponse += chunk
        if (turnId) appendRecordedAnswer(turnId, chunk)
        mainWindow.webContents.send('solution-chunk', chunk)
      }
    } catch (error) {
      if (!streamContext.controller.signal.aborted) {
        endedNaturally = false
        console.error('Error streaming follow-up solution:', error)
        mainWindow.webContents.send('solution-error', extractErrorMessage(error))
      } else {
        endedNaturally = false
      }
    }

    if (streamContext.controller.signal.aborted) {
      if (streamContext.reason === 'user') {
        mainWindow.webContents.send('solution-stopped')
      }
    } else if (endedNaturally) {
      // Update conversation history with user question and assistant response
      conversationMessages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: question
          }
        ]
      })
      if (assistantResponse) {
        conversationMessages.push({
          role: 'assistant',
          content: assistantResponse
        })
      }
      mainWindow.webContents.send('solution-complete')
    }
  } catch (error) {
    if (streamContext.controller.signal.aborted) {
      if (streamContext.reason === 'user') {
        mainWindow.webContents.send('solution-stopped')
      }
    } else {
      endedNaturally = false
      console.error('Error streaming follow-up solution:', error)
      mainWindow.webContents.send('solution-error', extractErrorMessage(error))
    }
  } finally {
    const isLatestStream = currentStreamContext === streamContext
    if (isLatestStream) {
      currentStreamContext = null
    }
    if (!streamStarted && streamContext.reason === 'user') {
      mainWindow.webContents.send('solution-stopped')
    }
    // In interview mode this request already sent ai-loading-start, so it owes
    // an ai-loading-end: an aborted or failed follow-up used to leave the
    // spinner running forever, which reads as a frozen app. Only the newest
    // stream may clear the flag, a superseded one must not.
    if (isLatestStream && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai-loading-end')
    }
    if (turnId && !mainWindow.isDestroyed()) {
      sendTurnEnd(
        mainWindow,
        turnId,
        assistantResponse,
        turnStatusFor(streamContext.controller.signal.aborted, endedNaturally)
      )
    }
  }

  return { success: true }
})
