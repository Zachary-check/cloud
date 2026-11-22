import type { ModelMessage } from 'ai'
import {
  MAX_INTERVIEW_KNOWLEDGE_PROMPT_CHARS,
  type InterviewKnowledgeDocument
} from '../shared/interview-knowledge'
import { matchPinnedProjectRule, type PinnedProjectRule } from '../shared/pinned-project'

type Project = { name: string; key: string }
type Turn = { question: string; answer: string }

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const stopWords = new Set(
  '介绍 一下 说说 讲讲 为什么 为何 怎么 如何 什么 哪些 哪个 可以 能否 这个 那个 那么 这么 刚才 前面 上面 当时 你们 我们 他们 项目 经历 详细 具体 继续 展开 how why what which please about would could project projects tell describe explain then and the you your'.split(
    ' '
  )
)
const followUpPattern =
  /刚才|前面|上面|之前提到|(?:这个|那个|该)(?:项目|方案)|你们|当时|^\s*(?:那|所以|继续|展开|再说)|^(?:怎么|如何)(?:验证|实现|处理|设计|排查|复现)|怎么(?:验证|实现|处理|设计)的|为什么(?:这样|这么)|详细说|具体说|^.{1,16}呢[?？。]?$|^\s*(?:and|so|then|why|how so|tell me more)\b/i
const topicChangePattern =
  /换(?:个|一个)(?:项目|话题)|换一项经历|改讲|(?:不讲|不聊).{0,28}换成|另(?:一个|一项)项目|下(?:一题|一个项目)|与(?:该|这个)项目无关|(?:another|different|next) (?:project|topic)/i
const projectQuestionPattern = /项目|经历|你们|负责|project|your (?:team|role)/i
const previousApproachPattern =
  /(?:这个|那个|这种|该|上述|刚才的|前面提到的)(?:方案|做法|方式|机制|设计)|为什么(?:这样|这么)|\b(?:this|that) (?:approach|design|implementation)\b/i
const questionAspects: Array<[RegExp, string[]]> = [
  [
    /验证|测试|压测|怎么证明|效果|validate|verif|benchmark|test/i,
    ['验证', '测试', '压测', '复现', '指标', '观测', '对照', 'test', 'metrics']
  ],
  [
    /为什么|选型|取舍|权衡|why|trade.?off/i,
    ['约束', '取舍', '选型', '替代', '对比', '原因', '代价', 'tradeoff']
  ],
  [
    /故障|踩坑|异常|失败|排查|failure|debug/i,
    ['故障', '异常', '定位', '回退', '重试', '补偿', 'failure']
  ],
  [
    /实现|怎么做|如何做|链路|架构|implement|architecture/i,
    ['实现', '步骤', '流程', '链路', '边界', 'implementation']
  ]
]

function folded(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]/gu, '')
}

function project(name: string): Project {
  return { name, key: folded(name) }
}

/** A filing prefix belongs to the source label, not the spoken project name. */
function spokenProject(title: Project): Project {
  const name = title.name
    .normalize('NFKC')
    .replace(/^(?:\p{Script=Han}{1,16}\s*[-_–—]\s*)?\d{1,3}\s*[-_.、–—]\s*/u, '')
    .trim()
  const alias = project(name)
  return alias.key.length >= 2 && /\p{L}/u.test(alias.key) ? alias : title
}

function namesIn(text: string, projects: Project[]): Project[] {
  const key = folded(text)
  const matches = [
    ...new Map(
      projects
        .filter((item) => item.key.length >= 2 && key.includes(item.key))
        .map((item) => [item.key, item] as const)
    ).values()
  ]
  // A more specific title wins when two file names share the same prefix.
  return matches.filter(
    (item) => !matches.some((other) => other.key !== item.key && other.key.includes(item.key))
  )
}

