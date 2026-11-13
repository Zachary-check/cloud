import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatRecordedTurn,
  formatSessionBreak,
  nextRecordSessionIndex,
  normalizeRecordFileName,
  parseRecordSessionIndex,
  recordFileDate,
  recordFileHeader,
  recordSessionFileName,
  recordSessionName
} from '../src/shared/interview-record.ts'

const at = new Date(2026, 9, 9, 17, 23, 5) // 2026-10-09 17:23:05 local time

test('会话文件按「日期-当天第几份」命名，天天只有一个头部', () => {
  assert.equal(recordFileDate(at), '2026-10-09')
  assert.equal(recordSessionName(at, 1), 'interview-2026-10-09-1')
  assert.equal(recordSessionFileName(at, 3), 'interview-2026-10-09-3.md')
  assert.equal(recordFileHeader(at), '# 面试记录 2026-10-09\n\n')
})

test('只有当天带序号的记录参与编号，旧的一天一文件不参与', () => {
  assert.equal(parseRecordSessionIndex('interview-2026-10-09-2.md', at), 2)
  assert.equal(parseRecordSessionIndex('interview-2026-10-09-12.md', at), 12)
  assert.equal(parseRecordSessionIndex('Interview-2026-10-09-4.MD', at), 4)
  // Day-only files were written before sessions were numbered: never counted.
  assert.equal(parseRecordSessionIndex('interview-2026-10-09.md', at), null)
  assert.equal(parseRecordSessionIndex('interview-2026-10-08-2.md', at), null)
  assert.equal(parseRecordSessionIndex('字节一面.md', at), null)
  assert.equal(parseRecordSessionIndex('interview-2026-10-09-0.md', at), null)
  assert.equal(parseRecordSessionIndex('interview-2026-10-09-x.md', at), null)

  assert.equal(nextRecordSessionIndex([], at), 1)
  assert.equal(nextRecordSessionIndex(['interview-2026-10-09-1.md'], at), 2)
  assert.equal(
    nextRecordSessionIndex(
      [
        'interview-2026-10-09.md',
        'interview-2026-10-09-2.md',
        'interview-2026-10-09-7.md',
        '字节一面.md'
      ],
      at
    ),
    8
  )
})

test('用户输入的文件名清洗成能创建的名字', () => {
  assert.equal(normalizeRecordFileName('  字节一面  '), '字节一面')
  assert.equal(normalizeRecordFileName('字节一面.md'), '字节一面')
  // A pasted path keeps only the file itself.
  assert.equal(normalizeRecordFileName('D:\\记录\\字节二面.md'), '字节二面')
  assert.equal(normalizeRecordFileName('~/records/三面'), '三面')
  assert.equal(normalizeRecordFileName('面试:第一轮?'), '面试-第一轮')
  assert.equal(normalizeRecordFileName('面试\u0001记录'), '面试记录')
  // Nothing usable left: the dialog has to treat these as invalid.
  assert.equal(normalizeRecordFileName('   '), '')
  assert.equal(normalizeRecordFileName('...'), '')
  assert.equal(normalizeRecordFileName('.md'), '')
  assert.equal(normalizeRecordFileName('////'), '')
})

test('过长的文件名被截断，尾部的点或空格不会留下', () => {
  assert.equal(normalizeRecordFileName('长'.repeat(200)).length, 80)
  // The name may not end in a dot or a space, and the cut must not create one.
  assert.equal(normalizeRecordFileName(`${'长'.repeat(79)}...`), '长'.repeat(79))
})

test('一个回合写成 问/答 两段，并带上知识库来源', () => {
  const text = formatRecordedTurn(
    {
      kind: 'question',
      question: '介绍一下你负责的部分',
      answer: '**结论**：我负责调度模块。\n\n第二段。',
      status: 'done',
      sources: ['项目.md', '简历.md']
    },
    at
  )

  assert.equal(
    text,
    [
      '## 17:23:05 · 面试提问',
      '',
      '**问**',
      '',
      '> 介绍一下你负责的部分',
      '',
      '**答**',
      '',
      '**结论**：我负责调度模块。',
      '',
      '第二段。',
      '',
      '_知识库：项目.md、简历.md_',
      '',
      '---',
      ''
    ].join('\n') + '\n'
  )
})

test('多行提问整段保持引用，空行不跳出引用块', () => {
  const text = formatRecordedTurn(
    { kind: 'followup', question: '第一行\n\n第二行', answer: '好', status: 'done', sources: [] },
    at
  )

  assert.ok(text.includes('· 手动追问'))
  assert.ok(text.includes('> 第一行\n>\n> 第二行'))
  assert.ok(!text.includes('_知识库'))
})

test('未完成的回答标注原因，空回答留占位而不是空白', () => {
  const stopped = formatRecordedTurn(
    { kind: 'question', question: 'q', answer: '半句', status: 'stopped', sources: [] },
    at
  )
  assert.ok(stopped.includes('> 本次回答被中断，内容可能不完整。'))

  const errored = formatRecordedTurn(
    { kind: 'screenshot', question: 'q', answer: '', status: 'error', sources: [] },
    at
  )
  assert.ok(errored.includes('· 截图分析'))
  assert.ok(errored.includes('> 本次回答出错，内容可能不完整。'))
  assert.ok(errored.includes('（没有产生回答）'))

  // A complete answer stays clean so the gaps are what stands out when skimming.
  const done = formatRecordedTurn(
    { kind: 'question', question: 'q', answer: 'a', status: 'done', sources: [] },
    at
  )
  assert.ok(!done.includes('不完整'))
})

test('新开对话在记录里留下分隔标记', () => {
  assert.equal(formatSessionBreak(at), '## ——— 新开对话 17:23:05 ———\n\n')
})
