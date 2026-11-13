import assert from 'node:assert/strict'
import test from 'node:test'
import { buildModelCandidates, streamWithFallback } from '../src/shared/model-fallback.ts'

const primary = {
  apiBaseURL: 'https://api.siliconflow.cn/v1',
  apiKey: 'sk-primary',
  model: 'Qwen/Qwen3-VL-32B-Instruct'
}

test('未开启备用模型时只有一个候选', () => {
  const off = buildModelCandidates(primary, {
    enabled: false,
    apiBaseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-backup',
    model: 'gpt-5-mini'
  })
  assert.equal(off.length, 1)
  assert.equal(off[0].isFallback, false)

  // 开关打开但没填模型名，等于没配
  const blank = buildModelCandidates(primary, {
    enabled: true,
    apiBaseURL: '',
    apiKey: '',
    model: '   '
  })
  assert.equal(blank.length, 1)
})

test('备用可以只换模型名，也可以整套换供应商', () => {
  const sameProvider = buildModelCandidates(primary, {
    enabled: true,
    apiBaseURL: '',
    apiKey: '',
    model: 'Qwen/Qwen3-VL-8B-Thinking'
  })
  assert.deepEqual(sameProvider[1], {
    apiBaseURL: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-primary',
    model: 'Qwen/Qwen3-VL-8B-Thinking',
    isFallback: true
  })

  const otherProvider = buildModelCandidates(primary, {
    enabled: true,
    apiBaseURL: ' https://api.openai.com/v1 ',
    apiKey: ' sk-backup ',
    model: ' gpt-5-mini '
  })
  assert.deepEqual(otherProvider[1], {
    apiBaseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-backup',
    model: 'gpt-5-mini',
    isFallback: true
  })
})

test('与首选完全相同的备用配置会被丢弃', () => {
  const duplicates = buildModelCandidates(primary, {
    enabled: true,
    apiBaseURL: primary.apiBaseURL,
    apiKey: primary.apiKey,
    model: primary.model
  })
  assert.equal(duplicates.length, 1)
})

/**
 * 假流：脚本数组描述每次读取的行为。
 * 普通字符串 => 返回该分片；'end' => 正常结束；'throw' => 报错；'hang' => 永不返回。
 */
function fakeStream(script) {
  let step = 0
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          // 脚本用尽即结束：绝不能把最后一个元素当作永久重复，否则流永不结束。
          const action = step < script.length ? script[step] : 'end'
          step += 1
          if (action === 'hang') return new Promise(() => {})
          if (action === 'throw') return Promise.reject(new Error('boom'))
          if (action === 'end') return Promise.resolve({ done: true, value: undefined })
          return Promise.resolve({ done: false, value: action })
        },
        return: () => Promise.resolve({ done: true, value: undefined })
      }
    }
  }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

const candidates = [
  { ...primary, isFallback: false },
  { ...primary, apiKey: 'sk-backup', model: 'gpt-5-mini', isFallback: true }
]

test('首选在出字前报错时切到备用，且不回放首选的内容', async () => {
  const attempts = []
  const fallbacks = []
  const chunks = await collect(
    streamWithFallback(candidates, {
      firstTokenTimeoutMs: 1000,
      open: (candidate) => {
        attempts.push(candidate.apiKey)
        return fakeStream(candidate.isFallback ? ['备用回答'] : ['throw'])
      },
      onFallback: (candidate, info) => fallbacks.push([candidate.model, info.reason])
    })
  )

  assert.deepEqual(attempts, ['sk-primary', 'sk-backup'])
  assert.deepEqual(chunks, ['备用回答'])
  assert.deepEqual(fallbacks, [['gpt-5-mini', 'error']])
})

test('首选长时间不吐字则按超时切换，并取消该次请求', async () => {
  const signals = []
  const fallbacks = []
  const chunks = await collect(
    streamWithFallback(candidates, {
      firstTokenTimeoutMs: 20,
      open: (candidate, signal) => {
        signals.push(signal)
        return fakeStream(candidate.isFallback ? ['备用回答'] : ['hang'])
      },
      onFallback: (candidate, info) => fallbacks.push([candidate.model, info.reason])
    })
  )

  assert.deepEqual(chunks, ['备用回答'])
  assert.deepEqual(fallbacks, [['gpt-5-mini', 'timeout']])
  assert.equal(signals[0].aborted, true, '超时后应中止首选请求')
  assert.equal(signals[1].aborted, false, '正常完成的备用请求不应被中止')
})

test('已经出过字的回答不会中途切换', async () => {
  const attempts = []
  await assert.rejects(
    collect(
      streamWithFallback(candidates, {
        firstTokenTimeoutMs: 1000,
        open: (candidate) => {
          attempts.push(candidate.apiKey)
          return fakeStream(candidate.isFallback ? ['备用回答'] : ['半个回答', 'throw'])
        }
      })
    ),
    /boom/
  )

  assert.deepEqual(attempts, ['sk-primary'], '半个回答之后的报错应直接抛给调用方')
})

