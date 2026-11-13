/**
 * A turn of the interview conversation: one interviewer question (or a manual
 * follow-up) plus the answer streamed for it.
 *
 * The main process owns the model-side history (`conversationMessages`); these
 * types only describe the boundaries it broadcasts so the renderer can show a
 * readable transcript. They are deliberately separate: the transcript is a view
 * concern and must never be used to rebuild the prompt.
 */

/** Where a turn came from, so the transcript can label it. */
export type InterviewTurnKind = 'question' | 'followup' | 'screenshot'

/**
 * `streaming` until the answer finishes; the other values mirror how it ended,
 * so an answer cut short by "停止生成" is not shown as if it were complete.
 *
 * `interrupted` never reaches the renderer: it is what the on-disk log uses for
 * a turn that was still streaming when the app closed.
 */
export type InterviewTurnStatus = 'streaming' | 'done' | 'stopped' | 'error' | 'interrupted'

export interface InterviewTurnStart {
  id: string
  kind: InterviewTurnKind
  question: string
}

export interface InterviewTurnEnd {
  id: string
  answer: string
  status: InterviewTurnStatus
}

export interface InterviewTurn {
  id: string
  kind: InterviewTurnKind
  question: string
  answer: string
  /** Knowledge-base documents included in this turn's prompt, if any. */
  sources: string[]
  status: InterviewTurnStatus
}

/**
 * Upper bound on turns kept on screen. A long interview would otherwise grow the
 * list without bound, and re-rendering it on each streamed chunk gets slower as
 * it grows.
 */
export const MAX_INTERVIEW_TURNS = 10

/**
 * How a finished stream is recorded. `aborted` covers "停止生成" and a superseded
 * answer; neither produced a complete answer, so neither may read as `done`.
 */
export function turnStatusFor(aborted: boolean, endedNaturally: boolean): InterviewTurnStatus {
  if (aborted) return 'stopped'
  return endedNaturally ? 'done' : 'error'
}

/*
 * The reducers below are pure so the transcript rules can be tested without a
 * renderer. Two properties matter for correctness and for performance:
 *
 * 1. Every function returns the input array untouched when nothing changes, so
 *    the store can skip a re-render.
 * 2. When something does change, only the touched turn gets a new object. The
 *    memoised cards for finished turns therefore keep their identity (and their
 *    parsed Markdown) across the dozens of chunks one answer produces.
 */

/** Append a turn opened by the main process, dropping the oldest past the cap. */ export function addTurn(
  turns: InterviewTurn[],
  turn: { id: string; kind: InterviewTurnKind; question: string }
): InterviewTurn[] {
  const created: InterviewTurn = {
    id: turn.id,
    kind: turn.kind,
    question: turn.question,
    answer: '',
    sources: [],
    status: 'streaming'
  }
  return [...turns, created].slice(-MAX_INTERVIEW_TURNS)
}

/**
 * Append a streamed chunk to the newest turn. Chunks belong to the turn the main
 * process just opened; appending to a finished turn would silently rewrite an
 * answer the user has already read, so an unexpected chunk is dropped instead.
 */
export function appendChunkToLastTurn(turns: InterviewTurn[], chunk: string): InterviewTurn[] {
  const index = turns.length - 1
  const last = turns[index]
  if (!last || last.status !== 'streaming') return turns
  const next = turns.slice()
  next[index] = { ...last, answer: last.answer + chunk }
  return next
}

/**
 * Close a turn. The answer sent with the end event wins unless it is empty (a
 * stream can fail before its first chunk), in which case whatever was streamed
 * stays on screen.
 */
export function finishTurn(
  turns: InterviewTurn[],
  id: string,
  patch: { answer: string; status: InterviewTurnStatus }
): InterviewTurn[] {
  const index = turns.findIndex((turn) => turn.id === id)
  if (index === -1) return turns
  const current = turns[index]
  const next = turns.slice()
  next[index] = { ...current, answer: patch.answer || current.answer, status: patch.status }
  return next
}

/** Attach the knowledge-base documents used for the newest turn's prompt. */
export function setLastTurnSources(turns: InterviewTurn[], sources: string[]): InterviewTurn[] {
  const index = turns.length - 1
  const last = turns[index]
  if (!last) return turns
  const next = turns.slice()
  next[index] = { ...last, sources }
  return next
}
