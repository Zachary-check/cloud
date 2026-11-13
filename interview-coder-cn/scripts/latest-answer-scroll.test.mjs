/**
 * The interview transcript anchors the newest answer to the middle of the
 * window. These tests pin the arithmetic and the fallbacks, because the failure
 * modes (an answer pushed off the top, or one pinned to the bottom edge) are
 * only visible on screen while an interview is running.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ANCHOR_FOLLOW_SLACK,
  isFollowingAnchor,
  latestAnswerScrollTop
} from '../src/shared/latest-answer-scroll.ts'

test('短回答落在窗口中间', () => {
  // 600px high window, 200px answer starting 400px down.
  assert.equal(
    latestAnswerScrollTop({
      scrollHeight: 1400,
      clientHeight: 600,
      elementTop: 400,
      elementHeight: 200
    }),
    200
  )
})

test('内容不足一屏时不滚动', () => {
  assert.equal(
    latestAnswerScrollTop({
      scrollHeight: 500,
      clientHeight: 600,
      elementTop: 120,
      elementHeight: 200
    }),
    0
  )
})

test('靠近顶部时不会滚出负偏移', () => {
  assert.equal(
    latestAnswerScrollTop({
      scrollHeight: 2000,
      clientHeight: 600,
      elementTop: 100,
      elementHeight: 200
    }),
    0
  )
})

test('靠近底部时不会越过可滚动范围', () => {
  // Centring would ask for 1600, but the document only scrolls to 1400.
  assert.equal(
    latestAnswerScrollTop({
      scrollHeight: 2000,
      clientHeight: 600,
      elementTop: 1800,
      elementHeight: 200
    }),
    1400
  )
})

test('比窗口还高的回答回退为跟随最新文字', () => {
  const metrics = {
    scrollHeight: 2400,
    clientHeight: 600,
    elementTop: 900,
    elementHeight: 900
  }

  assert.equal(latestAnswerScrollTop(metrics), 1800)
})

test('回答与窗口等高时同样回退到底部（居中没有意义）', () => {
  assert.equal(
    latestAnswerScrollTop({
      scrollHeight: 1800,
      clientHeight: 600,
      elementTop: 600,
      elementHeight: 600
    }),
    1200
  )
})

test('跟随判定留出容差，滚远即停止跟随', () => {
  assert.equal(isFollowingAnchor(500, 500), true)
  assert.equal(isFollowingAnchor(500, 500 - ANCHOR_FOLLOW_SLACK), true)
  assert.equal(isFollowingAnchor(500, 500 + ANCHOR_FOLLOW_SLACK), true)
  assert.equal(isFollowingAnchor(500, 500 - ANCHOR_FOLLOW_SLACK - 1), false)
  assert.equal(isFollowingAnchor(500, 500 + ANCHOR_FOLLOW_SLACK + 1), false)
})
