import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Engine } from '../../src/core/engine.js'
import { mathaBrief, mathaMatch, mathaRecord } from '../../src/mcp/tools.js'
import { recordContractViolation } from '../../src/store/records.js'
import { componentToFilename } from '../../src/core/schema.js'

describe('MCP tools (consolidated surface)', () => {
  let tmpDir: string
  let mathaDir: string
  let engine: Engine

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-tools-'))
    mathaDir = path.join(tmpDir, '.matha')
    await fs.mkdir(path.join(mathaDir, 'hippocampus', 'decisions'), { recursive: true })
    await fs.mkdir(path.join(mathaDir, 'cerebellum', 'contracts'), { recursive: true })
    engine = new Engine(mathaDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('every result carries diagnostics.brainDir', async () => {
    const brief = JSON.parse(await mathaBrief(engine))
    expect(brief.diagnostics.brainDir).toBe(mathaDir)
    const match = JSON.parse(await mathaMatch(engine, 'src/x.ts', 'anything'))
    expect(match.diagnostics.brainDir).toBe(mathaDir)
  })

  it('record type=decision validates input and rejects garbage', async () => {
    const bad = JSON.parse(
      await mathaRecord(engine, {
        type: 'decision', component: 'src/x.ts', previous_assumption: 'y', correction: 'y',
      }),
    )
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('too short')

    const good = JSON.parse(
      await mathaRecord(engine, {
        type: 'decision', component: 'src/x.ts',
        previous_assumption: 'assumed sync API', correction: 'it is actually async',
      }),
    )
    expect(good.success).toBe(true)
    expect(good.id).toBeDefined()
  })

  it('record type=danger rejects empty component', async () => {
    const bad = JSON.parse(
      await mathaRecord(engine, { type: 'danger', component: '  ', description: 'some description' }),
    )
    expect(bad.success).toBe(false)
  })

  it('MCP writes are capped at probable — agents cannot self-promote to confirmed', async () => {
    const result = JSON.parse(
      await mathaRecord(engine, {
        type: 'decision', component: 'src/x.ts',
        previous_assumption: 'assumed the cache is shared',
        correction: 'each pod has its own cache',
        confidence: 'confirmed', // agent tries to self-promote
      }),
    )
    expect(result.success).toBe(true)
    const stored = JSON.parse(
      await fs.readFile(
        path.join(mathaDir, 'hippocampus', 'decisions', `${result.id}.json`),
        'utf-8',
      ),
    )
    expect(stored.confidence).toBe('probable')

    // uncertain is still allowed — it's a demotion, not a promotion
    const unsure = JSON.parse(
      await mathaRecord(engine, {
        type: 'danger', component: 'src/y.ts',
        description: 'suspicion: writes may race under load',
        confidence: 'uncertain',
      }),
    )
    expect(unsure.success).toBe(true)
    const zones = JSON.parse(
      await fs.readFile(path.join(mathaDir, 'hippocampus', 'danger-zones.json'), 'utf-8'),
    )
    expect(zones.zones[0].confidence).toBe('uncertain')
  })

  it('near-duplicate writes are rejected, pointing at the existing record', async () => {
    const first = JSON.parse(
      await mathaRecord(engine, {
        type: 'decision', component: 'src/payments/retry.ts',
        previous_assumption: 'the gateway retries are idempotent',
        correction: 'the gateway double-charges on retry without an idempotency key',
      }),
    )
    expect(first.success).toBe(true)

    // Same learning, lightly reworded — an echo, not new knowledge
    const echo = JSON.parse(
      await mathaRecord(engine, {
        type: 'decision', component: 'src/payments/',
        previous_assumption: 'gateway retries are idempotent',
        correction: 'gateway double-charges on retry without idempotency key',
      }),
    )
    expect(echo.success).toBe(false)
    expect(echo.error).toContain('near-duplicate')
    expect(echo.error).toContain(first.id)

    // Genuinely different knowledge is accepted
    const different = JSON.parse(
      await mathaRecord(engine, {
        type: 'decision', component: 'src/auth/session.ts',
        previous_assumption: 'session TTL is fixed at 24 hours',
        correction: 'TTL is 30 minutes sliding, extended per request',
      }),
    )
    expect(different.success).toBe(true)

    // Same for danger zones
    await mathaRecord(engine, {
      type: 'danger', component: 'db/migrations/',
      description: 'non-idempotent migrations corrupt staging on parallel deploy',
    })
    const dupZone = JSON.parse(
      await mathaRecord(engine, {
        type: 'danger', component: 'db/',
        description: 'non-idempotent migrations corrupt staging on parallel deploys',
      }),
    )
    expect(dupZone.success).toBe(false)
    expect(dupZone.error).toContain('near-duplicate')
  })

  it('matha_match with scope omitted is a keyword-only search — never critical', async () => {
    await mathaRecord(engine, {
      type: 'danger', component: 'rate limiting', // text-only component, no path
      description: 'the limiter counts per pod, not per cluster',
    })
    // scope omitted entirely (relies on the default), matching how the MCP
    // server calls this when a client sends no `scope` argument at all.
    const match = JSON.parse(await (mathaMatch as any)(engine, undefined, 'tune rate limiting'))
    expect(match.results.length).toBeGreaterThan(0)
    expect(match.results[0].matchType).toBe('danger_zone')
    expect(match.hasCritical).toBe(false) // text-only structural floor caps severity
  })

  it('record rejects an unknown type with a readable reason', async () => {
    const bad = JSON.parse(await mathaRecord(engine, { type: 'note' as any, component: 'src/x.ts' }))
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('decision | danger | contract')
  })

  it('write → read round-trip through the same engine (cache invalidation)', async () => {
    await mathaRecord(engine, {
      type: 'decision', component: 'src/api/pay.ts',
      previous_assumption: 'assumed idempotent', correction: 'double-charges on retry',
    })
    const match = JSON.parse(
      await mathaMatch(engine, 'src/api/pay.ts', 'modify payment call', ['src/api/pay.ts']),
    )
    expect(match.summary.warning).toBe(1)
    expect(match.results[0].matchType).toBe('decision_pattern')
  })

  it('contract violations find the file recordContract wrote (one sanitizer)', async () => {
    const component = 'src/Payments/Retry.ts' // slashes + case: 0.1.x sanitizers disagreed here
    await mathaRecord(engine, {
      type: 'contract', component, assertions: ['never retries more than 3 times'],
    })

    const updated = await recordContractViolation(
      mathaDir, component, 'never retries more than 3 times', '2026-07-11T00:00:00Z',
    )
    expect(updated).toBe(true)

    const contract = JSON.parse(
      await fs.readFile(
        path.join(mathaDir, 'cerebellum', 'contracts', `${componentToFilename(component)}.json`),
        'utf-8',
      ),
    )
    expect(contract.assertions[0].violation_count).toBe(1)

    // ...and the violated contract now matches as critical on a direct hit
    const match = JSON.parse(
      await mathaMatch(engine, 'src/payments/retry.ts', 'touch retry', ['src/payments/retry.ts']),
    )
    const contractMatch = match.results.find((r: any) => r.matchType === 'contract')
    expect(contractMatch.severity).toBe('critical')
  })

  it('brief includes static context plus scope matches', async () => {
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'intent.json'),
      JSON.stringify({ why: 'purpose' }),
    )
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'rules.json'),
      JSON.stringify({ rules: ['rule A'] }),
    )
    await mathaRecord(engine, {
      type: 'danger', component: 'src/db/', description: 'schema changes need a migration',
    })

    const brief = JSON.parse(await mathaBrief(engine, 'src/db/users.ts', 'add a column'))
    expect(brief.why).toBe('purpose')
    expect(brief.rules).toEqual(['rule A'])
    expect(brief.matchResults).toHaveLength(1)
    expect(brief.hasCritical).toBe(true)
    expect(brief.tokenEstimate).toBeGreaterThan(0)
    expect(brief.diagnostics.brainDir).toBe(mathaDir)
  })

  it('brief without scope returns static context only, no matches', async () => {
    await mathaRecord(engine, {
      type: 'danger', component: 'src/db/', description: 'schema changes need a migration',
    })
    const brief = JSON.parse(await mathaBrief(engine))
    expect(brief.matchResults).toEqual([])
  })
})
