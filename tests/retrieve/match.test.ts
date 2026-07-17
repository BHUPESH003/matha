import { describe, it, expect } from 'vitest'
import {
  matchAll,
  matchDangerZones,
  matchFrozenFiles,
  matchDecisionPatterns,
  pathPairScore,
  type BrainData,
  type MatchContext,
} from '../../src/retrieve/match.js'
import type { StabilityRecord } from '../../src/codemap/index.js'

function ctx(overrides: Partial<MatchContext> = {}): MatchContext {
  return { scope: '', intent: '', filepaths: [], ...overrides }
}

function emptyBrain(overrides: Partial<BrainData> = {}): BrainData {
  return { dangerZones: [], contracts: [], stability: [], decisions: [], ...overrides }
}

function zone(component: string, description = 'a specific danger pattern') {
  return { id: 'z1', component, pattern: description, description }
}

function stabilityRecord(filepath: string, stability = 'frozen'): StabilityRecord {
  return {
    filepath,
    stability: stability as StabilityRecord['stability'],
    confidence: 'high',
    reason: 'low churn',
    classificationSource: 'derived',
    changeCount: 1,
    coChangeCount: 3,
    ageInDays: 100,
    daysSinceLastChange: 50,
  }
}

function decision(component: string, id = 'd1', timestamp = '2026-01-01T00:00:00Z') {
  return {
    id, timestamp, component,
    previous_assumption: 'assumed X', correction: 'actually Y',
    trigger: 't', confidence: 'confirmed' as const, status: 'active' as const,
    supersedes: null, session_id: id,
  }
}

describe('pathPairScore (hierarchical path matching)', () => {
  it('exact match → 1.0', () => {
    expect(pathPairScore('src/auth.ts', 'src/auth.ts')).toBe(1.0)
  })

  it('normalises slashes, case, leading ./', () => {
    expect(pathPairScore('src\\Auth.ts', './src/auth.ts')).toBe(1.0)
  })

  it('record dir is ancestor of query file → 0.8', () => {
    expect(pathPairScore('src/payments', 'src/payments/retry.ts')).toBe(0.8)
    expect(pathPairScore('src/payments/', 'src/payments/deep/nested.ts')).toBe(0.8)
  })

  it('query dir is ancestor of record file → 0.8', () => {
    expect(pathPairScore('src/payments/retry.ts', 'src/payments')).toBe(0.8)
  })

  it('siblings in same directory → 0.4', () => {
    expect(pathPairScore('src/payments/retry.ts', 'src/payments/refund.ts')).toBe(0.4)
  })

  it('unrelated paths → 0; prefix-of-name is NOT a match', () => {
    expect(pathPairScore('src/auth.ts', 'docs/readme.md')).toBe(0)
    // 0.1.x substring matching would have matched these:
    expect(pathPairScore('src/pay', 'src/payments/retry.ts')).toBe(0)
  })

  it('empty paths → 0', () => {
    expect(pathPairScore('', 'src/auth.ts')).toBe(0)
  })
})

describe('matchDangerZones', () => {
  it('zone on a directory matches files inside it (0.1.x under-fire fixed)', () => {
    const results = matchDangerZones(
      ctx({ scope: 'src/payments/retry.ts', intent: 'update retry' }),
      [zone('src/payments/')],
    )
    expect(results).toHaveLength(1)
    expect(results[0].severity).toBe('critical')
  })

  it('empty component NEVER matches (0.1.x over-fire fixed)', () => {
    const results = matchDangerZones(
      ctx({ scope: 'src/anything.ts', intent: 'do anything at all' }),
      [zone(''), zone('   ')],
    )
    expect(results).toHaveLength(0)
  })

  it('free-text component matches on whole-word keyword overlap with intent', () => {
    const results = matchDangerZones(
      ctx({ scope: 'src/x.ts', intent: 'refactor the payment reconciliation flow' }),
      [zone('payment reconciliation')],
    )
    expect(results).toHaveLength(1)
  })

  it('description keywords match against intent', () => {
    const results = matchDangerZones(
      ctx({ scope: 'src/y.ts', intent: 'changing the webhook handler' }),
      [zone('src/other.ts', 'webhook retries duplicate on failure')],
    )
    expect(results).toHaveLength(1)
  })

  it('unrelated zone does not match', () => {
    const results = matchDangerZones(
      ctx({ scope: 'src/ui/button.tsx', intent: 'adjust styling' }),
      [zone('src/payments/', 'ledger corruption')],
    )
    expect(results).toHaveLength(0)
  })

  it('retired zones are skipped', () => {
    const z = { ...zone('src/payments/'), status: 'retired' as const }
    const results = matchDangerZones(
      ctx({ scope: 'src/payments/retry.ts', intent: 'x' }),
      [z],
    )
    expect(results).toHaveLength(0)
  })
})

