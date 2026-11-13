/**
 * Exercises the real file writes of the interview record against a temporary
 * directory tree: a fake `electron` supplies `app.getPath`, everything else is
 * the real module.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as formatting from '../src/shared/interview-record.ts'

const nodeRequire = createRequire(import.meta.url)

const compiled = ts.transpileModule(
  readFileSync(new URL('../src/main/interview-record.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText

/**
 * Load the module against a temporary tree. Each call is an independent "app
 * run"; `paths` supplies what `app.getPath()` answers.
 */
function load(paths) {
  const module = { exports: {} }
  runInNewContext(compiled, {
    require: (name) => {
      if (name === 'electron') return { app: { getPath: (key) => paths[key] } }
      if (name === '../shared/interview-record') return formatting
      if (name.startsWith('node:')) return nodeRequire(name)
      assert.fail(`Unexpected dependency: ${name}`)
    },
    exports: module.exports,
    module,
    console
  })
  return module.exports
}

/** A throwaway root directory plus the paths Electron would report inside it. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'interview-record-'))
  return {
    root,
    paths: { documents: join(root, 'documents'), userData: join(root, 'userData') },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

/** Where the run's file lands before the user renames it: `-1`, `-2`, ... */
function sessionFilePath(dir, index = 1) {
  return join(dir, formatting.recordSessionFileName(new Date(), index))
}

/** Writes are queued asynchronously, so wait for the file to show the expected text. */
async function waitForFile(path, predicate) {
  let lastError = 'file never appeared'
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const text = readFileSync(path, 'utf8')
      if (predicate(text)) return text
      lastError = `unexpected content:\n${text}`
    } catch (error) {
      lastError = String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`record file did not reach the expected state — ${lastError}`)
}

function waitForRecord(dir, predicate) {
  return waitForFile(sessionFilePath(dir), predicate)
}

test('默认写到「文档/interview」，文件名带当天的份数', async () => {
  const { paths, cleanup } = fixture()
  const records = load(paths)

  records.beginRecordedTurn('t1', 'question', '默认目录的提问')
  records.finishRecordedTurn('t1', '默认目录的回答', 'done')

  const expectedDir = join(paths.documents, 'interview')
  const text = await waitForRecord(expectedDir, (value) => value.includes('默认目录的回答'))
  assert.match(text, /^# 面试记录 \d{4}-\d{2}-\d{2}\n\n/)
  assert.match(sessionFilePath(expectedDir), /interview-\d{4}-\d{2}-\d{2}-1\.md$/)

  cleanup()
})

test('配置目录后写到指定位置，默认目录不再产生文件', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const custom = join(root, '自定义目录', '面试记录')
  records.setInterviewRecordDir(`  ${custom}  `)

  assert.equal(records.getInterviewRecordDir(), custom)

  records.beginRecordedTurn('t1', 'question', '自定义目录的提问')
  records.finishRecordedTurn('t1', '自定义目录的回答', 'done')

  await waitForRecord(custom, (value) => value.includes('自定义目录的回答'))
  assert.throws(() => readFileSync(sessionFilePath(join(paths.documents, 'interview')), 'utf8'))

  cleanup()
})

test('先建目录与头部，之后的回合按提问顺序追加', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const dir = join(root, 'records')
  records.setInterviewRecordDir(dir)

  records.noteRecordSources(['项目.md'])
  records.beginRecordedTurn('t1', 'question', '介绍一下项目')
  records.finishRecordedTurn('t1', '第一段回答', 'done')
  records.beginRecordedTurn('t2', 'followup', '追问一句')
  records.finishRecordedTurn('t2', '第二段回答', 'done')

  const text = await waitForRecord(dir, (value) => value.includes('第二段回答'))
  assert.match(text, /^# 面试记录 \d{4}-\d{2}-\d{2}\n\n/)
  assert.ok(text.indexOf('第一段回答') < text.indexOf('第二段回答'))
  assert.ok(text.includes('> 介绍一下项目'))
  assert.ok(text.includes('> 追问一句'))
  assert.ok(text.includes('_知识库：项目.md_'))

  cleanup()
})

