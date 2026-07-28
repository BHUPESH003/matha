import { describe, it, expect } from 'vitest'
import {
  matchAll,
  pathPairScore,
  type BrainData,
  type MatchContext,
} from '../../src/retrieve/match.js'
import type { StabilityRecord } from '../../src/codemap/index.js'
import type { Confidence } from '../../src/core/schema.js'

const NOW = Date.parse('2026-07-01T00:00:00Z')

function ctx(overrides: Partial<MatchContext> = {}): MatchContext {
  return { scope: '', intent: '', filepaths: [], now: NOW, ...overrides }
}

function brain(overrides: Partial<BrainData> = {}): BrainData {
  return { dangerZones: [], contracts: [], stability: [], decisions: [], coChanges: [], ...overrides }
}

function zone(component: string, description = 'a specific danger pattern', id = 'z1') {
  return { id, component, pattern: description, description }
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

function decision(
  component: string,
  id = 'd1',
  timestamp = '2026-06-01T00:00:00Z',
  confidence: Confidence = 'confirmed',
) {
  return {
    id, timestamp, component,
    previous_assumption: 'assumed X', correction: 'actually Y',
    trigger: 't', confidence, status: 'active' as const,
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

describe('scoring pipeline — structural (S)', () => {
  it('zone on a directory matches files inside it as CRITICAL (0.1.x under-fire fixed)', () => {
    const results = matchAll(
      ctx({ scope: 'src/payments/retry.ts', intent: 'update retry' }),
      brain({ dangerZones: [zone('src/payments/')] }),
    )
    expect(results).toHaveLength(1)
    expect(results[0].severity).toBe('critical')
    expect(results[0].recordId).toBe('z1')
  })

  it('empty component NEVER matches (0.1.x over-fire fixed)', () => {
    const results = matchAll(
      ctx({ scope: 'src/anything.ts', intent: 'do anything at all' }),
      brain({ dangerZones: [{ ...zone(''), description: '' }, { ...zone('   ', '', 'z2'), description: '' }] }),
    )
    expect(results).toHaveLength(0)
  })

  it('unrelated zone does not match', () => {
    const results = matchAll(
      ctx({ scope: 'src/ui/button.tsx', intent: 'adjust styling' }),
      brain({ dangerZones: [zone('src/payments/', 'ledger corruption')] }),
    )
    expect(results).toHaveLength(0)
  })

  it('retired zones are skipped', () => {
    const z = { ...zone('src/payments/'), status: 'retired' as const }
    const results = matchAll(
      ctx({ scope: 'src/payments/retry.ts', intent: 'x' }),
      brain({ dangerZones: [z] }),
    )
    expect(results).toHaveLength(0)
  })

  it('co-change expansion links records across directories, capped below CRITICAL', () => {
    const data = brain({
      dangerZones: [zone('src/payments/retry.ts')],
      coChanges: [{ fileA: 'src/payments/retry.ts', fileB: 'src/jobs/reconcile.ts', coChangeCount: 8 }],
    })
    const results = matchAll(ctx({ scope: 'src/jobs/reconcile.ts', intent: 'reconcile payments' }), data)
    expect(results).toHaveLength(1)
    expect(results[0].severity).toBe('warning') // S capped at 0.5 — never critical

    const withoutGraph = matchAll(
      ctx({ scope: 'src/jobs/reconcile.ts', intent: 'reconcile payments' }),
      brain({ dangerZones: [zone('src/payments/retry.ts')] }),
    )
    expect(withoutGraph).toHaveLength(0)
  })
})

describe('scoring pipeline — lexical (L)', () => {
  it('free-text component matches on intent wording, even in a tiny brain', () => {
    const results = matchAll(
      ctx({ scope: 'src/x.ts', intent: 'refactor the payment reconciliation flow' }),
      brain({ dangerZones: [zone('payment reconciliation')] }),
    )
    expect(results).toHaveLength(1)
  })

  it('a lexical-only match is NEVER critical', () => {
    const results = matchAll(
      ctx({ scope: 'src/api/limits.ts', intent: 'tune the rate limiter thresholds' }),
      brain({
        dangerZones: [zone('rate limiter', 'the rate limiter counts per pod, limits multiply by pod count')],
      }),
    )
    expect(results).toHaveLength(1)
    expect(results[0].severity).toBe('warning')
  })
})

describe('scoring pipeline — confidence (C) and recency (R)', () => {
  it('confirmed outranks uncertain on the same path', () => {
    const data = brain({
      decisions: [
        decision('src/api/a.ts', 'd-uncertain', '2026-06-01T00:00:00Z', 'uncertain'),
        decision('src/api/a.ts', 'd-confirmed', '2026-06-01T00:00:00Z', 'confirmed'),
      ],
    })
    const results = matchAll(ctx({ scope: 'src/api/a.ts', intent: 'change api' }), data)
    expect(results[0].recordId).toBe('d-confirmed')
  })

  it('newer decisions outrank older ones; all active matches survive (no arbitrary cap)', () => {
    const decisions = [
      decision('src/api/a.ts', 'd1', '2026-01-01T00:00:00Z'),
      decision('src/api/b.ts', 'd2', '2026-02-01T00:00:00Z'),
      decision('src/api/c.ts', 'd3', '2026-03-01T00:00:00Z'),
      decision('src/api/d.ts', 'd4', '2026-04-01T00:00:00Z'),
    ]
    const results = matchAll(ctx({ scope: 'src/api' }), brain({ decisions }))
    expect(results).toHaveLength(4)
    expect(results[0].recordId).toBe('d4') // newest first
  })

  it('a years-old decision still surfaces on an exact path hit (decay is floored)', () => {
    const results = matchAll(
      ctx({ scope: 'src/billing/invoice.ts', intent: 'rounding' }),
      brain({ decisions: [decision('src/billing/invoice.ts', 'd-old', '2023-01-01T00:00:00Z')] }),
    )
    expect(results).toHaveLength(1)
  })

  it('superseded decisions are excluded', () => {
    const d = { ...decision('src/api/a.ts'), status: 'superseded' as const }
    expect(matchAll(ctx({ scope: 'src/api/a.ts' }), brain({ decisions: [d] }))).toHaveLength(0)
  })
})

describe('possiblyStale (work done outside matha)', () => {
  it('a decision whose file changed after it was recorded is flagged and demoted', () => {
    const data = brain({
      decisions: [
        decision('src/api/a.ts', 'd-stale', '2026-05-01T00:00:00Z'),
        decision('src/api/b.ts', 'd-fresh', '2026-05-01T00:00:00Z'),
      ],
      fileLastChanged: {
        'src/api/a.ts': '2026-06-15T00:00:00Z', // changed 6 weeks after recording
        'src/api/b.ts': '2026-04-01T00:00:00Z', // unchanged since
      },
    })
    const results = matchAll(ctx({ scope: 'src/api' }), data)
    const stale = results.find((r) => r.recordId === 'd-stale')!
    const fresh = results.find((r) => r.recordId === 'd-fresh')!
    expect(stale.possiblyStale).toBe(true)
    expect(fresh.possiblyStale).toBeUndefined()
    expect(stale.score).toBeLessThan(fresh.score) // demoted, still surfaced
  })

  it('a change within the grace window does not flag the record that captured it', () => {
    const data = brain({
      decisions: [decision('src/api/a.ts', 'd1', '2026-05-01T00:00:00Z')],
      fileLastChanged: { 'src/api/a.ts': '2026-05-02T00:00:00Z' }, // next day
    })
    const results = matchAll(ctx({ scope: 'src/api/a.ts' }), data)
    expect(results[0].possiblyStale).toBeUndefined()
  })

  it('a dir-scoped decision is flagged when a file under the dir changes', () => {
    const data = brain({
      decisions: [decision('src/payments/', 'd-dir', '2026-05-01T00:00:00Z')],
      fileLastChanged: { 'src/payments/retry.ts': '2026-06-20T00:00:00Z' },
    })
    const results = matchAll(ctx({ scope: 'src/payments/' }), data)
    expect(results[0].possiblyStale).toBe(true)
  })

  it('no codemap data → no flags, no crash', () => {
    const data = brain({ decisions: [decision('src/api/a.ts')] })
    const results = matchAll(ctx({ scope: 'src/api/a.ts' }), data)
    expect(results).toHaveLength(1)
    expect(results[0].possiblyStale).toBeUndefined()
  })
})

describe('frozen files', () => {
  it('frozen file matched by exact path or containing dir', () => {
    const records = [stabilityRecord('src/core/ledger.ts')]
    expect(
      matchAll(ctx({ scope: '', filepaths: ['src/core/ledger.ts'] }), brain({ stability: records })),
    ).toHaveLength(1)
    expect(matchAll(ctx({ scope: 'src/core' }), brain({ stability: records }))).toHaveLength(1)
  })

  it('sibling proximity is NOT enough for a frozen critical', () => {
    const records = [stabilityRecord('src/core/ledger.ts')]
    expect(
      matchAll(ctx({ filepaths: ['src/core/other.ts'] }), brain({ stability: records })),
    ).toHaveLength(0)
  })

  it('non-frozen records never fire', () => {
    const records = [stabilityRecord('src/core/ledger.ts', 'stable')]
    expect(
      matchAll(ctx({ filepaths: ['src/core/ledger.ts'] }), brain({ stability: records })),
    ).toHaveLength(0)
  })

  it('frozenFileSeverity config downgrades the match without hiding it', () => {
    // Field finding: on a repo where a large share of files classify frozen,
    // every CRITICAL match makes `matha check --strict` unusable. Default
    // stays 'critical' (unchanged eval behavior); config.json can opt down.
    const records = [stabilityRecord('src/core/ledger.ts')]
    const results = matchAll(
      ctx({ filepaths: ['src/core/ledger.ts'] }),
      brain({ stability: records, frozenFileSeverity: 'warning' }),
    )
    expect(results).toHaveLength(1)
    expect(results[0].severity).toBe('warning')
  })
})

describe('matchAll combined', () => {
  it('sorts by severity then score, deduplicates by type+component', () => {
    const data = brain({
      dangerZones: [zone('src/payments/'), zone('src/payments/', 'a specific danger pattern', 'z2')],
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
    // frozen (S=1.0) ranks above the dir-level danger zone (S=0.8)
    expect(results[0].matchType).toBe('frozen_file')
  })

  it('every result carries a stable recordId and a score', () => {
    const data = brain({
      dangerZones: [zone('src/payments/')],
      contracts: [{
        component: 'src/payments/retry.ts', version: 1, last_updated: '2026-06-01T00:00:00Z',
        assertions: [{ id: 'a1', description: 'stays idempotent', type: 'invariant' as const, status: 'active' as const, violation_count: 0, last_violated: null }],
      }],
    })
    const results = matchAll(ctx({ scope: 'src/payments/retry.ts', intent: 'retry' }), data)
    const ids = results.map((r) => r.recordId)
    expect(ids).toContain('z1')
    expect(ids).toContain('contract:src/payments/retry.ts')
    for (const r of results) expect(r.score).toBeGreaterThan(0)
  })

  it('returns empty for empty brain', () => {
    expect(matchAll(ctx({ scope: 'src/x.ts', intent: 'y' }), brain())).toEqual([])
  })
})
