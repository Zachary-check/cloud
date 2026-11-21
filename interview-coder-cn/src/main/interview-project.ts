import { isProjectChoiceQuestion } from '../shared/pinned-project'

export type ProjectIntent =
  | 'select'
  | 'switch'
  | 'continue'
  | 'compare'
  | 'clarify'
  | 'general'
  | 'choose'

export interface ProjectDecision {
  intent: ProjectIntent
  projects: string[]
  reason: string
  query: string
  nextProject: string | null
}

const profiles = [
  {
    name: 'K8s',
    titles: ['k8s', 'k8sdashboard', 'kubernetes', 'kubernetesdashboard', '多集群管理面板'],
    primary: /(?<![a-z0-9])k\s*8\s*s(?:\s*dashboard)?(?![a-z0-9])/iu,
    aliases:
      /(?<![a-z0-9])(?:kubernetes|dashboard)(?![a-z0-9])|多集群(?:的)?(?:管理|平台|面板)|容器集群管理/iu,
    signatures:
      /application\s*operator|kubeconfig|owner\s*reference|resource\s*version|observed\s*generation|list\s*\/?\s*watch|命名空间.{0,10}(?:角色|权限)|声明式调谐|watch_namespace|多集群.{0,16}(?:授权|权限|凭据)/iu,
    pair: [
      /deployment|命名空间|kubernetes|集群|pod/iu,
      /调谐|控制器|operator|reconcile|rbac|副本|kubernetes api/iu
    ]
  },
  {
    name: 'StreamVault',
    titles: ['streamvault', 'webfileserver', 'webfileclient', '大文件传输', '大文件传输服务'],
    primary: /(?<![a-z0-9])stream\s*vault(?![a-z0-9])/iu,
    aliases:
      /(?<![a-z0-9])web\s*file\s*(?:server|client)(?![a-z0-9])|大文件传输|(?:文件服务|文件管理|文件传输)(?:的)?(?:系统|项目|服务|平台)|做(?:大)?文件传输|传大文件/iu,
    signatures:
      /io[\s_-]*uring|分片\s*ack|下载(?:的)?窗口|文件.{0,24}(?:临时路径|临时文件).{0,16}(?:原子改名|rename|提交)|(?:上传|下载).{0,18}(?:ack|临时文件|pwrite|断点续传)|(?:服务发现|注册中心|registry).{0,20}(?:ttl|租约|空快照)|protobuf.{0,12}(?:粘包|半包|长度头)/iu,
    pair: [
      /上传|下载|传文件|传输文件|写文件|文件网关|网关|registry|注册中心|rpc/iu,
      /分片|ack|背压|窗口|额度|读不动|下一块|限流|rename|临时文件|pwrite|半包|sha[\s-]*256|租约|ttl|掉电/iu
    ]
  },
  {
    name: 'MiniLLM',
    titles: ['minillm', 'tinyllama', '本地推理引擎'],
    primary: /(?<![a-z0-9])mini\s*llm(?![a-z0-9])/iu,
    aliases:
      /(?<![a-z0-9])tiny\s*llama(?![a-z0-9])|decoder[\s-]*only\s*llm|(?:本地|大模型|模型)(?:的)?推理引擎|推理项目|做(?:本地|大模型)?推理(?:那(?:个|段|块)|(?:的)?(?:运行时|项目))/iu,
    signatures:
      /kv[\s-]*(?:cache|缓存)|prefill|token\s*\/\s*s|\bttft\b|cuda\s*graph|(?:草稿|推测解码).{0,15}(?:token|量化|截断|缓存)|(?:int8|fp16).{0,12}(?:权重|量化|logits)|(?:量化|权重).{0,12}(?:int8|fp16)|gqa.{0,12}(?:头|head|cache)/iu,
    pair: [
      /\bllm\b|推理|token|cuda|模型|llama/iu,
      /量化|草稿|显存|logits|gqa|greedy|贪心|采样|decode|首词|首个输出/iu
    ]
  }
]

