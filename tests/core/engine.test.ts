import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Engine } from '../../src/core/engine.js'

describe('Engine (in-memory index)', () => {
  let tmpDir: string
  let mathaDir: string
  let engine: Engine

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-engine-'))
    mathaDir = path.join(tmpDir, '.matha')
    await fs.mkdir(path.join(mathaDir, 'hippocampus', 'decisions'), { recursive: true })
    await fs.mkdir(path.join(mathaDir, 'cerebellum', 'contracts'), { recursive: true })
    await fs.mkdir(path.join(mathaDir, 'cortex'), { recursive: true })
    engine = new Engine(mathaDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const rulesPath = () => path.join(mathaDir, 'hippocampus', 'rules.json')

  it('reads rules, serves cached data on second read', async () => {
    await fs.writeFile(rulesPath(), JSON.stringify({ rules: ['rule one'] }))
    expect(await engine.getRules()).toEqual(['rule one'])
    expect(await engine.getRules()).toEqual(['rule one'])
  })

  it('cache invalidates when the file changes (mtime/size)', async () => {
    await fs.writeFile(rulesPath(), JSON.stringify({ rules: ['rule one'] }))
    expect(await engine.getRules()).toEqual(['rule one'])

    // Rewrite with different content; ensure size differs so the check
    // cannot be fooled by coarse mtime granularity.
    await fs.writeFile(rulesPath(), JSON.stringify({ rules: ['rule one', 'rule two!'] }))
    expect(await engine.getRules()).toEqual(['rule one', 'rule two!'])
  })

  it('cache invalidates when the file is deleted', async () => {
    await fs.writeFile(rulesPath(), JSON.stringify({ rules: ['rule one'] }))
    expect(await engine.getRules()).toEqual(['rule one'])
    await fs.rm(rulesPath())
    expect(await engine.getRules()).toEqual([])
  })

  it('malformed JSON is treated as missing, never throws', async () => {
    await fs.writeFile(rulesPath(), '{not json')
    expect(await engine.getRules()).toEqual([])
  })

  it('reads decisions from directory, newest first, with limit', async () => {
    const dir = path.join(mathaDir, 'hippocampus', 'decisions')
    for (const [id, ts] of [
      ['d1', '2026-01-01T00:00:00Z'],
      ['d2', '2026-03-01T00:00:00Z'],
      ['d3', '2026-02-01T00:00:00Z'],
    ]) {
      await fs.writeFile(
        path.join(dir, `${id}.json`),
        JSON.stringify({
          id, timestamp: ts, component: 'src/x.ts', previous_assumption: 'aaa',
          correction: 'bbb', trigger: 't', confidence: 'confirmed', status: 'active',
          supersedes: null, session_id: id,
        }),
      )
    }
    const all = await engine.getDecisions()
    expect(all.map((d) => d.id)).toEqual(['d2', 'd3', 'd1'])
    expect((await engine.getDecisions(undefined, 2)).length).toBe(2)
  })

  it('stabilityFor matches normalised paths (case/slash-insensitive)', async () => {
    await fs.writeFile(
      path.join(mathaDir, 'cortex', 'stability.json'),
      JSON.stringify([
        { filepath: 'src\\Auth.ts', stability: 'frozen', confidence: 'high', reason: 'r' },
      ]),
    )
    const result = await engine.stabilityFor(['src/auth.ts', 'src/missing.ts'])
    expect(result['src/auth.ts']?.stability).toBe('frozen')
    expect(result['src/missing.ts']).toBeNull()
  })

  it('counts reports every store', async () => {
    await fs.writeFile(rulesPath(), JSON.stringify({ rules: ['r1', 'r2'] }))
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'danger-zones.json'),
      JSON.stringify({ zones: [{ id: 'z', component: 'src/x.ts', pattern: 'p', description: 'd' }] }),
    )
    const counts = await engine.counts()
    expect(counts.rules).toBe(2)
    expect(counts.dangerZones).toBe(1)
    expect(counts.decisions).toBe(0)
    expect(counts.contracts).toBe(0)
  })

  it('match returns diagnostics with brainDir and recordsConsidered', async () => {
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'danger-zones.json'),
      JSON.stringify({
        zones: [{ id: 'z', component: 'src/payments/', pattern: 'p', description: 'retry storm' }],
      }),
    )
    const { results, diagnostics } = await engine.match({
      scope: 'src/payments/retry.ts',
      intent: 'change retry logic',
      filepaths: ['src/payments/retry.ts'],
    })
    expect(diagnostics.brainDir).toBe(mathaDir)
    expect(diagnostics.recordsConsidered).toBe(1)
    expect(results.length).toBe(1)
    expect(results[0].matchType).toBe('danger_zone')
  })
})
