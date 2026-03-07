import { describe, it, expect } from 'vitest'
import { classifyStability } from '../../src/analysis/stability-classifier.js'
import type { GitAnalysisResult, FileChangeRecord } from '../../src/analysis/git-analyser.js'

// ──────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString()
}

function makeFile(overrides: Partial<FileChangeRecord> & { filepath: string }): FileChangeRecord {
  return {
    changeCount: 1,
    lastChanged: daysAgo(1),
    firstSeen: daysAgo(60),
    authors: ['dev'],
    coChangedWith: [],
    ...overrides,
  }
}

function makeAnalysis(files: FileChangeRecord[]): GitAnalysisResult {
  return {
    analysedAt: new Date().toISOString(),
    commitCount: files.reduce((s, f) => s + f.changeCount, 0),
    fileCount: files.length,
    files,
    coChanges: [],
    oldestCommit: files.length ? files[0].firstSeen : '',
    newestCommit: files.length ? files[0].lastChanged : '',
  }
}

describe('stability-classifier', () => {
  // ──────────────────────────────────────────────────────────────
  // EMPTY ANALYSIS
  // ──────────────────────────────────────────────────────────────

  it('empty analysis → empty result, no throw', () => {
    const analysis = makeAnalysis([])
    const result = classifyStability(analysis)

    expect(result.classifications).toEqual([])
    expect(result.fileCount).toBe(0)
    expect(result.summary.frozen).toBe(0)
    expect(result.summary.stable).toBe(0)
    expect(result.summary.volatile).toBe(0)
    expect(result.summary.disposable).toBe(0)
    expect(result.classifiedAt).toBeTruthy()
  })

  // ──────────────────────────────────────────────────────────────
  // FROZEN: low churn + high connectivity + age
  // ──────────────────────────────────────────────────────────────

  it('file with low churn + high connectivity + age → FROZEN', () => {
    // 3 changes over 120 days = 0.75 changes/month (well under default 2)
    // coChangedWith has 3 files → high connectivity
    // age 120 days >= 30 day minimum
    const file = makeFile({
      filepath: 'src/core/engine.ts',
      changeCount: 3,
      firstSeen: daysAgo(120),
      lastChanged: daysAgo(30),
      coChangedWith: ['src/types.ts', 'src/config.ts', 'src/utils.ts'],
    })

    const result = classifyStability(makeAnalysis([file]))
    const c = result.classifications[0]

    expect(c.stability).toBe('frozen')
    expect(c.reason).toContain('changes/month')
    expect(c.reason).toContain('co-changed')
  })

  // ──────────────────────────────────────────────────────────────
  // VOLATILE: high churn
  // ──────────────────────────────────────────────────────────────

  it('file with high churn → VOLATILE', () => {
    // 30 changes over 30 days = 30 changes/month (well above default 8)
    const file = makeFile({
      filepath: 'src/ui/dashboard.tsx',
      changeCount: 30,
      firstSeen: daysAgo(30),
      lastChanged: daysAgo(1),
    })

    const result = classifyStability(makeAnalysis([file]))
    const c = result.classifications[0]

    expect(c.stability).toBe('volatile')
    expect(c.reason).toContain('changes/month')
  })

  // ──────────────────────────────────────────────────────────────
  // DISPOSABLE: low churn + low connectivity + age
  // ──────────────────────────────────────────────────────────────

  it('file with low churn + low connectivity + age → DISPOSABLE', () => {
    // 1 change over 90 days = 0.33 changes/month
    // coChangedWith is empty → low connectivity (0 <= 1)
    // age 90 days >= 30
    const file = makeFile({
      filepath: 'scripts/old-migration.ts',
      changeCount: 1,
      firstSeen: daysAgo(90),
      lastChanged: daysAgo(90),
      coChangedWith: [],
    })

    const result = classifyStability(makeAnalysis([file]))
    const c = result.classifications[0]

    expect(c.stability).toBe('disposable')
    expect(c.reason).toContain('low connectivity')
  })

  // ──────────────────────────────────────────────────────────────
  // STABLE: everything else
  // ──────────────────────────────────────────────────────────────

  it('file with moderate churn → STABLE', () => {
    // 6 changes over 30 days = 6 changes/month (between 2 and 8)
    const file = makeFile({
      filepath: 'src/services/api.ts',
      changeCount: 6,
      firstSeen: daysAgo(30),
      lastChanged: daysAgo(1),
      coChangedWith: ['src/models.ts'],
    })

    const result = classifyStability(makeAnalysis([file]))
    const c = result.classifications[0]

    expect(c.stability).toBe('stable')
    expect(c.reason).toContain('changes/month')
  })

  // ──────────────────────────────────────────────────────────────
  // AGE GUARD — new file can't be FROZEN
  // ──────────────────────────────────────────────────────────────

  it('new file (< 30 days) with low churn + high connectivity → not FROZEN', () => {
    // 1 change over 10 days, high connectivity — doesn't meet age requirement
    const file = makeFile({
      filepath: 'src/new-module.ts',
      changeCount: 1,
      firstSeen: daysAgo(10),
      lastChanged: daysAgo(10),
      coChangedWith: ['a.ts', 'b.ts', 'c.ts'],
    })

    const result = classifyStability(makeAnalysis([file]))
    const c = result.classifications[0]

    expect(c.stability).not.toBe('frozen')
  })

  // ──────────────────────────────────────────────────────────────
  // AGE GUARD — new file can't be DISPOSABLE
  // ──────────────────────────────────────────────────────────────

  it('new file (< 30 days) with low churn + low connectivity → not DISPOSABLE', () => {
    const file = makeFile({
      filepath: 'src/brand-new.ts',
      changeCount: 1,
      firstSeen: daysAgo(5),
      lastChanged: daysAgo(5),
      coChangedWith: [],
    })

    const result = classifyStability(makeAnalysis([file]))
    const c = result.classifications[0]

    expect(c.stability).not.toBe('disposable')
    // Should fall through to STABLE as catch-all
    expect(c.stability).toBe('stable')
  })

  // ──────────────────────────────────────────────────────────────
  // CONFIDENCE: HIGH
  // ──────────────────────────────────────────────────────────────

  it('confidence HIGH: age >= 90 days and changeCount >= 5', () => {
    const file = makeFile({
      filepath: 'src/mature.ts',
      changeCount: 10,
      firstSeen: daysAgo(100),
      lastChanged: daysAgo(1),
    })

    const result = classifyStability(makeAnalysis([file]))
    expect(result.classifications[0].confidence).toBe('high')
  })

  // ──────────────────────────────────────────────────────────────
  // CONFIDENCE: MEDIUM
  // ──────────────────────────────────────────────────────────────

  it('confidence MEDIUM: age >= 30 days and changeCount >= 2', () => {
    const file = makeFile({
      filepath: 'src/mid-age.ts',
      changeCount: 3,
      firstSeen: daysAgo(45),
      lastChanged: daysAgo(1),
    })

    const result = classifyStability(makeAnalysis([file]))
    expect(result.classifications[0].confidence).toBe('medium')
  })

  // ──────────────────────────────────────────────────────────────
  // CONFIDENCE: LOW
  // ──────────────────────────────────────────────────────────────

  it('confidence LOW: very new file with 1 commit', () => {
    const file = makeFile({
      filepath: 'src/brand-new.ts',
      changeCount: 1,
      firstSeen: daysAgo(2),
      lastChanged: daysAgo(2),
    })

    const result = classifyStability(makeAnalysis([file]))
    expect(result.classifications[0].confidence).toBe('low')
  })

  // ──────────────────────────────────────────────────────────────
  // DIVISION BY ZERO GUARD
  // ──────────────────────────────────────────────────────────────

  it('changesPerMonth: ageInDays = 0 guarded correctly', () => {
    // File created and classified in the same instant
    const now = new Date().toISOString()
    const file = makeFile({
      filepath: 'src/just-created.ts',
      changeCount: 1,
      firstSeen: now,
      lastChanged: now,
    })
    const analysis = makeAnalysis([file])
    analysis.analysedAt = now

    // Should not throw
    const result = classifyStability(analysis)
    expect(result.classifications).toHaveLength(1)
    expect(result.classifications[0].ageInDays).toBeGreaterThanOrEqual(0)
  })

  // ──────────────────────────────────────────────────────────────
  // SUMMARY COUNTS
  // ──────────────────────────────────────────────────────────────

  it('summary counts match classifications array length', () => {
    const files = [
      // Frozen: low churn, high connectivity, old
      makeFile({
        filepath: 'core.ts',
        changeCount: 2,
        firstSeen: daysAgo(120),
        lastChanged: daysAgo(60),
        coChangedWith: ['a.ts', 'b.ts', 'c.ts'],
      }),
      // Volatile: high churn
      makeFile({
        filepath: 'hot.ts',
        changeCount: 30,
        firstSeen: daysAgo(30),
        lastChanged: daysAgo(1),
      }),
      // Disposable: low churn, low connectivity, old
      makeFile({
        filepath: 'old.ts',
        changeCount: 1,
        firstSeen: daysAgo(90),
        lastChanged: daysAgo(90),
        coChangedWith: [],
      }),
      // Stable: catch-all
      makeFile({
        filepath: 'mid.ts',
        changeCount: 5,
        firstSeen: daysAgo(30),
        lastChanged: daysAgo(1),
      }),
    ]

    const result = classifyStability(makeAnalysis(files))
    const { summary } = result

    expect(summary.frozen + summary.stable + summary.volatile + summary.disposable)
      .toBe(result.classifications.length)
    expect(result.fileCount).toBe(4)
  })

  // ──────────────────────────────────────────────────────────────
  // REASON STRINGS
  // ──────────────────────────────────────────────────────────────

  it('reason strings are non-empty for all classifications', () => {
    const files = [
      makeFile({ filepath: 'a.ts', changeCount: 1, coChangedWith: ['x.ts', 'y.ts', 'z.ts'] }),
      makeFile({ filepath: 'b.ts', changeCount: 30, firstSeen: daysAgo(30) }),
      makeFile({ filepath: 'c.ts', changeCount: 1, firstSeen: daysAgo(90), coChangedWith: [] }),
    ]

    const result = classifyStability(makeAnalysis(files))

    for (const c of result.classifications) {
      expect(c.reason).toBeTruthy()
      expect(c.reason.length).toBeGreaterThan(0)
    }
  })

  // ──────────────────────────────────────────────────────────────
  // CUSTOM THRESHOLDS
  // ──────────────────────────────────────────────────────────────

  it('custom frozenThreshold override changes classification', () => {
    // 4 changes over 60 days = 2 changes/month
    // With default threshold (2) → borderline, with coChangeCount >= 3 → frozen
    // With custom threshold (1) → not frozen (2 > 1)
    const file = makeFile({
      filepath: 'src/core.ts',
      changeCount: 4,
      firstSeen: daysAgo(60),
      lastChanged: daysAgo(1),
      coChangedWith: ['a.ts', 'b.ts', 'c.ts'],
    })

    const defaultResult = classifyStability(makeAnalysis([file]))
    const customResult = classifyStability(makeAnalysis([file]), { frozenThreshold: 1 })

    expect(defaultResult.classifications[0].stability).toBe('frozen')
    expect(customResult.classifications[0].stability).not.toBe('frozen')
  })

  // ──────────────────────────────────────────────────────────────
  // CLASSIFICATION SOURCE
  // ──────────────────────────────────────────────────────────────

  it('classificationSource is always "derived"', () => {
    const file = makeFile({ filepath: 'src/app.ts' })
    const result = classifyStability(makeAnalysis([file]))

    for (const c of result.classifications) {
      expect(c.classificationSource).toBe('derived')
    }
  })

  // ──────────────────────────────────────────────────────────────
  // DAYS SINCE LAST CHANGE
  // ──────────────────────────────────────────────────────────────

  it('daysSinceLastChange is calculated correctly', () => {
    const file = makeFile({
      filepath: 'src/old.ts',
      lastChanged: daysAgo(45),
    })

    const result = classifyStability(makeAnalysis([file]))
    const c = result.classifications[0]

    // Should be approximately 45 (allow ±1 for timing)
    expect(c.daysSinceLastChange).toBeGreaterThanOrEqual(44)
    expect(c.daysSinceLastChange).toBeLessThanOrEqual(46)
  })

  // ──────────────────────────────────────────────────────────────
  // CLASSIFICATION ORDER: frozen checked before disposable
  // ──────────────────────────────────────────────────────────────

  it('frozen takes priority over disposable when both could match', () => {
    // Low churn, old, high connectivity → frozen wins
    // (disposable requires low connectivity, so they can't both match)
    // But frozen is checked first in the chain
    const file = makeFile({
      filepath: 'src/contract.ts',
      changeCount: 1,
      firstSeen: daysAgo(180),
      lastChanged: daysAgo(180),
      coChangedWith: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
    })

    const result = classifyStability(makeAnalysis([file]))
    expect(result.classifications[0].stability).toBe('frozen')
  })
})
