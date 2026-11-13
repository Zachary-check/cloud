import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PNG } from 'pngjs'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const compile = (name) =>
  ts.transpileModule(readFileSync(join(root, 'src/main/capture', name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
mkdirSync(join(root, '.cache'), { recursive: true })
const temporary = mkdtempSync(join(root, '.cache/image-test-'))
for (const name of ['image-worker', 'image-codec'])
  writeFileSync(join(temporary, name + '.js'), compile(name))
after(() => rmSync(temporary, { recursive: true, force: true }))
const exports = {}
runInNewContext(compile('image-worker-client'), {
  exports,
  setTimeout,
  clearTimeout,
  Uint8Array,
  Error,
  Promise
})
const { createImageWorkerClient } = exports
const realClient = () =>
  createImageWorkerClient(() => new Worker(join(temporary, 'image-worker.js')))
const frame = (width, height) => ({
  pixels: new Uint8Array(width * height * 4).fill(200),
  width,
  height,
  stride: width * 4
})

test('4K PNG conversion preserves pixels while the main event loop keeps running', async (t) => {
  const client = realClient()
  const input = frame(3840, 2160)
  input.pixels.set([10, 80, 230, 0])
  let ticks = 0
  let last = performance.now()
  let largestGap = 0
  const timer = setInterval(() => {
    ticks++
    const now = performance.now()
    largestGap = Math.max(largestGap, now - last)
    last = now
  }, 5)
  try {
    const result = await client.run({ kind: 'encode', frame: input, preview: true })
    assert.equal(result.kind, 'encoded')
    assert.ok(ticks > 0, 'pointer/UI timers must run while the image is compressed')
    t.diagnostic(
      `4K processing: ${ticks} timer ticks, maximum timer gap ${largestGap.toFixed(1)}ms`
    )
    const decoded = PNG.sync.read(Buffer.from(result.image, 'base64'))
    assert.equal(decoded.width, 3840)
    assert.equal(decoded.height, 2160)
    assert.deepEqual([...decoded.data.subarray(0, 4)], [230, 80, 10, 255])
    const preview = PNG.sync.read(Buffer.from(result.preview, 'base64'))
    assert.equal(preview.width, 640)
    assert.equal(preview.height, 360)
  } finally {
    clearInterval(timer)
    client.close()
  }
})

test('disabled previews are omitted, and fallback PNG decoding restores BGRA', async () => {
  const client = realClient()
  try {
    const input = frame(80, 40)
    input.pixels.set([30, 100, 240, 255])
    const encoded = await client.run({ kind: 'encode', frame: input, preview: false })
    assert.equal(encoded.preview, '')
    const decoded = await client.run({ kind: 'decode', png: Buffer.from(encoded.image, 'base64') })
    assert.equal(decoded.kind, 'decoded')
    assert.deepEqual([...decoded.frame.pixels.subarray(0, 4)], [30, 100, 240, 255])
  } finally {
    client.close()
  }
})

test('truncated pixels, invalid PNGs and excessive dimensions fail without killing the worker', async () => {
  const client = realClient()
  try {
    await assert.rejects(
      client.run({ kind: 'encode', frame: { ...frame(10, 10), stride: 10 }, preview: false }),
      /不完整/
    )
    await assert.rejects(client.run({ kind: 'decode', png: new Uint8Array(64) }), /无效/)
    const excessive = Buffer.alloc(33)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(excessive)
    excessive.write('IHDR', 12)
    excessive.writeUInt32BE(32768, 16)
    excessive.writeUInt32BE(32768, 20)
    await assert.rejects(client.run({ kind: 'decode', png: excessive }), /尺寸/)
    assert.equal(
      (await client.run({ kind: 'encode', frame: frame(4, 4), preview: false })).kind,
      'encoded'
    )
  } finally {
    client.close()
  }
})

class FakeWorker extends EventEmitter {
  ref() {
    return this
  }
  unref() {
    return this
  }
  postMessage(message) {
    this.message = message
  }
  terminate() {
    this.terminated = true
    return Promise.resolve(0)
  }
}

test('cancelled workers cannot settle a newer job, and crashed workers can be replaced', async () => {
  const workers = []
  const client = createImageWorkerClient(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker
  })
  const signal = new AbortController()
  const first = client.run({ kind: 'encode', frame: frame(4, 4), preview: false }, signal.signal)
  const rejected = assert.rejects(first, /取消/)
  signal.abort()
  await rejected
  assert.equal(workers[0].terminated, true)
  const second = client.run({ kind: 'encode', frame: frame(4, 4), preview: false })
  workers[0].emit('error', new Error('late'))
  workers[0].emit('exit', 1)
  const failure = assert.rejects(second, /异常/)
  workers[1].emit('error', new Error('crash'))
  await failure
  const third = client.run({ kind: 'encode', frame: frame(4, 4), preview: false })
  workers[2].emit('message', {
    id: workers[2].message.id,
    result: { kind: 'encoded', image: 'ok', preview: '' }
  })
  assert.equal((await third).image, 'ok')
  client.close()
})

test('a non-responsive worker has a deadline and is terminated', async () => {
  const worker = new FakeWorker()
  const client = createImageWorkerClient(() => worker, 25)
  await assert.rejects(client.run({ kind: 'encode', frame: frame(4, 4), preview: false }), /超时/)
  assert.equal(worker.terminated, true)
})
