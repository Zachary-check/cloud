import { memo, useDeferredValue, useEffect, useRef, useState } from 'react'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { useSolutionStore } from '@/lib/store/solution'
import { useInterviewTurnsStore, type InterviewTurn } from '@/lib/store/interview-turns'
import MarkdownRenderer from '@/components/MarkdownRenderer'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { useSettingsStore } from '@/lib/store/settings'
import { formatDualAnswer } from '../../../shared/dual-answer'
import {
  isFollowingAnchor,
  latestAnswerScrollTop,
  type AnchorMetrics
} from '../../../shared/latest-answer-scroll'

const TURN_LABELS: Record<InterviewTurn['kind'], string> = {
  question: '面试官提问',
  followup: '我的追问',
  screenshot: '补充截图'
}

/** Dual answers scroll inside their compact panel; other modes use the page. */
function scrollAnswerContent(direction: -1 | 1): void {
  const container =
    document.getElementById('dual-answer-content') ?? document.getElementById('app-content')
  if (!container) return
  const step = Math.max(1, Math.round(container.clientHeight * 0.8))
  // Do not rely on an animation progressing while a click-through window is
  // in the background. Each toolbar dwell or shortcut moves immediately.
  container.scrollBy({ top: direction * step, behavior: 'auto' })
}

const TURN_STATUS_NOTES: Partial<Record<InterviewTurn['status'], string>> = {
  stopped: '已停止生成，此回答不完整',
  error: '生成中断，此回答不完整'
}

/**
 * The geometry `latestAnswerScrollTop` needs, measured from live elements. The
 * card is measured with `getBoundingClientRect` and the container's scroll
 * offset folded back in, because the cards' offset parent is not the scroller.
 */
function measureAnchor(container: HTMLElement, card: Element): AnchorMetrics {
  const containerRect = container.getBoundingClientRect()
  const cardRect = card.getBoundingClientRect()
  return {
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    elementTop: container.scrollTop + (cardRect.top - containerRect.top),
    elementHeight: cardRect.height
  }
}

/**
 * Memoised on purpose: every streamed chunk produces a new turns array, but only
 * the turn being streamed gets a new object, so finished answers are not
 * re-parsed as Markdown dozens of times per question.
 */
const InterviewTurnCard = memo(function InterviewTurnCard({ turn }: { turn: InterviewTurn }) {
  const note = TURN_STATUS_NOTES[turn.status]
  return (
    <div className="rounded-lg bg-gray-600/40 px-4 py-3">
      <div className="mb-2 flex items-start gap-2 text-xs text-gray-200">
        <span className="shrink-0 rounded bg-gray-700/80 px-1.5 py-0.5">
          {TURN_LABELS[turn.kind]}
        </span>
        <span className="flex-1 whitespace-pre-wrap break-words">{turn.question}</span>
      </div>
      {turn.answer ? (
        <div className="interview-answer">
          <MarkdownRenderer>{turn.answer}</MarkdownRenderer>
        </div>
      ) : turn.status === 'streaming' ? (
        <p className="text-sm text-gray-300">正在组织回答…</p>
      ) : (
        <p className="text-sm text-gray-400">没有生成内容</p>
      )}
      {turn.sources.length > 0 && (
        <div className="mt-2 break-words text-xs text-gray-300">
          知识库参考：{turn.sources.join('、')}
        </div>
      )}
      {note && <div className="mt-1 text-xs text-amber-300">{note}</div>}
    </div>
  )
})

