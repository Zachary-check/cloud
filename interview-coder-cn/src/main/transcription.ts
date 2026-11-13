import { app, ipcMain } from 'electron'
import WebSocket from 'ws'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  DEFAULT_INTERVIEW_TRIGGER_DELAY_MS,
  DEFAULT_INTERVIEW_TRIGGER_MUTE_MS,
  normalizeInterviewTriggerDelayMs,
  normalizeInterviewTriggerMuteMs,
  shouldRearmTrigger
} from '../shared/interview-trigger'

const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/'
/**
 * How long a final ASR sentence must remain quiet before it is submitted as the
 * interview question. User-adjustable from the settings page, so this is only the
 * starting value; setInterviewTriggerDelayMs below is the single writer.
 */
let interviewTriggerDelayMs = DEFAULT_INTERVIEW_TRIGGER_DELAY_MS
/**
 * How long the recognizer's output is ignored after a question is submitted.
 * User-adjustable from the same settings card; setInterviewTriggerMuteMs below
 * is the single writer, and 0 turns the pause off.
 */
let interviewTriggerMuteMs = DEFAULT_INTERVIEW_TRIGGER_MUTE_MS
/** Keep the ASR VAD responsive; the separate interview trigger still waits 2s. */
const ASR_MAX_SENTENCE_SILENCE_MS = 800
/** Audio can begin while the WebSocket task is handshaking. Keep a short lead-in. */
const MAX_PENDING_AUDIO_CHUNKS = 20
/**
 * A connection that never opens leaves the UI showing "转录中" forever with no
 * audio flowing and no error, which is indistinguishable from a frozen app.
 */
const WS_OPEN_TIMEOUT_MS = 10_000
const WS_TASK_TIMEOUT_MS = 10_000
const RECONNECT_DELAY_MS = 500
const MAX_BUFFERED_AUDIO_BYTES = 1024 * 1024
const MIN_MEANINGFUL_TEXT_LENGTH = 10
const MIN_SHORT_QUESTION_LENGTH = 3
const SHORT_FRAGMENT_RETENTION_MS = 8000
const DUPLICATE_SUPPRESSION_MS = 5000
/**
 * How often the "armed but never fired" state is checked for.
 *
 * A submission is armed with a single timer, and that timer used to be the only
 * way a question ever reached the answer. The gateway can cancel it without
 * ever arming it again (it emits an empty `sentence_begin` marker when it opens
 * a sentence, and a dropped/merged sentence produces no final at all), which
 * left a fully transcribed question sitting on screen while the app waited for
 * something that was never coming. The watchdog turns that dead end into a
 * recoverable state instead of trusting one timer to survive.
 */
const TRIGGER_WATCHDOG_INTERVAL_MS = 500
const QUESTION_INTENT_PATTERN =
  /[?？]|为什么|为何|怎么|如何|什么|哪些|哪个|区别|差异|介绍|解释|说说|讲讲|能否|是否|是不是|可以吗|吗|呢|why\b|how\b|what\b|which\b|could you|can you/i
const NON_ACTIONABLE_PATTERN =
  /^(好的?|行|可以|明白|了解|收到|谢谢|辛苦了|那我们.*(?:下一题|到这里|结束)|今天.*(?:到这里|结束))[，,。.!！\s]*$/i

type WorkMode = 'written' | 'interview' | 'dual'
type InterviewTriggerHandler = (text: string) => void | Promise<void>

let ws: WebSocket | null = null
let taskId: string | null = null
let isTranscribing = false
let taskStarted = false
let accumulatedText = ''
let currentPartial = ''
let workMode: WorkMode = 'written'
let interviewTriggerTimer: NodeJS.Timeout | null = null
let shortFragmentExpiryTimer: NodeJS.Timeout | null = null
let wsOpenTimer: NodeJS.Timeout | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let interviewTriggerHandler: InterviewTriggerHandler | null = null
let lastTriggeredFingerprint = ''
let lastTriggeredAt = 0
/** Last time any transcript packet (partial or final) arrived. */
let lastResultAt = 0
/**
 * Text that was already evaluated and deliberately not submitted (too short,
 * or a filler sentence such as "好的"). The watchdog must not keep re-arming
 * for it, or the fragment would never be cleared.
 */