describe('matchFrozenFiles', () => {
  it('frozen file matched by exact path or containing dir', () => {
    const records = [stabilityRecord('src/core/ledger.ts')]
    expect(
      matchFrozenFiles(ctx({ scope: '', filepaths: ['src/core/ledger.ts'] }), records),
    ).toHaveLength(1)
    expect(
      matchFrozenFiles(ctx({ scope: 'src/core' }), records),
    ).toHaveLength(1)
  })

  it('sibling proximity is NOT enough for a frozen critical', () => {
    const records = [stabilityRecord('src/core/ledger.ts')]
    expect(
      matchFrozenFiles(ctx({ filepaths: ['src/core/other.ts'] }), records),
    ).toHaveLength(0)
  })

  it('non-frozen records never fire', () => {
    const records = [stabilityRecord('src/core/ledger.ts', 'stable')]
    expect(
      matchFrozenFiles(ctx({ filepaths: ['src/core/ledger.ts'] }), records),
    ).toHaveLength(0)
  })
})

describe('matchDecisionPatterns', () => {
  it('caps at 3 most recent active decisions', () => {
    const decisions = [
      decision('src/api/a.ts', 'd1', '2026-01-01T00:00:00Z'),
      decision('src/api/b.ts', 'd2', '2026-02-01T00:00:00Z'),
      decision('src/api/c.ts', 'd3', '2026-03-01T00:00:00Z'),
      decision('src/api/d.ts', 'd4', '2026-04-01T00:00:00Z'),
    ]
    const results = matchDecisionPatterns(ctx({ scope: 'src/api' }), decisions)
    expect(results).toHaveLength(3)
    expect(results[0].component).toBe('src/api/d.ts') // newest first
  })

  it('superseded decisions are excluded', () => {
    const d = { ...decision('src/api/a.ts'), status: 'superseded' as const }
    expect(matchDecisionPatterns(ctx({ scope: 'src/api/a.ts' }), [d])).toHaveLength(0)
  })
})

describe('matchAll', () => {
  it('sorts by severity then score, deduplicates by type+component', () => {
    const data = emptyBrain({
      dangerZones: [zone('src/payments/'), zone('src/payments/')],
      decisions: [decision('src/payments/retry.ts')],
      stability: [stabilityRecord('src/payments/retry.ts')],
    })
    const results = matchAll(
      ctx({ scope: 'src/payments/retry.ts', intent: 'change retry', filepaths: ['src/payments/retry.ts'] }),
      data,
    )
    // deduped: one danger zone, one frozen, one decision
    expect(results).toHaveLength(3)
    expect(results[0].severity).toBe('critical')
    expect(results[results.length - 1].severity).toBe('warning')
    // frozen (score 1.0) ranks above the dir-level danger zone (0.8)
    expect(results[0].matchType).toBe('frozen_file')
  })

  it('returns empty for empty brain', () => {
    expect(matchAll(ctx({ scope: 'src/x.ts', intent: 'y' }), emptyBrain())).toEqual([])
  })
})
