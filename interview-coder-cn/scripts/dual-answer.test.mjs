import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDualAnswer } from '../src/shared/dual-answer.ts'

test('双机位答案只保留最终选项', () => {
  assert.equal(formatDualAnswer('<think>推理</think>\n**正确答案：A. 哈希表**\n解析：略'), 'A')
  assert.equal(formatDualAnswer('1. A\n2. C\n3. B\n解释：略'), '1.A 2.C 3.B')
  assert.equal(formatDualAnswer('答案：A、C'), 'AC')
  assert.equal(formatDualAnswer('TYPE:CHOICE\nA C'), 'AC')
  assert.equal(formatDualAnswer('TYPE:CHOICE\n1.A\n2.C'), '1.A 2.C')
  assert.equal(formatDualAnswer('正确答案是 A. HashMap，可以在常数时间查询'), 'A')
  assert.equal(
    formatDualAnswer(
      'CODE:java\npublic class Main {\n  public static void main(String[] args) {}\n}'
    ),
    'CODE\npublic class Main {\n  public static void main(String[] args) {}\n}'
  )
  assert.equal(
    formatDualAnswer('```python\nprint(input()[::-1])\n```'),
    'CODE\nprint(input()[::-1])'
  )
  assert.equal(
    formatDualAnswer('TYPE:CODE\na = int(input())\nprint(a + 1)'),
    'CODE\na = int(input())\nprint(a + 1)'
  )
  assert.equal(
    formatDualAnswer(
      'TYPE:CODE\nclass Solution { public: int twoSum(vector<int>& nums) { return 0; } };'
    ),
    'CODE\nclass Solution { public: int twoSum(vector<int>& nums) { return 0; } };'
  )
  assert.equal(formatDualAnswer('TYPE:UNKNOWN'), '无法识别')
  assert.equal(formatDualAnswer('无法确定'), '无法识别')
})
