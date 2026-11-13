/**
 * Model failover: pick which endpoints a request may try, and run the request
 * against them until one starts answering.
 *
 * The rules live here rather than in `main/ai.ts` so they can be tested without
 * an AI SDK, a network, or a credential — this is the part of the feature that
 * is easy to get subtly wrong (a fallback that fires after the user has already
 * read half an answer is worse than no fallback at all).
 */

/**
 * How long an attempt may take to produce its first chunk before it is written
 * off. A provider that is down often does not fail fast: the connection opens
 * and then nothing arrives, which no try/catch can detect.
 *
 * 60s, not 20s: a reasoning model working through a figure puzzle routinely
 * spends longer than that before its first token, and cutting it off makes the
 * app useless for exactly the questions it exists to help with.
 *
 * Lives here, not in main/ai.ts, because the renderer's "switched to backup"
 * notice names this duration — one constant keeps the message honest.
 */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 60_000

export interface ModelEndpoint {
  apiBaseURL: string
  apiKey: string
  model: string
}

export interface ModelCandidate extends ModelEndpoint {
  /** True for a candidate that only runs when the preferred one failed. */
  isFallback: boolean
}

export interface FallbackSettings {
  enabled: boolean
  apiBaseURL: string
  apiKey: string
  model: string
}

/**
 * Build the ordered list of endpoints a request may use.
 *
 * The fallback may leave `apiBaseURL`/`apiKey` blank to reuse the primary's,
 * which covers "another model on the same platform"; filling them in covers
 * "another platform entirely", which is the only thing that survives a provider
 * outage.
 */
export function buildModelCandidates(
  primary: ModelEndpoint,
  fallback: FallbackSettings
): ModelCandidate[] {
  const candidates: ModelCandidate[] = [{ ...trimEndpoint(primary), isFallback: false }]

  if (!fallback.enabled || !fallback.model.trim()) return candidates

  const resolved: ModelCandidate = {
    apiBaseURL: fallback.apiBaseURL.trim() || primary.apiBaseURL.trim(),
    apiKey: fallback.apiKey.trim() || primary.apiKey.trim(),
    model: fallback.model.trim(),
    isFallback: true
  }

  const duplicated = candidates.some(
    (candidate) =>
      candidate.apiBaseURL === resolved.apiBaseURL &&
      candidate.apiKey === resolved.apiKey &&
      candidate.model === resolved.model
  )
  // Retrying an identical endpoint would only add another timeout's worth of
  // waiting before the same failure, so it is not a fallback.
  if (duplicated) return candidates

  candidates.push(resolved)
  return candidates
}

function trimEndpoint(endpoint: ModelEndpoint): ModelEndpoint {
  return {
    apiBaseURL: endpoint.apiBaseURL.trim(),
    apiKey: endpoint.apiKey.trim(),
    model: endpoint.model.trim()
  }
}

export type FallbackReason = 'timeout' | 'error' | 'empty'

/** A provider that answers 200 with nothing at all is as unusable as one that fails. */
const EMPTY_RESPONSE_MESSAGE = '模型没有返回任何内容'

export interface FallbackInfo<T> {
  reason: FallbackReason
  error: unknown
  /** The candidate that failed and is being skipped. */
  failed: T
}

export interface StreamWithFallbackOptions<T> {
  /** The caller's abort signal (user pressed "停止生成", app quitting, …). */
  signal?: AbortSignal
  /**
   * How long the first chunk of an attempt may take before it is abandoned, or
   * null for no limit at all. Callers pass null when there is no other
   * candidate: with nothing to switch to, a timeout can only kill a request
   * that was still working.
   */
  firstTokenTimeoutMs: number | null
  open: (candidate: T, signal: AbortSignal) => AsyncIterable<string>
  /** Called with the candidate taking over, so the UI can name the model in use. */
  onFallback?: (candidate: T, info: FallbackInfo<T>) => void
}

/** Marker for "no chunk arrived in time"; never escapes to the caller as a value. */
const TIMED_OUT: unique symbol = Symbol('first-token-timeout')

/**
 * Stream from the first candidate that answers, in order.
 *
 * A candidate is abandoned — and the next one tried — only when it fails
 * *before producing any text*. Once a chunk has been yielded the answer is
 * already on screen, so switching would either splice two answers together or
 * make the visible answer vanish and start over; both are worse than reporting
 * the failure. A user-initiated abort never counts as a failure either.
 */
export async function* streamWithFallback<T>(
  candidates: readonly T[],
  options: StreamWithFallbackOptions<T>
): AsyncGenerator<string> {
  const { signal, firstTokenTimeoutMs, open, onFallback } = options

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const isLast = index === candidates.length - 1

    // Each attempt gets its own controller so a stalled attempt can be
    // cancelled without cancelling the request as a whole.
    const attempt = new AbortController()
    const abortAttempt = (): void => attempt.abort()
    if (signal) {
      if (signal.aborted) attempt.abort()
      else signal.addEventListener('abort', abortAttempt, { once: true })
    }

    let produced = false
    let iterator: AsyncIterator<string> | null = null
    try {
      iterator = open(candidate, attempt.signal)[Symbol.asyncIterator]()
      for (;;) {
        const result = await nextChunk(
          iterator,
          produced ? null : firstTokenTimeoutMs,
          abortAttempt
        )
        if (result.done) {
          // Some gateways answer 200 and then close the stream without a single
          // token; that is indistinguishable from a broken provider, so it is
          // treated as one. A user-initiated stop is not a fault, though.
          if (produced || isLast || signal?.aborted) return
          onFallback?.(candidates[index + 1], {
            reason: 'empty',
            error: new Error(EMPTY_RESPONSE_MESSAGE),
            failed: candidate
          })
          break
        }
        produced = true
        yield result.value
      }
    } catch (error) {
      // Normalise the internal timeout marker here, so every path out of this
      // function (thrown to the caller, or reported through onFallback) carries
      // a real Error with a message the user can be shown.
      const failure =
        error === TIMED_OUT && firstTokenTimeoutMs !== null
          ? new Error(firstTokenErrorMessage(firstTokenTimeoutMs))
          : error
      if (produced || signal?.aborted || isLast) throw failure
      onFallback?.(candidates[index + 1], {
        reason: error === TIMED_OUT ? 'timeout' : 'error',
        error: failure,
        failed: candidate
      })
    } finally {
      signal?.removeEventListener('abort', abortAttempt)
      // The timeout path leaves a read pending; closing the iterator releases it.
      const closing = iterator?.return?.(undefined)
      if (closing) closing.catch(() => {})
    }
  }
}

function firstTokenErrorMessage(timeoutMs: number): string {
  return `模型在 ${Math.round(timeoutMs / 1000)} 秒内没有返回任何内容`
}

/**
 * Read the next chunk, optionally giving up if it takes too long. `timeoutMs` is
 * only used for the first chunk of an attempt: once a model has started talking,
 * a slow chunk is normal streaming behaviour, not a dead connection.
 */
async function nextChunk(
  iterator: AsyncIterator<string>,
  timeoutMs: number | null,
  onTimeout: () => void
): Promise<IteratorResult<string>> {
  const pending = iterator.next()
  if (timeoutMs === null) {
    try {
      return await pending
    } finally {
      pending.catch(() => {})
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      pending,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
      })
    ])
    if (result === TIMED_OUT) {
      onTimeout()
      throw TIMED_OUT
    }
    return result
  } finally {
    if (timer) clearTimeout(timer)
    // A timed-out read still settles later (usually by rejecting); handling it
    // here keeps it from surfacing as an unhandled rejection.
    pending.catch(() => {})
  }
}
