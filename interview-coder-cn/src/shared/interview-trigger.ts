/**
 * How long the recognizer must stay quiet after the last final sentence before
 * an interview question is considered finished and submitted for an answer.
 *
 * This was a hard-coded constant inside main/transcription.ts. It is now
 * user-adjustable, so the default, the bounds, and the unit conversions live
 * here: the main process, the persisted settings store, and the settings input
 * must all agree on the same numbers.
 */
export const DEFAULT_INTERVIEW_TRIGGER_DELAY_MS = 2000

/**
 * This window starts *after* the gateway emits a final sentence, which it does
 * following its own `ASR_MAX_SENTENCE_SILENCE_MS` (800 ms) of silence, so the
 * two are sequential rather than competing. Short values are the risky
 * direction: a too-short window submits mid-question, a too-long one merely
 * feels slower.
 */
export const MIN_INTERVIEW_TRIGGER_DELAY_MS = 300

/** Past this the user is waiting on the app rather than on the interviewer. */
export const MAX_INTERVIEW_TRIGGER_DELAY_MS = 15_000

/** Clamp any finite number into the supported range. */
export function clampInterviewTriggerDelayMs(value: number): number {
  return Math.min(
    MAX_INTERVIEW_TRIGGER_DELAY_MS,
    Math.max(MIN_INTERVIEW_TRIGGER_DELAY_MS, Math.round(value))
  )
}

/**
 * Coerce whatever a persisted store, an IPC payload, or a text field produced
 * into a usable delay. Anything missing, non-numeric, or non-positive means
 * "not configured" and falls back to the default rather than disabling the
 * trigger: a 0 ms quiet window would submit on every partial sentence.
 */
export function normalizeInterviewTriggerDelayMs(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_INTERVIEW_TRIGGER_DELAY_MS
  return clampInterviewTriggerDelayMs(numeric)
}

/**
 * Milliseconds -> the seconds shown in the settings input. Rounded to one
 * decimal so 2000 never renders as "2.0000000000000004".
 */
export function triggerDelayMsToSeconds(ms: unknown): number {
  return Math.round(normalizeInterviewTriggerDelayMs(ms) / 100) / 10
}

/**
 * Seconds typed into the settings input -> milliseconds. Returns null when the
 * field is empty or unparsable so the caller can keep the previous value
 * instead of silently resetting the user's number.
 */
export function triggerDelaySecondsToMs(input: unknown): number | null {
  if (typeof input === 'string' && input.trim() === '') return null
  const seconds = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return clampInterviewTriggerDelayMs(seconds * 1000)
}

/**
 * How long recognition stays suppressed *after* a question has been submitted.
 *
 * Submitting an answer does not stop the interviewer: one question often
 * arrives as two sentences, and the second lands right after the first was
 * answered -- a new request that aborts the answer that just started. The pause
 * swallows that tail. It has to stay short: anything spoken inside the window
 * is lost, so a long window trades an interruption for a missing question.
 *
 * Unlike the removed auto-pause, this never closes the socket and never stops
 * the audio capture. There is nothing to reconnect and nothing to resume, so it
 * cannot leave the app silently "stopped" -- the window is a plain timestamp
 * that simply expires.
 */
export const DEFAULT_INTERVIEW_TRIGGER_MUTE_MS = 3000

/** 0 is a supported choice here: it turns the pause off entirely. */
export const MIN_INTERVIEW_TRIGGER_MUTE_MS = 0

/** Past this the pause outlives the answer it was protecting. */
export const MAX_INTERVIEW_TRIGGER_MUTE_MS = 15_000

/** Clamp any finite number into the supported range. */
export function clampInterviewTriggerMuteMs(value: number): number {
  return Math.min(
    MAX_INTERVIEW_TRIGGER_MUTE_MS,
    Math.max(MIN_INTERVIEW_TRIGGER_MUTE_MS, Math.round(value))
  )
}

/**
 * Coerce a persisted store value or an IPC payload into a usable pause.
 *
 * Zero is legal and means "off", so only genuinely unparsable input falls back
 * to the default -- which includes a missing field in a store saved before this
 * option existed.
 */
export function normalizeInterviewTriggerMuteMs(value: unknown): number {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return DEFAULT_INTERVIEW_TRIGGER_MUTE_MS
  }
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return DEFAULT_INTERVIEW_TRIGGER_MUTE_MS
  return clampInterviewTriggerMuteMs(numeric)
}

/** Milliseconds -> the seconds shown in the settings input; 0 stays 0. */
export function triggerMuteMsToSeconds(ms: unknown): number {
  return Math.round(normalizeInterviewTriggerMuteMs(ms) / 100) / 10
}

/**
 * Seconds typed into the settings input -> milliseconds. Returns null when the
 * field is empty or unparsable so the caller keeps the previous value instead
 * of silently resetting it.
 */
export function triggerMuteSecondsToMs(input: unknown): number | null {
  if (typeof input === 'string' && input.trim() === '') return null
  if (typeof input === 'boolean') return null
  const seconds = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return clampInterviewTriggerMuteMs(seconds * 1000)
}

/**
 * Everything the main process knows about a question that is on screen but has
 * not been submitted yet.
 *
 * This state used to be spread across the packet handler and a single timer,
 * and the failure mode was always the same: the timer got cancelled by some
 * packet and nothing ever re-armed it, so a fully transcribed question sat in
 * the UI while the app waited for a final that never came. Keeping the decision
 * in one pure predicate makes that invariant testable instead of hoping every
 * branch remembers to re-arm.
 */
export interface TriggerRearmState {
  /** Recognized text is buffered and still shown to the user. */
  hasBufferedText: boolean
  /** A submission timer is already counting down. */
  hasArmedTrigger: boolean
  /** The short-fragment cleanup timer is scheduled for that same text. */
  hasFragmentExpiry: boolean
  /** Milliseconds since the last transcript packet (partial or final). */
  msSinceLastResult: number
  /** Milliseconds until the post-trigger pause ends; <= 0 when it is over. */
  msUntilPauseEnds: number
  /** The configured quiet window (`interviewTriggerDelayMs`). */
  quietWindowMs: number
  /** Fingerprint of the buffered text. */
  fingerprint: string
  /** Fingerprint already judged not worth submitting; '' when there is none. */
  rejectedFingerprint: string
}

/**
 * True when a submission has to be armed again because the buffered text has
 * gone quiet while nothing was scheduled to submit it.
 *
 * Deliberately conservative: it never overrides a timer that is already
 * running, never re-arms text that was already rejected as "not a question"
 * (that would keep a stray fragment on screen forever), and never fires inside
 * the post-trigger pause.
 */
export function shouldRearmTrigger(state: TriggerRearmState): boolean {
  if (state.hasArmedTrigger || state.hasFragmentExpiry) return false
  if (!state.hasBufferedText) return false
  if (state.msUntilPauseEnds > 0) return false
  if (state.msSinceLastResult < state.quietWindowMs) return false
  if (!state.fingerprint) return false
  return state.fingerprint !== state.rejectedFingerprint
}
