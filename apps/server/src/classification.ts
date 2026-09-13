import type { Analysis, AuthorRef, Slot } from '@two-sides/contract'
import type { AnswerClassification, CommonTopic, OrientedJudgment, RawAnswer } from './agents/types'
import { divergenceFromCounts } from './metrics'

/** Local accounting: a missing/invalid response is a failure, never a neutral vote. */
export function assembleClassifications(
  topics: CommonTopic[],
  answers: RawAnswer[],
  results: Array<AnswerClassification | null>,
): { judgments: OrientedJudgment[]; classification: NonNullable<Analysis['classification']> } {
  const classification = { matchedAnswerCount: 0, unmatchedAnswerCount: 0, failedAnswerCount: 0 }
  const byTopic = new Map(topics.map((topic) => [topic.id, [] as Array<{ answer: RawAnswer; slot: Slot; quote: string; reason: string }>]))
  for (const [index, answer] of answers.entries()) {
    const result = results[index]
    if (!result || result.answerId !== answer.answerId) { classification.failedAnswerCount++; continue }
    if (result.placements.length === 0) { classification.unmatchedAnswerCount++; continue }
    const seen = new Set<string>()
    let matched = false
    for (const placement of result.placements) {
      const entries = byTopic.get(placement.topicId)
      const quote = placement.quote.trim()
      const reason = placement.reason.trim()
      if (!entries || seen.has(placement.topicId) || !quote || !reason ||
        !answer.content.includes(quote) || ![1, 2, 3, 4, 5].includes(placement.slot)) continue
      seen.add(placement.topicId)
      entries.push({ answer, slot: placement.slot, quote, reason })
      matched = true
    }
    if (matched) classification.matchedAnswerCount++
    else classification.failedAnswerCount++
  }

  const judgments = topics.flatMap((topic): OrientedJudgment[] => {
    // Same author contributes once to a topic; choose the most voted answer.
    const authors = new Map<string, { slot: Slot; ref: AuthorRef; answerId: string }>()
    for (const { answer, slot, quote, reason } of byTopic.get(topic.id) ?? []) {
      const previous = authors.get(answer.authorName)
      if (previous && previous.ref.voteUp >= answer.voteUp) continue
      authors.set(answer.authorName, { slot, answerId: answer.answerId, ref: {
        name: answer.authorName, badge: answer.authorBadge, authority: answer.authority,
        quote, reason, url: answer.url, voteUp: answer.voteUp,
      } })
    }
    if (authors.size === 0) return []
    const counts = [0, 0, 0, 0, 0]
    const authorityDistribution = [0, 0, 0, 0, 0]
    const distribution: OrientedJudgment['distribution'] = []
    for (const slot of [1, 2, 3, 4, 5] as const) {
      const refs = [...authors.values()].filter((value) => value.slot === slot).map((value) => value.ref)
      if (!refs.length) continue
      counts[slot - 1] = refs.length
      authorityDistribution[slot - 1] = refs.filter((ref) => ref.authority >= 3).length
      distribution.push({ slot, authors: refs })
    }
    return [{
      id: topic.id, text: topic.text, semanticAxis: topic.semanticAxis,
      participantCount: authors.size, divergence: divergenceFromCounts(counts),
      orientStatus: classification.failedAnswerCount ? 'partial' : 'done',
      scaleDirection: 'left_to_right', distribution, authorityDistribution,
      relatedAnswerIds: [...authors.values()].map((value) => value.answerId),
    }]
  })
  return { judgments, classification }
}
