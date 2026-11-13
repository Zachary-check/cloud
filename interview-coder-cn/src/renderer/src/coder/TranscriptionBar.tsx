import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Pause, Play } from 'lucide-react'
import { useTranscriptionStore } from '@/lib/store/transcription'
import { useSettingsStore } from '@/lib/store/settings'
import { subscribeToInputLevel } from '@/lib/audio-capture'

export function TranscriptionBar() {
  const { isTranscribing, transcriptionText } = useTranscriptionStore()
  const workMode = useSettingsStore((state) => state.workMode)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [inputLevel, setInputLevel] = useState(0)

  useEffect(() => subscribeToInputLevel(setInputLevel), [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [transcriptionText])

  const isInterviewMode = workMode === 'interview'
  if (!isInterviewMode && !isTranscribing && !transcriptionText) return null

  const handleToggleTranscription = () => {
    void window.api.triggerAction('toggleTranscription')
  }

  return (
    <div className="transcription-bar absolute top-10 left-0 right-0 px-6 pb-2 z-10">
      <div className="flex items-start gap-2 bg-gray-700/80 rounded-lg px-2 py-1">
        {isTranscribing ? (
          <Mic className="w-4 h-4 mt-0.5 text-green-400 flex-shrink-0 animate-pulse" />
        ) : (
          <MicOff className="w-4 h-4 mt-0.5 text-amber-400 flex-shrink-0" />
        )}
        <div
          ref={scrollRef}
          className="transcription-scroll text-sm text-gray-300 max-h-[4.2em] overflow-y-auto leading-[1.4em] flex-1 whitespace-pre-wrap break-words"
        >
          {transcriptionText ||
            (isTranscribing ? '正在监听面试官提问...' : '收音已暂停，AI 回答结束后会自动恢复听题')}
        </div>
        {isTranscribing && (
          <div className="flex h-6 shrink-0 items-center gap-1.5" title="实时输入音量">
            <span className="text-[10px] text-gray-400">输入</span>
            <div className="h-1.5 w-14 overflow-hidden rounded-full bg-black/30">
              <div
                className={`h-full rounded-full transition-[width] duration-100 ${
                  inputLevel > 0.7
                    ? 'bg-amber-400'
                    : inputLevel > 0.05
                      ? 'bg-green-400'
                      : 'bg-gray-500'
                }`}
                style={{ width: `${Math.max(3, Math.round(inputLevel * 100))}%` }}
              />
            </div>
          </div>
        )}
        {isInterviewMode && (
          <button
            type="button"
            onClick={handleToggleTranscription}
            className="flex h-6 shrink-0 items-center gap-1 rounded bg-white/10 px-2 text-xs text-gray-200 hover:bg-white/20"
          >
            {isTranscribing ? (
              <>
                <Pause className="size-3" />
                暂停收音
              </>
            ) : (
              <>
                <Play className="size-3" />
                继续听题
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
