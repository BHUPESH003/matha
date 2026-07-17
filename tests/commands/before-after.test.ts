import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { runBefore } from '../../src/commands/before.js'
import { runAfter } from '../../src/commands/after.js'
import { getDecisions, getDangerZones } from '../../src/store/records.js'
import { CURRENT_SCHEMA_VERSION } from '../../src/core/schema.js'

describe('before/after commands (slim, post scope-cut)', () => {
  let tmpDir: string
  let mathaDir: string
  let logs: string[]

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-cmd-'))
    mathaDir = path.join(tmpDir, '.matha')
    await fs.mkdir(path.join(mathaDir, 'hippocampus', 'decisions'), { recursive: true })
    await fs.writeFile(
      path.join(mathaDir, 'config.json'),
      JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION }),
    )
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'intent.json'),
      JSON.stringify({ why: 'test project purpose' }),
    )
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'rules.json'),
      JSON.stringify({ rules: ['never delete the ledger'] }),
    )
    logs = []
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const log = (msg: string) => logs.push(msg)

  describe('before', () => {
    it('uninitialised project → exit 1 with init hint', async () => {
      const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-bare-'))
      const result = await runBefore(bare, { log })
      expect(result.exitCode).toBe(1)
      expect(result.message).toContain('matha init')
      await fs.rm(bare, { recursive: true, force: true })
    })

    it('prints brief with why, rules, and diagnostics; exit 0', async () => {
      const result = await runBefore(tmpDir, { log })
      expect(result.exitCode).toBe(0)
      expect(result.brief?.why).toBe('test project purpose')
      expect(result.brief?.rules).toEqual(['never delete the ledger'])
      expect(result.brief?.diagnostics.brainDir).toBe(mathaDir)
      const output = logs.join('\n')
      expect(output).toContain('test project purpose')
      expect(output).toContain('never delete the ledger')
    })

    it('scope produces matches against recorded danger zones', async () => {
      await fs.writeFile(
        path.join(mathaDir, 'hippocampus', 'danger-zones.json'),
        JSON.stringify({
          zones: [{ id: 'z1', component: 'src/payments/', pattern: 'p', description: 'retry storm risk' }],
        }),
      )
      const result = await runBefore(tmpDir, { log, scope: 'src/payments/retry.ts' })
      expect(result.brief?.matchResults).toHaveLength(1)
      expect(result.brief?.hasCritical).toBe(true)
    })
  })

  describe('after', () => {
    function askSequence(answers: string[]) {
      let i = 0
      return async () => answers[i++] ?? ''
    }

    it('records a validated decision with confirmed confidence', async () => {
      const result = await runAfter(tmpDir, {
        log,
        ask: askSequence([
          'the API is idempotent',           // assumption
          'the API double-charges on retry', // correction
          'src/payments/client.ts',          // component
          '',                                // no danger zone
        ]),
      })
      expect(result.exitCode).toBe(0)
      expect(result.decisionRecorded).toBe(true)
      const decisions = await getDecisions(mathaDir)
      expect(decisions).toHaveLength(1)
      expect(decisions[0].confidence).toBe('confirmed')
      expect(decisions[0].component).toBe('src/payments/client.ts')
    })

    it('rejects trivial garbage instead of recording it (the "y"→"y" bug)', async () => {
      const result = await runAfter(tmpDir, {
        log,
        ask: askSequence(['y', 'y', 'y', '']),
      })
      expect(result.exitCode).toBe(0)
      expect(result.decisionRecorded).toBe(false)
      expect(await getDecisions(mathaDir)).toHaveLength(0)
      expect(logs.join('\n')).toContain('not recorded')
    })

    it('records a danger zone with component', async () => {
      const result = await runAfter(tmpDir, {
        log,
        ask: askSequence([
          '',                                        // no decision
          'changing timeouts here breaks the queue', // danger pattern
          'src/queue/worker.ts',                     // component
        ]),
      })
      expect(result.dangerZoneRecorded).toBe(true)
      const zones = await getDangerZones(mathaDir)
      expect(zones).toHaveLength(1)
      expect(zones[0].component).toBe('src/queue/worker.ts')
    })

    it('skipping everything records nothing, exit 0', async () => {
      const result = await runAfter(tmpDir, { log, ask: askSequence(['', '']) })
      expect(result.exitCode).toBe(0)
      expect(result.decisionRecorded).toBe(false)
      expect(result.dangerZoneRecorded).toBe(false)
    })
  })
})
