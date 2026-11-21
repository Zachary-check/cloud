import assert from 'node:assert/strict'
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

function loadAi(settings) {
  const load = (file) => {
    if (!compiled.has(file)) {
      compiled.set(
        file,
        ts.transpileModule(readFileSync(file, 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText
      )
    }
    const exports = {}
    runInNewContext(compiled.get(file), {
      exports,
      require: (name) => {
        if (name === './settings') return { settings }
        if (name === 'ai') return { streamText }
        if (name === '@ai-sdk/openai') return { createOpenAI }
        assert.ok(name.startsWith('.'), name)
        return load(resolve(dirname(file), name + '.ts'))
      },
      AbortController,
      DOMException,
      setTimeout,
      clearTimeout,
      console: { warn: () => undefined }
    })
    return exports
  }
  return load(resolve(root, 'src/main/ai.ts'))
}

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
