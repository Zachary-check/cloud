import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const prompt = readFileSync(
  resolve(root, 'src/renderer/src/lib/store/prompts/interview.md'),
  'utf8'
)
const compiled = new Map()
const replay = JSON.parse(
  readFileSync(resolve(root, 'scripts/fixtures/interview-project-replay.json'), 'utf8')
)

function loadMain(settings, entry = 'ai', dependencies = {}, mainWindow = undefined) {
  const modules = new Map()
  const load = (file) => {
    if (modules.has(file)) return modules.get(file)
    if (!compiled.has(file)) {
      compiled.set(
        file,
        ts.transpileModule(readFileSync(file, 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText
      )
    }
    const exports = {}
    modules.set(file, exports)
    runInNewContext(compiled.get(file), {
      exports,
      require: (name) => {
        if (Object.hasOwn(dependencies, name)) return dependencies[name]
        if (name === './settings') return { settings }
        if (name === 'ai') return { streamText }
        if (name === '@ai-sdk/openai') return { createOpenAI }
        assert.ok(name.startsWith('.'), name)
        return load(resolve(dirname(file), name + '.ts'))
      },
      AbortController,
      DOMException,
      global: { mainWindow },
      setTimeout,
      clearTimeout,
      console: { warn: () => undefined, error: () => undefined }
    })
    return exports
  }
  return load(resolve(root, `src/main/${entry}.ts`))
}

const loadAi = (settings) => loadMain(settings)

async function endpoint(t, options = {}) {
  const requests = []
  const server = createServer(async (request, response) => {
    let payload = ''
    for await (const part of request) payload += part
    const body = JSON.parse(payload)
    requests.push(body)
    if (body.model === options.failModel) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'test failure' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) =>
      'data: ' +
      JSON.stringify({
        id: 'answer',
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason }]
      }) +
      '\n\n'
    response.write(chunk({ role: 'assistant', content: '模拟' }))
    await options.pause?.(body)
    if (response.destroyed) return
    response.write(chunk({ content: '回答' }))
    response.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  t.after(() => {
    server.close()
    server.closeAllConnections()
  })
  return { requests, url: 'http://127.0.0.1:' + server.address().port + '/v1' }
}

const deliveryProject = {
  id: 'delivery',
  name: '订单履约.md',
  enabled: true,
  content: [
    '# 订单履约',
    '背景是帮助商家查询发货状态。我负责订单重试链路。',
    '## 实现',
    '使用业务幂等键，冲突时查询原有任务状态。',
    '## 约束与选型',
    '现有数据库已支持事务。同步提交后用任务表收敛重试，团队不需要维护独立 Kafka 集群。',
    '## 验证',
    '测试时模拟数据库已提交但响应丢失，重复提交后核对订单日志和表中只有一次写入。',
    '## 边界',
    '超过有效期就按新操作处理，告警中附上请求标识。'
  ].join('\n\n')
}
const inventoryProject = {
  id: 'inventory',
  name: '库存告警.md',
  enabled: true,
  content:
    '# 库存告警\n我负责告警吞吐。\n## 验证\n压测将告警入队速度提升为每秒三百条，记录队列积压。'
}

function settingsFor(url, overrides = {}) {
  return {
    workMode: 'interview',
    customPrompt: prompt,
    apiBaseURL: url,
    apiKey: 'test-local-endpoint',
    model: 'stub-primary',
    codeLanguage: '',
    interviewContext: '',
    interviewKnowledgeBaseEnabled: true,
    interviewKnowledgeBase: [inventoryProject, deliveryProject],
    pinnedProjectRules: [
      { id: 'default', keywords: '', project: '库存告警', note: '我负责告警吞吐。' }
    ],
    ...overrides
  }
}

const user = (question) => ({ role: 'user', content: question })
const speech = (question) => ({
  role: 'user',
  content: [
    {
      type: 'text',
      text: '这是面试官的语音提问：\n' + question + '\n\n请直接给出适合面试场景的回答。'
    }
  ]
})
const system = ({ messages }) => messages.find(({ role }) => role === 'system').content
async function collect(stream) {
  const chunks = []
  for await (const text of stream) chunks.push(text)
  assert.equal(chunks.join(''), '模拟回答')
}

test('one stream per turn carries project facts into new aspects, repeats and project switches', async (t) => {
  const stub = await endpoint(t)
  const ai = loadAi(settingsFor(stub.url))
  const history = []
  async function ask(question, expectedName, manual = false) {
    const message = manual ? user(question) : speech(question)
    const sources = []
    const options = { question, onKnowledgeSources: (names) => sources.push(Array.from(names)) }
    const count = stub.requests.length
    const stream = manual
      ? ai.getFollowUpStream(history, question, options)
      : ai.getGeneralStream([...history, message], options)
    await collect(stream)
    assert.equal(stub.requests.length, count + 1)
    assert.equal(stub.requests.at(-1).model, 'stub-primary')
    assert.deepEqual(sources, [[expectedName]])
    history.push(message, { role: 'assistant', content: '模拟回答' })
    return system(stub.requests.at(-1))
  }

  const overview = await ask('介绍一下订单履约项目', '订单履约.md')
  assert.match(overview, /四到七句话/)
  assert.match(overview, /我负责订单重试链路/)
  assert.doesNotMatch(overview, /本次提问已经命中规则/)
  const decision = await ask('当时为什么没有换成 Kafka？', '订单履约.md')
  assert.match(decision, /同步提交后用任务表收敛重试/)
  assert.doesNotMatch(decision, /文档：库存告警/)

  const verification = await ask('那你们怎么验证的？', '订单履约.md')
  assert.match(verification, /数据库已提交但响应丢失/)
  assert.match(verification, /追问直接补充新细节/)
  assert.doesNotMatch(verification, /同一提问已有一轮回答/)
  assert.doesNotMatch(verification, /超过有效期就按新操作处理/)
  const repeated = await ask('那你们怎么验证的?', '订单履约.md')
  assert.match(repeated, /同一提问已有一轮回答/)
  assert.match(repeated, /优先补充一项之前没说清/)
  assert.match(repeated, /超过有效期就按新操作处理/)
  const switched = await ask('不讲订单履约了，换成库存告警，压测呢？', '库存告警.md', true)
  assert.match(switched, /切换了项目或话题/)
  assert.match(switched, /每秒三百条/)
  assert.doesNotMatch(switched, /文档：订单履约/)
  const next = await ask('边界条件呢？', '库存告警.md', true)
  assert.match(next, /本轮关联项目：.*库存告警/)
})

test('a late detail in a long Markdown section reaches the request within the evidence budget', async (t) => {
  const stub = await endpoint(t)
  const detail = '模拟响应丢失，断言库存冻结只有一条流水'
  const ai = loadAi(
    settingsFor(stub.url, {
      interviewKnowledgeBase: [
        {
          ...deliveryProject,
          content: '项目背景。'.repeat(6500) + '\n## 验证\n\n' + detail
        }
      ]
    })
  )
  await collect(ai.getFollowUpStream([user('介绍订单履约')], '怎么验证的？', {}))
  const text = system(stub.requests[0])
  assert.ok(text.includes(detail))
  const supplied = text
    .split('<candidate_knowledge_base>\n')[1]
    .split('\n</candidate_knowledge_base>')[0]
  assert.ok(supplied.length <= 16_060)
})

test('spoken project names resolve numbered notes and referential questions prefer the prior approach', async (t) => {
  const stub = await endpoint(t)
  const numberedName = '快速复习-02-订单履约.md'
  const detail = 'LeaseToken 防止过期调度器覆盖新确认。长事务锁会把外部等待计入锁持有时间。'
  const notes = {
    ...deliveryProject,
    name: numberedName,
    content: [
      ...Array.from(
        { length: 5 },
        (_value, index) =>
          '## 旁支模块选型 ' + index + '\n' + '这个模块的方案考虑了约束、选型原因、替代做法和对比。'
      ),
      '## LeaseToken 的代价',
      detail
    ].join('\n\n')
  }
  const settings = settingsFor(stub.url, {
    interviewKnowledgeBase: [
      { ...inventoryProject, name: '01_库存告警.md' },
      notes,
      { id: 'other', name: '快速复习-03-报表服务.md', content: '报表选型与验证。', enabled: true }
    ],
    pinnedProjectRules: []
  })
  const ai = loadAi(settings)
  const history = [
    speech('介绍一下你觉得最难的项目，你负责哪部分？'),
    { role: 'assistant', content: '最难的是订单履约，我负责调度状态和超时恢复。' }
  ]
  async function ask(question, recent, expectedName) {
    const reports = []
    await collect(
      ai.getGeneralStream([...recent, speech(question)], {
        question,
        onKnowledgeSources: (names) => reports.push(Array.from(names))
      })
    )
    assert.deepEqual(reports, [[expectedName]])
    return system(stub.requests.at(-1))
  }
  const implementation = '那你们具体是怎么做的？失败时怎么办？'
  const carried = await ask(implementation, history, numberedName)
  assert.match(carried, /本轮关联项目：「订单履约」/)
  history.push(speech(implementation), {
    role: 'assistant',
    content: '我们用 LeaseToken 校验调度资格。'
  })
  const decision = await ask('这种做法为什么合适？有没有考虑过别的方案？', history, numberedName)
  assert.match(decision, /上一轮刚讲到的具体做法/)
  assert.ok(decision.includes(detail), 'the relevant justification must survive the passage limit')
  assert.doesNotMatch(decision, /文档：01_库存告警|文档：快速复习-03-报表服务/)

  const switched = await ask('改讲库存告警，怎么验证这个方案？', history, '01_库存告警.md')
  assert.doesNotMatch(switched, /上一轮刚讲到的具体做法/)

  settings.pinnedProjectRules = [
    { id: 'saved', keywords: '最满意', project: '快速复习-02-订单履约', note: '' }
  ]
  const pinned = await ask('你最满意的项目是哪个？', [], numberedName)
  assert.match(pinned, /必须用「快速复习-02-订单履约」/)
})

test('default pins apply to choosing a project, while disabled project sources stay excluded', async (t) => {
  const stub = await endpoint(t)
  const settings = settingsFor(stub.url, {
    interviewKnowledgeBase: [inventoryProject, { ...deliveryProject, enabled: false }]
  })
  const ai = loadAi(settings)
  async function ask(question, expectedSources) {
    const reports = []
    await collect(
      ai.getGeneralStream([speech(question)], {
        question,
        onKnowledgeSources: (names) => reports.push(Array.from(names))
      })
    )
    assert.deepEqual(reports, [expectedSources])
    return system(stub.requests.at(-1))
  }
  assert.match(await ask('挑一个你最满意的项目', ['库存告警.md']), /必须用「库存告警」/)
  assert.doesNotMatch(await ask('解释一下哈希表扩容', ['库存告警.md']), /本次提问已经命中规则/)
  const disabled = await ask('订单履约是怎么验证的？', [])
  assert.doesNotMatch(disabled, /candidate_knowledge_base|文档：库存告警/)
  settings.workMode = 'written'
  settings.customPrompt = '笔试场景测试'
  const written = await ask('解释一下哈希表扩容', [])
  assert.match(written, /笔试场景测试/)
  assert.doesNotMatch(written, /candidate_knowledge_base|项目固定选择|追问直接补充新细节/)
})

test('the configured backup consumes the same prepared evidence and reports sources once', async (t) => {
  const stub = await endpoint(t, { failModel: 'stub-primary' })
  const settings = settingsFor(stub.url, {
    fallbackModelEnabled: true,
    fallbackModel: 'stub-backup',
    fallbackApiBaseURL: '',
    fallbackApiKey: ''
  })
  const ai = loadAi(settings)
  const reports = []
  const switched = []
  await collect(
    ai.getFollowUpStream([speech('介绍订单履约')], '怎么验证？', {
      onFallback: (...data) => {
        // An unrelated settings change during failover must not change this turn.
        settings.interviewKnowledgeBaseEnabled = false
        switched.push(data)
      },
      onKnowledgeSources: (names) => reports.push(Array.from(names))
    })
  )
  assert.deepEqual(
    stub.requests.map(({ model }) => model),
    ['stub-primary', 'stub-backup']
  )
  assert.equal(system(stub.requests[0]), system(stub.requests[1]))
  assert.match(system(stub.requests[1]), /数据库已提交但响应丢失/)
  assert.deepEqual(switched, [['stub-backup', 'error']])
  assert.deepEqual(reports, [['订单履约.md']])
})

// These snippets exercise routing and passage selection with synthetic facts.
// The interviewee's original Markdown files are deliberately not test inputs.
const profileNotes = [
  {
    id: 'K8s',
    name: '面试知识库-01-K8s.md',
    enabled: true,
    content: [
      '## OwnerReference',
      '匹配 UID、管理标签和 controller 字段后才处理资源归属。',
      '## WATCH_NAMESPACE',
      '留空时监听所有命名空间。控制器调谐失败以限速队列重试。'
    ].join('\n\n')
  },
  {
    id: 'StreamVault',
    name: '面试知识库-02-StreamVault.md',
    enabled: true,
    content: [
      '## io_uring 异步写',
      '队列满返回 503，pwrite 写失败返回 500。',
      '## 分片上传 ACK',
      '整片写入后才按序号回复 ACK。',
      '## 通过 RPC 服务发现',
      '网关查询 Registry，实例过期后释放租约。',
      '## 文件下载窗口',
      'RPC 用 128 KiB 的字节窗口管理下载，累计 ACK 到低水位时才继续发送。',
      '## protobuf 长度头',
      '用 4 字节长度头判断半包，收到完整消息后再解码。'
    ].join('\n\n')
  },
  {
    id: 'MiniLLM',
    name: '面试知识库-03-MiniLLM.md',
    enabled: true,
    content: [
      '## Prefill',
      '单独记录 Prefill 和 TTFT，比较首个输出前的等待时间。',
      '## CUDA Graph',
      '捕获前预热 RoPE 和工作区，固定地址再回放。',
      '## INT8 量化验证',
      '对固定输入比较 INT8 logits 和 KV Cache 下的解码结果。'
    ].join('\n\n')
  }
]

const profileFiles = (projects) =>
  projects.map((id) => profileNotes.find((item) => item.id === id).name)
const promptSources = (request) =>
  [...system(request).matchAll(/^--- 文档：(.+) ---$/gm)].map((match) => match[1])

test('original replay cases route through the real stream and send only the intended notes', async (t) => {
  const stub = await endpoint(t)
  const ai = loadAi(
    settingsFor(stub.url, {
      interviewKnowledgeBase: profileNotes,
      pinnedProjectRules: []
    })
  )

  async function examine(item, previousProject, history) {
    const decisions = []
    const sources = []
    const requestCount = stub.requests.length
    const options = {
      question: item.question,
      previousProject,
      onProjectDecision: (decision) => decisions.push(decision),
      onKnowledgeSources: (names) => sources.push(Array.from(names))
    }
    const stream = ai.getGeneralStream([...history, speech(item.question)], options)
    if (item.intent === 'clarify') {
      assert.deepEqual(await Array.fromAsync(stream), ['您想听哪个项目？'], item.id)
      assert.equal(stub.requests.length, requestCount, item.id)
    } else {
      await collect(stream)
      assert.equal(stub.requests.length, requestCount + 1, item.id)
      const request = stub.requests.at(-1)
      assert.deepEqual(promptSources(request).sort(), profileFiles(item.projects).sort(), item.id)
      assert.ok(JSON.stringify(request.messages.at(-1).content).includes(item.question), item.id)
    }
    assert.equal(decisions.length, 1, item.id)
    const [decision] = decisions
    assert.equal(decision.intent, item.intent, item.id)
    assert.deepEqual(Array.from(decision.projects).sort(), [...item.projects].sort(), item.id)
    const nextProject = item.projects.length === 1 ? item.projects[0] : null
    assert.equal(decision.nextProject, nextProject, item.id)
    assert.deepEqual(
      sources.map((files) => files.sort()),
      [profileFiles(item.projects).sort()],
      item.id
    )

    const expectedEvidence = replay.evidenceChecks[item.id]
    if (expectedEvidence) {
      const promptText = system(stub.requests.at(-1))
      const evidence = promptText
        .split('<candidate_knowledge_base>')[1]
        .split('</candidate_knowledge_base>')[0]
      const missing = expectedEvidence.filter((term) => !evidence.includes(term))
      if (item.id === '21') {
        assert.deepEqual(missing, expectedEvidence, item.id)
        assert.match(promptText, /「Prefill」、「KV Cache」、「INT8 量化」.*问想具体了解哪个技术点/)
      } else {
        assert.deepEqual(missing, [], item.id)
      }
    }
    return decision.nextProject
  }
  assert.equal(replay.singleTurns.length, 66)
  assert.equal(replay.sequence.length, 10)
  assert.equal(Object.keys(replay.evidenceChecks).length, 12)
  for (const item of replay.singleTurns) {
    const [question, answer] = replay.examples[item.previous] ?? []
    const history = question ? [speech(question), { role: 'assistant', content: answer }] : []
    await examine(item, item.previous || null, history)
  }
  let active = null
  const history = []
  for (const item of replay.sequence) {
    active = await examine(item, active, history)
    history.push(speech(item.question), { role: 'assistant', content: item.answer })
  }
})

test('pins cannot redirect a scoped question and missing or disabled documents are reported', async (t) => {
  const stub = await endpoint(t)
  const settings = settingsFor(stub.url, {
    interviewKnowledgeBase: profileNotes,
    pinnedProjectRules: [
      { id: 'k', keywords: '验证', project: 'K8s Dashboard', note: 'K8S_ONLY_NOTE' },
      {
        id: 'm',
        keywords: 'io_uring、验证、基础题',
        project: '面试知识库-03-MiniLLM',
        note: 'MINI_ONLY_NOTE'
      },
      { id: 's', keywords: '', project: 'WebFileServer', note: 'STREAM_ONLY_NOTE' }
    ]
  })
  const ai = loadAi(settings)

  async function ask(question, projects, previousProject = 'K8s') {
    const reports = []
    await collect(
      ai.getFollowUpStream([], question, {
        previousProject,
        onKnowledgeSources: (names) => reports.push(Array.from(names))
      })
    )
    const request = stub.requests.at(-1)
    assert.deepEqual(promptSources(request).sort(), profileFiles(projects).sort(), question)
    assert.deepEqual(reports[0].sort(), profileFiles(projects).sort(), question)
    return system(request)
  }

  const switched = await ask('异步写用了 io_uring，写队列满怎么办？', ['StreamVault'])
  assert.match(switched, /STREAM_ONLY_NOTE/)
  assert.doesNotMatch(switched, /K8S_ONLY_NOTE|MINI_ONLY_NOTE|必须用/)
  assert.match(
    await ask('刚才说的是 K8s，换个项目讲 WebFileServer 的下载窗口', ['StreamVault']),
    /本轮关联项目：「StreamVault」/
  )
  assert.doesNotMatch(await ask('讲一下二叉搜索树的复杂度。', []), /本轮关联项目|ONLY_NOTE/)
  const compared = await ask('K8s 和 StreamVault 分别怎么验证？', ['K8s', 'StreamVault'])
  assert.match(compared, /K8S_ONLY_NOTE/)
  assert.match(compared, /STREAM_ONLY_NOTE/)
  assert.doesNotMatch(compared, /MINI_ONLY_NOTE|必须用/)
  assert.doesNotMatch(
    await ask('先问个基础题，KV Cache 为什么省计算？', []),
    /ONLY_NOTE|项目固定选择/
  )
  assert.match(await ask('说一个你做过最难的项目', ['StreamVault']), /必须用「WebFileServer」/)

  settings.interviewKnowledgeBase = profileNotes.filter(({ id }) => id !== 'StreamVault')
  assert.match(await ask('WebFileServer 怎么做服务发现？', []), /没有可用的「StreamVault」项目资料/)
  assert.match(
    await ask('K8s 和 StreamVault 的失败处理有何区别？', ['K8s']),
    /「StreamVault」项目资料/
  )
  settings.interviewKnowledgeBase = profileNotes.map((doc) =>
    doc.id === 'StreamVault' ? { ...doc, enabled: false } : doc
  )
  assert.match(await ask('WebFileClient 下载窗口怎么算？', []), /没有可用的「StreamVault」项目资料/)
  settings.interviewKnowledgeBaseEnabled = false
  assert.match(await ask('CUDA Graph 怎么做的？', []), /没有可用的「MiniLLM」项目资料/)
})

function interviewWorkflow(settings) {
  const handlers = new Map()
  const events = []
  const waiters = new Map()
  const noop = () => {}
  let voice
  let changeMode
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (event, value) => {
        events.push([event, value])
        const resolve = waiters.get(event)
        waiters.delete(event)
        resolve?.(value)
      }
    }
  }
  loadMain(
    settings,
    'shortcuts',
    {
      'node:crypto': { randomUUID },
      electron: {
        globalShortcut: {},
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) }
      },
      './main-window': {},
      './toolbar-window': {},
      './window-placement': {},
      './take-screenshot': {
        takeScreenshot: async () =>
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZyFIAAAAASUVORK5CYII=',
        cancelPendingCapture: noop,
        toDisplayThumbnail: () => ''
      },
      './save-screenshot': { saveScreenshotToDisk: noop },
      './interview-record': {
        beginRecordedTurn: noop,
        appendRecordedAnswer: noop,
        finishRecordedTurn: noop,
        noteRecordSources: noop,
        recordSessionBreak: noop
      },
      './native-overlay': { nativeAnswerEvent: noop },
      './settings': {
        settings,
        setWorkModeChangeHandler: (handler) => {
          changeMode = handler
        }
      },
      './state': { state: { inCoderPage: true } },
      './transcription': {
        getTranscriptionText: () => '',
        setInterviewTriggerHandler: (handler) => {
          voice = handler
        }
      }
    },
    mainWindow
  )
  return {
    events,
    voice,
    call: (name, ...args) => handlers.get(name)(null, ...args),
    waitFor: (event) => new Promise((resolve) => waiters.set(event, resolve)),
    setMode: (mode) => {
      const previous = settings.workMode
      settings.workMode = mode
      changeMode(previous)
    }
  }
}

