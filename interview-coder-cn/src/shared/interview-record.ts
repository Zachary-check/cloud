/**
 * The on-disk interview transcript: one Markdown file per app run, one block
 * per turn. The file is named when the run ends, so the defaults here are what
 * the close dialog offers before the user edits them.
 *
 * Formatting lives here (pure, testable); the file writes live in
 * `main/interview-record.ts`. This is a review log only — it is never read back
 * into the prompt, so nothing in the app may depend on it.
 */

import type { InterviewTurnKind, InterviewTurnStatus } from './interview-turn'

export interface RecordedTurn {
  kind: InterviewTurnKind
  question: string
  answer: string
  status: InterviewTurnStatus
  /** Knowledge-base documents this answer was built from. */
  sources: string[]
}

const KIND_LABEL: Record<InterviewTurnKind, string> = {
  question: '面试提问',
  followup: '手动追问',
  screenshot: '截图分析'
}

/**
 * Only incomplete turns get a warning: a bare heading already means the answer
 * finished, so keeping the complete case quiet makes the gaps stand out when
 * skimming the log.
 */
const INCOMPLETE_NOTE: Record<Exclude<InterviewTurnStatus, 'done'>, string> = {
  streaming: '本次回答没有结束记录，内容可能不完整。',
  stopped: '本次回答被中断，内容可能不完整。',
  error: '本次回答出错，内容可能不完整。',
  // Written when the app closed while the answer was still streaming, so the
  // text below is whatever had arrived by then.
  interrupted: '应用关闭时该回答仍在生成，内容可能不完整。'
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

/** `HH:MM:SS` in local time. */
export function formatClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `YYYY-MM-DD` — the day a record file belongs to. */
export function recordFileDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * `interview-2026-10-11-3` — the day plus this run's order within it. It is the
 * name a session gets while it is being written, and the value the close dialog
 * starts from.
 */
export function recordSessionName(date: Date, index: number): string {
  return `interview-${recordFileDate(date)}-${index}`
}

/** `interview-2026-10-11-3.md`. */
export function recordSessionFileName(date: Date, index: number): string {
  return `${recordSessionName(date, index)}.md`
}

/**
 * The run number in an `interview-<day>-N.md` name, or null for everything else.
 * Names written before sessions were numbered (`interview-<day>.md`) do not
 * match, so they are left alone and never counted.
 */
export function parseRecordSessionIndex(fileName: string, date: Date): number | null {
  const match = new RegExp(`^interview-${recordFileDate(date)}-(\\d+)\\.md$`, 'i').exec(
    fileName.trim()
  )
  if (!match) return null
  const index = Number(match[1])
  return Number.isInteger(index) && index > 0 ? index : null
}

/**
 * The next free run number for the day, so a second run never overwrites the
 * first. Counted from the file names rather than kept in memory: the app has no
 * idea what earlier runs wrote.
 */
export function nextRecordSessionIndex(fileNames: string[], date: Date): number {
  let highest = 0
  for (const fileName of fileNames) {
    const index = parseRecordSessionIndex(fileName, date)
    if (index !== null && index > highest) highest = index
  }
  return highest + 1
}

/** Long enough for a descriptive name, short enough to stay readable. */
const MAX_RECORD_NAME_LENGTH = 80

/**
 * Turn whatever the user typed into a name we can actually create. A pasted
 * path keeps only its last segment, characters Windows rejects become dashes,
 * control characters are dropped, and a trailing `.md` is stripped because the
 * extension is fixed by the caller. Windows also refuses names that end in a
 * dot or a space, and a name that is nothing but dashes or dots is not worth
 * creating, which is why leading and trailing punctuation goes too.
 */
export function normalizeRecordFileName(input: string): string {
  const lastSegment = input.trim().split(/[\\/]/).pop() ?? ''
  const withoutExtension = lastSegment.replace(/\.md$/i, '')
  const printable = Array.from(withoutExtension)
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join('')
  return printable
    .replace(/[<>:"|?*]/g, '-')
    .replace(/^[.\s-]+/, '')
    .slice(0, MAX_RECORD_NAME_LENGTH)
    .replace(/[.\s-]+$/, '')
}

/** Written once, when the session's file is created. */
export function recordFileHeader(date: Date): string {
  return `# 面试记录 ${recordFileDate(date)}\n\n`
}

export function formatRecordedTurn(turn: RecordedTurn, at: Date): string {
  const lines: string[] = [`## ${formatClock(at)} · ${KIND_LABEL[turn.kind]}`, '']

  if (turn.status !== 'done') {
    lines.push(`> ${INCOMPLETE_NOTE[turn.status]}`, '')
  }

  lines.push('**问**', '')
  // Quoted so a multi-line question cannot be mistaken for the answer's own
  // headings, and empty lines still need the marker to stay inside the quote.
  for (const line of turn.question.split('\n')) {
    lines.push(line.trim() ? `> ${line}` : '>')
  }

  const answer = turn.answer.trim()
  lines.push('', '**答**', '', answer || '（没有产生回答）', '')

  if (turn.sources.length > 0) {
    lines.push(`_知识库：${turn.sources.join('、')}_`, '')
  }

  lines.push('---', '')
  // Trailing newline so the separator stays clear of the next block's heading.
  return `${lines.join('\n')}\n`
}

/** Written when "新开对话" resets the transcript, so the log shows the break too. */
export function formatSessionBreak(at: Date): string {
  return `## ——— 新开对话 ${formatClock(at)} ———\n\n`
}
