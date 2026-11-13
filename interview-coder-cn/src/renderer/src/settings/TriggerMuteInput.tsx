import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  MAX_INTERVIEW_TRIGGER_MUTE_MS,
  MIN_INTERVIEW_TRIGGER_MUTE_MS,
  normalizeInterviewTriggerMuteMs,
  triggerMuteMsToSeconds,
  triggerMuteSecondsToMs
} from '../../../shared/interview-trigger'

const MIN_SECONDS = MIN_INTERVIEW_TRIGGER_MUTE_MS / 1000
const MAX_SECONDS = MAX_INTERVIEW_TRIGGER_MUTE_MS / 1000

interface TriggerMuteInputProps {
  /** Current pause in milliseconds, exactly as stored in settings. */
  valueMs: number
  onChange: (valueMs: number) => void
}

/**
 * Free-text seconds field for the post-question pause.
 *
 * Same local-text-then-commit pattern as TriggerDelayInput, with one difference:
 * 0 is a legal value here (it means "no pause"), so unlike the delay field an
 * empty box is still the only thing that counts as "not a number".
 */
export function TriggerMuteInput({ valueMs, onChange }: TriggerMuteInputProps) {
  const [text, setText] = useState(() => String(triggerMuteMsToSeconds(valueMs)))

  useEffect(() => {
    setText((current) =>
      triggerMuteSecondsToMs(current) === normalizeInterviewTriggerMuteMs(valueMs)
        ? current
        : String(triggerMuteMsToSeconds(valueMs))
    )
  }, [valueMs])

  const commit = () => {
    const ms = triggerMuteSecondsToMs(text)
    if (ms === null) {
      setText(String(triggerMuteMsToSeconds(valueMs)))
      return
    }
    setText(String(triggerMuteMsToSeconds(ms)))
    if (ms !== normalizeInterviewTriggerMuteMs(valueMs)) onChange(ms)
  }

  return (
    <div className="flex items-center w-60 gap-2">
      <Input
        type="number"
        inputMode="decimal"
        min={MIN_SECONDS}
        max={MAX_SECONDS}
        step={0.5}
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