test('用户主动中止不会触发切换', async () => {
  const controller = new AbortController()
  const attempts = []
  const iterator = streamWithFallback(candidates, {
    signal: controller.signal,
    firstTokenTimeoutMs: 1000,
    open: (candidate, signal) => {
      attempts.push(candidate.apiKey)
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
              }),
            return: () => Promise.resolve({ done: true, value: undefined })
          }
        }
      }
    }
  })[Symbol.asyncIterator]()

  const pending = iterator.next()
  controller.abort()
  await assert.rejects(pending, /aborted/)
  assert.deepEqual(attempts, ['sk-primary'], '用户中止后不应改试备用模型')
})

test('所有候选都失败时抛出最后一次的错误', async () => {
  await assert.rejects(
    collect(
      streamWithFallback(candidates, {
        firstTokenTimeoutMs: 20,
        open: () => fakeStream(['hang'])
      })
    ),
    /没有返回任何内容/
  )
})

test('首选静默返回空内容时也算失败，并切到备用', async () => {
  const fallbacks = []
  const chunks = await collect(
    streamWithFallback(candidates, {
      firstTokenTimeoutMs: 1000,
      open: (candidate) => fakeStream(candidate.isFallback ? ['备用回答'] : ['end']),
      onFallback: (taking, info) => fallbacks.push([taking.model, info.reason])
    })
  )

  assert.deepEqual(chunks, ['备用回答'])
  assert.deepEqual(fallbacks, [['gpt-5-mini', 'empty']])
})

test('没有备用可选时，空响应安静结束而不是抛错', async () => {
  const fallbacks = []
  const chunks = await collect(
    streamWithFallback([candidates[0]], {
      firstTokenTimeoutMs: 1000,
      open: () => fakeStream(['end']),
      onFallback: (taking, info) => fallbacks.push([taking.model, info.reason])
    })
  )

  assert.deepEqual(chunks, [])
  assert.deepEqual(fallbacks, [], '没有下一个候选时不应报告切换')
})

test('首选空响应后备用也空，同样安静结束', async () => {
  const chunks = await collect(
    streamWithFallback(candidates, {
      firstTokenTimeoutMs: 1000,
      open: () => fakeStream(['end'])
    })
  )
  assert.deepEqual(chunks, [])
})

test('用户停止后即使没有内容也不算失败', async () => {
  const controller = new AbortController()
  const attempts = []
  const fallbacks = []
  const chunks = await collect(
    streamWithFallback(candidates, {
      signal: controller.signal,
      firstTokenTimeoutMs: 1000,
      open: (candidate) => {
        attempts.push(candidate.apiKey)
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                controller.abort()
                return { done: true, value: undefined }
              },
              return: () => Promise.resolve({ done: true, value: undefined })
            }
          }
        }
      },
      onFallback: (taking, info) => fallbacks.push([taking.model, info.reason])
    })
  )

  assert.deepEqual(chunks, [])
  assert.deepEqual(attempts, ['sk-primary'], '用户停止后不应改试备用模型')
  assert.deepEqual(fallbacks, [])
})

test('首选直接成功时不产生任何切换', async () => {
  const attempts = []
  const chunks = await collect(
    streamWithFallback(candidates, {
      firstTokenTimeoutMs: 1000,
      open: (candidate) => {
        attempts.push(candidate.apiKey)
        return fakeStream(candidate.isFallback ? ['备用'] : ['首选', '回答'])
      }
    })
  )

  assert.deepEqual(attempts, ['sk-primary'])
  assert.deepEqual(chunks, ['首选', '回答'])
})

/** 首个分片要等 delayMs 才吐出来的慢流。 */
function slowFirstChunk(delayMs) {
  return {
    [Symbol.asyncIterator]() {
      let step = 0
      return {
        next: () => {
          step += 1
          if (step === 1) {
            return new Promise((resolve) =>
              setTimeout(() => resolve({ done: false, value: '慢慢想出来的回答' }), delayMs)
            )
          }
          return Promise.resolve({ done: true, value: undefined })
        },
        return: () => Promise.resolve({ done: true, value: undefined })
      }
    }
  }
}

test('首字超时为 null 时，迟迟不吐字的首选不会被误杀', async () => {
  // 图形推理这类题首字很慢。只有「没有备用可切」时才传 null，
  // 若实现里仍把 null 当成一个数值超时，这里会被判失败。
  const chunks = await collect(
    streamWithFallback([candidates[0]], {
      firstTokenTimeoutMs: null,
      open: () => slowFirstChunk(60)
    })
  )
  assert.deepEqual(chunks, ['慢慢想出来的回答'])
})

test('同一段慢流在设了数值超时时会被判失败（对照）', async () => {
  await assert.rejects(
    collect(
      streamWithFallback([candidates[0]], {
        firstTokenTimeoutMs: 20,
        open: () => slowFirstChunk(60)
      })
    ),
    /没有返回任何内容/
  )
})
