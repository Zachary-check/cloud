export function formatDualAnswer(input: string): string {
  const withoutReasoning = input.replace(
    /<(?:think|analysis)>[\s\S]*?(?:<\/(?:think|analysis)>|$)/gi,
    ''
  )
  const typedAnswer = withoutReasoning.trim().match(/^TYPE:(CHOICE|CODE|UNKNOWN)\s*\n?([\s\S]*)$/i)
  if (typedAnswer?.[1].toUpperCase() === 'UNKNOWN') return '无法识别'
  if (typedAnswer?.[1].toUpperCase() === 'CODE') {
    const code = typedAnswer[2].replace(/^```(?:\w+)?\s*\n?([\s\S]*?)```\s*$/i, '$1').trim()
    return code ? `CODE\n${code}` : '无法识别'
  }
  if (typedAnswer?.[1].toUpperCase() === 'CHOICE') {
    return formatChoiceAnswer(typedAnswer[2])
  }

  const fencedCode = withoutReasoning.match(/```(?:\w+)?\s*\n?([\s\S]*?)```/)
  const taggedCode = withoutReasoning.match(/^\s*CODE(?:\s*:\s*\w+)?\s*\n([\s\S]*)$/i)
  const code = (fencedCode?.[1] || taggedCode?.[1])?.trim()
  if (code) return `CODE\n${code}`

  return formatChoiceAnswer(withoutReasoning)
}

function formatChoiceAnswer(input: string): string {
  const text = input
    .replace(/```[^\n]*\n?/g, '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*[-*#>]+\s*/, '')
        .replace(/[*_`]/g, '')
        .trim()
    )
    .filter(Boolean)
    .join(' ')
    .replace(/[。；;]\s*(?:因为|解析|分析|原因|理由|思路|解释|步骤)[\s\S]*$/i, '')
    .replace(/([A-H])\s*[,，、]\s*(?=[A-H])/gi, '$1')

  const numberedAnswers = [
    ...text.matchAll(
      /(?:第\s*)?(\d+)\s*(?:题)?\s*[.、:：-]?\s*(?:(?:正确)?答案(?:是|为)?\s*[:：]?\s*)?(?:选项\s*)?([A-H]{1,8})(?=[^A-Za-z]|$)/gi
    )
  ]
  if (numberedAnswers.length) {
    return numberedAnswers
      .slice(0, 20)
      .map((match) => `${match[1]}.${match[2].toUpperCase()}`)
      .join(' ')
  }

  const candidate = text.replace(
    /^(?:(?:最终)?(?:正确)?答案(?:是|为)?|(?:应该)?选择|选项)\s*[:：]?\s*/i,
    ''
  )
  const separatedAnswer = candidate.match(
    /^([A-H](?:\s*[,，、/+\s]\s*[A-H])+)(?=[^A-Za-z]|$)/i
  )?.[1]
  const answer =
    separatedAnswer?.replace(/[^A-H]/gi, '') ||
    candidate.match(/^([A-H]{1,8})(?=[^A-Za-z]|$)/i)?.[1]

  return answer?.toUpperCase() || '无法识别'
}