test(
  'voice and typed turns share state through an interrupted stream, comparison, and session reset',
  { timeout: 10000 },
  async (t) => {
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.after(release.resolve)
    const stub = await endpoint(t, {
      pause: (body) => {
        if (!JSON.stringify(body.messages.at(-1).content).includes('故意延迟')) return
        started.resolve()
        return release.promise
      }
    })
    const workflow = interviewWorkflow(
      settingsFor(stub.url, {
        interviewKnowledgeBase: profileNotes,
        pinnedProjectRules: []
      })
    )
    const assertSources = (projects) => {
      const expected = profileFiles(projects).sort()
      assert.deepEqual(promptSources(stub.requests.at(-1)).sort(), expected)
      const reported = workflow.events.findLast(([event]) => event === 'knowledge-sources')[1]
      assert.deepEqual(Array.from(reported).sort(), expected)
    }
    const assertLocalClarification = async (ask) => {
      const count = stub.requests.length
      await ask()
      assert.equal(stub.requests.length, count)
      const sources = workflow.events.findLast(([event]) => event === 'knowledge-sources')[1]
      assert.deepEqual(Array.from(sources), [])
      const turn = workflow.events.findLast(([event]) => event === 'interview-turn-end')[1]
      assert.equal(turn.answer, '您想听哪个项目？')
    }
    const pending = workflow.voice('WebFileServer 的下载窗口怎么设？故意延迟')
    await started.promise
    assertSources(['StreamVault'])
    await workflow.call('sendFollowUpQuestion', 'TinyLlama 权重怎么转换？')
    assertSources(['MiniLLM'])
    release.resolve()
    await pending
    const stopped = workflow.events.filter(
      ([event, turn]) => event === 'interview-turn-end' && turn.status === 'stopped'
    )
    assert.equal(stopped.length, 1)
    await workflow.voice('那怎么验证？')
    assertSources(['MiniLLM'])
    await workflow.voice('Mini LLM 和 WebFileServer 有什么区别？')
    assertSources(['MiniLLM', 'StreamVault'])
    await assertLocalClarification(() =>
      workflow.call('sendFollowUpQuestion', '能不能再具体一点？')
    )
    await workflow.voice('多集群管理面板怎么隔离权限？')
    assertSources(['K8s'])
    const screenshot = workflow.waitFor('interview-turn-end')
    workflow.call('triggerAction', 'takeScreenshot')
    await screenshot
    assertSources(['K8s', 'MiniLLM', 'StreamVault'])
    assert.ok(workflow.events.some(([event]) => event === 'interview-turns-clear'))
    await assertLocalClarification(() => workflow.voice('这个项目怎么验证？'))
    await workflow.voice('io_uring 的写队列满了怎么办？')
    assertSources(['StreamVault'])
    workflow.setMode('written')
    workflow.setMode('interview')
    await assertLocalClarification(() => workflow.voice('那怎么验证？'))
  }
)
