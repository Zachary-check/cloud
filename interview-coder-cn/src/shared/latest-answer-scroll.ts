/**
 * Where the interview transcript scrolls to when an answer arrives.
 *
 * The newest answer is anchored to the middle of the window, so it is read
 * where the eye already is instead of being pinned to the last line against the
 * bottom edge. An answer taller than the window cannot be centred without
 * hiding its beginning, so it keeps the older behaviour: the newest text stays
 * visible at the bottom while it streams.
 *
 * Pure and DOM-free so the arithmetic is testable; the renderer supplies the
 * measurements in `coder/AppContent.tsx`.
 */

/**
 * How far the view may sit from the anchor before the user is considered to be
 * reading something else. Anything the renderer scrolls to lands exactly on the
 * anchor, so this only has to absorb rounding and a stray pixel of layout.
 */
export const ANCHOR_FOLLOW_SLACK = 48

export interface AnchorMetrics {
  /** The scroll container's `scrollHeight`. */
  scrollHeight: number
  /** The scroll container's `clientHeight`. */
  clientHeight: number
  /** The newest answer's top, measured in the container's scroll coordinates. */
  elementTop: number
  /** The newest answer's height. */
  elementHeight: number
}

/**
 * Scroll offset that puts the newest answer in the middle of the container,
 * clamped to the scrollable range (a short transcript therefore stays at 0
 * instead of scrolling into empty space).
 */
export function latestAnswerScrollTop(metrics: AnchorMetrics): number {
  const maxScroll = Math.max(0, metrics.scrollHeight - metrics.clientHeight)

  // Too tall to centre without pushing its own beginning off screen: follow the
  // newest text at the bottom, which is what the transcript did before.
  if (metrics.elementHeight >= metrics.clientHeight) return maxScroll

  const centred = metrics.elementTop - (metrics.clientHeight - metrics.elementHeight) / 2
  return Math.min(maxScroll, Math.max(0, centred))
}

/** True while the view is still close enough to the anchor to keep following it. */
export function isFollowingAnchor(
  scrollTop: number,
  anchor: number,
  slack: number = ANCHOR_FOLLOW_SLACK
): boolean {
  return Math.abs(scrollTop - anchor) <= slack
}
