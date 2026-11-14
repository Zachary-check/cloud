import type { CaptureFrame, FrameQuality } from '../../shared/capture'

const SAMPLE_EDGE = 480
const BLACK_LUMA = 12

/** Inspect BGRA pixels without decoding images or retaining frame contents. */
export function inspectFrame({
  pixels,
  width,
  height,
  stride = width * 4
}: Pick<CaptureFrame, 'pixels' | 'width' | 'height'> & { stride?: number }): FrameQuality {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isInteger(stride) ||
    stride < width * 4 ||
    !pixels ||
    pixels.length < stride * height
  ) {
    throw new TypeError('Invalid BGRA frame')
  }
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(width, height))
  const cols = Math.max(1, Math.round(width * scale))
  const rows = Math.max(1, Math.round(height * scale))
  const histogram = new Int32Array(cols)
  const stack = new Int32Array(cols + 1)
  let black = 0
  let edges = 0
  let largest = { area: 0, left: 0, top: 0, right: 0, bottom: 0 }

  for (let y = 0; y < rows; y++) {
    const sourceY = Math.min(height - 1, Math.floor((y * height) / rows))
    let previous = 0
    for (let x = 0; x < cols; x++) {
      const sourceX = Math.min(width - 1, Math.floor((x * width) / cols))
      const offset = sourceY * stride + sourceX * 4
      const luma =
        (pixels[offset + 2] * 299 + pixels[offset + 1] * 587 + pixels[offset] * 114) / 1000
      const dark = luma < BLACK_LUMA
      if (dark) black++
      histogram[x] = dark ? histogram[x] + 1 : 0
      if (x > 0 && Math.abs(luma - previous) > 24) edges++
      previous = luma
    }
    let depth = 0
    for (let x = 0; x <= cols; x++) {
      const value = x === cols ? -1 : histogram[x]
      while (depth > 0 && histogram[stack[depth - 1]] > value) {
        const index = stack[--depth]
        const left = depth === 0 ? 0 : stack[depth - 1] + 1
        const area = histogram[index] * (x - left)
        if (area > largest.area) {
          largest = { area, left, top: y - histogram[index] + 1, right: x - 1, bottom: y }
        }
      }
      stack[depth++] = x
    }
  }

  const total = cols * rows
  const blackRatio = black / total
  const edgeRatio = edges / total
  const rectangleRatio = largest.area / total
  const uniformBlack = blackRatio >= 0.98 && edgeRatio < 0.00005
  const insetBlack =
    rectangleRatio >= 0.6 &&
    largest.left >= 2 &&
    largest.top >= 2 &&
    cols - 1 - largest.right >= 2 &&
    rows - 1 - largest.bottom >= 2
  return {
    status: uniformBlack ? 'blank' : insetBlack ? 'obscured' : 'usable',
    blackRatio,
    edgeRatio,
    rectangleRatio,
    sampledWidth: cols,
    sampledHeight: rows
  }
}
