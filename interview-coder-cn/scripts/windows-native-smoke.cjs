/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const { join } = require('node:path')
const assert = require('node:assert/strict')

if (process.platform !== 'win32') throw new Error('Run this smoke check on Windows')
const native = join(__dirname, '../native/bin')
const capabilities = JSON.parse(
  execFileSync(join(native, 'capture-helper.exe'), ['--capabilities'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000
  })
)
assert.equal(capabilities.ok, true)
assert.equal(capabilities.protocol, 1)
assert.ok(capabilities.methods.includes('gdi'))

async function checkProcess(file, args, use) {
  const child = spawn(join(native, file), args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const deadline = setTimeout(() => child.kill(), 15000)
  child.stderr.resume()
  const lines = []
  let input = ''
  child.stdout.on('data', (chunk) => {
    input += chunk
    let newline
    while ((newline = input.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(input.slice(0, newline)))
      input = input.slice(newline + 1)
    }
  })
  const closed = once(child, 'close')
  try {
    await use(child, lines)
    child.stdin.end('stop\n')
    const [code] = await closed
    assert.equal(code, 0)
    return lines
  } finally {
    clearTimeout(deadline)
    child.kill()
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

;(async () => {
  const sampled = await checkProcess(
    'capture-helper.exe',
    ['--watch-background'],
    async (child, lines) => {
      child.stdin.write('0 0 160 120\n')
      for (let i = 0; i < 100 && lines.length === 0; i++) await pause(25)
      assert.ok(lines.length > 0)
      assert.ok(['light', 'dark'].includes(lines[0].theme))
    }
  )
  const ordering = await checkProcess(
    'capture-helper.exe',
    ['--watch-window-order'],
    async (child, lines) => {
      child.stdin.write('0 0 auto\n')
      for (let i = 0; i < 100 && lines.length === 0; i++) await pause(25)
      assert.equal(lines[0]?.ok, true)
      assert.equal(lines[0]?.covered, false)
    }
  )
  const overlay = await checkProcess(
    'answer-overlay.exe',
    ['--hover-ms', '0'],
    async (child, lines) => {
      for (let i = 0; i < 100 && !lines.some((line) => line.event === 'ready'); i++) await pause(25)
      assert.ok(lines.some((line) => line.event === 'ready'))
      const send = async (command, value) => {
        if (!child.stdin.write(`${command} ${Buffer.from(value).toString('base64')}\n`))
          await once(child.stdin, 'drain')
      }
      await send('appearance', 'text')
      for (let i = 0; i < 1000; i++)
        await send('text', `稳定性检查 ${i}\n` + '测试文字 '.repeat(80))
      await send('appearance', 'panel')
      await send('appearance', 'text')
      await pause(400)
    }
  )
  assert.ok(overlay.some((line) => line.event === 'exit'))
  console.log(
    JSON.stringify({
      ok: true,
      nativeStartup: true,
      backgroundSample: sampled[0].ok,
      windowOrderProtocol: ordering[0].ok,
      nativeWindow: true,
      updatesSent: 1000,
      cleanExit: true
    })
  )
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
