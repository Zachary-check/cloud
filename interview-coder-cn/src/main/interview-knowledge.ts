import type { ModelMessage } from 'ai'
import {
  MAX_INTERVIEW_KNOWLEDGE_PROMPT_CHARS,
  type InterviewKnowledgeDocument
} from '../shared/interview-knowledge'
import { matchPinnedProjectRule, type PinnedProjectRule } from '../shared/pinned-project'
import {
  decideProject,
  interviewDetailChoices,
  interviewProjectCatalog,
  isInterviewFollowUp,
  projectKey,
  refersToPreviousApproach,
  type ProjectDecision
} from './interview-project'

type Turn = { question: string; answer: string }

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const stopWords = new Set(
  '介绍 一下 说说 讲讲 为什么 为何 怎么 如何 什么 哪些 哪个 可以 能否 这个 那个 那么 这么 刚才 前面 上面 当时 你们 我们 他们 项目 经历 详细 具体 继续 展开 how why what which please about would could project projects tell describe explain then and the you your'.split(
    ' '
  )
)
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
      const question =
        text.match(/^这是面试官的语音提问：\n([\s\S]*?)\n\n请/)?.[1] ??
        text.match(/^这是语音转录内容：\n([\s\S]*?)\n\n同时附上屏幕截图/)?.[1] ??
        text.match(/^这是下一部分截图和语音转录内容：\n([\s\S]*?)\n请结合/)?.[1] ??
        text
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
  decision: ProjectDecision | null
  repeated: boolean
  changedTopic: boolean
  refersToPreviousApproach: boolean
  detailChoices: string[]
  missingProjects: string[]
  pinnedRules: PinnedProjectRule[]
  pinnedRule: PinnedProjectRule | null
  excerpts: { name: string; content: string }[]
}

interface SelectionOptions {
  manualFollowUp: boolean
  previousProject?: string | null
  knowledgeEnabled: boolean
}

/** Compatibility for generic documents when a prior free-choice answer named its project. */
function legacyProjectFromHistory(
  recent: Turn[],
  catalog: ReturnType<typeof interviewProjectCatalog>,
  rules: PinnedProjectRule[],
  previousProject: string | null | undefined
): string | null {
  if (previousProject || catalog.usesProfiles) return previousProject ?? null
  for (const turn of previousProject === undefined ? recent : recent.slice(0, 1)) {
    const decision = decideProject(turn.question, null, catalog)
    if (decision.intent === 'choose' && turn.answer.trim()) {
      const { strong } = catalog.identify(turn.answer)
      const pin = matchPinnedProjectRule(rules, decision.query)
      return pin ? catalog.canonical(pin.project) : strong.length === 1 ? strong[0] : null
    }
    if (previousProject === undefined && decision.nextProject) return decision.nextProject
    if (decision.reason !== 'context-unclear' || !isInterviewFollowUp(turn.question)) break
  }
  return null
}