let rejectedFingerprint = ''
let triggerWatchdogTimer: NodeJS.Timeout | null = null
/**
 * Wall-clock end of the post-trigger pause. A timestamp rather than a timer on
 * purpose: there is no callback that can fail to run, no state to restore, and
 * nothing for a manual stop to leave dangling -- the packet check simply starts
 * passing again once the moment has gone by.
 */
let resultMuteUntil = 0
let pendingAudioChunks: Buffer[] = []
/**
 * The ASR gateway can close a task on its own (idle gateway, transient network
 * drop). Ending up in "stopped" costs the user a manual restart for something
 * they did not do, so re-open the session a bounded number of times first.
 */
const MAX_SILENT_RECONNECTS = 5
let silentReconnects = 0
let lastApiKey = ''

/**
 * Best-effort breadcrumb next to perf.log, so a report of "it just sat there"
 * can be answered with evidence instead of a guess. One line per submission or
 * per skip, so the file stays tiny.
 */
let asrLogPath: string | null = null
function logAsr(event: string, detail = '') {
  try {
    if (!asrLogPath) asrLogPath = join(app.getPath('userData'), 'asr.log')
    appendFileSync(asrLogPath, `${new Date().toISOString()} ${event} ${detail}\n`)
  } catch {
    // Never let diagnostics break recognition.
  }
}

function sendToRenderer(channel: string, ...args: unknown[]) {
  const mainWindow = global.mainWindow
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function cleanup() {
  clearInterviewTriggerTimer()
  clearShortFragmentExpiryTimer()
  clearWsOpenTimer()
  stopTriggerWatchdog()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  pendingAudioChunks = []
  if (ws) {
    const socket = ws
    ws = null
    socket.removeAllListeners()
    // ws emits an asynchronous error when a CONNECTING socket is cancelled.
    // Keep that expected error handled after detaching this session's callbacks.
    socket.on('error', () => {})
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate()
    }
  }
  taskId = null
  isTranscribing = false
  taskStarted = false
}

function recoverTranscription(message: string) {
  const mainWindow = global.mainWindow
  const canReconnect =
    isTranscribing &&
    workMode === 'interview' &&
    Boolean(lastApiKey) &&
    silentReconnects < MAX_SILENT_RECONNECTS &&
    mainWindow &&
    !mainWindow.isDestroyed()
  cleanup()
  if (!canReconnect) {
    sendToRenderer('transcription-error', `${message}；收音已停止，请点麦克风重新开始`)
    sendToRenderer('transcription-stopped')
    return
  }

  silentReconnects += 1
  // Keep capture running during the short retry, but allow a manual stop to
  // cancel both the retry and the pending audio through cleanup().
  isTranscribing = true
  logAsr('reconnect', `attempt=${silentReconnects}`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    isTranscribing = false
    try {
      if (startTranscription(lastApiKey, { silent: true })) return
    } catch (error) {
      console.warn('Failed to reconnect transcription:', error)
    }
    cleanup()
    sendToRenderer('transcription-error', '语音识别重新连接失败，请点麦克风重试')
    sendToRenderer('transcription-stopped')
  }, RECONNECT_DELAY_MS)
}

function clearInterviewTriggerTimer() {
  if (interviewTriggerTimer) {
    clearTimeout(interviewTriggerTimer)
    interviewTriggerTimer = null
  }
}

function clearShortFragmentExpiryTimer() {
  if (shortFragmentExpiryTimer) {
    clearTimeout(shortFragmentExpiryTimer)
    shortFragmentExpiryTimer = null
  }
}

