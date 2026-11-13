/**
 * Pinned project rules force the answer to a class of "pick a project"
 * questions onto one specific project.
 *
 * The rule text is injected last in the system prompt and resolved against the
 * current transcript, so it is a deterministic instruction rather than a hint
 * buried in a long prompt. It also survives knowledge-base trimming: a resolved
 * rule names the project even when the matching document was cut for budget.
 */
export interface PinnedProjectRule {
  id: string
  /** Trigger phrases, separated by , ， 、 ; ； | or newlines. Empty = fallback rule. */
  keywords: string
  /** The project that must be answered with. */
  project: string
  /** Optional sentence the answer should reuse verbatim. */
  note: string
}

export const MAX_PINNED_PROJECT_RULES = 20
export const MAX_PINNED_PROJECT_KEYWORD_CHARS = 120
export const MAX_PINNED_PROJECT_NAME_CHARS = 80
export const MAX_PINNED_PROJECT_NOTE_CHARS = 300

/** Split the trigger field into individual phrases, dropping separators. */
export function splitPinnedKeywords(keywords: string): string[] {
  return keywords
    .split(/[,，、;；|\n]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .slice(0, 12)
}

export function normalizePinnedProjectRules(input: unknown): PinnedProjectRule[] {
  if (!Array.isArray(input)) return []

  const rules: PinnedProjectRule[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    if (rules.length >= MAX_PINNED_PROJECT_RULES) break
    const candidate = item as Partial<PinnedProjectRule>
    const project = typeof candidate.project === 'string' ? candidate.project.trim() : ''
    // A rule without a project cannot pin anything; keep it out of the prompt.
    if (!project) continue
    const keywords = typeof candidate.keywords === 'string' ? candidate.keywords : ''
    const note = typeof candidate.note === 'string' ? candidate.note.trim() : ''
    rules.push({
      id:
        typeof candidate.id === 'string' && candidate.id.trim()
          ? candidate.id
          : `pin-${rules.length}`,
      keywords: splitPinnedKeywords(keywords).join('、').slice(0, MAX_PINNED_PROJECT_KEYWORD_CHARS),
      project: project.slice(0, MAX_PINNED_PROJECT_NAME_CHARS),
      note: note.slice(0, MAX_PINNED_PROJECT_NOTE_CHARS)
    })
  }
  return rules
}

/** Lowercase and drop punctuation/whitespace so ASR text matches on content only. */
function foldForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * Rules with triggers win over the fallback rule, in the order they were set.
 * The fallback (empty triggers) is only used when nothing more specific fits.
 */
export function matchPinnedProjectRule(
  rules: PinnedProjectRule[],
  query: string | undefined
): PinnedProjectRule | null {
  const folded = query ? foldForMatch(query) : ''
  if (folded) {
    for (const rule of rules) {
      const keywords = splitPinnedKeywords(rule.keywords)
      if (!keywords.length) continue
      if (keywords.some((keyword) => folded.includes(foldForMatch(keyword)))) return rule
    }
  }
  return rules.find((rule) => splitPinnedKeywords(rule.keywords).length === 0) ?? null
}

/**
 * Build the always-injected rule block. Returns an empty string when there is
 * nothing to pin, so callers can filter it out of the prompt.
 */
export function buildPinnedProjectPrompt(
  rules: PinnedProjectRule[],
  query: string | undefined
): string {
  const usable = rules.filter((rule) => rule.project.trim())
  if (!usable.length) return ''

  const lines = ['以下是候选人预先设定的项目固定选择规则，必须遵守：']
  for (const rule of usable) {
    const keywords = splitPinnedKeywords(rule.keywords)
    lines.push(
      keywords.length
        ? `- 提问中出现「${keywords.join('」「')}」等说法时，一律用「${rule.project}」作答`
        : `- 其他需要挑选、推荐或比较项目的提问，一律用「${rule.project}」作答`
    )
  }
  lines.push(
    '- 命中规则时不得改选其他项目，也不得先并列比较其他项目再另选；回答中出现的项目名只能是规则指定的那个。'
  )
  lines.push(
    '- 项目事实以知识库为准；知识库没有的细节用概括表述，不要编造具体数据，也不要因此改选其他项目。'
  )

  const matched = matchPinnedProjectRule(usable, query)
  if (matched) {
    lines.push(`本次提问已经命中规则：必须用「${matched.project}」作答。`)
    if (matched.note) lines.push(`固定说法（原样照说）：${matched.note}`)
  }

  return [
    '## 项目固定选择（最高优先级）',
    lines.join('\n'),
    '以上规则优先于本提示词中其他关于项目选择的表述，也优先于知识库和背景资料中的任何相反描述。'
  ].join('\n')
}
