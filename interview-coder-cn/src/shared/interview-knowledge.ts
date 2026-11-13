/** A Markdown document that can be used as factual interview context. */
export interface InterviewKnowledgeDocument {
  id: string
  name: string
  content: string
  /** Disabled documents remain uploaded but are omitted from AI requests. */
  enabled: boolean
}

/** Keep the local knowledge base useful without allowing an accidental upload storm. */
export const MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS = 5
export const MAX_INTERVIEW_KNOWLEDGE_DOCUMENT_CHARS = 50000
export const MAX_INTERVIEW_KNOWLEDGE_TOTAL_CHARS = 120000
export const MAX_INTERVIEW_KNOWLEDGE_PROMPT_CHARS = 60000

export function normalizeInterviewKnowledgeDocuments(
  documents: unknown
): InterviewKnowledgeDocument[] {
  if (!Array.isArray(documents)) return []

  const normalized: InterviewKnowledgeDocument[] = []
  let totalChars = 0
  for (const item of documents) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<InterviewKnowledgeDocument>
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
    const content = typeof candidate.content === 'string' ? candidate.content.trim() : ''
    if (!name || !content || normalized.length >= MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS) continue

    const remaining = MAX_INTERVIEW_KNOWLEDGE_TOTAL_CHARS - totalChars
    if (remaining <= 0) break
    const clipped = content.slice(0, Math.min(MAX_INTERVIEW_KNOWLEDGE_DOCUMENT_CHARS, remaining))
    if (!clipped) continue

    normalized.push({
      id:
        typeof candidate.id === 'string' && candidate.id.trim()
          ? candidate.id
          : `knowledge-${normalized.length}-${name}`,
      name: name.slice(0, 160),
      content: clipped,
      enabled: candidate.enabled !== false
    })
    totalChars += clipped.length
  }
  return normalized
}
