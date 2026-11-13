import { useSettingsStore } from '@/lib/store/settings'

const ASR_SAMPLE_RATE = 16000
/** DashScope recommends PCM packets of roughly 100 ms (1600 mono samples). */
const ASR_PACKET_SAMPLES = ASR_SAMPLE_RATE / 10
// 1024 keeps the first 100 ms packet from waiting on a 2k-frame callback;
// buffering below still coalesces these callbacks into network-sized packets.
const SCRIPT_PROCESSOR_BUFFER_SIZE = 1024

let mediaStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let processor: ScriptProcessorNode | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let captureGeneration = 0
let startingCapture: Promise<boolean> | null = null
let pendingPcm = new Int16Array(0)
let resampleBuffer = new Float32Array(0)
let resamplePosition = 0
let resampleInputRate = ASR_SAMPLE_RATE
let smoothedInputLevel = 0
const inputLevelListeners = new Set<(level: number) => void>()

function emitInputLevel(level: number): void {
  smoothedInputLevel = smoothedInputLevel * 0.72 + level * 0.28
  inputLevelListeners.forEach((listener) => listener(smoothedInputLevel))
}

function calculateInputLevel(samples: Float32Array, gain: number): number {
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] * gain))
    sumSquares += sample * sample
  }
  const rms = Math.sqrt(sumSquares / samples.length)
  return Math.min(1, rms * 8)
}

function resetResampler(inputSampleRate = ASR_SAMPLE_RATE): void {
  resampleBuffer = new Float32Array(0)
  resamplePosition = 0
  resampleInputRate = inputSampleRate
}

/**
 * Resample continuously instead of restarting at every ScriptProcessor
 * callback. Keeping the fractional position prevents gaps/duplicate samples
 * at callback boundaries and avoids long-term clock drift.
 */
function resample(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === ASR_SAMPLE_RATE) {
    if (resampleBuffer.length > 0 || resampleInputRate !== inputSampleRate) {
      resetResampler(inputSampleRate)
    }
    return input
  }

  if (resampleInputRate !== inputSampleRate) resetResampler(inputSampleRate)

  const combined = new Float32Array(resampleBuffer.length + input.length)
  combined.set(resampleBuffer)
  combined.set(input, resampleBuffer.length)

  const step = inputSampleRate / ASR_SAMPLE_RATE
  const output = new Float32Array(Math.ceil(combined.length / step))
  let outputLength = 0

  // Keep one source sample available for interpolation on the next callback.
  while (resamplePosition + 1 < combined.length) {
    const start = Math.floor(resamplePosition)
    const fraction = resamplePosition - start
    output[outputLength++] = combined[start] * (1 - fraction) + combined[start + 1] * fraction
    resamplePosition += step
  }

  // The next output may need the last retained source sample. Never drop it
  // even when the fractional position has advanced past this callback.
  const consumed = Math.min(Math.floor(resamplePosition), Math.max(0, combined.length - 1))
  if (consumed > 0) {
    resampleBuffer = combined.slice(consumed)
    resamplePosition -= consumed
  } else {
    resampleBuffer = combined
  }

  return output.slice(0, outputLength)
}

function enqueuePcm(samples: Int16Array): void {
  if (samples.length === 0) return

  const combined = new Int16Array(pendingPcm.length + samples.length)
  combined.set(pendingPcm)
  combined.set(samples, pendingPcm.length)

  let offset = 0
  while (offset + ASR_PACKET_SAMPLES <= combined.length) {
    const packet = combined.slice(offset, offset + ASR_PACKET_SAMPLES)
    window.api.sendTranscriptionAudioChunk(packet.buffer)
    offset += ASR_PACKET_SAMPLES
  }
  pendingPcm = combined.slice(offset)
}

function flushPendingPcm(): void {
  if (pendingPcm.length === 0) return
  // A final short packet is useful when the user pauses/stops immediately
  // after speaking; the regular stream remains in exact ~100 ms packets.
  window.api.sendTranscriptionAudioChunk(pendingPcm.buffer)
  pendingPcm = new Int16Array(0)
}

function sendAudioChunk(float32: Float32Array, inputSampleRate: number, gain: number): void {
  emitInputLevel(calculateInputLevel(float32, gain))

  const samples = resample(float32, inputSampleRate)
  const int16 = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * gain))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  enqueuePcm(int16)
}

