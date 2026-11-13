import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaptureBackend } from './service'
import type { CaptureCapabilities, CaptureFrame, CaptureWindow } from '../../shared/capture'
import { nativeEnvironment } from './native-environment'

const execute = promisify(execFile)
const MAX_PIXELS = 33554432
export function validateFrame(
  metadata: { width: number; height: number; stride: number },
  byteLength: number
): void {
  const { width, height, stride } = metadata
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 32768 ||
    height > 32768 ||
    width * height > MAX_PIXELS ||
    stride !== width * 4 ||
    byteLength !== stride * height
  )
    throw new Error('原生采集返回的图像数据不完整')
}

export function createNativeBackend(executable: string): CaptureBackend {
  let capabilities: Promise<CaptureCapabilities> | null = null
  async function command(args: string[], signal?: AbortSignal, timeout = 4000) {
    const { stdout } = await execute(executable, args, {
      windowsHide: true,
      timeout,
      maxBuffer: 512 * 1024,
      encoding: 'utf8',
      env: nativeEnvironment(),
      signal
    })
    const result = JSON.parse(stdout.trim())
    if (result.ok !== true) throw new Error('原生采集助手无法完成本次操作')
    return result
  }
  return {
    capabilities() {
      capabilities ??= command(['--capabilities'], undefined, 1500)
        .then((result) => ({ ...result, native: true }) as CaptureCapabilities)
        .catch((error) => {
          capabilities = null
          throw error
        })
      return capabilities
    },
    async snapshot(signal) {
      const result = await command(['--snapshot', '--owner-pid', String(process.pid)], signal, 1500)
      return { windows: result.windows as CaptureWindow[] }
    },
    async capture({ mode, platform, display, signal }) {
      const directory = await mkdtemp(join(tmpdir(), 'integrated-capture-'))
      const output = join(directory, 'frame.bgra')
      try {
        const metadata = await command(
          [
            '--mode',
            mode,
            '--platform',
            platform,
            '--display',
            display,
            '--owner-pid',
            String(process.pid),
            '--output',
            output
          ],
          signal
        )
        validateFrame(metadata, (await stat(output)).size)
        const pixels = await readFile(output)
        validateFrame(metadata, pixels.length)
        return { ...metadata, pixels } as CaptureFrame
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
}
