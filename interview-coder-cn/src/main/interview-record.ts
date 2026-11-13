/**
 * Writes the interview transcript to Markdown, one block per turn, one file per
 * run of the app.
 *
 * The main process owns both the question and the answer, so it is the only
 * place that can persist a turn without shipping text back from the renderer.
 * Recording is best-effort: a failed write must never disturb a live interview,
 * so every path here swallows its error after logging it.
 *
 * Turns are written as they happen, under a default name derived from the day
 * and the number of sessions that day. When the user closes the window they are
 * asked what to call the file, and `renameInterviewRecord` moves it there — so
 * a crash or a force-quit still leaves a usable file behind.
 *
 * The directory is whatever the settings say, defaulting to
 * `<documents>/interview`. It is pushed in with `setInterviewRecordDir` rather
 * than read from `./settings`, so this module keeps depending on nothing but
 * `electron` and `node:fs` — that is what lets the file writes be tested
 * (`scripts/interview-record-io.test.mjs`).
 */

import { app } from 'electron'
import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  formatRecordedTurn,
  formatSessionBreak,
  nextRecordSessionIndex,
  normalizeRecordFileName,
  recordFileHeader,
  recordSessionName
} from '../shared/interview-record'
import type { InterviewTurnKind, InterviewTurnStatus } from '../shared/interview-turn'

interface PendingTurn {
  kind: InterviewTurnKind
  question: string
  /** Text streamed so far; the answer itself arrives with the end event. */
  answer: string
  /** When the question was asked; the block is timestamped with this. */
  at: Date
  sources: string[]
}

/** The file this run is being written to, decided the first time text arrives. */
interface RecordSession {
  /** Absolute path of the Markdown file. */
  file: string
  /**
   * The directory the session was opened in. Kept on the session so changing
   * the setting mid-interview cannot split one transcript across two folders.
   */
  dir: string
  /** File name without the `.md` suffix — what the rename dialog starts from. */
  name: string
  /** Whether this process has already written the `# 面试记录` header. */
  headerWritten: boolean
}

/** What the close dialog needs to render itself. */
export interface InterviewRecordSessionInfo {
  /** File name without the `.md` suffix. */
  name: string
  /** Directory the file lives in. */
  dir: string
}

/** Why a rename could not be applied, so the dialog can say something useful. */
export type RecordRenameFailure = 'invalid' | 'exists' | 'missing' | 'failed'

export type RecordRenameResult =
  | { ok: true; name: string; path: string }
  | { ok: false; reason: RecordRenameFailure }

/**
 * Turns that were shown but have not finished yet, keyed by the id linking
 * start to end. A turn is dropped from here when it ends, which is also what
 * makes a duplicate end event harmless.
 */
const pendingTurns = new Map<string, PendingTurn>()

/** Sources of the newest turn; a turn may publish them either side of opening. */
let openSources: string[] = []

/** Where the settings said to write. Blank means "use the default folder". */
let recordDir = ''

/** Null until the first turn is shown; a run with no turns never asks to save. */
let session: RecordSession | null = null

/** Turns shown in this run. Zero means there is nothing worth asking about. */
let recordedTurns = 0

/** Set once the user answered the close dialog, so no new write is queued. */
let sealed = false

/** Set when the user chose not to keep this run's file. */
let discarded = false

/**
 * Writes are chained: two answers finishing at once must not interleave inside
 * one file, and the header check has to see the previous write's result.
 */
let writeQueue: Promise<void> = Promise.resolve()

/** Called whenever the user's configured directory changes. */
export function setInterviewRecordDir(dir: string): void {
  recordDir = dir.trim()
}

/** `.../Documents/interview` unless the user picked somewhere else. */
export function getInterviewRecordDir(): string {
  return recordDir || join(app.getPath('documents'), 'interview')
}

/** Whether this run produced something worth asking the user to name. */
export function hasRecordedInterview(): boolean {
  return recordedTurns > 0 && !discarded
}

/**
 * The session the close dialog should offer, creating it if the first answer is
 * still streaming and nothing has reached the disk yet. Null when this run has
 * nothing to save.
 */
export async function prepareRecordSession(): Promise<InterviewRecordSessionInfo | null> {
  if (!hasRecordedInterview()) return null
  const current = await resolveSession(new Date())
  return { name: current.name, dir: current.dir }
}

/**
 * Called wherever knowledge sources are broadcast. Nothing is recorded here —
 * it only keeps `openSources` current for a turn that is opening or already open.
 */
export function noteRecordSources(sources: string[]): void {
  openSources = [...sources]
  for (const turn of pendingTurns.values()) {
    turn.sources = [...sources]
  }
}

export function beginRecordedTurn(id: string, kind: InterviewTurnKind, question: string): void {
  if (sealed || discarded) return
  recordedTurns += 1
  pendingTurns.set(id, { kind, question, answer: '', at: new Date(), sources: [...openSources] })
}

