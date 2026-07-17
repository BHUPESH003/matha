import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Engine } from '../../src/core/engine.js'
import { writeFixtureBrain, GOLDEN_QUERIES, FIXED_NOW } from './fixture.js'
import { runGoldenSet, formatFailures, type EvalMetrics } from './harness.js'

/**
 * Golden-set retrieval eval — the CI gate from target-architecture §3.1.
 * Exit criteria (Phase 2): recall@5 ≥ 0.8, false-critical ≤ 0.05, every
 * brief within budget. These thresholds are the contract; loosening them
 * is a product decision, not a test fix.
 */

describe('golden-set retrieval eval', () => {
  let projectDir: string
  let metrics: EvalMetrics

  beforeAll(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-eval-'))
    const mathaDir = await writeFixtureBrain(projectDir)
    metrics = await runGoldenSet(new Engine(mathaDir), GOLDEN_QUERIES, FIXED_NOW)
    console.info(`[eval]\n${formatFailures(metrics)}`)
  })

  afterAll(async () => {
    await fs.rm(projectDir, { recursive: true, force: true })
  })

  it('recall@5 ≥ 0.8', () => {
    expect(metrics.recallAt5, formatFailures(metrics)).toBeGreaterThanOrEqual(0.8)
  })

  it('false-critical rate ≤ 0.05', () => {
    expect(metrics.falseCriticalRate, formatFailures(metrics)).toBeLessThanOrEqual(0.05)
  })

  it('precision@5 ≥ 0.6', () => {
    expect(metrics.precisionAt5, formatFailures(metrics)).toBeGreaterThanOrEqual(0.6)
  })

  it('every brief stays within the token budget', () => {
    expect(metrics.briefTokenMax).toBeLessThanOrEqual(metrics.briefBudget)
  })

  it('p95 warm match latency < 50ms', () => {
    expect(metrics.p95LatencyMs, `p95=${metrics.p95LatencyMs}ms`).toBeLessThan(50)
  })
})
