import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { app, clipboard } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nativeEnvironment } from './capture/native-environment'

let child: ChildProcessWithoutNullStreams | null = null
let opening: Promise<void> | null = null
let answer = ''
let timer: ReturnType<typeof setTimeout> | null = null
let closingApp = false
let ready = false
let trigger: (action: string) => void = () => {}
let reveal: () => void = () => {}

export function nativeExecutable(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'native', `${name}.exe`)
    : join(app.getAppPath(), 'native', 'bin', `${name}.exe`)
}
export function initNativeOverlay(onAction: (action: string) => void, onClose: () => void): void {
  trigger = onAction
  reveal = onClose
}
export function nativeOverlayActive(): boolean {
  return ready && !!child
}
function write(command: string, value: string): void {
  if (!child?.stdin.writable || !ready) return
  try {
    child.stdin.write(`${command} ${Buffer.from(value.slice(-64000), 'utf8').toString('base64')}\n`)
  } catch {
    /* Process exit owns cleanup. */
  }
}
export function nativeAnswerEvent(kind: 'clear' | 'chunk' | 'status', text = ''): void {
  if (kind === 'status') {
    write('status', text)
    return
  }
  answer = kind === 'clear' ? '' : (answer + text).slice(-64000)
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    write('text', answer)
  }, 80)
}
export async function openNativeOverlay(hoverMs: number): Promise<void> {
  if (nativeOverlayActive()) return
  if (opening) return opening
  const executable = nativeExecutable('answer-overlay')
  if (process.platform !== 'win32' || !existsSync(executable))
    throw new Error('原生答题窗仅在包含原生组件的 Windows 版本中提供')
  opening = new Promise<void>((resolve, reject) => {
    const process = spawn(executable, ['--hover-ms', String(hoverMs || 1200)], {
      windowsHide: true,
      env: nativeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child = process
    let settled = false
    let buffer = ''
    const deadline = setTimeout(() => {
      process.kill()
      settle(new Error('原生答题窗启动超时'))
    }, 5000)
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) reject(error)
      else resolve()
    }
    process.stdin.on('error', () => {})
    process.stderr.on('data', () => {})
    process.on('error', (error) => settle(error))
    process.on('close', () => {
      const wasReady = ready && child === process
      if (child === process) {
        child = null
        ready = false
      }
      settle(new Error('原生答题窗已退出'))
      if (wasReady && !closingApp) reveal()
    })
    process.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      if (buffer.length > 32768) {
        process.kill()
        return
      }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const event = JSON.parse(line).event
          if (event === 'ready') {
            ready = true
            settle()
            write('text', answer)
            write('status', '截题、加页与 AI 配置沿用工作台；悬停或点击按钮操作')
          } else if (event === 'copy') {
            clipboard.writeText(answer.match(/```[^\n]*\n([\s\S]*?)```/)?.[1]?.trim() || answer)
            write('status', '已复制当前答案')
          } else if (['capture', 'append', 'stop'].includes(event)) trigger(event)
          else if (event === 'exit') process.stdin.end()
        } catch {
          /* Ignore an incomplete helper message. */
        }
      }
    })
  }).finally(() => {
    opening = null
  })
  return opening
}
export function closeNativeOverlay(quit = false): void {
  closingApp ||= quit
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  child?.stdin.end('stop\n')
  const current = child
  if (current) {
    const deadline = setTimeout(() => current.kill(), 1000)
    deadline.unref()
  }
}
