import { describe, it, expect } from 'vitest'
import { isNearDuplicate } from '../../src/core/schema.js'

/**
 * Near-duplicate detection calibration. The exact paraphrase case below is
 * from a real field audit (customer-portal repo): a DGH-validation decision
 * reworded by an LLM missed Jaccard (0.22, below the 0.7 bar) but the same
 * pair scores 0.54 on overlap coefficient — the second signal added to catch
 * asymmetric-length paraphrases without embeddings.
 */
describe('isNearDuplicate', () => {
  const original =
    'gateway retries are idempotent gateway double-charges on retry; every retry must reuse the idempotency key'

  it('catches a longer LLM paraphrase that Jaccard alone would miss', () => {
    const paraphrase =
      'It was previously assumed that the payment gateway would retry idempotently, but in ' +
      'practice the gateway can double-charge a customer unless every retry attempt sends the ' +
      'exact same idempotency key as the original request'
    expect(isNearDuplicate(original, paraphrase)).toBe(true)
  })

  it('catches near-verbatim rewording (the original Jaccard case)', () => {
    const echo = 'gateway retries are idempotent gateway double-charges on retry without idempotency key'
    expect(isNearDuplicate(original, echo)).toBe(true)
  })

  it('does not flag a genuinely different correction in the same topic area', () => {
    const different =
      'assumed retry backoff was linear it is actually exponential with jitter, capped at five ' +
      'attempts before the job moves to a dead-letter queue for manual review'
    expect(isNearDuplicate(original, different)).toBe(false)
  })

  it('does not flag an unrelated correction', () => {
    const unrelated =
      'assumed the webhook handler acknowledges within one second it must ack within five ' +
      'seconds or the provider begins duplicating delivery of the same event'
    expect(isNearDuplicate(original, unrelated)).toBe(false)
  })

  it('short texts need a minimum shared-word count, not just a high ratio', () => {
    // 2 shared words out of 3 each = 0.5 Jaccard, 0.66 overlap — would fire
    // without the MIN_SHARED_WORDS guard, despite being nearly meaningless.
    expect(isNearDuplicate('fix the bug', 'fix that bug')).toBe(false)
  })

  it('empty or whitespace-only text never matches', () => {
    expect(isNearDuplicate('', original)).toBe(false)
    expect(isNearDuplicate('   ', original)).toBe(false)
  })
})
