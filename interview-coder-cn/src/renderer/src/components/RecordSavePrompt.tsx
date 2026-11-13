import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** What the main process offers as a starting point for the file name. */
interface CloseRequest {
  /** Default name, already free of the `.md` suffix (which is fixed here). */
  name: string
  /** Directory the file is being written to. */
  dir: string
}

/** Reasons the main process refuses a name, spelled out for the user. */
const FAILURE_MESSAGE: Record<string, string> = {
  exists: '这个文件名已经存在，换一个吧。',
  invalid: '文件名不能为空，也不能只有符号。',
  failed: '重命名失败，文件可能正被占用，换个名字再试试。',
  missing: '没有找到这次会话的记录文件。'
}

/**
 * Asks for the file name when the window is closing, because this run recorded
 * an interview. The transcript is already on disk under a default name, so
 * every answer here — including "不保存" — ends with the app exiting, and
 * "取消" is the only way to go back to the interview.
 *
 * The main process holds the close open while this is on screen, which is why
 * the dialog must always be able to answer something.
 */
export function RecordSavePrompt() {
  const [request, setRequest] = useState<CloseRequest | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.api.onInterviewRecordCloseRequest((session) => {
      setRequest(session)
      setName(session.name)
      setError(null)
      setBusy(false)
    })
    return () => window.api.removeInterviewRecordCloseRequestListener()
  }, [])

  useEffect(() => {
    if (!request) return
    // Selected, not just focused: typing replaces the generated name outright.
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [request])

  const submit = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await window.api.saveInterviewRecord(name)
    // On success the main process closes the window; anything still rendered
    // here would only show up for a frame.
    if (result.ok) return
    setBusy(false)
    setError(FAILURE_MESSAGE[result.reason] ?? '保存失败，请重试。')
  }, [busy, name])

  const discard = useCallback(async () => {
    if (busy) return
    setBusy(true)
    await window.api.discardInterviewRecord()
  }, [busy])

  const cancel = useCallback(async () => {
    if (busy) return
    await window.api.cancelInterviewRecordClose()
    setRequest(null)
  }, [busy])

  if (!request) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-lg rounded-xl bg-gray-100 p-6 text-gray-900 shadow-2xl">
        <h2 className="text-base font-semibold">保存面试记录</h2>
        <p className="mt-2 text-sm text-gray-600">
          本次问答记录将保存到下面的目录，文件名可以改成方便区分的名字：
        </p>
        <p className="mt-1 break-all text-xs text-gray-500">{request.dir}</p>

        <div className="mt-4 flex items-center gap-2">
          <Input
            ref={inputRef}
            value={name}
            disabled={busy}
            aria-label="记录文件名"
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                void cancel()
              }
            }}
            className="bg-white"
          />
          <span className="text-sm text-gray-500">.md</span>
        </div>

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>
            取消
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void discard()}>
            不保存
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            保存并退出
          </Button>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          取消会回到面试界面继续记录；不保存会删除这次的记录文件。
        </p>
      </div>
    </div>
  )
}
