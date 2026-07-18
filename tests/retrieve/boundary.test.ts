import { describe, it, expect } from 'vitest'
import { matchAll, type BrainData } from '../../src/retrieve/match.js'

const NOW = Date.parse('2026-07-01T00:00:00Z')

function brain(overrides: Partial<BrainData> = {}): BrainData {
  return {
    dangerZones: [], contracts: [], stability: [], decisions: [], coChanges: [],
    boundaries: [
      {
        id: 'b-schema', component: 'db/schema/',
        rule: 'Schema changes require DBA sign-off',
        declaredBy: 'alice', created: '2020-01-01T00:00:00Z',
      },
    ],
    ...overrides,
  }
}

describe('declared boundaries in the matcher (§5.5)', () => {
  it('fires CRITICAL on a direct path hit, at full confirmed weight, with no decay', () => {
    // created six years before NOW — a decision this old would be at the decay floor
    const results = matchAll(
      { scope: 'db/schema/users.sql', intent: 'add a column', now: NOW },
      brain(),
    )
    expect(results).toHaveLength(1)
    expect(results[0].matchType).toBe('boundary')
    expect(results[0].severity).toBe('critical')
    expect(results[0].recordId).toBe('b-schema')
    expect(results[0].description).toContain('DBA sign-off')
    // S=0.8 (ancestor) × L≥0.5 × C=1.0 × R=1 — no six-year decay applied
    expect(results[0].score).toBeGreaterThanOrEqual(0.4)
  })

  it('never fires on siblings or lexical-only matches — path hit or nothing', () => {
    const sibling = matchAll(
      { scope: 'db/seeds/users.sql', intent: 'seed data', now: NOW },
      brain(),
    )
    expect(sibling.find((r) => r.matchType === 'boundary')).toBeUndefined()

    const lexical = matchAll(
      { scope: 'src/api/users.ts', intent: 'schema changes need DBA sign-off?', now: NOW },
      brain(),
    )
    expect(lexical.find((r) => r.matchType === 'boundary')).toBeUndefined()
  })

  it('retired boundaries do not fire', () => {
    const results = matchAll(
      { scope: 'db/schema/users.sql', intent: 'add a column', now: NOW },
      brain({
        boundaries: [
          {
            id: 'b-schema', component: 'db/schema/', rule: 'Schema changes require DBA sign-off',
            declaredBy: 'alice', created: '2020-01-01T00:00:00Z', status: 'retired',
          },
        ],
      }),
    )
    expect(results).toHaveLength(0)
  })
})

describe('last_confirmed resets the possiblyStale clock', () => {
  const decision = {
    id: 'd1', timestamp: '2026-01-01T00:00:00Z', component: 'src/pay.ts',
    previous_assumption: 'assumed retries idempotent', correction: 'they double-charge',
    trigger: 't', confidence: 'confirmed' as const, status: 'active' as const,
    supersedes: null, session_id: 's',
  }
  // file changed in June — after the January record
  const fileLastChanged = { 'src/pay.ts': '2026-06-01T00:00:00Z' }

  it('without last_confirmed the record is possiblyStale', () => {
    const results = matchAll(
      { scope: 'src/pay.ts', intent: 'touch payments', now: NOW },
      brain({ boundaries: [], decisions: [decision], fileLastChanged }),
    )
    expect(results[0].possiblyStale).toBe(true)
  })

  it('a review-confirm after the change clears the flag', () => {
    const results = matchAll(
      { scope: 'src/pay.ts', intent: 'touch payments', now: NOW },
      brain({
        boundaries: [],
        decisions: [{ ...decision, last_confirmed: '2026-06-15T00:00:00Z' }],
        fileLastChanged,
      }),
    )
    expect(results[0].possiblyStale).toBeUndefined()
  })
})
