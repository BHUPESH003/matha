import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  runGate,
  validateSequence,
  generateBrief,
  runWriteBack,
  type GateState,
  type SessionContext,
} from '../../src/brain/frontal-lobe.js'
import {
  getDecisions,
  getDangerZones,
  recordDecision,
  recordDangerZone,
  type DecisionEntry,
  type DangerZone,
} from '../../src/brain/hippocampus.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

describe('frontal-lobe', () => {
  let tmpDir: string
  let mathaDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-test-'))
    mathaDir = path.join(tmpDir, '.matha')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const baseContext: SessionContext = {
    sessionId: 'session-100',
    scope: 'src/brain/frontal-lobe.ts',
    operationType: 'business_logic',
  }

  describe('runGate', () => {
    it('never throws on bad input and returns completed false', () => {
      expect(() => runGate(1, baseContext, null)).not.toThrow()
      expect(runGate(1, baseContext, null)).toEqual({
        gateId: 1,
        completed: false,
        output: null,
      })
    })

    it('gate 07 refuses readyToBuild when any of gates 01-05 are incomplete', () => {
      const states: GateState[] = [
        { gateId: 1, completed: true, output: 'why' },
        { gateId: 2, completed: false, output: [] },
        { gateId: 3, completed: true, output: {} },
        { gateId: 4, completed: true, output: [] },
        { gateId: 5, completed: true, output: ['assertion'] },
      ]

      const gate7 = runGate(7, baseContext, states)
      expect(gate7.completed).toBe(false)
      expect(gate7.output).toEqual({ readyToBuild: false, missing: [2] })
    })

    it('gate 07 allows readyToBuild when gates 01-05 are complete (gate 06 advisory)', () => {
      const states: GateState[] = [
        { gateId: 1, completed: true, output: 'why' },
        { gateId: 2, completed: true, output: ['bound'] },
        { gateId: 3, completed: true, output: { a: 'stable' } },
        { gateId: 4, completed: true, output: [] },
        { gateId: 5, completed: true, output: ['assertion'] },
        { gateId: 6, completed: false, output: null },
      ]

      const gate7 = runGate(7, baseContext, states)
      expect(gate7.completed).toBe(true)
      expect(gate7.output).toEqual({ readyToBuild: true, missing: [] })
    })
  })

  describe('validateSequence', () => {
    it('identifies missing gates in 01-06', () => {
      const states: GateState[] = [
        { gateId: 1, completed: true, output: 'why' },
        { gateId: 2, completed: false, output: [] },
        { gateId: 4, completed: true, output: [] },
        { gateId: 6, completed: false, output: null },
      ]

      const result = validateSequence(states)
      expect(result.valid).toBe(false)
      expect(result.missing).toEqual([2, 3, 5, 6])
    })

    it('is valid when gates 01-06 are all completed', () => {
      const states: GateState[] = [1, 2, 3, 4, 5, 6].map((id) => ({
        gateId: id,
        completed: true,
        output: true,
      }))

      const result = validateSequence(states)
      expect(result).toEqual({ valid: true, missing: [] })
    })
  })

  describe('generateBrief', () => {
    const makeStates = (): GateState[] => [
      { gateId: 1, completed: true, output: 'Prevent unsafe refactor regressions' },
      { gateId: 2, completed: true, output: ['Never bypass gate checks'] },
      { gateId: 3, completed: true, output: { 'frontal-lobe': 'stable' } },
      { gateId: 5, completed: true, output: ['Should refuse gate 07 if gate 05 is missing'] },
      { gateId: 7, completed: true, output: { readyToBuild: true, missing: [] } },
    ]

    it('assembles brief from gate outputs and hippocampus danger zones', async () => {
      const dz: DangerZone = {
        id: 'dz-100',
        component: 'frontal-lobe',
        pattern: 'gate bypass',
        description: 'Never allow gate 07 when gate 05 is incomplete',
      }

      const hippocampus = {
        getDangerZones: vi.fn().mockResolvedValue([dz]),
      }

      const brief = await generateBrief(baseContext, makeStates(), hippocampus)

      expect(hippocampus.getDangerZones).toHaveBeenCalledWith(baseContext.scope)
      expect(brief.sessionId).toBe(baseContext.sessionId)
      expect(brief.scope).toBe(baseContext.scope)
      expect(brief.why).toBe('Prevent unsafe refactor regressions')
      expect(brief.bounds).toEqual(['Never bypass gate checks'])
      expect(brief.contract).toEqual(['Should refuse gate 07 if gate 05 is missing'])
      expect(brief.dangerZones).toEqual([dz])
      expect(brief.gatesCompleted).toEqual([1, 2, 3, 5, 7])
      expect(brief.readyToBuild).toBe(true)
    })

    it.each([
      ['rename', 'lightweight', 2000],
      ['crud', 'lightweight', 2000],
      ['business_logic', 'capable', 8000],
      ['architecture', 'capable', 16000],
      ['frozen_component', 'capable', 16000],
    ] as const)(
      'routes %s to %s with budget %d',
      async (operationType, expectedTier, expectedBudget) => {
        const context: SessionContext = {
          ...baseContext,
          operationType,
        }

        const brief = await generateBrief(context, makeStates(), {
          getDangerZones: async () => [],
        })

        expect(brief.modelTier).toBe(expectedTier)
        expect(brief.tokenBudget).toBe(expectedBudget)
      },
    )
  })

  describe('runWriteBack', () => {
    it('writes decision and danger zone when discovery includes both', async () => {
      const discovery = {
        previousAssumption: 'Gate 06 was mandatory for build readiness',
        correction: 'Gate 06 is advisory only',
        trigger: 'Contract clarification',
        confidence: 'confirmed' as const,
        dangerPattern: 'readyToBuild true while gates 01-05 incomplete',
        dangerDescription: 'Critical invariant violation in gate 07',
      }

      await runWriteBack(baseContext, discovery, {
        mathaDir,
        recordDecision: (dir: string, entry: DecisionEntry) =>
          recordDecision(dir, entry),
        recordDangerZone: (dir: string, zone: DangerZone) =>
          recordDangerZone(dir, zone),
      })

      const decisions = await getDecisions(mathaDir)
      const zones = await getDangerZones(mathaDir)

      expect(decisions).toHaveLength(1)
      expect(decisions[0].correction).toBe(discovery.correction)
      expect(zones).toHaveLength(1)
      expect(zones[0].pattern).toBe(discovery.dangerPattern)
    })

    it('skips silently when discovery has neither correction nor danger pattern', async () => {
      const recordDecisionSpy = vi.fn()
      const recordDangerSpy = vi.fn()

      await expect(
        runWriteBack(
          baseContext,
          { correction: '', dangerPattern: '' },
          {
            mathaDir,
            recordDecision: recordDecisionSpy,
            recordDangerZone: recordDangerSpy,
          },
        ),
      ).resolves.toBeUndefined()

      expect(recordDecisionSpy).not.toHaveBeenCalled()
      expect(recordDangerSpy).not.toHaveBeenCalled()
    })
  })
})