export function AppContent() {
  const {
    screenshotData,
    isLoading,
    solutionChunks,
    errorMessage,
    setScreenshotData,
    setIsLoading,
    addSolutionChunk,
    setErrorMessage,
    setKnowledgeSources,
    clearSolution
  } = useSolutionStore()

  const [recentScreenshots, setRecentScreenshots] = useState<string[]>([])
  const contentRef = useRef<HTMLDivElement>(null)
  const workMode = useSettingsStore((state) => state.workMode)
  // Markdown parsing/highlighting can be noticeably heavier than the live
  // transcription bar. Keep the latest AI text available, but let React defer
  // the expensive markdown pass so ASR updates remain responsive.
  const solutionText = solutionChunks.join('')
  const deferredSolutionText = useDeferredValue(solutionText)

  const {
    turns,
    startTurn,
    appendChunk,
    endTurn,
    setSources: setTurnSources,
    clearTurns
  } = useInterviewTurnsStore()
  const deferredTurns = useDeferredValue(turns)
  /** The turn cards, so the newest one can be found and anchored. */
  const cardsRef = useRef<HTMLDivElement>(null)
  /** Follow the newest answer only while the user is reading it. */
  const followLatest = useRef(true)
  /** Offset last scrolled to; moving away from it means the user took over. */
  const lastAnchor = useRef(0)
  const lastTurnId = useRef<string | null>(null)

  /**
   * Anchor the newest answer to the middle of the window: a short answer is read
   * where the eye already is, and one too tall to fit keeps the newest text at
   * the bottom (see `shared/latest-answer-scroll`).
   *
   * Keyed on the newest turn's id rather than on the number of turns: past ten
   * turns the list is capped, so a count would never notice another question.
   */
  useEffect(() => {
    const el = contentRef.current
    if (!el || workMode !== 'interview') return

    const newestId = deferredTurns[deferredTurns.length - 1]?.id ?? null
    if (newestId !== lastTurnId.current) {
      // A new question arrived: the previous reading position no longer matters.
      lastTurnId.current = newestId
      followLatest.current = true
    }
    if (!followLatest.current) return

    const card = cardsRef.current?.lastElementChild
    if (!card) return
    const anchor = latestAnswerScrollTop(measureAnchor(el, card))
    lastAnchor.current = anchor
    el.scrollTop = anchor
  }, [deferredTurns, workMode])

  const handleContentScroll = () => {
    const el = contentRef.current
    if (!el) return
    // Scrolling away from the anchor is the user reading an earlier answer: stop
    // fighting them. Scrolling back to it resumes following.
    followLatest.current = isFollowingAnchor(el.scrollTop, lastAnchor.current)
  }

  useEffect(() => {
    // Sources and the transcript both belong to one interview session; do not
    // carry either of them into another work mode. Leaving interview mode ends
    // the session, while re-entering it must not wipe a transcript that is still
    // on screen (the store lives outside React, so it survives route changes).
    setKnowledgeSources([])
    if (workMode !== 'interview') clearTurns()
  }, [workMode, setKnowledgeSources, clearTurns])

  useEffect(() => {
    if (workMode !== 'dual') return
    clearSolution()
    setRecentScreenshots([])
    setScreenshotData(null)
  }, [workMode, clearSolution, setScreenshotData])

  useEffect(() => {
    // Listen for screenshot events (latest)
    window.api.onScreenshotTaken((data: string) => {
      setScreenshotData(data)
    })

    // Listen for screenshots-updated events (gallery)
    window.api.onScreenshotsUpdated((screenshots: string[]) => {
      setRecentScreenshots(screenshots)
    })

    // New session clear (pictures + answers)
    window.api.onSolutionClear(() => {
      clearSolution()
      setRecentScreenshots([])
      setScreenshotData(null)
      setErrorMessage(null)
    })

    // Listen for solution chunks. In interview mode an answer belongs to the turn
    // the main process opened, so it goes there instead of into the single-answer
    // buffer the other work modes still use.
    window.api.onSolutionChunk((chunk: string) => {
      if (useSettingsStore.getState().workMode === 'interview') {
        appendChunk(chunk)
        return
      }
      addSolutionChunk(chunk)
    })

    // The main process sends the exact knowledge-base files included in the
    // latest interview prompt; keep this metadata separate from the answer
    // stream so it never pollutes the model output.
    window.api.onKnowledgeSources((sources: string[]) => {
      if (useSettingsStore.getState().workMode === 'interview') {
        setTurnSources(sources)
        return
      }
      setKnowledgeSources(sources)
    })

    // Transcript turns: one per question, so earlier answers stay on screen.
    window.api.onInterviewTurnStart((turn) => {
      if (useSettingsStore.getState().workMode !== 'interview') return
      startTurn(turn)
    })
    window.api.onInterviewTurnEnd((turn) => {
      endTurn(turn.id, { answer: turn.answer, status: turn.status })
    })
    window.api.onInterviewTurnsClear(() => {
      clearTurns()
    })

    // AI loading
    window.api.onAiLoadingStart(() => {
      setIsLoading(true)
      setErrorMessage(null) // Clear error when new request starts
    })
    window.api.onAiLoadingEnd(() => {
      setIsLoading(false)
    })

    // Cleanup listeners on unmount
    return () => {
      window.api.removeScreenshotListener()
      window.api.removeScreenshotsUpdatedListener()
      window.api.removeSolutionChunkListener()
      window.api.removeKnowledgeSourcesListener()
      window.api.removeAiLoadingStartListener()
      window.api.removeAiLoadingEndListener()
      window.api.removeSolutionClearListener()
      window.api.removeInterviewTurnStartListener()
      window.api.removeInterviewTurnEndListener()
      window.api.removeInterviewTurnsClearListener()
    }
  }, [
    setScreenshotData,
    clearSolution,
    setIsLoading,
    addSolutionChunk,
    setErrorMessage,
    setKnowledgeSources,
    startTurn,
    appendChunk,
    endTurn,
    setTurnSources,
    clearTurns
  ])

  useEffect(() => {
    window.api.onSolutionComplete(() => {
      setIsLoading(false)
    })
    window.api.onSolutionStopped(() => {
      setIsLoading(false)
    })
    window.api.onSolutionError((message: string) => {
      setIsLoading(false)
      setErrorMessage(message)
    })
    return () => {
      window.api.removeSolutionCompleteListener()
      window.api.removeSolutionStoppedListener()
      window.api.removeSolutionErrorListener()
    }
  }, [setIsLoading, setErrorMessage])

  useEffect(() => {
    window.api.onScrollPageUp(() => {
      followLatest.current = false
      scrollAnswerContent(-1)
    })
    return () => {
      window.api.removeScrollPageUpListener()
    }
  }, [])

  useEffect(() => {
    window.api.onScrollPageDown(() => {
      followLatest.current = false
      scrollAnswerContent(1)
    })
    return () => {
      window.api.removeScrollPageDownListener()
    }
  }, [])

  if (workMode === 'interview') {
    return (
      <div id="app-content" ref={contentRef} onScroll={handleContentScroll} className="px-6 py-4">
        <div ref={cardsRef} className="mx-auto w-full max-w-3xl space-y-3">
          {errorMessage && (
            <div role="alert" className="rounded-lg bg-red-500/20 p-3 text-sm text-red-100">
              {errorMessage}
              <button
                type="button"
                onClick={() => setErrorMessage(null)}
                className="ml-3 underline"
              >
                关闭
              </button>
            </div>
          )}
          {deferredTurns.length === 0 && !errorMessage && (
            <p className="text-center text-sm text-gray-200">
              {isLoading ? '正在组织回答…' : '等待面试官提问，回答将在这里显示'}
            </p>
          )}
          {deferredTurns.map((turn) => (
            <InterviewTurnCard key={turn.id} turn={turn} />
          ))}
        </div>
      </div>
    )
  }

  if (workMode === 'dual') {
    const rawAnswer = solutionChunks.join('').trim()
    const answer = rawAnswer ? formatDualAnswer(rawAnswer) : ''
    const isCodeAnswer = answer.startsWith('CODE\n')
    return (
      <div id="app-content" className="flex items-center justify-center p-3 text-center">
        <div
          id="dual-answer-content"
          className="max-h-full w-full min-w-0 overflow-x-hidden overflow-y-auto text-xs font-semibold leading-5 text-gray-50"
        >
          {errorMessage ? (
            <span className="text-red-200">{errorMessage}</span>
          ) : isLoading ? (
            <span className="text-gray-300">1</span>
          ) : answer ? (
            isCodeAnswer ? (
              <pre className="m-0 whitespace-pre-wrap break-words text-left font-mono text-[10px] leading-4">
                {answer.slice(5)}
              </pre>
            ) : (
              <span className="whitespace-pre-wrap">{answer}</span>
            )
          ) : (
            <span className="text-gray-400">按上方相机按钮识别当前屏幕</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div id="app-content" className="px-6 pt-4 pb-16">
      {/* Error Banner */}
      {errorMessage && (
        <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg flex items-start gap-3">
          <svg
            className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-red-400 font-medium text-sm">API 调用失败</p>
            <p className="text-red-300/80 text-sm mt-0.5 break-words">{errorMessage}</p>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-400/80 hover:text-red-300 flex-shrink-0"
            title="关闭"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Screenshot Gallery */}
      {recentScreenshots.length > 0 ? (
        <div className="mb-4 flex gap-2 overflow-x-auto pb-2">
          {recentScreenshots.map((data, index) => (
            <img
              key={index}
              src={`data:image/png;base64,${data}`}
              alt={`Screenshot ${index + 1}`}
              className="w-40 h-auto flex-shrink-0 border border-gray-600 rounded-lg shadow-lg hover:shadow-xl transition-shadow"
              title={`第 ${index + 1} 张截图`}
            />
          ))}
        </div>
      ) : screenshotData ? (
        <div className="mb-4">
          <img
            src={`data:image/png;base64,${screenshotData}`}
            alt="Screenshot"
            className="w-40 h-auto border border-gray-600 rounded-lg shadow-lg"
          />
        </div>
      ) : (
        <ShortcutTip />
      )}

      {/* Solution Display */}
      <MarkdownRenderer>{deferredSolutionText}</MarkdownRenderer>
    </div>
  )
}

function ShortcutTip() {
  const { shortcuts } = useShortcutsStore()

  return (
    <div className="flex items-center justify-center h-full text-xl text-gray-400 select-none">
      请按下快捷键
      <ShortcutRenderer
        shortcut={shortcuts.takeScreenshot.key}
        className="mx-1 font-bold text-black"
      />
      抓取屏幕进行分析
    </div>
  )
}