function clearWsOpenTimer() {
  if (wsOpenTimer) {
    clearTimeout(wsOpenTimer)
    wsOpenTimer = null
  }
}

function getTextFingerprint(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function getMeaningfulTextLength(text: string): number {
  const withoutFillers = text.replace(
    /(^|[，,。.!！?？\s])(嗯+|呃+|额+|啊+|哦+|那个|这个|就是|然后|好+)(?=$|[，,。.!！?？\s])/gi,
    ' '
  )
  return getTextFingerprint(withoutFillers).length
}

function prepareTranscript(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && getMeaningfulTextLength(line) > 0)
    .join('\n')
}

function shouldTriggerInterview(text: string): boolean {
  if (NON_ACTIONABLE_PATTERN.test(text.trim())) return false
  const meaningfulLength = getMeaningfulTextLength(text)
  if (meaningfulLength >= MIN_MEANINGFUL_TEXT_LENGTH) return true

  // Keep short but explicit interview questions such as “为什么？” or “那缺点呢？”.
  return meaningfulLength >= MIN_SHORT_QUESTION_LENGTH && QUESTION_INTENT_PATTERN.test(text)
}

function isRecentlyTriggeredDuplicate(text: string): boolean {
  const fingerprint = getTextFingerprint(text)
  const now = Date.now()
  if (
    fingerprint &&
    fingerprint === lastTriggeredFingerprint &&
    now - lastTriggeredAt < DUPLICATE_SUPPRESSION_MS
  ) {
    return true
  }
  lastTriggeredFingerprint = fingerprint
  lastTriggeredAt = now
  return false
}

function scheduleShortFragmentExpiry() {
  clearShortFragmentExpiryTimer()
  shortFragmentExpiryTimer = setTimeout(() => {
    shortFragmentExpiryTimer = null
    if (workMode !== 'interview' || interviewTriggerTimer) return
    clearTranscriptionText()
    sendToRenderer('transcription-cleared')
  }, SHORT_FRAGMENT_RETENTION_MS)
}

function appendFinalText(text: string): boolean {
  const trimmedText = text.trim()
  if (!trimmedText) return false

  // Some ASR connections emit the same final result twice.
  const lastFinalText = accumulatedText.split('\n').at(-1)
  if (lastFinalText === trimmedText) return false
  accumulatedText += `${accumulatedText ? '\n' : ''}${trimmedText}`
  return true
}

function startTriggerWatchdog() {
  if (triggerWatchdogTimer) return
  triggerWatchdogTimer = setInterval(() => {
    if (workMode !== 'interview' || !isTranscribing) return

    const text = prepareTranscript(getTranscriptionText())
    const rearm = shouldRearmTrigger({
      hasBufferedText: Boolean(accumulatedText),
      hasArmedTrigger: interviewTriggerTimer !== null,
      hasFragmentExpiry: shortFragmentExpiryTimer !== null,
      msSinceLastResult: Date.now() - lastResultAt,
      msUntilPauseEnds: resultMuteUntil - Date.now(),
      quietWindowMs: interviewTriggerDelayMs,
      fingerprint: getTextFingerprint(text),
      rejectedFingerprint
    })
    if (!rearm) return

    logAsr('watchdog:rearm', `len=${text.length}`)
    scheduleInterviewTrigger()
  }, TRIGGER_WATCHDOG_INTERVAL_MS)
  // Never hold the process open on account of a diagnostic timer.
  triggerWatchdogTimer.unref?.()
}

function stopTriggerWatchdog() {
  if (triggerWatchdogTimer) {
    clearInterval(triggerWatchdogTimer)
    triggerWatchdogTimer = null
  }
}