test('同一天第二次开启软件另起一份文件，编号递增', async () => {
  const { root, paths, cleanup } = fixture()
  const dir = join(root, 'records')

  const firstRun = load(paths)
  firstRun.setInterviewRecordDir(dir)
  firstRun.beginRecordedTurn('t1', 'question', '第一次提问')
  firstRun.finishRecordedTurn('t1', 'A', 'done')
  await waitForFile(sessionFilePath(dir, 1), (value) => value.includes('A'))

  const secondRun = load(paths)
  secondRun.setInterviewRecordDir(dir)
  secondRun.beginRecordedTurn('t2', 'question', '第二次提问')
  secondRun.finishRecordedTurn('t2', 'B', 'done')
  const second = await waitForFile(sessionFilePath(dir, 2), (value) => value.includes('B'))

  const first = readFileSync(sessionFilePath(dir, 1), 'utf8')
  // Each run keeps its own transcript, and each one has exactly one header.
  assert.ok(first.includes('A') && !first.includes('B'))
  assert.equal(first.match(/^# 面试记录/gm).length, 1)
  assert.equal(second.match(/^# 面试记录/gm).length, 1)
  assert.ok(!second.includes('A'))

  cleanup()
})

test('重复的结束事件和没有开始的回合都不会写进记录', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const dir = join(root, 'records')
  records.setInterviewRecordDir(dir)

  records.finishRecordedTurn('ghost', '不该出现的回答', 'done')
  records.beginRecordedTurn('t1', 'question', '只有一个提问')
  records.finishRecordedTurn('t1', '真正的回答', 'done')
  records.finishRecordedTurn('t1', '重复的收尾', 'done')

  const text = await waitForRecord(dir, (value) => value.includes('真正的回答'))
  assert.ok(!text.includes('不该出现的回答'))
  assert.ok(!text.includes('重复的收尾'))
  assert.equal(text.match(/^## /gm).length, 1)

  cleanup()
})

test('新开对话写入分隔标记，且不打断已有内容', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const dir = join(root, 'records')
  records.setInterviewRecordDir(dir)

  records.beginRecordedTurn('t1', 'question', '上一个会话的提问')
  records.finishRecordedTurn('t1', '上一个会话的回答', 'done')
  records.recordSessionBreak()
  records.beginRecordedTurn('t2', 'question', '新会话的提问')
  records.finishRecordedTurn('t2', '新会话的回答', 'done')

  const text = await waitForRecord(dir, (value) => value.includes('新会话的回答'))
  assert.ok(text.includes('——— 新开对话 '))
  assert.ok(text.indexOf('上一个会话的回答') < text.indexOf('——— 新开对话 '))
  assert.ok(text.indexOf('——— 新开对话 ') < text.indexOf('新会话的提问'))

  cleanup()
})

test('关闭应用时把没结束的回答连同已收到的文字一起保存', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const dir = join(root, 'records')
  records.setInterviewRecordDir(dir)

  records.beginRecordedTurn('t1', 'question', '被打断的提问')
  records.appendRecordedAnswer('t1', '已经收到的')
  records.appendRecordedAnswer('t1', '一部分回答')
  records.beginRecordedTurn('t2', 'question', '完整结束的提问')
  records.finishRecordedTurn('t2', '完整回答', 'done')

  await records.finalizeInterviewRecord()

  const text = readFileSync(sessionFilePath(dir), 'utf8')
  assert.ok(text.includes('> 被打断的提问'))
  assert.ok(text.includes('已经收到的一部分回答'))
  assert.ok(text.includes('应用关闭时该回答仍在生成'))
  // The finished turn is written once, by its own end event.
  assert.equal(text.match(/完整回答/g).length, 1)
  assert.equal(text.match(/^## /gm).length, 2)

  cleanup()
})

test('冲刷后再冲刷不会重复写入', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const dir = join(root, 'records')
  records.setInterviewRecordDir(dir)

  records.beginRecordedTurn('t1', 'question', '只问一次的提问')
  await records.finalizeInterviewRecord()
  await records.finalizeInterviewRecord()

  const text = readFileSync(sessionFilePath(dir), 'utf8')
  assert.equal(text.match(/^## /gm).length, 1)

  cleanup()
})

test('没有问答的会话不产生文件，也不会要求命名', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const dir = join(root, 'records')
  records.setInterviewRecordDir(dir)

  assert.equal(records.hasRecordedInterview(), false)
  assert.equal(await records.prepareRecordSession(), null)
  assert.throws(() => readFileSync(sessionFilePath(dir), 'utf8'))

  cleanup()
})

test('关闭对话框拿到默认名，回答还在流式时也能改名', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const dir = join(root, 'records')
  records.setInterviewRecordDir(dir)

  records.beginRecordedTurn('t1', 'question', '被打断的提问')
  records.appendRecordedAnswer('t1', '已经收到的')

  const session = await records.prepareRecordSession()
  // Spread into this realm's objects: the module runs in a vm context, so its
  // objects have a different prototype than the ones written here.
  assert.deepEqual(
    { ...session },
    {
      name: `interview-${formatting.recordFileDate(new Date())}-1`,
      dir
    }
  )
  assert.equal(records.hasRecordedInterview(), true)

  // Renaming before anything reached the disk is a pure name change.
  const renamed = await records.renameInterviewRecord(session.name)
  assert.deepEqual({ ...renamed }, { ok: true, name: session.name, path: sessionFilePath(dir) })

  await records.finalizeInterviewRecord()
  const text = readFileSync(sessionFilePath(dir), 'utf8')
  assert.ok(text.includes('已经收到的'))
  assert.ok(text.includes('应用关闭时该回答仍在生成'))

  cleanup()
})

test('改名把整份记录搬到新文件名，之后继续写在新文件里', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const dir = join(root, 'records')
  records.setInterviewRecordDir(dir)

  records.beginRecordedTurn('t1', 'question', '介绍一下项目')
  records.finishRecordedTurn('t1', '回答一', 'done')
  await waitForRecord(dir, (value) => value.includes('回答一'))

  const renamed = await records.renameInterviewRecord('  字节一面  ')
  assert.deepEqual({ ...renamed }, { ok: true, name: '字节一面', path: join(dir, '字节一面.md') })
  assert.ok(readFileSync(join(dir, '字节一面.md'), 'utf8').includes('回答一'))
  assert.throws(() => readFileSync(sessionFilePath(dir), 'utf8'))

  records.beginRecordedTurn('t2', 'question', '第二个问题')
  records.finishRecordedTurn('t2', '回答二', 'done')
  await records.finalizeInterviewRecord()

  const text = readFileSync(join(dir, '字节一面.md'), 'utf8')
  assert.ok(text.includes('回答一') && text.includes('回答二'))
  assert.equal(text.match(/^# 面试记录/gm).length, 1)

  cleanup()
})

test('文件名重复时拒绝改名，原文件一点不动', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const dir = join(root, 'records')
  records.setInterviewRecordDir(dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '已存在.md'), '别人的记录')

  records.beginRecordedTurn('t1', 'question', 'q')
  records.finishRecordedTurn('t1', 'A', 'done')
  await waitForRecord(dir, (value) => value.includes('A'))

  assert.deepEqual(
    { ...(await records.renameInterviewRecord('已存在')) },
    {
      ok: false,
      reason: 'exists'
    }
  )
  assert.equal(readFileSync(join(dir, '已存在.md'), 'utf8'), '别人的记录')
  assert.ok(readFileSync(sessionFilePath(dir), 'utf8').includes('A'))

  // Nothing usable in the box at all.
  assert.deepEqual(
    { ...(await records.renameInterviewRecord('   ')) },
    {
      ok: false,
      reason: 'invalid'
    }
  )

  // A rejected name leaves the session able to keep recording, so the dialog
  // can be answered with a different one.
  records.beginRecordedTurn('t2', 'question', 'q2')
  records.finishRecordedTurn('t2', 'B', 'done')
  await records.finalizeInterviewRecord()
  const text = readFileSync(sessionFilePath(dir), 'utf8')
  assert.ok(text.includes('A') && text.includes('B'))

  cleanup()
})

test('选择不保存会删掉这次的记录，退出冲刷也不会让它复活', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const dir = join(root, 'records')
  records.setInterviewRecordDir(dir)

  records.beginRecordedTurn('t1', 'question', 'q')
  records.finishRecordedTurn('t1', 'A', 'done')
  await waitForRecord(dir, (value) => value.includes('A'))
  assert.equal(records.hasRecordedInterview(), true)

  await records.discardInterviewRecord()

  assert.equal(records.hasRecordedInterview(), false)
  assert.throws(() => readFileSync(sessionFilePath(dir), 'utf8'))
  await records.finalizeInterviewRecord()
  assert.throws(() => readFileSync(sessionFilePath(dir), 'utf8'))

  cleanup()
})

test('已有当天的旧记录时，新一份从下一个编号开始', async () => {
  const { root, paths, cleanup } = fixture()
  const records = load(paths)
  const dir = join(root, 'records')
  records.setInterviewRecordDir(dir)
  mkdirSync(dir, { recursive: true })
  // Written by earlier runs, including the day-only name used before.
  writeFileSync(join(dir, formatting.recordSessionFileName(new Date(), 1)), '早上的第一份')
  writeFileSync(join(dir, formatting.recordSessionFileName(new Date(), 3)), '中午的第三份')
  writeFileSync(join(dir, `interview-${formatting.recordFileDate(new Date())}.md`), '旧格式')

  records.beginRecordedTurn('t1', 'question', 'q')
  records.finishRecordedTurn('t1', 'A', 'done')

  const session = await records.prepareRecordSession()
  assert.equal(session.name, `interview-${formatting.recordFileDate(new Date())}-4`)
  await records.finalizeInterviewRecord()

  const text = readFileSync(sessionFilePath(dir, 4), 'utf8')
  assert.ok(text.includes('A'))
  assert.equal(readFileSync(sessionFilePath(dir, 1), 'utf8'), '早上的第一份')
  assert.equal(readFileSync(sessionFilePath(dir, 3), 'utf8'), '中午的第三份')

  cleanup()
})
