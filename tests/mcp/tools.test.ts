import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Engine } from '../../src/core/engine.js'
import {
  mathaBrief,
  mathaGetRules,
  mathaMatch,
  mathaRecordContract,
  mathaRecordDanger,
  mathaRecordDecision,
} from '../../src/mcp/tools.js'
import { recordContractViolation } from '../../src/store/records.js'
import { componentToFilename } from '../../src/core/schema.js'

describe('MCP tools', () => {
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

  it('every read result carries diagnostics.brainDir', async () => {
    const result = JSON.parse(await mathaGetRules(engine))
    expect(result.diagnostics.brainDir).toBe(mathaDir)
  })

  it('record_decision validates input and rejects garbage', async () => {
    const bad = JSON.parse(await mathaRecordDecision(engine, 'src/x.ts', 'y', 'y'))
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('too short')

    const good = JSON.parse(
      await mathaRecordDecision(engine, 'src/x.ts', 'assumed sync API', 'it is actually async'),
    )
    expect(good.success).toBe(true)
    expect(good.id).toBeDefined()
  })

  it('record_danger rejects empty component', async () => {
    const bad = JSON.parse(await mathaRecordDanger(engine, '  ', 'some description'))
    expect(bad.success).toBe(false)
  })

  it('write → read round-trip through the same engine (cache invalidation)', async () => {
    await mathaRecordDecision(engine, 'src/api/pay.ts', 'assumed idempotent', 'double-charges on retry')
    const match = JSON.parse(
      await mathaMatch(engine, 'src/api/pay.ts', 'modify payment call', ['src/api/pay.ts']),
    )
    expect(match.summary.warning).toBe(1)
    expect(match.results[0].matchType).toBe('decision_pattern')
  })

  it('contract violations find the file recordContract wrote (one sanitizer)', async () => {
    const component = 'src/Payments/Retry.ts' // slashes + case: 0.1.x sanitizers disagreed here
    await mathaRecordContract(engine, component, ['never retries more than 3 times'])

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

    // ...and the violated contract now matches as critical
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
    await mathaRecordDanger(engine, 'src/db/', 'schema changes need a migration')

    const brief = JSON.parse(await mathaBrief(engine, 'src/db/users.ts', 'add a column'))
    expect(brief.why).toBe('purpose')
    expect(brief.rules).toEqual(['rule A'])
    expect(brief.matchResults).toHaveLength(1)
    expect(brief.hasCritical).toBe(true)
    expect(brief.diagnostics.brainDir).toBe(mathaDir)
  })

  it('brief without scope returns static context only, no matches', async () => {
    await mathaRecordDanger(engine, 'src/db/', 'schema changes need a migration')
    const brief = JSON.parse(await mathaBrief(engine))
    expect(brief.matchResults).toEqual([])
  })
})