function scheduleInterviewTrigger() {
  if (workMode !== 'interview') return

  clearInterviewTriggerTimer()
  clearShortFragmentExpiryTimer()
  // Belt and braces: the pause is enforced by ignoring packets in the message
  // handler, so a timer is normally never armed inside it. If one ever is
  // (pause shortened mid-flight, or a packet that slipped through), it must not
  // fire inside the pause and start the very interruption the pause prevents.
  const waitForMute = Math.max(0, resultMuteUntil - Date.now())
  interviewTriggerTimer = setTimeout(() => {
    interviewTriggerTimer = null
    if (workMode !== 'interview') return

    const text = prepareTranscript(getTranscriptionText())
    if (!text || !interviewTriggerHandler) {
      // Nothing usable. Clear it on the normal schedule instead of leaving a
      // permanent state for the watchdog to keep re-arming.
      scheduleShortFragmentExpiry()
      return
    }
    if (!shouldTriggerInterview(text)) {
      rejectedFingerprint = getTextFingerprint(text)
      logAsr('skip:not-a-question', `len=${text.length}`)
      scheduleShortFragmentExpiry()
      return
    }
    if (isRecentlyTriggeredDuplicate(text)) {
      logAsr('skip:duplicate', `len=${text.length}`)
      clearTranscriptionText()
      sendToRenderer('transcription-cleared')
      return
    }

    clearTranscriptionText()
    sendToRenderer('transcription-cleared')
    // Start the pause here, not when the answer finishes: the sentence that
    // would abort this answer is already being spoken.
    resultMuteUntil = Date.now() + interviewTriggerMuteMs
    logAsr('submit', `len=${text.length}`)
    Promise.resolve()
      .then(() => interviewTriggerHandler?.(text))
      .catch((error) => {
        console.error('Failed to trigger interview response:', error)
        sendToRenderer('solution-error', error instanceof Error ? error.message : String(error))
      })
  }, interviewTriggerDelayMs + waitForMute)
}

