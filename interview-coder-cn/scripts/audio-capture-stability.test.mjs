import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = process.env.INTERVIEW_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const ts = require('typescript')
const compiled = ts.transpileModule(
  readFileSync(join(root, 'src/renderer/src/lib/audio-capture.ts'), 'utf8'),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }
).outputText

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup(options = {}) {
  const streams = []
  const contexts = []
  let packets = 0
  let bytes = 0
  let maxPacketBytes = 0
  class Track extends EventTarget {
    stopped = false
    kind
    constructor(kind) {
      super()
      this.kind = kind
    }
    stop() {
      this.stopped = true
    }
    end() {
      this.stopped = true
      this.dispatchEvent(new Event('ended'))
      this.onended?.()
    }
  }
  class Stream {
    audio = [new Track('audio')]
    video = [new Track('video')]
    constructor(tracks) {
      if (tracks) {
        this.audio = tracks.filter((t) => t.kind === 'audio')
        this.video = tracks.filter((t) => t.kind === 'video')
      } else streams.push(this)
    }
    getAudioTracks() {
      return this.audio
    }
    getVideoTracks() {
      return this.video
    }
    getTracks() {
      return [...this.audio, ...this.video]
    }
  }
  class Context extends EventTarget {
    state = 'running'
    sampleRate = 48000
    destination = {}
    closed = false
    nodes = []
    constructor() {
      super()
      contexts.push(this)
      if (options.resume) this.state = 'suspended'
      if (options.constructFails) throw new Error('Audio device initialization failed')
    }
    resume() {
      this.state = 'running'
      return options.resume?.promise || Promise.resolve()
    }
    close() {
      this.closed = true
      this.state = 'closed'
      this.dispatchEvent(new Event('statechange'))
      return Promise.resolve()
    }
    createMediaStreamSource() {
      if (options.sourceFails) throw new Error('Audio stream could not be connected')
      const node = {
        connected: false,
        connect() {
          this.connected = true
        },
        disconnect() {
          this.connected = false
        }
      }
      this.nodes.push(node)
      return node
    }
    createScriptProcessor() {
      const node = {
        connected: false,
        onaudioprocess: null,
        connect() {
          this.connected = true
        },
        disconnect() {
          this.connected = false
        }
      }
      this.nodes.push(node)
      return node
    }
  }
  let opens = 0
  const acquire = () => {
    opens++
    return options.acquisition?.promise || Promise.resolve(new Stream())
  }
  const exports = {}
  runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.equal(name, '@/lib/store/settings')
      return {
        useSettingsStore: {
          getState: () => ({ audioCaptureSource: 'system', transcriptionInputGain: 1 })
        }
      }
    },
    navigator: { mediaDevices: { getDisplayMedia: acquire, getUserMedia: acquire } },
    window: {
      api: {
        sendTranscriptionAudioChunk: (packet) => {
          packets++
          bytes += packet.byteLength
          maxPacketBytes = Math.max(maxPacketBytes, packet.byteLength)
        }
      }
    },
    AudioContext: Context,
    MediaStream: Stream,
    Float32Array,
    Int16Array,
    Error,
    console: {
      warn() {
        return undefined
      },
      error() {
        return undefined
      }
    }
  })
  return {
    exports,
    streams,
    contexts,
    Stream,
    stats: () => ({ packets, bytes, maxPacketBytes, opens })
  }
}

test('stopping while the device is opening releases the late stream instead of resurrecting capture', async () => {
  const acquisition = deferred()
  const h = setup({ acquisition })
  const starting = h.exports.startAudioCapture()
  h.exports.stopAudioCapture()
  const stream = new h.Stream()
  acquisition.resolve(stream)
  await starting
  assert.ok(
    stream.getTracks().every((t) => t.stopped),
    'A late device acquisition restarted capture after stop'
  )
  assert.equal(h.contexts.length, 0)
})

test('stopping during audio context resume releases the device immediately', async () => {
  const resume = deferred()
  const h = setup({ resume })
  const starting = h.exports.startAudioCapture()
  for (let i = 0; i < 20 && h.contexts.length === 0; i++) await Promise.resolve()
  assert.equal(h.contexts.length, 1)
  h.exports.stopAudioCapture()
  assert.ok(h.contexts[0].closed)
  assert.ok(h.streams[0].getTracks().every((track) => track.stopped))
  resume.resolve()
  assert.equal(await starting, false)
})

test('overlapping capture requests share one device acquisition', async () => {
  const acquisition = deferred()
  const h = setup({ acquisition })
  const first = h.exports.startAudioCapture()
  const second = h.exports.startAudioCapture()
  acquisition.resolve(new h.Stream())
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(h.stats().opens, 1)
  assert.equal(h.contexts.length, 1)
  h.exports.stopAudioCapture()
})

test('audio graph setup failure cannot strand an active device and block the next start', async () => {
  const h = setup({ sourceFails: true })
  await assert.rejects(h.exports.startAudioCapture(), /could not be connected/)
  assert.ok(
    h.streams[0].getTracks().every((t) => t.stopped),
    'Failed startup leaked an open audio device'
  )
  assert.ok(h.contexts[0].closed)
  await assert.rejects(h.exports.startAudioCapture(), /could not be connected/)
  assert.equal(h.stats().opens, 2)
})

test('device removal reports interruption and releases resources instead of displaying false recognition', async () => {
  const h = setup()
  const interruptions = []
  await h.exports.startAudioCapture((message) => interruptions.push(message))
  h.streams[0].getAudioTracks()[0].end()
  assert.equal(
    interruptions.length,
    1,
    'Audio device ended with no notification to the interview UI'
  )
  assert.ok(h.contexts[0].closed)
  assert.ok(h.streams[0].getTracks().every((t) => t.stopped))
})

test('100 start/stop cycles leave no live device, node, or audio context', async () => {
  const h = setup()
  for (let i = 0; i < 100; i++) {
    await h.exports.startAudioCapture()
    h.exports.stopAudioCapture()
  }
  assert.equal(h.contexts.length, 100)
  assert.ok(
    h.contexts.every((context) => context.closed && context.nodes.every((node) => !node.connected))
  )
  assert.ok(h.streams.every((stream) => stream.getTracks().every((track) => track.stopped)))
})

test('intentional stop never reports a device failure or re-enters interruption cleanup', async () => {
  const h = setup()
  const interruptions = []
  await h.exports.startAudioCapture((message) => interruptions.push(message))
  h.exports.stopAudioCapture()
  assert.equal(interruptions.length, 0)
  assert.ok(h.contexts[0].closed)
})

test('90 minutes of synthetic 48kHz audio preserve 16kHz packet size and sample count', async () => {
  const h = setup()
  await h.exports.startAudioCapture()
  const processAudio = h.contexts[0].nodes[1].onaudioprocess
  const input = new Float32Array(1024)
  const totalSamples = 90 * 60 * 48000
  let remaining = totalSamples
  while (remaining > 0) {
    const samples = remaining >= input.length ? input : input.subarray(0, remaining)
    processAudio({ inputBuffer: { getChannelData: () => samples } })
    remaining -= samples.length
  }
  h.exports.stopAudioCapture()
  const stats = h.stats()
  assert.equal(stats.maxPacketBytes, 3200)
  assert.ok(
    Math.abs(stats.bytes / 2 - totalSamples / 3) <= 1,
    `Resampler drift: ${stats.bytes / 2 - totalSamples / 3} samples`
  )
  assert.equal(stats.packets, 54_000)
})
