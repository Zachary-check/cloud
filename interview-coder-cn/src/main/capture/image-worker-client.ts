import type { Worker } from 'node:worker_threads'
import type { ImageJob, ImageResult } from './image-codec'

/** One in-flight image job, with cancellation, crash isolation and a bounded lifetime. */
export function createImageWorkerClient(createWorker: () => Worker, timeoutMs = 12000) {
  let worker: Worker | null = null
  let sequence = 0
  let pending: {
    id: number
    finish(error?: Error, result?: ImageResult): void
  } | null = null

  function stop(error = new Error('截图处理已取消')): void {
    const previous = worker
    worker = null
    pending?.finish(error)
    if (previous) void previous.terminate().catch(() => {})
  }

  function getWorker(): Worker {
    if (worker) return worker
    const current = createWorker()
    worker = current
    current.on('error', () => {
      if (worker === current) stop(new Error('截图处理进程异常，请重新截图'))
    })
    current.on('exit', () => {
      if (worker === current) stop(new Error('截图处理进程已退出，请重新截图'))
    })
    current.on('message', (message) => {
      if (worker !== current || message?.id !== pending?.id) return
      if (typeof message.error === 'string') pending?.finish(new Error(message.error))
      else if (message.result?.kind === 'encoded' || message.result?.kind === 'decoded')
        pending?.finish(undefined, message.result)
      else stop(new Error('截图处理返回了无效结果'))
    })
    return current
  }

  return {
    close: stop,
    run(job: ImageJob, signal?: AbortSignal): Promise<ImageResult> {
      if (signal?.aborted) return Promise.reject(new Error('截图处理已取消'))
      if (pending) stop()
      return new Promise((resolve, reject) => {
        const current = getWorker()
        const id = ++sequence
        let settled = false
        const abort = () => stop()
        const deadline = setTimeout(() => stop(new Error('截图处理超时，请重试')), timeoutMs)
        pending = {
          id,
          finish(error, result) {
            if (settled) return
            settled = true
            clearTimeout(deadline)
            signal?.removeEventListener('abort', abort)
            if (pending?.id === id) pending = null
            current.unref()
            if (error) reject(error)
            else resolve(result!)
          }
        }
        signal?.addEventListener('abort', abort, { once: true })
        try {
          current.ref()
          const pixels = job.kind === 'encode' ? job.frame.pixels : job.png
          // Node may pool small Buffers. Never detach an unrelated pooled allocation.
          const data =
            pixels.byteOffset === 0 && pixels.byteLength === pixels.buffer.byteLength
              ? pixels
              : Uint8Array.from(pixels)
          const payload =
            job.kind === 'encode'
              ? { ...job, frame: { ...job.frame, pixels: data } }
              : { ...job, png: data }
          current.postMessage({ id, job: payload }, [data.buffer as ArrayBuffer])
        } catch {
          stop(new Error('无法启动截图处理，请重试'))
        }
      })
    }
  }
}
