import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_INTERVIEW_TRIGGER_DELAY_MS,
  DEFAULT_INTERVIEW_TRIGGER_MUTE_MS,
  MAX_INTERVIEW_TRIGGER_DELAY_MS,
  MAX_INTERVIEW_TRIGGER_MUTE_MS,
  MIN_INTERVIEW_TRIGGER_DELAY_MS,
  clampInterviewTriggerDelayMs,
  clampInterviewTriggerMuteMs,
  normalizeInterviewTriggerDelayMs,
  normalizeInterviewTriggerMuteMs,
  shouldRearmTrigger,
  triggerDelayMsToSeconds,
  triggerDelaySecondsToMs,
  triggerMuteMsToSeconds,
  triggerMuteSecondsToMs
} from '../src/shared/interview-trigger.ts'

test('常数关系自洽', () => {
  assert.ok(MIN_INTERVIEW_TRIGGER_DELAY_MS < DEFAULT_INTERVIEW_TRIGGER_DELAY_MS)
  assert.ok(DEFAULT_INTERVIEW_TRIGGER_DELAY_MS < MAX_INTERVIEW_TRIGGER_DELAY_MS)
  assert.equal(DEFAULT_INTERVIEW_TRIGGER_DELAY_MS, 2000)
})

test('缺失或非法的值一律回退到默认值，而不是关闭功能', () => {
  // 0 与负数都不能当成"立即提交"：那会在半句话时就把问题发出去。
  for (const bad of [undefined, null, '', 0, -1, 'abc', NaN, Infinity, -Infinity, {}]) {
    assert.equal(
      normalizeInterviewTriggerDelayMs(bad),
      DEFAULT_INTERVIEW_TRIGGER_DELAY_MS,
      `期望 ${String(bad)} 回退到默认值`
    )
  }
})

test('合法值原样通过，字符串数字也接受', () => {
  assert.equal(normalizeInterviewTriggerDelayMs(2000), 2000)
  assert.equal(normalizeInterviewTriggerDelayMs('1500'), 1500)
  assert.equal(normalizeInterviewTriggerDelayMs(1500.4), 1500)
  assert.equal(normalizeInterviewTriggerDelayMs(1500.6), 1501)
})

test('超出范围的值被钳制到上下界', () => {
  assert.equal(normalizeInterviewTriggerDelayMs(1), MIN_INTERVIEW_TRIGGER_DELAY_MS)
  assert.equal(normalizeInterviewTriggerDelayMs(999_999), MAX_INTERVIEW_TRIGGER_DELAY_MS)
  assert.equal(clampInterviewTriggerDelayMs(120), MIN_INTERVIEW_TRIGGER_DELAY_MS)
  assert.equal(clampInterviewTriggerDelayMs(60_000), MAX_INTERVIEW_TRIGGER_DELAY_MS)
})

test('毫秒转秒不会出现浮点毛刺', () => {
  assert.equal(triggerDelayMsToSeconds(2000), 2)
  assert.equal(triggerDelayMsToSeconds(1500), 1.5)
  assert.equal(triggerDelayMsToSeconds(800), 0.8)
  assert.equal(triggerDelayMsToSeconds(300), 0.3)
  // 未配置时显示默认值，输入框里不该出现 0。
  assert.equal(triggerDelayMsToSeconds(0), 2)
  assert.equal(triggerDelayMsToSeconds(undefined), 2)
})

test('秒转毫秒：空值与非法值返回 null，让调用方保留旧值', () => {
  assert.equal(triggerDelaySecondsToMs(''), null)
  assert.equal(triggerDelaySecondsToMs('   '), null)
  assert.equal(triggerDelaySecondsToMs('abc'), null)
  assert.equal(triggerDelaySecondsToMs('0'), null)
  assert.equal(triggerDelaySecondsToMs('-1'), null)
  assert.equal(triggerDelaySecondsToMs(NaN), null)
})

test('秒转毫秒：正常换算并钳制', () => {
  assert.equal(triggerDelaySecondsToMs('2'), 2000)
  assert.equal(triggerDelaySecondsToMs('1.5'), 1500)
  assert.equal(triggerDelaySecondsToMs(2), 2000)
  assert.equal(triggerDelaySecondsToMs('0.5'), 500)
  // 0.05s 会落在下界以下，钳制到最小可用值。
  assert.equal(triggerDelaySecondsToMs('0.05'), MIN_INTERVIEW_TRIGGER_DELAY_MS)
  assert.equal(triggerDelaySecondsToMs('99'), MAX_INTERVIEW_TRIGGER_DELAY_MS)
})

test('秒 -> 毫秒 -> 秒 往返等于原值', () => {
  for (const seconds of ['0.3', '0.8', '1.5', '2', '6', '15']) {
    const ms = triggerDelaySecondsToMs(seconds)
    assert.equal(triggerDelayMsToSeconds(ms), Number(seconds), `往返失败：${seconds}`)
  }
})