function startTranscription(apiKey: string, options: { silent?: boolean } = {}): boolean {
  if (workMode !== 'interview' || !apiKey) return false
  if (isTranscribing) return true

  // A user-requested session gets a full reconnect budget; a silent recovery
  // keeps spending from the same budget, so a socket that keeps dying still
  // ends up reporting "stopped" instead of looping forever.
  if (!options.silent) silentReconnects = 0
  lastApiKey = apiKey

  cleanup()
  isTranscribing = true
  startTriggerWatchdog()
  taskId = randomUUID()

  try {
    ws = new WebSocket(WS_URL, {
      headers: { Authorization: `bearer ${apiKey}` }
    })
  } catch (error) {
    console.error('Failed to initialize transcription connection:', error)
    cleanup()
    sendToRenderer('transcription-error', '语音识别连接初始化失败，请检查设置后重试')
    sendToRenderer('transcription-stopped')
    return false
  }

  // Give up on a handshake that never completes, so the UI cannot sit on
  // "转录中" indefinitely with no error to explain it.
  clearWsOpenTimer()
  wsOpenTimer = setTimeout(() => {
    wsOpenTimer = null
    if (!isTranscribing) return
    console.warn('Transcription WebSocket did not open within', WS_OPEN_TIMEOUT_MS, 'ms')
    recoverTranscription('语音识别连接超时')
  }, WS_OPEN_TIMEOUT_MS)

  ws.on('open', () => {
    clearWsOpenTimer()
    const runTask = {
      header: {
        action: 'run-task',
        task_id: taskId,
        streaming: 'duplex'
      },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: 'fun-asr-realtime',
        parameters: {
          format: 'pcm',
          sample_rate: 16000,
          max_sentence_silence: ASR_MAX_SENTENCE_SILENCE_MS,
          semantic_punctuation_enabled: false,
          heartbeat: true
        },
        input: {}
      }
    }
    try {
      ws!.send(JSON.stringify(runTask))
    } catch (error) {
      console.warn('Failed to start transcription task:', error)
      recoverTranscription('语音识别任务启动失败')
      return
    }
    // A successful WebSocket handshake does not mean the ASR task is ready.
    // Bound this second stage too, or audio can be discarded forever while the
    // renderer keeps displaying an active microphone.
    wsOpenTimer = setTimeout(() => {
      wsOpenTimer = null
      recoverTranscription('语音识别任务启动超时')
    }, WS_TASK_TIMEOUT_MS)
  })

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString())
      const event = msg.header?.event

      if (event === 'task-started') {
        clearWsOpenTimer()
        taskStarted = true
        flushPendingAudio()
        return
      }

      if (event === 'result-generated') {
        const output = msg.payload?.output
        const sentence = output?.sentence
        if (!sentence) return
        // Heartbeat packets use the same event name but contain no transcript.
        // Treating one as an empty partial would erase the text in the renderer
        // until the next recognition packet arrives.
        if (sentence.heartbeat === true) return
        // Inside the post-trigger pause: drop the packet before it can reach the
        // text buffer, otherwise the tail of the question that was just
        // submitted would queue a second request and abort the answer.
        if (Date.now() < resultMuteUntil) return

        const text: string =
          typeof sentence.text === 'string'
            ? sentence.text
            : typeof output.text === 'string'
              ? output.text
              : ''
        const sentenceEnd: boolean =
          sentence.sentence_end === true ||
          (sentence.end_time !== null && sentence.end_time !== undefined)

        lastResultAt = Date.now()

        if (sentenceEnd) {
          // A few gateway/proxy versions have emitted a final marker with an
          // empty sentence text after useful intermediate text. Commit that
          // intermediate text instead of dropping the question.
          const finalText = text || currentPartial
          const isNewFinal = appendFinalText(finalText)
          currentPartial = ''
          if (isNewFinal) scheduleInterviewTrigger()
        } else {
          // A blank packet can mark the start of a sentence. Do not let an
          // otherwise empty intermediate packet erase useful text already
          // shown while the recognizer is still refining the sentence.
          if (text || sentence.sentence_begin === true) currentPartial = text
          // Only speech with actual text restarts the quiet window. An empty
          // `sentence_begin` marker carries no words: cancelling the armed
          // submission for it -- and never re-arming, because no final ever
          // follows -- is what left a transcribed question on screen forever.
          if (text) {
            clearInterviewTriggerTimer()
            clearShortFragmentExpiryTimer()
          }
        }

        sendToRenderer('transcription-text', {
          text: getTranscriptionText(),
          isPartial: !sentenceEnd
        })
        return
      }

      if (event === 'task-failed') {
        const errorMsg = msg.header?.error_message || '语音识别失败'
        console.error('Transcription task failed:', errorMsg)
        // A failure is shown to the user instead of being retried: a bad key or
        // a rejected task would otherwise loop forever.
        sendToRenderer('transcription-error', errorMsg)
        cleanup()
        sendToRenderer('transcription-stopped')
        return
      }

      if (event === 'task-finished') {
        recoverTranscription('语音识别任务意外结束')
      }
    } catch (e) {
      console.error('Failed to parse transcription message:', e)
    }
  })

  ws.on('error', (err) => {
    console.error('Transcription WebSocket error:', err)
    recoverTranscription('语音识别网络连接中断')
  })

  ws.on('close', () => {
    if (!isTranscribing) return
    recoverTranscription('语音识别连接反复中断')
  })

  return true
}

function stopTranscription() {
  clearInterviewTriggerTimer()
  clearShortFragmentExpiryTimer()
  if (!isTranscribing) return

  if (ws && ws.readyState === WebSocket.OPEN && taskId && taskStarted) {
    const finishTask = {
      header: {
        action: 'finish-task',
        task_id: taskId,
        streaming: 'duplex'
      },
      payload: {
        input: {}
      }
    }
    try {
      ws.send(JSON.stringify(finishTask))
    } catch (error) {
      console.warn('Failed to finish transcription task:', error)
    }
  }

  isTranscribing = false
  cleanup()
  sendToRenderer('transcription-stopped')
}