/**
 * Mirror a streamed chunk into the open turn. A turn that is still in flight
 * when the app closes is written from what was collected here, so the log keeps
 * the text the user had already read.
 */
export function appendRecordedAnswer(id: string, chunk: string): void {
  const turn = pendingTurns.get(id)
  if (turn) turn.answer += chunk
}

export function finishRecordedTurn(id: string, answer: string, status: InterviewTurnStatus): void {
  const turn = pendingTurns.get(id)
  // An end with no matching start means the turn was never shown (or was
  // already recorded), so there is nothing to describe.
  if (!turn) return
  pendingTurns.delete(id)
  enqueue(turn.at, formatRecordedTurn({ ...turn, answer: answer || turn.answer, status }, turn.at))
}

export function recordSessionBreak(): void {
  if (sealed || discarded) return
  const now = new Date()
  enqueue(now, formatSessionBreak(now))
}

/**
 * Rename this run's file to whatever the user typed. Called from the close
 * dialog, so the queued writes are drained first: the rename must not race a
 * block that is still on its way to the old path.
 *
 * A failure here leaves everything as it was, which is what lets the user try
 * another name instead of losing the session.
 */
export async function renameInterviewRecord(input: string): Promise<RecordRenameResult> {
  const name = normalizeRecordFileName(input)
  if (!name) return { ok: false, reason: 'invalid' }

  // Drained first: the rename must not race a block still on its way to the
  // old path.
  await writeQueue

  // The dialog normally opens on an existing session, but a first answer that
  // is still streaming has not needed one yet.
  const current = session ?? (hasRecordedInterview() ? await resolveSession(new Date()) : null)
  if (!current) return { ok: false, reason: 'missing' }

  const file = join(current.dir, `${name}.md`)
  if (file !== current.file) {
    // Windows resolves `Foo.md` and `foo.md` to the same file, so a pure case
    // change has to be treated as the session's own file, not a collision.
    const sameFile = name.toLowerCase() === current.name.toLowerCase()
    if (!sameFile && (await fileExists(file))) return { ok: false, reason: 'exists' }
    try {
      // Nothing has been written yet when the very first answer is still
      // streaming, and there is no file to move in that case.
      if (await fileExists(current.file)) await rename(current.file, file)
    } catch (error) {
      console.error('Failed to rename the interview record:', error)
      return { ok: false, reason: 'failed' }
    }
    current.file = file
    current.name = name
  }

  return { ok: true, name, path: current.file }
}

/**
 * Write whatever is still open and stop accepting writes: called while the app
 * is quitting. A turn that never ended (the window was closed mid-answer) would
 * otherwise be lost entirely, since the on-screen transcript is memory-only.
 * The partial text collected by `appendRecordedAnswer` is kept and the block is
 * marked as incomplete.
 */
export async function finalizeInterviewRecord(): Promise<void> {
  if (sealed) {
    await writeQueue
    return
  }
  for (const [id, turn] of pendingTurns) {
    pendingTurns.delete(id)
    enqueue(turn.at, formatRecordedTurn({ ...turn, status: 'interrupted' }, turn.at))
  }
  sealed = true
  await writeQueue
}

/**
 * Drop this run's file because the user chose not to keep it. The queued writes
 * land first — deleting a file that a write is about to append to would leave
 * it behind again.
 */
export async function discardInterviewRecord(): Promise<void> {
  const current = session
  sealed = true
  pendingTurns.clear()
  await writeQueue
  discarded = true
  session = null
  if (!current) return
  try {
    await rm(current.file, { force: true })
  } catch (error) {
    console.error('Failed to remove the discarded interview record:', error)
  }
}

function enqueue(at: Date, text: string): void {
  writeQueue = writeQueue
    .then(() => appendRecord(at, text))
    .catch((error) => {
      console.error('Failed to write interview record:', error)
    })
}

async function appendRecord(at: Date, text: string): Promise<void> {
  if (discarded) return
  const current = await resolveSession(at)
  await mkdir(current.dir, { recursive: true })

  let payload = text
  if (!current.headerWritten) {
    current.headerWritten = true
    // The file may already be there from an earlier run that picked the same
    // name, so ask the disk rather than trusting in-memory state.
    if (!(await fileExists(current.file))) payload = recordFileHeader(at) + text
  }

  await appendFile(current.file, payload, 'utf8')
}

/**
 * The session for this run, created on first use. The name is derived from what
 * the folder already holds, so a second run the same day picks the next number
 * instead of appending to the first run's transcript.
 */
async function resolveSession(at: Date): Promise<RecordSession> {
  if (session) return session
  const dir = getInterviewRecordDir()
  const index = nextRecordSessionIndex(await listFileNames(dir), at)
  const name = recordSessionName(at, index)
  session = { file: join(dir, `${name}.md`), dir, name, headerWritten: false }
  return session
}

/** A folder that does not exist yet simply holds no sessions. */
async function listFileNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
