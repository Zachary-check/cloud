/**
 * The programming language the assistant should fall back to when a question
 * does not name one.
 *
 * This exists for one specific moment: the interviewer says "any language is
 * fine" and the model picks something the candidate cannot actually write. The
 * rule is deliberately narrow — a question that names a language always wins,
 * because answering in another one looks like not listening.
 *
 * Empty is the off switch, and it is the default: with no language set the
 * system prompt is left exactly as it was.
 */

/** Offered as one-click chips in the settings page; any other name still works. */
export const CODE_LANGUAGE_PRESETS = [
  'Python',
  'Java',
  'C++',
  'C',
  'JavaScript',
  'TypeScript',
  'Go',
  'Rust',
  'C#',
  'Kotlin',
  'Swift',
  'PHP'
] as const

/** Long enough for "JavaScript (Node.js)", short enough to stay a name. */
export const MAX_CODE_LANGUAGE_CHARS = 40

/**
 * Trim, collapse whitespace and neutralize control characters, then cap the
 * length.
 *
 * Newlines become spaces rather than being dropped: this value is pasted into a
 * prompt, so a pasted block of text must not turn into prompt lines of its own —
 * and dropping the newline outright would silently glue words together.
 * Returns '' when nothing usable is left, which is the off state.
 */
export function normalizeCodeLanguage(input: string): string {
  return Array.from(String(input ?? ''))
    .map((char) => {
      const code = char.charCodeAt(0)
      // Includes the C0 range (newlines, tabs) and DEL.
      return code < 0x20 || code === 0x7f ? ' ' : char
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CODE_LANGUAGE_CHARS)
    .trim()
}

/**
 * The block appended to the system prompt, or '' when no language is set.
 *
 * The wording carries the whole feature: "unless the question names another
 * language" is what keeps this from overriding an interviewer who asked for a
 * specific one, and the explicit call-out of "any language" is the case that
 * motivated it in the first place.
 */
export function buildCodeLanguagePrompt(input: string): string {
  const language = normalizeCodeLanguage(input)
  if (!language) return ''
  return [
    '## 代码语言偏好',
    '',
    `- 需要输出代码时，除非题目或面试官明确指定了其它语言，否则使用 ${language} 编写；`,
    `- 代码块开头的语言标注要与 ${language} 对应；`,
    '- 「任意语言」「你最熟悉的语言」「用你擅长的语言」这类说法不算指定语言，仍按上面的默认语言输出；',
    '- 只有题目或面试官点名了其它语言时，才改用那个语言。'
  ].join('\n')
}