function resolveQuestion(question: string, titles: Project[], rules: PinnedProjectRule[]) {
  const change = topicChangePattern.exec(question)
  const current = change ? question.slice(change.index + change[0].length) : question
  const named = namesIn(current, titles)
  const pinnedRule = matchPinnedProjectRule(rules, current, !change && !named.length)
  return {
    current,
    changedTopic: Boolean(change),
    pinnedRule,
    projects: pinnedRule ? [project(pinnedRule.project)] : named
  }
}

function continuesTopic(question: string): boolean {
  return followUpPattern.test(question) || previousApproachPattern.test(question)
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

function latestTurns(history: readonly ModelMessage[]): Turn[] {
  const turns: Turn[] = []
  let answer = ''
  for (const message of history.slice(-24).reverse()) {
    if (message.role === 'assistant') {
      answer = messageText(message)
    } else if (message.role === 'user') {
      const text = messageText(message)
      // Use only the question from the speech request's wrapper.
      const question = text.match(/^这是面试官的语音提问：\n([\s\S]*?)\n\n请/)?.[1] ?? text
      turns.push({ question, answer })
      answer = ''
    }
  }
  return turns
}

function terms(text: string): string[] {
  const query = text.slice(0, 4000).normalize('NFKC').toLowerCase()
  const words = new Set(query.match(/[a-z][a-z0-9+#_-]*/g) ?? [])
  for (const { segment, isWordLike } of segmenter.segment(query)) {
    if (isWordLike && /\p{Script=Han}/u.test(segment)) words.add(segment)
  }
  return [...words].filter((word) => word.length >= 2 && !stopWords.has(word)).slice(0, 24)
}

function termScore(searchable: string, tokens: string[]): number {
  return tokens.reduce(
    (score, word) => score + (searchable.includes(word) ? Math.min(word.length, 8) : 0),
    0
  )
}

/** Associate a Markdown heading with the passages that follow it. */
function passages(content: string): { heading: string; text: string }[] {
  const result: { heading: string; text: string }[] = []
  let heading = ''
  const size = 1500
  for (let block of content.replace(/\r\n/g, '\n').split(/\n[ \t]*\n|\n(?=#{1,6}[ \t])/)) {
    block = block.trim()
    const title = block.match(/^#{1,6}[ \t]+[^\n]+/)
    if (title) {
      heading = title[0]
      block = block.slice(heading.length).trim()
    }
    while (block.length > size) {
      const prefix = block.slice(0, size)
      const boundary = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('。'))
      const end = boundary >= size / 2 ? boundary + 1 : size
      result.push({ heading, text: block.slice(0, end).trim() })
      block = block.slice(end).trimStart()
    }
    if (block) result.push({ heading, text: block })
  }
  return result
}

function excerpt(
  content: string,
  budget: number,
  relevance: (text: string) => number,
  focus: boolean
): string {
  if (!focus && content.length <= budget) return content
  const sections = passages(content).map(({ heading, text }, index) => ({
    text: [heading, text].filter(Boolean).join('\n'),
    index,
    score: relevance(text) + relevance(heading) * 2
  }))
  const matching = sections.filter(({ score }) => score > 0)
  if (content.length <= budget && (!focus || !matching.length)) return content

  const ranked = (focus && matching.length ? matching : sections)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, focus && matching.length ? 4 : sections.length)
  const chosen: typeof ranked = []
  let remaining = budget
  for (const section of ranked) {
    if (section.text.length + 2 > remaining) continue
    chosen.push(section)
    remaining -= section.text.length + 2
  }
  if (!chosen.length) return content.slice(0, budget)
  return chosen
    .sort((a, b) => a.index - b.index)
    .map(({ text }) => text)
    .join('\n\n')
}

export interface InterviewReferences {
  projects: string[]
  repeated: boolean
  changedTopic: boolean
  refersToPreviousApproach: boolean
  pinnedRule: PinnedProjectRule | null
  excerpts: { name: string; content: string }[]
}

/** Resolve the current project before ranking passages for the new question. */
export function selectInterviewReferences(
  documents: InterviewKnowledgeDocument[],
  rules: PinnedProjectRule[],
  query: string | undefined,
  history: readonly ModelMessage[],
  manualFollowUp: boolean
): InterviewReferences {
  const question = query?.trim() ?? ''
  const titles = documents.map(({ name }) => project(name.replace(/\.(md|markdown)$/i, '')))
  const aliases = titles.map(spokenProject)
  const recent = latestTurns(history)
  const previous = recent[0]
  const previousAnswer = previous?.answer ?? ''
  const target = resolveQuestion(question, aliases, rules)
  const refersToPreviousApproach =
    !target.changedTopic &&
    !target.projects.length &&
    Boolean(previousAnswer.trim()) &&
    previousApproachPattern.test(target.current)
  let projects = target.projects
  let priorQuestion = ''
  const followUp = !target.changedTopic && (manualFollowUp || continuesTopic(question))
  if (!projects.length && followUp) {
    for (const turn of recent) {
      const prior = resolveQuestion(turn.question, aliases, rules)
      projects = prior.projects
      if (!projects.length && projectQuestionPattern.test(prior.current)) {
        projects = namesIn(turn.answer, aliases)
      }
      if (projects.length) {
        priorQuestion = turn.question
        break
      }
      if (prior.changedTopic || (!manualFollowUp && !continuesTopic(turn.question))) break
    }
  }

  const words = terms(target.current)
  const key = folded(question)
  const repeated = Boolean(
    previous && previousAnswer.trim() && key.length >= 4 && key === folded(previous.question)
  )
  const aspects = questionAspects.flatMap(([pattern, values]) =>
    pattern.test(target.current) ? values : []
  )
  const previousWords = terms(priorQuestion).filter((word) => !words.includes(word))
  const approachWords =
    refersToPreviousApproach && projects.length
      ? terms(previousAnswer).filter(
          (word) => !words.includes(word) && !projects.some(({ key }) => key.includes(folded(word)))
        )
      : []
  // A repeated question can use an adjacent detail from the same project if
  // the first answer already covered the most obvious matching passage.
  const additional = repeated && projects.length ? ['边界', '代价', '异常', '限制'] : []
  const relevance = (text: string) => {
    const searchable = text.normalize('NFKC').toLowerCase()
    return (
      termScore(searchable, words) * 4 +
      termScore(searchable, aspects) * 2 +
      termScore(searchable, previousWords) +
      // In a referential question, a specific term from the previous answer
      // carries more meaning than generic headings such as "方案" or "取舍".
      Math.min(8, termScore(searchable, approachWords)) * 6 +
      termScore(searchable, additional)
    )
  }
  const ranked = documents
    .flatMap((document, index) => {
      if (!document.enabled) return []
      const score = relevance(document.name) * 3 + relevance(document.content)
      return [{ document, score, index }]
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)

  const isProjectTitle = (title: Project) =>
    projects.some(({ key }) => key && title.key.includes(key))
  const matching = ranked.filter(({ score }) => score > 0)
  // Prefer the project's own files. A handwritten pin may only appear within a
  // combined document, in which case use only documents mentioning that project.
  const candidates = titles.some(isProjectTitle)
    ? ranked.filter(({ index }) => isProjectTitle(titles[index]))
    : projects.length
      ? ranked.filter(({ document }) =>
          projects.some(({ key }) => key && folded(document.content).includes(key))
        )
      : matching.length
        ? matching
        : ranked
  const excerpts: InterviewReferences['excerpts'] = []
  let remaining = MAX_INTERVIEW_KNOWLEDGE_PROMPT_CHARS
  for (const [index, { document }] of candidates.entries()) {
    if (remaining <= 0) break
    const budget = Math.min(remaining, Math.floor(remaining / (candidates.length - index)))
    const focus = followUp || repeated || aspects.length > 0
    const content = excerpt(document.content, budget, relevance, focus)
    excerpts.push({ name: document.name, content })
    remaining -= content.length
  }

  return {
    projects: projects.map(({ name }) => name),
    repeated,
    changedTopic: target.changedTopic,
    refersToPreviousApproach,
    pinnedRule: target.pinnedRule,
    excerpts
  }
}
