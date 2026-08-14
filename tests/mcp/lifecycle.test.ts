import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Engine } from '../../src/core/engine.js'
import { mathaRecord } from '../../src/mcp/tools.js'
import { componentToFilename } from '../../src/core/schema.js'
import { recordContract } from '../../src/store/records.js'

describe('matha_record lifecycle verbs (Phase 4)', () => {
  let tmpDir: string
  let mathaDir: string
  let engine: Engine

  async function writeDecision(id: string, overrides: Record<string, unknown> = {}) {
    const entry = {
      id, timestamp: '2026-07-01T00:00:00Z', component: 'src/x.ts',
      previous_assumption: 'assumed something', correction: 'actually otherwise',
      trigger: 't', confidence: 'probable', status: 'active',
      supersedes: null, session_id: id, ...overrides,
    }
    const filePath = path.join(
      mathaDir, 'hippocampus', 'decisions', `${componentToFilename(entry.component as string)}.jsonl`,
    )
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8')
  }

  async function readDecision(id: string, component = 'src/x.ts') {
    const filePath = path.join(
      mathaDir, 'hippocampus', 'decisions', `${componentToFilename(component)}.jsonl`,
    )
    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n').filter(Boolean)
    return lines.map((l) => JSON.parse(l)).find((d: { id: string }) => d.id === id)
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-lifecycle-'))
    mathaDir = path.join(tmpDir, '.matha')
    await fs.mkdir(path.join(mathaDir, 'hippocampus', 'decisions'), { recursive: true })
    await fs.mkdir(path.join(mathaDir, 'cerebellum', 'contracts'), { recursive: true })
    engine = new Engine(mathaDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('retire marks a decision retired with a reason, content untouched', async () => {
    await writeDecision('d1')
    const result = JSON.parse(
      await mathaRecord(engine, { type: 'retire', id: 'd1', reason: 'module was deleted in the v2 rewrite' }),
    )
    expect(result.success).toBe(true)
    expect(result.retired).toBe('decision')

    const stored = await readDecision('d1')
    expect(stored.status).toBe('retired')
    expect(stored.retired_reason).toContain('v2 rewrite')
    expect(stored.previous_assumption).toBe('assumed something') // content immutable
  })

  it('retire finds danger zones too, and rejects unknown ids and empty reasons', async () => {
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'danger-zones.json'),
      JSON.stringify({ zones: [{ id: 'z1', component: 'src/y.ts', pattern: 'p', description: 'watch out' }] }),
    )
    const zone = JSON.parse(
      await mathaRecord(engine, { type: 'retire', id: 'z1', reason: 'race condition fixed upstream' }),
    )
    expect(zone.success).toBe(true)
    expect(zone.retired).toBe('danger')

    const unknown = JSON.parse(await mathaRecord(engine, { type: 'retire', id: 'nope', reason: 'whatever reason' }))
    expect(unknown.success).toBe(false)

    await writeDecision('d2')
    const noReason = JSON.parse(await mathaRecord(engine, { type: 'retire', id: 'd2' }))
    expect(noReason.success).toBe(false)
    expect(noReason.error).toContain('reason')
  })

  it('supersede writes the new decision and links both directions', async () => {
    await writeDecision('d-old')
    const result = JSON.parse(
      await mathaRecord(engine, {
        type: 'supersede', supersedes: 'd-old', component: 'src/x.ts',
        previous_assumption: 'the earlier correction was itself wrong',
        correction: 'the API is async only in v3, sync before',
        confidence: 'confirmed', // still capped
      }),
    )
    expect(result.success).toBe(true)
    expect(result.superseded).toBe('d-old')

    const old = await readDecision('d-old')
    expect(old.status).toBe('superseded')
    expect(old.superseded_by).toBe(result.id)

    const next = await readDecision(result.id)
    expect(next.supersedes).toBe('d-old')
    expect(next.status).toBe('active')
    expect(next.confidence).toBe('probable') // cap applies to supersede too
  })

  it('supersede rejects unknown or already-superseded targets', async () => {
    const unknown = JSON.parse(
      await mathaRecord(engine, {
        type: 'supersede', supersedes: 'ghost', component: 'src/x.ts',
        previous_assumption: 'assumed something', correction: 'actually otherwise entirely',
      }),
    )
    expect(unknown.success).toBe(false)

    await writeDecision('d-done', { status: 'superseded' })
    const again = JSON.parse(
      await mathaRecord(engine, {
        type: 'supersede', supersedes: 'd-done', component: 'src/x.ts',
        previous_assumption: 'assumed something new', correction: 'actually different again',
      }),
    )
    expect(again.success).toBe(false)
    expect(again.error).toContain('superseded')
  })

  it('violation increments the assertion count with evidence', async () => {
    await recordContract(mathaDir, 'src/payments/retry.ts', [
      'every retry carries the original idempotency key',
    ])
    const ok = JSON.parse(
      await mathaRecord(engine, {
        type: 'violation', component: 'src/payments/retry.ts',
        assertion: 'every retry carries the original idempotency key',
      }),
    )
    expect(ok.success).toBe(true)

    const contract = JSON.parse(
      await fs.readFile(
        path.join(mathaDir, 'cerebellum', 'contracts', `${componentToFilename('src/payments/retry.ts')}.json`),
        'utf-8',
      ),
    )
    expect(contract.assertions[0].violation_count).toBe(1)
    expect(contract.assertions[0].last_violated).toBeTruthy()

    const miss = JSON.parse(
      await mathaRecord(engine, {
        type: 'violation', component: 'src/payments/retry.ts', assertion: 'no such assertion',
      }),
    )
    expect(miss.success).toBe(false)
  })
})
