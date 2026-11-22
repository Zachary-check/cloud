import { parentPort } from 'node:worker_threads'
import { processImage, type ImageJob } from './image-codec'

parentPort?.on('message', ({ id, job }: { id: number; job: ImageJob }) => {
  try {
    const result = processImage(job)
    const transfers = result.kind === 'decoded' ? [result.frame.pixels.buffer as ArrayBuffer] : []
    parentPort?.postMessage({ id, result }, transfers)
  } catch (error) {
    parentPort?.postMessage({
      id,
      error: error instanceof Error ? error.message : '截图编码失败'
    })
  }
})