const switchCue =
  /换(?:个|一个|到|讲)(?:项目|话题|方向)?|(?:^|[,。;]\s*)换成|改(?:聊|谈|讲|问)|转(?:到|聊|说)|(?:回到|回头聊|回去说).{0,22}(?:项目|经历)|另(?:一个|一项|个)(?:项目|经历|话题)|先放(?:一放|一下|一边)|先到(?:这[儿里]?|这里)|先(?:不|别)聊|先略过|跳过|先不(?:讲|说|谈)|别再回到|翻篇|说完.{0,12}(?:再|来)|与.{0,8}项目无关|下(?:一题|一个项目)|\b(?:another|different|next) (?:project|topic)\b/iu
const focusCue =
  /(?:我|现在)(?:现在|主要|只)?(?:想问|要问|问的是|想听|更关心)|只(?:问|想听|讲|说)|(?:改|转)(?:为|去)?(?:聊|谈|讲|问)|(?:接下来|下面|接着)(?:我)?(?:想|请|来)?(?:说说|聊聊|谈谈|讲讲|听听|问问)/u
const switchFocusCue =
  /(?:^|[，,]\s*|(?:现在|接下来|然后|我们)(?:想|再|就)?)(?:换(?:个|一个)(?:项目|话题)|换(?:成|到)|改(?:聊|谈|讲|问)|转(?:到|聊|说))/u
const discardClause =
  /^(?:先|暂时|这次|今天)?(?:不要|不用|先别|别|不)(?:再)?(?:聊|讲|问|谈|提|说|回到|往)|^不是(?:让|要).{0,12}(?:对比|比较)|^(?:和|与).{0,15}(?:项目|话题)无关|^.{1,45}(?:先放(?:一放|一下|一边)|先到(?:这[儿里]?|这里)|先别(?:提|聊|讲)|先不(?:聊|讲|谈|说|问)|先略过|先点到为止|先不展开|已经说完(?:了)?|聊过了|讲完了|就到这[儿里]?)$/u
const compareCue =
  /两个项目.{0,20}(?:共用|复用|分别|各自)|对比|相比|比较|各自|分别.{0,12}(?:说|讲|介绍|怎么样|是什么|怎么|有什么)|(?:有何|有什么|有啥)(?:区别|差别|不同)|先.{0,40}再(?:谈|讲|说|问)|\b(?:compare|versus|vs\.?|respectively)\b/iu
const compareWithPrevious =
  /(?:跟|和|比|与).{0,6}(?:刚才|前一个|上一个|上一套|前面).{0,8}(?:比|比较|对比|不同)|(?:跟|和|与)(?:刚才|前面)那(?:个|套)|(?:把|将)(?:刚才|前面|上一个).{0,45}(?:和|跟|与).{0,40}(?:对比|比较|区别|比一比)/u
const generalCue =
  /基础题|算法题|撇开项目|不谈项目|跟项目没关系|(?:与|跟|和).{0,8}项目无关|英语自我介绍|手撕|\b(?:general|theory) question\b/iu
const outside = /面试软件|科研项目|论文项目|实习经历|毕业设计/u
const genericProjectTopic =
  /^(?:[\s，,]*(?:那|那么|然后))?\s*(?:缓存|性能|幂等|失败|RPC|重试|恢复|边界|吞吐|延迟)(?:[\s?？。]*$|呢|怎么|如何|是怎么|有(?:什么|哪些|何)|的(?:处理|策略|边界|瓶颈|实现)|怎么样|[了时]怎么办)/iu
const shortDetailCue =
  /^(?:那|所以)?\s*(?:(?:能不能|能否|可以|能|请)(?:再)?)?\s*(?:再)?(?:说|讲|展开)?(?:得)?(?:更)?(?:具体|详细|细致)(?:说|讲)?(?:一?点|一些|一下)?(?:吗|呢)?[\s?？。！!]*$/u
const previousApproachCue =
  /(?:这个|那个|这种|该|上述|刚才的|前面提到的)(?:方案|做法|方式|机制|设计)|为什么(?:这样|这么)|\b(?:this|that) (?:approach|design|implementation)\b/i