test('提问后静音：0 是合法值，只有无法解析的输入才回退默认', () => {
  // 与问题结束判定时间相反：这里 0 表示"关闭静音"，不能被当成未配置。
  assert.equal(normalizeInterviewTriggerMuteMs(0), 0)
  assert.equal(normalizeInterviewTriggerMuteMs('0'), 0)
  assert.equal(normalizeInterviewTriggerMuteMs(3000), 3000)
  for (const bad of [undefined, null, '', 'abc', NaN, Infinity, -Infinity, -1, {}, true]) {
    assert.equal(
      normalizeInterviewTriggerMuteMs(bad),
      DEFAULT_INTERVIEW_TRIGGER_MUTE_MS,
      `期望 ${String(bad)} 回退到默认值`
    )
  }
})

test('提问后静音：超范围被钳制到 0 与上界之间', () => {
  assert.equal(clampInterviewTriggerMuteMs(-5), 0)
  assert.equal(clampInterviewTriggerMuteMs(999_999), MAX_INTERVIEW_TRIGGER_MUTE_MS)
  assert.equal(normalizeInterviewTriggerMuteMs(999_999), MAX_INTERVIEW_TRIGGER_MUTE_MS)
  assert.equal(normalizeInterviewTriggerMuteMs(2500.6), 2501)
})

test('提问后静音：秒与毫秒往返，0 显示成 0', () => {
  assert.equal(triggerMuteMsToSeconds(0), 0)
  assert.equal(triggerMuteMsToSeconds(3000), 3)
  assert.equal(triggerMuteMsToSeconds(2500), 2.5)
  assert.equal(triggerMuteSecondsToMs('0'), 0)
  assert.equal(triggerMuteSecondsToMs('2.5'), 2500)
  for (const seconds of ['0', '0.5', '2.5', '3', '15']) {
    assert.equal(triggerMuteMsToSeconds(triggerMuteSecondsToMs(seconds)), Number(seconds))
  }
})

test('提问后静音：空值或非法输入返回 null，让调用方保留旧值', () => {
  for (const bad of ['', '   ', 'abc', '-1', NaN, true]) {
    assert.equal(triggerMuteSecondsToMs(bad), null, `期望 ${String(bad)} 返回 null`)
  }
})

test('重新排定：只在"有文本、无计时器、已静默"时成立', () => {
  const base = {
    hasBufferedText: true,
    hasArmedTrigger: false,
    hasFragmentExpiry: false,
    msSinceLastResult: 5000,
    msUntilPauseEnds: -1000,
    quietWindowMs: 2000,
    fingerprint: 'abcdefghijkl',
    rejectedFingerprint: ''
  }
  assert.equal(shouldRearmTrigger(base), true)
  // 已有计时器：不要叠加第二个
  assert.equal(shouldRearmTrigger({ ...base, hasArmedTrigger: true }), false)
  // 短碎片的 8 秒清理已排好：交给它
  assert.equal(shouldRearmTrigger({ ...base, hasFragmentExpiry: true }), false)
  // 没有待提交文本
  assert.equal(shouldRearmTrigger({ ...base, hasBufferedText: false }), false)
})

test('重新排定：静默时间不足或仍在提问后暂停内都不动', () => {
  const base = {
    hasBufferedText: true,
    hasArmedTrigger: false,
    hasFragmentExpiry: false,
    msSinceLastResult: 5000,
    msUntilPauseEnds: 0,
    quietWindowMs: 2000,
    fingerprint: 'abcdefghijkl',
    rejectedFingerprint: ''
  }
  // 刚说完，还没到静默窗口
  assert.equal(shouldRearmTrigger({ ...base, msSinceLastResult: 1999 }), false)
  // 正好到点
  assert.equal(shouldRearmTrigger({ ...base, msSinceLastResult: 2000 }), true)
  // 暂停中
  assert.equal(shouldRearmTrigger({ ...base, msUntilPauseEnds: 1 }), false)
  assert.equal(shouldRearmTrigger({ ...base, msUntilPauseEnds: 0 }), true)
})

test('重新排定：已判定为"不是问题"的同一段文本不再重排', () => {
  const base = {
    hasBufferedText: true,
    hasArmedTrigger: false,
    hasFragmentExpiry: false,
    msSinceLastResult: 9000,
    msUntilPauseEnds: 0,
    quietWindowMs: 2000,
    fingerprint: 'haode',
    rejectedFingerprint: 'haode'
  }
  assert.equal(shouldRearmTrigger(base), false)
  // 文本变了（又说了新内容）就恢复
  assert.equal(shouldRearmTrigger({ ...base, fingerprint: 'haodexinzeng' }), true)
  // 指纹为空时不应触发
  assert.equal(shouldRearmTrigger({ ...base, fingerprint: '', rejectedFingerprint: '' }), false)
})