/** Resolve the current project before ranking passages for the new question. */
export function selectInterviewReferences(
  documents: InterviewKnowledgeDocument[],
  rules: PinnedProjectRule[],
  query: string | undefined,
  history: readonly ModelMessage[],
  { manualFollowUp, previousProject, knowledgeEnabled }: SelectionOptions
): InterviewReferences {
  const question = query?.trim() ?? ''
  const catalog = interviewProjectCatalog(
    documents.map(({ name }) => name),
    [...rules.map(({ project }) => project), ...(previousProject ? [previousProject] : [])]
  )
  const recent = latestTurns(history)
  const previous = recent[0]
  const previousQuestion = previous?.question ?? ''
  const previousAnswer = previous?.answer ?? ''
  const active = legacyProjectFromHistory(recent, catalog, rules, previousProject)
  const routed = question ? decideProject(question, active, catalog) : null
  // With no transcript a screenshot can start a visual question, including a
  // typed follow-up about the image. Keep that path available after a new shot.
  const imageFollowUp =
    manualFollowUp &&
    routed?.reason === 'context-unclear' &&
    /^(?:这是屏幕截图|这是下一部分截图，请)/.test(previousQuestion) &&
    !/项目|经历|\bproject\b/i.test(question)
  const decision = imageFollowUp ? null : routed
  const pinnedRule =
    decision &&
    (decision.intent === 'choose' || (!catalog.usesProfiles && decision.reason === 'general'))
      ? matchPinnedProjectRule(rules, decision.query, decision.intent === 'choose')
      : null
  if (pinnedRule && decision) {
    decision.intent = 'choose'
    decision.projects = [catalog.canonical(pinnedRule.project)]
    decision.reason = 'pinned'
  }
  const projects = decision?.projects ?? []
  const pinnedRules = !decision
    ? rules
    : pinnedRule
      ? [pinnedRule]
      : rules.filter(({ project }) => projects.includes(catalog.canonical(project)))
  const current = decision?.query ?? question
  const followUp = decision?.intent === 'continue'
  const sameTopicApproach =
    followUp && Boolean(previousAnswer.trim()) && refersToPreviousApproach(current)
  const changedTopic = decision?.intent === 'switch' || decision?.reason === 'project-cleared'
  const detailChoices = followUp
    ? interviewDetailChoices(projects[0], current, `${previousQuestion}\n${previousAnswer}`)
    : []

  const words = terms(current)
  const key = projectKey(question)
  const repeated = Boolean(
    previousAnswer.trim() && key.length >= 4 && key === projectKey(previousQuestion)
  )
  const aspects = questionAspects.flatMap(([pattern, values]) =>
    pattern.test(current) ? values : []
  )
  const previousWords = followUp
    ? terms(previousQuestion).filter((word) => !words.includes(word))
    : []
  const approachWords =
    followUp && (sameTopicApproach || words.length < 2)
      ? terms(previousAnswer).filter(
          (word) =>
            !words.includes(word) &&
            !projects.some((project) => projectKey(project).includes(projectKey(word)))
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
  const legacyPinInCombinedNotes =
    pinnedRule && !catalog.usesProfiles && !catalog.documents.includes(projects[0])
  const unscoped =
    !decision ||
    (!catalog.usesProfiles && (decision.reason === 'general' || decision.reason === 'self-choice'))
  const ranked = documents
    .flatMap((document, index) => {
      if (!knowledgeEnabled || !document.enabled) return []
      const title = catalog.documents[index]
      const included =
        unscoped ||
        projects.includes(title) ||
        (legacyPinInCombinedNotes && projectKey(document.content).includes(projectKey(projects[0])))
      return included
        ? [
            {
              document,
              title,
              score: relevance(document.name) * 3 + relevance(document.content),
              index
            }
          ]
        : []
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const matching = ranked.filter(({ score }) => score > 0)
  let candidates = unscoped && matching.length ? matching : ranked
  if (decision?.intent === 'compare') {
    // Give each side a share of the existing budget, even if one project has
    // more than one imported file under different titles.
    candidates = projects.flatMap((project) => {
      const best = ranked.find(({ title }) => title === project)
      return best ? [best] : []
    })
  }
  const missingProjects = projects.filter(
    (project) =>
      !candidates.some(({ title }) => title === project) &&
      !(legacyPinInCombinedNotes && candidates.length)
  )
  const excerpts: InterviewReferences['excerpts'] = []
  let remaining = MAX_INTERVIEW_KNOWLEDGE_PROMPT_CHARS
  for (const [index, { document }] of candidates.entries()) {
    if (remaining <= 0) break
    const budget = Math.min(remaining, Math.floor(remaining / (candidates.length - index)))
    const focus =
      followUp ||
      repeated ||
      aspects.length > 0 ||
      decision?.intent === 'switch' ||
      decision?.intent === 'compare'
    const content = excerpt(document.content, budget, relevance, focus)
    excerpts.push({ name: document.name, content })
    remaining -= content.length
  }

  return {
    decision,
    repeated,
    changedTopic,
    refersToPreviousApproach: sameTopicApproach,
    detailChoices,
    missingProjects,
    pinnedRules,
    pinnedRule,
    excerpts
  }
}