const followCue =
  /^(?:那|然后|所以|继续|再|还有|就|嗯)|刚才|前面|你们|当时|这个|那个|其中|它|上[一]?(?:步|一轮)|能不能.{0,8}(?:具体|举例|展开)|说(?:说)?详细|为什么(?:这样|这么|选这|要这么)|(?:怎么|如何)(?:验证|处理|实现|重试|恢复|设计|排查|复现|做)(?:的|[?？。]?$)|(?:呢|这样|那样)[?？。]?$|^\s*(?:and|so|then|why|how so|tell me more)\b/i

export function projectKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]/gu, '')
}

function documentTitle(filename: string): string {
  const title = filename
    .normalize('NFKC')
    .replace(/\.(?:md|markdown)$/i, '')
    .trim()
  const spoken = title
    .replace(/^(?:\p{Script=Han}{1,16}\s*[-_–—]\s*)?\d{1,3}\s*[-_.、–—]\s*/u, '')
    .trim()
  return projectKey(spoken).length >= 2 && /\p{L}/u.test(spoken) ? spoken : title
}

export function interviewProjectCatalog(filenames: string[], configuredProjects: string[]) {
  const profileFor = (name: string) => {
    const key = projectKey(documentTitle(name))
    return profiles.find(({ titles }) => titles.includes(key))
  }
  const usesProfiles = [...filenames, ...configuredProjects].some(profileFor)
  const documents = filenames.map((name) => profileFor(name)?.name ?? documentTitle(name))
  const otherTitles = documents
    .filter((name) => !profiles.some((profile) => profile.name === name))
    .map((name) => ({ name, key: projectKey(name) }))

  return {
    documents,
    usesProfiles,
    canonical(name: string): string {
      const title = documentTitle(name)
      return (
        profileFor(title)?.name ??
        otherTitles.find(({ key }) => key === projectKey(title))?.name ??
        title
      )
    },
    identify(text: string) {
      const key = projectKey(text)
      const matches = otherTitles.filter(
        (title) => title.key.length >= 2 && key.includes(title.key)
      )
      const strong = matches
        .filter(
          (title) =>
            !matches.some((other) => other.key !== title.key && other.key.includes(title.key))
        )
        .map(({ name }) => name)
      const aliases: string[] = []
      const technical: string[] = []
      const withoutEnvironment = text.replace(
        /(?:部署|跑|运行|放|搬|上线)(?:到|在|进)?\s*(?:k\s*8\s*s|kubernetes)|(?:k\s*8\s*s|kubernetes)\s*(?:的)?(?:上|环境|集群|平台)(?:里|中)?|\b(?:on|in)\s+(?:k\s*8\s*s|kubernetes)/giu,
        ''
      )
      for (const profile of usesProfiles ? profiles : []) {
        if (profile.primary.test(text)) strong.push(profile.name)
        else if (profile.aliases.test(text)) aliases.push(profile.name)
        if (profile.signatures.test(text) || profile.pair.every((pattern) => pattern.test(text))) {
          technical.push(profile.name)
        }
      }
      const [k8s] = profiles
      const environmentOnly =
        withoutEnvironment !== text &&
        !k8s.primary.test(withoutEnvironment) &&
        !k8s.aliases.test(withoutEnvironment) &&
        [...strong, ...aliases, ...technical].some((name) => name !== k8s.name)
      const relevant = (names: string[]) =>
        [...new Set(names)].filter((name) => !environmentOnly || name !== k8s.name)
      return {
        strong: relevant(strong),
        aliases: relevant(aliases),
        technical: relevant(technical)
      }
    }
  }
}

export function isInterviewFollowUp(question: string): boolean {
  return (
    followCue.test(question) ||
    previousApproachCue.test(question) ||
    shortDetailCue.test(question) ||
    genericProjectTopic.test(question) ||
    /^(?:为什么|怎么回事|怎么办|怎么做|继续说)[?？。！!]*$/u.test(question)
  )
}

