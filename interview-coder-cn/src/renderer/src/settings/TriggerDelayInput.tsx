import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  MAX_INTERVIEW_TRIGGER_DELAY_MS,
  MIN_INTERVIEW_TRIGGER_DELAY_MS,
  normalizeInterviewTriggerDelayMs,
  triggerDelayMsToSeconds,
  triggerDelaySecondsToMs
} from '../../../shared/interview-trigger'

const MIN_SECONDS = MIN_INTERVIEW_TRIGGER_DELAY_MS / 1000
const MAX_SECONDS = MAX_INTERVIEW_TRIGGER_DELAY_MS / 1000

interface TriggerDelayInputProps {
  /** Current quiet window in milliseconds, exactly as stored in settings. */
  valueMs: number
  onChange: (valueMs: number) => void
}

/**
 * Free-text seconds field for the interview trigger delay.
 *
 * The store keeps milliseconds because that is what `setTimeout` and the shared
 * bounds are written in, but a quiet window is something a person reasons about
 * in seconds. The text is therefore held locally and only committed on blur or
 * Enter: binding the input straight to the store would rewrite the field on
 * every keystroke, so typing "2" on the way to "15" would immediately clamp to
 * 2 and fight the user.
 */
export function TriggerDelayInput({ valueMs, onChange }: TriggerDelayInputProps) {
  const [text, setText] = useState(() => String(triggerDelayMsToSeconds(valueMs)))

  // Follow changes coming from outside the field (initial sync from the main
  // process, or a reset) without discarding what the user is currently typing:
  // if the text already parses to the stored value, leave it exactly as typed.
  useEffect(() => {
    setText((current) =>
      triggerDelaySecondsToMs(current) === normalizeInterviewTriggerDelayMs(valueMs)
        ? current
        : String(triggerDelayMsToSeconds(valueMs))
    )
  }, [valueMs])

  const commit = () => {
    const ms = triggerDelaySecondsToMs(text)
    if (ms === null) {
      // Empty or unparsable: restore what is stored rather than guessing a value.
      setText(String(triggerDelayMsToSeconds(valueMs)))
      return
    }
    // Echo the clamped result back, so an out-of-range entry visibly snaps to a
    // legal number instead of silently differing from what is displayed.
    setText(String(triggerDelayMsToSeconds(ms)))
    if (ms !== normalizeInterviewTriggerDelayMs(valueMs)) onChange(ms)
  }

  return (
    <div className="flex items-center w-60 gap-2">
      <Input
        type="number"
        inputMode="decimal"
        min={MIN_SECONDS}
        max={MAX_SECONDS}
        step={0.1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit()
            event.currentTarget.blur()
          }
        }}
        className="flex-1 bg-white text-sm"
      />
      <span className="text-xs font-light whitespace-nowrap">秒</span>
    </div>
  )
}
