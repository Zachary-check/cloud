import ImageWorker from './image-worker?nodeWorker'
import { createImageWorkerClient } from './image-worker-client'
import type { CaptureFrame } from '../../shared/capture'

const client = createImageWorkerClient(() =>
  ImageWorker({ env: {}, resourceLimits: { maxOldGenerationSizeMb: 128 } })
)
let cachedPreview: { image: string; preview: string } | null = null

export async function encodeCaptureFrame(
  frame: CaptureFrame,
  preview: boolean,
  signal?: AbortSignal
): Promise<string> {
  const result = await client.run({ kind: 'encode', frame, preview }, signal)
  if (result.kind !== 'encoded') throw new Error('截图编码结果无效')
  cachedPreview = { image: result.image, preview: result.preview }
  return result.image
}

export async function decodeCapturePng(
  png: Uint8Array,
  signal?: AbortSignal
): Promise<CaptureFrame> {
  const result = await client.run({ kind: 'decode', png }, signal)
  if (result.kind !== 'decoded') throw new Error('截图解码结果无效')
  return result.frame
}

/** Preview lookup must never decode a full-screen PNG on the main thread. */
export function cachedDisplayThumbnail(image: string): string {
  return cachedPreview?.image === image ? cachedPreview.preview : ''
}

export function closeImageProcessing(): void {
  client.close()
  cachedPreview = null
}
