import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Engine } from '../../src/core/engine.js'
import { assembleBrief, BRIEF_TOKEN_BUDGET } from '../../src/retrieve/brief.js'

describe('brief token budget', () => {
  let tmpDir: string
  let mathaDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-brief-'))
    mathaDir = path.join(tmpDir, '.matha')
    await fs.mkdir(path.join(mathaDir, 'hippocampus', 'decisions'), { recursive: true })
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'intent.json'),
      JSON.stringify({ why: 'test project' }),
    )
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'rules.json'),
      JSON.stringify({ rules: ['rule one'] }),
    )
    // 40 danger zones on distinct components, all matching the scope —
    // far more than any budget holds. z0 is an ancestor-dir hit (critical);
    // the rest are siblings (warnings).
    const zones = Array.from({ length: 40 }, (_, i) => ({
      id: `z${i}`,
      component: i === 0 ? 'src/payments/' : `src/payments/file${i}.ts`,
      pattern: `pattern number ${i}`,
      description: `a fairly long danger description used to consume budget, variant number ${i}, with extra words about double charging customers on retry`,
    }))
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'danger-zones.json'),
      JSON.stringify({ zones }),
    )
    // decisions: one that also matches the scope, to prove dedup
    const d = {
      id: 'd-dup', timestamp: '2026-06-01T00:00:00Z', component: 'src/payments/retry.ts',
      previous_assumption: 'assumed something', correction: 'learned otherwise',
      trigger: 't', confidence: 'confirmed', status: 'active', supersedes: null, session_id: 'd-dup',
    }
    await fs.writeFile(path.join(mathaDir, 'hippocampus', 'decisions', 'd-dup.json'), JSON.stringify(d))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('stays within the default budget and flags truncation', async () => {
    const brief = await assembleBrief(new Engine(mathaDir), {
      scope: 'src/payments/retry.ts',
      intent: 'change retry',
    })
    expect(brief.tokenEstimate).toBeLessThanOrEqual(BRIEF_TOKEN_BUDGET)
    expect(brief.truncated).toBe(true)
    expect(brief.matchResults.length).toBeGreaterThan(0)
    expect(brief.matchResults.length).toBeLessThan(40)
  })

  it('a tighter budget yields fewer matches, never a blown budget', async () => {
    const brief = await assembleBrief(new Engine(mathaDir), {
      scope: 'src/payments/retry.ts',
      intent: 'change retry',
      budget: 400,
    })
    expect(brief.tokenEstimate).toBeLessThanOrEqual(400)
    expect(brief.truncated).toBe(true)
    // static section survives even under a tight budget
    expect(brief.why).toBe('test project')
    expect(brief.rules).toEqual(['rule one'])
  })

  it('hasCritical reflects ALL matches, including ones the budget truncated', async () => {
    const brief = await assembleBrief(new Engine(mathaDir), {
      scope: 'src/payments/retry.ts',
      intent: 'change retry',
      budget: 100, // too tight for any match to fit
    })
    expect(brief.matchResults.length).toBe(0)
    expect(brief.hasCritical).toBe(true)
  })

  it('a decision shown in recentDecisions is not repeated as a match', async () => {
    const brief = await assembleBrief(new Engine(mathaDir), {
      scope: 'src/payments/retry.ts',
      intent: 'change retry',
    })
    expect(brief.recentDecisions.map((d) => d.id)).toContain('d-dup')
    const matchedDecisionIds = brief.matchResults
      .filter((m) => m.matchType === 'decision_pattern')
      .map((m) => m.recordId)
    expect(matchedDecisionIds).not.toContain('d-dup')
  })
})