async function openMicrophoneStream(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: deviceId
      ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
      : { echoCancellation: true, noiseSuppression: true },
    video: false
  })
}

async function openSystemAudioStream(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true
  })
  stream.getVideoTracks().forEach((t) => t.stop())
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('未获取到系统音频，请确认面试声音正在通过这台电脑播放')
  }
  return stream
}

export async function startAudioCapture(
  onInterrupted?: (message: string) => void
): Promise<boolean> {
  if (startingCapture) return startingCapture
  if (mediaStream) return true

  const pending = openAudioCapture(captureGeneration, onInterrupted)
  startingCapture = pending
  try {
    return await pending
  } finally {
    if (startingCapture === pending) startingCapture = null
  }
}

async function openAudioCapture(
  generation: number,
  onInterrupted?: (message: string) => void
): Promise<boolean> {
  pendingPcm = new Int16Array(0)
  resetResampler()

  const { audioCaptureSource, audioInputDeviceId, audioOutputDeviceId, transcriptionInputGain } =
    useSettingsStore.getState()

  let stream: MediaStream
  if (audioCaptureSource === 'microphone') {
    stream = await openMicrophoneStream(audioInputDeviceId || undefined)
  } else {
    stream = await openSystemAudioStream()
  }

  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let node: ScriptProcessorNode | null = null
  let started = false
  try {
    if (generation !== captureGeneration) return false
    mediaStream = stream
    context = new AudioContext({ latencyHint: 'interactive' })
    audioContext = context
    if (context.state === 'suspended') await context.resume()

    if (audioOutputDeviceId && 'setSinkId' in context) {
      try {
        await (context as AudioContext & { setSinkId: (id: string) => Promise<void> }).setSinkId(
          audioOutputDeviceId
        )
      } catch (err) {
        console.warn('Failed to set audio output device:', err)
      }
    }
    if (generation !== captureGeneration) return false
    if (stream.getAudioTracks().some((track) => track.readyState === 'ended')) {
      throw new Error('收音设备已断开，请检查设备后重试')
    }

    source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
    node = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1)
    const sampleRate = context.sampleRate
    node.onaudioprocess = (e) => {
      if (generation !== captureGeneration) return
      sendAudioChunk(e.inputBuffer.getChannelData(0), sampleRate, transcriptionInputGain)
    }
    source.connect(node)
    node.connect(context.destination)

    sourceNode = source
    processor = node
    const interrupted = () => {
      if (mediaStream !== stream) return
      stopAudioCapture()
      onInterrupted?.('收音设备或音频连接已断开，请检查设备后点麦克风重新开始')
    }
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener('ended', interrupted, { once: true })
    })
    context.addEventListener('statechange', () => {
      if (context?.state === 'closed') interrupted()
    })
    started = true
    return true
  } catch (error) {
    if (generation !== captureGeneration) return false
    throw error
  } finally {
    if (!started) {
      if (mediaStream === stream) mediaStream = null
      if (audioContext === context) audioContext = null
      if (node) {
        node.onaudioprocess = null
        node.disconnect()
      }
      source?.disconnect()
      if (context)
        void context.close().catch((error) => console.warn('Failed to close audio:', error))
      stream.getTracks().forEach((track) => track.stop())
    }
  }
}

export function subscribeToInputLevel(listener: (level: number) => void): () => void {
  inputLevelListeners.add(listener)
  listener(smoothedInputLevel)
  return () => inputLevelListeners.delete(listener)
}

export function stopAudioCapture(): void {
  // Invalidate device acquisitions/resume calls that have not resolved yet.
  captureGeneration += 1
  startingCapture = null
  const stream = mediaStream
  mediaStream = null
  try {
    flushPendingPcm()
  } catch (error) {
    console.warn('Failed to flush final audio packet:', error)
  }

  if (processor) {
    processor.onaudioprocess = null
    processor.disconnect()
    processor = null
  }
  if (sourceNode) {
    sourceNode.disconnect()
    sourceNode = null
  }
  if (audioContext) {
    const context = audioContext
    audioContext = null
    void context.close().catch((error) => console.warn('Failed to close audio:', error))
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop())
  }
  pendingPcm = new Int16Array(0)
  resetResampler()
  smoothedInputLevel = 0
  inputLevelListeners.forEach((listener) => listener(0))
}