function sendAudioChunk(chunk: Buffer): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN || !taskStarted || chunk.length === 0) {
    return false
  }
  if (ws.bufferedAmount + chunk.length > MAX_BUFFERED_AUDIO_BYTES) {
    recoverTranscription('语音识别音频发送堵塞')
    return false
  }
  try {
    ws.send(chunk)
    return true
  } catch (error) {
    console.warn('Failed to send transcription audio chunk:', error)
    recoverTranscription('语音识别音频发送失败')
    return false
  }
}

function flushPendingAudio() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !taskStarted) return
  const chunks = pendingAudioChunks
  pendingAudioChunks = []
  for (let index = 0; index < chunks.length; index += 1) {
    if (!sendAudioChunk(chunks[index])) {
      pendingAudioChunks = chunks.slice(index)
      break
    }
  }
}

function handleAudioChunk(chunk: ArrayBuffer) {
  if (!(chunk instanceof ArrayBuffer) || chunk.byteLength === 0 || !isTranscribing) return
  const audio = Buffer.from(chunk)
  if (sendAudioChunk(audio)) return

  // Capture can start while the ASR task is still handshaking. Retain a short
  // lead-in so the first words are not silently discarded, without allowing a
  // slow connection to create an unbounded backlog.
  if (pendingAudioChunks.length < MAX_PENDING_AUDIO_CHUNKS) {
    // Keep the oldest packets so the beginning of a question survives a slow
    // handshake; drop only newer packets once the bounded lead-in is full.
    pendingAudioChunks.push(audio)
  }
}

export function getTranscriptionText(): string {
  if (!accumulatedText) return currentPartial
  if (!currentPartial) return accumulatedText
  return `${accumulatedText}\n${currentPartial}`
}

export function clearTranscriptionText() {
  clearInterviewTriggerTimer()
  clearShortFragmentExpiryTimer()
  accumulatedText = ''
  currentPartial = ''
  // The verdict belonged to the text that just went away.
  rejectedFingerprint = ''
}

export function setInterviewTriggerHandler(handler: InterviewTriggerHandler) {
  interviewTriggerHandler = handler
}

/**
 * Applied when the next quiet window is scheduled. A timer that is already
 * counting down keeps the value it was created with, which is what a user
 * expects after typing a new number while a question is still being spoken.
 */
export function setInterviewTriggerDelayMs(value: number) {
  interviewTriggerDelayMs = normalizeInterviewTriggerDelayMs(value)
}

/** Applied from the next submission onwards; an answer already running keeps its pause. */
export function setInterviewTriggerMuteMs(value: number) {
  interviewTriggerMuteMs = normalizeInterviewTriggerMuteMs(value)
}

export function setTranscriptionWorkMode(mode: WorkMode) {
  if (workMode === mode) {
    sendToRenderer('transcription-mode-change', mode === 'interview')
    return
  }

  workMode = mode
  clearInterviewTriggerTimer()
  clearTranscriptionText()
  lastTriggeredFingerprint = ''
  lastTriggeredAt = 0
  sendToRenderer('transcription-cleared')

  if (mode !== 'interview') {
    stopTranscription()
  }
  sendToRenderer('transcription-mode-change', mode === 'interview')
}

ipcMain.handle('start-transcription', (_event, apiKey: string) => {
  return startTranscription(apiKey)
})

ipcMain.handle('stop-transcription', () => {
  // Reaching this handler means the renderer stopped on purpose (toggle,
  // shortcut, mode switch, unmount). Honour it.
  stopTranscription()
})

ipcMain.on('transcription-audio-chunk', (_event, chunk: ArrayBuffer) => {
  handleAudioChunk(chunk)
})

ipcMain.handle('get-transcription-text', () => {
  return getTranscriptionText()
})

ipcMain.handle('clear-transcription-text', () => {
  clearTranscriptionText()
})

ipcMain.on('transcription-renderer-ready', () => {
  sendToRenderer('transcription-mode-change', workMode === 'interview')
})
