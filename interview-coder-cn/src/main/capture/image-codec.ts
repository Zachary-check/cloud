import { PNG } from 'pngjs'
import type { CaptureFrame } from '../../shared/capture'

const MAX_PIXELS = 33554432
const MAX_PNG_BYTES = MAX_PIXELS * 4 + 1048576
const PREVIEW_WIDTH = 640

export type ImageJob =
  | { kind: 'encode'; frame: CaptureFrame; preview: boolean }
  | { kind: 'decode'; png: Uint8Array }
export type ImageResult =
  | { kind: 'encoded'; image: string; preview: string }
  | { kind: 'decoded'; frame: CaptureFrame }

function validateSize(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 32768 ||
    height > 32768 ||
    width * height > MAX_PIXELS
  )
    throw new Error('截图尺寸超出处理范围')
}

function encode(width: number, height: number, data: Buffer): string {
  const png = new PNG()
  png.width = width
  png.height = height
  png.data = data
  return PNG.sync.write(png, { deflateLevel: 3, filterType: 1, colorType: 2 }).toString('base64')
}

/** Runs only in a worker: full-screen pixel conversion, PNG compression and previews. */
export function processImage(job: ImageJob): ImageResult {
  if (job.kind === 'decode') {
    const png = Buffer.from(job.png.buffer, job.png.byteOffset, job.png.byteLength)
    if (
      png.length < 33 ||
      png.length > MAX_PNG_BYTES ||
      !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      png.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw new Error('截图 PNG 数据无效')
    validateSize(png.readUInt32BE(16), png.readUInt32BE(20))
    const decoded = PNG.sync.read(png, { checkCRC: true })
    const pixels = decoded.data
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset]
      pixels[offset] = pixels[offset + 2]
      pixels[offset + 2] = red
      pixels[offset + 3] = 255
    }
    return {
      kind: 'decoded',
      frame: {
        pixels,
        width: decoded.width,
        height: decoded.height,
        stride: decoded.width * 4
      }
    }
  }
  const { width, height, stride, pixels } = job.frame
  validateSize(width, height)
  if (stride !== width * 4 || pixels.byteLength !== stride * height)
    throw new Error('截图像素数据不完整')
  const rgba = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const blue = rgba[offset]
    rgba[offset] = rgba[offset + 2]
    rgba[offset + 2] = blue
    rgba[offset + 3] = 255
  }
  const image = encode(width, height, rgba)
  let preview = ''
  if (job.preview) {
    if (width <= PREVIEW_WIDTH) preview = image
    else {
      const previewHeight = Math.max(1, Math.round((height * PREVIEW_WIDTH) / width))
      const small = Buffer.allocUnsafe(PREVIEW_WIDTH * previewHeight * 4)
      for (let y = 0; y < previewHeight; y++) {
        const sourceY = Math.min(height - 1, Math.floor(((y + 0.5) * height) / previewHeight))
        for (let x = 0; x < PREVIEW_WIDTH; x++) {
          const sourceX = Math.min(width - 1, Math.floor(((x + 0.5) * width) / PREVIEW_WIDTH))
          const source = (sourceY * width + sourceX) * 4
          small.writeUInt32LE(rgba.readUInt32LE(source), (y * PREVIEW_WIDTH + x) * 4)
        }
      }
      preview = encode(PREVIEW_WIDTH, previewHeight, small)
    }
  }
  return { kind: 'encoded', image, preview }
}