export function refersToPreviousApproach(question: string): boolean {
  return previousApproachCue.test(question)
}

export function interviewDetailChoices(project: string | undefined, query: string, prior: string) {
  if (project !== 'MiniLLM' || !shortDetailCue.test(query)) return []
  const topics = [
    { name: 'Prefill', cue: /prefill/iu },
    { name: 'KV Cache', cue: /kv[\s-]*(?:cache|缓存)/iu },
    { name: 'INT8 量化', cue: /\bint8\b/iu },
    { name: 'CUDA Graph', cue: /cuda\s*graph/iu }
  ].filter(({ cue }) => cue.test(prior))
  return topics.length > 1 ? topics.map(({ name }) => name) : []
}

export function decideProject(
  question: string,
  previous: string | null,
  catalog: ReturnType<typeof interviewProjectCatalog>
): ProjectDecision {
  const text = question.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const active = previous ? catalog.canonical(previous) : null
  const clauses = text
    .split(/[,。;!?]/u)
    .map((part) => part.trim())
    .filter(Boolean)
  const kept = clauses.flatMap((part) => {
    if (!discardClause.test(part)) return [part]
    const focus = focusCue.exec(part)
    return focus ? [part.slice(focus.index + focus[0].length).trim()] : []
  })
  const cleaned = kept.join('，')
  const change = switchFocusCue.exec(cleaned)
  const current = change ? cleaned.slice(change.index + change[0].length).trim() : cleaned
  const focus = focusCue.exec(current)
  const tail = focus ? current.slice(focus.index + focus[0].length).trim() : ''
  const mentions = (query: string) =>
    Object.values(catalog.identify(query)).some((names) => names.length)
  const query =
    tail && (mentions(tail) || switchCue.test(tail) || generalCue.test(tail)) ? tail : current
  const { strong, aliases, technical } = catalog.identify(query)
  const named = [...new Set([...strong, ...aliases])]
  const comparison = compareWithPrevious.test(query)
  const boundary = switchCue.test(text) || clauses.some((part) => discardClause.test(part))
  const result = (intent: ProjectIntent, projects: string[], reason: string): ProjectDecision => ({
    intent,
    projects,
    reason,
    query: query || text,
    nextProject:
      intent === 'select' || intent === 'switch' || intent === 'continue' ? projects[0] : null
  })

  if (
    !outside.test(query) &&
    (generalCue.test(query) || (!named.length && /(?:与|跟|和).{0,8}项目无关/u.test(text)))
  ) {
    return result('general', [], 'explicit-general')
  }
  if (compareCue.test(query) || comparison) {
    const compared = [
      ...new Set([
        ...(named.length >= 2 ? named : [...named, ...technical]),
        ...(comparison && active ? [active] : [])
      ])
    ]
    if (compared.length === 2) return result('compare', compared, 'comparison')
    if (compared.length > 2 || comparison || /两(?:个项目|段经历)/u.test(query)) {
      return result('clarify', [], 'comparison-unclear')
    }
  }
  if (named.length > 1 || (!named.length && outside.test(query))) {
    return result('clarify', [], 'project-unclear')
  }
  const signals = [
    { projects: strong, reason: 'name' },
    { projects: aliases, reason: 'alias' },
    { projects: technical, reason: 'technical' }
  ]
  for (const { projects, reason } of signals) {
    if (projects.length > 1) return result('clarify', [], 'project-unclear')
    if (projects.length === 1) {
      const intent = projects[0] === active ? 'continue' : active ? 'switch' : 'select'
      return result(intent, projects, reason)
    }
  }
  if (isProjectChoiceQuestion(query)) return result('choose', [], 'self-choice')
  if (boundary || outside.test(text)) return result('clarify', [], 'project-cleared')
  const follow = isInterviewFollowUp(text)
  if (active && follow) return result('continue', [active], 'follow-up')
  if (/项目|经历|那套|这个|那个|你们/u.test(text) || (follow && text.length <= 16)) {
    return result('clarify', [], 'context-unclear')
  }
  return result('general', [], 'general')
}
