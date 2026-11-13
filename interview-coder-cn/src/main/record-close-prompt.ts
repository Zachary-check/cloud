/**
 * Asks the user what to call this run's interview record, instead of letting the
 * window close silently.
 *
 * The file is already written under a default name by the time this runs, so
 * the dialog is a rename, not a save: whatever the user answers — or does not
 * answer at all — the transcript survives on disk.
 *
 * The close is held with `event.preventDefault()` and released by whichever
 * outcome arrives first: an answer from the dialog, or `CLOSE_PROMPT_DEADLINE_MS`
 * of silence. That deadline is what keeps a crashed or stuck renderer from
 * trapping the user in a window that refuses to close.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import {
  discardInterviewRecord,
  finalizeInterviewRecord,
  hasRecordedInterview,
  prepareRecordSession,
  renameInterviewRecord,
  type RecordRenameResult
} from './interview-record'

/** Long enough to type a name, short enough not to feel like a hang. */
const CLOSE_PROMPT_DEADLINE_MS = 20000

/** The window whose close is on hold, or null when no prompt is showing. */
let promptWindow: BrowserWindow | null = null

/** Whether the renderer has been asked and has not answered yet. */
let promptOpen = false

/** Set for the close we asked for ourselves, so the dialog is not shown twice. */
let closing = false

let deadline: ReturnType<typeof setTimeout> | null = null

export function installRecordClosePrompt(window: BrowserWindow): void {
  window.on('close', (event) => {
    // The pass through here that follows an answered dialog is the quit we asked
    // for; a run with nothing recorded has nothing to name.
    if (closing || !hasRecordedInterview()) return
    event.preventDefault()
    if (promptOpen) return
    promptOpen = true
    void openPrompt(window)
  })
}

async function openPrompt(window: BrowserWindow): Promise<void> {
  promptWindow = window
  const session = await prepareRecordSession()
  if (!session) {
    // Nothing to save after all, so there is nothing to ask about. Leave the
    // window open: the user can close it again and this time it will go through.
    promptOpen = false
    promptWindow = null
    return
  }
  if (window.isDestroyed()) {
    promptOpen = false
    promptWindow = null
    return
  }
  window.webContents.send('interview-record-close-request', session)
  deadline = setTimeout(() => {
    // Silence from the renderer must not block the close, and the default name
    // is a perfectly good name to keep the record under.
    void finalizeInterviewRecord().finally(() => closeWindow())
  }, CLOSE_PROMPT_DEADLINE_MS)
}

ipcMain.handle(
  'interviewRecordSave',
  async (_event, input: unknown): Promise<RecordRenameResult> => {
    if (!promptOpen) return { ok: false, reason: 'missing' }
    const result = await renameInterviewRecord(typeof input === 'string' ? input : '')
    // A rejected name keeps the dialog open, with the session untouched, so the
    // user can try again or cancel.
    if (!result.ok) return result
    // Everything already shown on screen has to reach the file first: the
    // transcript itself is memory-only.
    await finalizeInterviewRecord()
    closeWindow()
    return result
  }
)

ipcMain.handle('interviewRecordDiscard', async () => {
  if (!promptOpen) return { ok: false, reason: 'missing' }
  await discardInterviewRecord()
  closeWindow()
  return { ok: true }
})

ipcMain.handle('interviewRecordCancelClose', () => {
  clearPromptState()
  promptWindow = null
  return { ok: true }
})

function closeWindow(): void {
  clearPromptState()
  closing = true
  const window = promptWindow ?? global.mainWindow
  promptWindow = null
  if (window && !window.isDestroyed()) {
    window.close()
    return
  }
  app.quit()
}

function clearPromptState(): void {
  promptOpen = false
  if (deadline) {
    clearTimeout(deadline)
    deadline = null
  }
}
