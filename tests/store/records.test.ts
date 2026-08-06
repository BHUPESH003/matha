import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getIntent,
  getRules,
  recordDecision,
  getDecisions,
  getDangerZones,
  recordDangerZone,
  migrateLegacyDecisions,
  type DecisionEntry,
  type DangerZone,
} from '@/store/records.js'
import { componentToFilename } from '@/core/schema.js'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('hippocampus', () => {
  let tmpDir: string
  let mathaDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-test-'))
    mathaDir = path.join(tmpDir, '.matha')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // ── getIntent ────────────────────────────────────────────────────

  describe('getIntent', () => {
    it('returns null when intent.json does not exist', async () => {
      const result = await getIntent(mathaDir)
      expect(result).toBeNull()
    })

    it('returns the intent object when it exists', async () => {
      const hippocampusDir = path.join(mathaDir, 'hippocampus')
      await fs.mkdir(hippocampusDir, { recursive: true })
      await fs.writeFile(
        path.join(hippocampusDir, 'intent.json'),
        JSON.stringify({ why: 'To solve X', core_problem: 'Problem Y' }),
        'utf-8',
      )

      const result = await getIntent(mathaDir)
      expect(result).toEqual({ why: 'To solve X', core_problem: 'Problem Y' })
    })
  })

  // ── getRules ─────────────────────────────────────────────────────

  describe('getRules', () => {
    it('returns empty array when rules.json does not exist', async () => {
      const result = await getRules(mathaDir)
      expect(result).toEqual([])
    })

    it('returns the rules array when it exists', async () => {
      const hippocampusDir = path.join(mathaDir, 'hippocampus')
      await fs.mkdir(hippocampusDir, { recursive: true })
      await fs.writeFile(
        path.join(hippocampusDir, 'rules.json'),
        JSON.stringify({ rules: ['Rule 1', 'Rule 2', 'Rule 3'] }),
        'utf-8',
      )

      const result = await getRules(mathaDir)
      expect(result).toEqual(['Rule 1', 'Rule 2', 'Rule 3'])
    })

    it('returns empty array if rules.json has no rules field', async () => {
      const hippocampusDir = path.join(mathaDir, 'hippocampus')
      await fs.mkdir(hippocampusDir, { recursive: true })
      await fs.writeFile(
        path.join(hippocampusDir, 'rules.json'),
        JSON.stringify({ other: 'data' }),
        'utf-8',
      )

      const result = await getRules(mathaDir)
      expect(result).toEqual([])
    })
  })

  // ── recordDecision ───────────────────────────────────────────────

  describe('recordDecision', () => {
    it('writes a decision entry into its component group file', async () => {
      const entry: DecisionEntry = {
        id: 'decision-001',
        timestamp: '2026-03-04T10:00:00Z',
        component: 'auth',
        previous_assumption: 'Tokens never expire',
        correction: 'Tokens expire after 1 hour',
        trigger: 'Production bug',
        confidence: 'confirmed',
        status: 'active',
        supersedes: null,
        session_id: 'session-001',
      }

      await recordDecision(mathaDir, entry)

      const groupPath = path.join(
        mathaDir,
        'hippocampus',
        'decisions',
        `${componentToFilename('auth')}.json`,
      )
      const content = JSON.parse(await fs.readFile(groupPath, 'utf-8'))
      expect(content).toEqual({ component: 'auth', decisions: [entry] })
    })

    it('appends a second decision on the same component into the same file', async () => {
      const entry1: DecisionEntry = {
        id: 'decision-001',
        timestamp: '2026-03-04T10:00:00Z',
        component: 'auth',
        previous_assumption: 'A1',
        correction: 'C1',
        trigger: 'T1',
        confidence: 'confirmed',
        status: 'active',
        supersedes: null,
        session_id: 'session-001',
      }
      const entry2: DecisionEntry = { ...entry1, id: 'decision-003', correction: 'C3' }

      await recordDecision(mathaDir, entry1)
      await recordDecision(mathaDir, entry2)

      const groupPath = path.join(
        mathaDir,
        'hippocampus',
        'decisions',
        `${componentToFilename('auth')}.json`,
      )
      const content = JSON.parse(await fs.readFile(groupPath, 'utf-8'))
      expect(content.decisions).toHaveLength(2)
    })

    it('rejects if a decision with the same id already exists', async () => {
      const entry: DecisionEntry = {
        id: 'decision-001',
        timestamp: '2026-03-04T10:00:00Z',
        component: 'auth',
        previous_assumption: 'Assumption A',
        correction: 'Correction A',
        trigger: 'Trigger A',
        confidence: 'confirmed',
        status: 'active',
        supersedes: null,
        session_id: 'session-001',
      }

      await recordDecision(mathaDir, entry)

      const duplicate = { ...entry, correction: 'Different correction' }
      await expect(recordDecision(mathaDir, duplicate)).rejects.toThrow()
    })

    it('creates the decisions directory if it does not exist', async () => {
      const entry: DecisionEntry = {
        id: 'decision-002',
        timestamp: '2026-03-04T10:00:00Z',
        component: 'storage',
        previous_assumption: 'Old assumption',
        correction: 'New understanding',
        trigger: 'Code review',
        confidence: 'probable',
        status: 'active',
        supersedes: null,
        session_id: 'session-002',
      }

      await recordDecision(mathaDir, entry)

      const groupPath = path.join(
        mathaDir,
        'hippocampus',
        'decisions',
        `${componentToFilename('storage')}.json`,
      )
      await expect(fs.access(groupPath)).resolves.toBeUndefined()
    })
  })

  // ── getDecisions ─────────────────────────────────────────────────

  describe('getDecisions', () => {
    it('returns empty array when decisions directory does not exist', async () => {
      const result = await getDecisions(mathaDir)
      expect(result).toEqual([])
    })

    it('returns all decisions sorted by timestamp descending (most recent first)', async () => {
      const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')
      await fs.mkdir(decisionsDir, { recursive: true })

      const entry1: DecisionEntry = {
        id: 'decision-001',
        timestamp: '2026-03-01T10:00:00Z',
        component: 'auth',
        previous_assumption: 'A1',
        correction: 'C1',
        trigger: 'T1',
        confidence: 'confirmed',
        status: 'active',
        supersedes: null,
        session_id: 'session-001',
      }

      const entry2: DecisionEntry = {
        id: 'decision-002',
        timestamp: '2026-03-03T10:00:00Z',
        component: 'storage',
        previous_assumption: 'A2',
        correction: 'C2',
        trigger: 'T2',
        confidence: 'confirmed',
        status: 'active',
        supersedes: null,
        session_id: 'session-002',
      }

      await fs.writeFile(
        path.join(decisionsDir, `${componentToFilename(entry1.component)}.json`),
        JSON.stringify({ component: entry1.component, decisions: [entry1] }),
        'utf-8',
      )
      await fs.writeFile(
        path.join(decisionsDir, `${componentToFilename(entry2.component)}.json`),
        JSON.stringify({ component: entry2.component, decisions: [entry2] }),
        'utf-8',
      )

      const result = await getDecisions(mathaDir)
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('decision-002') // most recent first
      expect(result[1].id).toBe('decision-001')
    })

    it('filters by component when provided', async () => {
      const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')
      await fs.mkdir(decisionsDir, { recursive: true })

      const entry1: DecisionEntry = {
        id: 'decision-001',
        timestamp: '2026-03-01T10:00:00Z',
        component: 'auth',
        previous_assumption: 'A1',
        correction: 'C1',
        trigger: 'T1',
        confidence: 'confirmed',
        status: 'active',
        supersedes: null,
        session_id: 'session-001',
      }

      const entry2: DecisionEntry = {
        id: 'decision-002',
        timestamp: '2026-03-03T10:00:00Z',
        component: 'storage',
        previous_assumption: 'A2',
        correction: 'C2',
        trigger: 'T2',
        confidence: 'confirmed',
        status: 'active',
        supersedes: null,
        session_id: 'session-002',
      }

      await fs.writeFile(
        path.join(decisionsDir, `${componentToFilename(entry1.component)}.json`),
        JSON.stringify({ component: entry1.component, decisions: [entry1] }),
        'utf-8',
      )
      await fs.writeFile(
        path.join(decisionsDir, `${componentToFilename(entry2.component)}.json`),
        JSON.stringify({ component: entry2.component, decisions: [entry2] }),
        'utf-8',
      )

      const result = await getDecisions(mathaDir, 'storage')
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('decision-002')
    })

    it('limits results when limit parameter is provided', async () => {
      const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')
      await fs.mkdir(decisionsDir, { recursive: true })

      const decisions: DecisionEntry[] = []
      for (let i = 1; i <= 5; i++) {
        decisions.push({
          id: `decision-00${i}`,
          timestamp: `2026-03-0${i}T10:00:00Z`,
          component: 'test',
          previous_assumption: `A${i}`,
          correction: `C${i}`,
          trigger: `T${i}`,
          confidence: 'confirmed',
          status: 'active',
          supersedes: null,
          session_id: `session-00${i}`,
        })
      }
      await fs.writeFile(
        path.join(decisionsDir, `${componentToFilename('test')}.json`),
        JSON.stringify({ component: 'test', decisions }),
        'utf-8',
      )

      const result = await getDecisions(mathaDir, undefined, 2)
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('decision-005') // most recent
      expect(result[1].id).toBe('decision-004')
    })
  })

  // ── migrateLegacyDecisions ────────────────────────────────────────

  describe('migrateLegacyDecisions', () => {
    it('groups pre-1.1 bare-entry files by component and removes the old files', async () => {
      const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')
      await fs.mkdir(decisionsDir, { recursive: true })

      const legacy1: DecisionEntry = {
        id: 'session-001',
        timestamp: '2026-03-01T10:00:00Z',
        component: 'auth',
        previous_assumption: 'A1',
        correction: 'C1',
        trigger: 'T1',
        confidence: 'confirmed',
        status: 'active',
        supersedes: null,
        session_id: 'session-001',
      }
      const legacy2: DecisionEntry = { ...legacy1, id: 'session-002', correction: 'C2' }
      await fs.writeFile(path.join(decisionsDir, 'session-001.json'), JSON.stringify(legacy1))
      await fs.writeFile(path.join(decisionsDir, 'session-002.json'), JSON.stringify(legacy2))

      const migrated = await migrateLegacyDecisions(mathaDir)
      expect(migrated).toBe(2)

      const remaining = await fs.readdir(decisionsDir)
      expect(remaining).toEqual([`${componentToFilename('auth')}.json`])

      const result = await getDecisions(mathaDir)
      expect(result.map((d) => d.id).sort()).toEqual(['session-001', 'session-002'])
    })

    it('is idempotent — a second run is a no-op', async () => {
      const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')
      await fs.mkdir(decisionsDir, { recursive: true })
      const legacy: DecisionEntry = {
        id: 'session-001',
        timestamp: '2026-03-01T10:00:00Z',
        component: 'auth',
        previous_assumption: 'A1',
        correction: 'C1',
        trigger: 'T1',
        confidence: 'confirmed',
        status: 'active',
        supersedes: null,
        session_id: 'session-001',
      }
      await fs.writeFile(path.join(decisionsDir, 'session-001.json'), JSON.stringify(legacy))

      await migrateLegacyDecisions(mathaDir)
      const second = await migrateLegacyDecisions(mathaDir)
      expect(second).toBe(0)
    })

    it('returns 0 when the decisions directory does not exist', async () => {
      expect(await migrateLegacyDecisions(mathaDir)).toBe(0)
    })

    it('leaves a malformed/stray file alone instead of crashing the migration', async () => {
      const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')
      await fs.mkdir(decisionsDir, { recursive: true })
      await fs.writeFile(
        path.join(decisionsDir, 'stray-report.json'),
        JSON.stringify({ id: 'stray', session_title: 'not a decision', findings: {} }),
      )
      const legacy: DecisionEntry = {
        id: 'session-001',
        timestamp: '2026-03-01T10:00:00Z',
        component: 'auth',
        previous_assumption: 'A1',
        correction: 'C1',
        trigger: 'T1',
        confidence: 'confirmed',
        status: 'active',
        supersedes: null,
        session_id: 'session-001',
      }
      await fs.writeFile(path.join(decisionsDir, 'session-001.json'), JSON.stringify(legacy))

      const migrated = await migrateLegacyDecisions(mathaDir)
      expect(migrated).toBe(1)
      await expect(fs.access(path.join(decisionsDir, 'stray-report.json'))).resolves.toBeUndefined()
    })
  })

  // ── getDangerZones ───────────────────────────────────────────────

  describe('getDangerZones', () => {
    it('returns empty array when danger-zones.json does not exist', async () => {
      const result = await getDangerZones(mathaDir)
      expect(result).toEqual([])
    })

    it('returns all danger zones when no context is provided', async () => {
      const hippocampusDir = path.join(mathaDir, 'hippocampus')
      await fs.mkdir(hippocampusDir, { recursive: true })

      const zones: DangerZone[] = [
        {
          id: 'dz-001',
          component: 'storage/writer',
          pattern: 'non-atomic writes',
          description: 'Non-atomic writes corrupt state',
        },
        {
          id: 'dz-002',
          component: 'auth/tokens',
          pattern: 'missing expiry check',
          description: 'Tokens must have expiry validation',
        },
      ]

      await fs.writeFile(
        path.join(hippocampusDir, 'danger-zones.json'),
        JSON.stringify({ zones }),
        'utf-8',
      )

      const result = await getDangerZones(mathaDir)
      expect(result).toEqual(zones)
    })

    it('filters by context matching component or description (case-insensitive)', async () => {
      const hippocampusDir = path.join(mathaDir, 'hippocampus')
      await fs.mkdir(hippocampusDir, { recursive: true })

      const zones: DangerZone[] = [
        {
          id: 'dz-001',
          component: 'storage/writer',
          pattern: 'non-atomic writes',
          description: 'Non-atomic writes corrupt state',
        },
        {
          id: 'dz-002',
          component: 'auth/tokens',
          pattern: 'missing expiry check',
          description: 'Tokens must have expiry validation',
        },
        {
          id: 'dz-003',
          component: 'api/handler',
          pattern: 'unchecked input',
          description: 'Storage layer must validate all inputs',
        },
      ]

      await fs.writeFile(
        path.join(hippocampusDir, 'danger-zones.json'),
        JSON.stringify({ zones }),
        'utf-8',
      )

      const result = await getDangerZones(mathaDir, 'storage')
      expect(result).toHaveLength(2)
      expect(result.map((z: DangerZone) => z.id)).toEqual(['dz-001', 'dz-003'])
    })

    it('returns empty array when danger-zones.json has no zones field', async () => {
      const hippocampusDir = path.join(mathaDir, 'hippocampus')
      await fs.mkdir(hippocampusDir, { recursive: true })
      await fs.writeFile(
        path.join(hippocampusDir, 'danger-zones.json'),
        JSON.stringify({ other: 'data' }),
        'utf-8',
      )

      const result = await getDangerZones(mathaDir)
      expect(result).toEqual([])
    })
  })

  // ── recordDangerZone ─────────────────────────────────────────────

  describe('recordDangerZone', () => {
    it('creates danger-zones.json with the zone if file does not exist', async () => {
      const zone: DangerZone = {
        id: 'dz-001',
        component: 'storage',
        pattern: 'direct fs access',
        description: 'Must use storage layer',
      }

      await recordDangerZone(mathaDir, zone)

      const zonePath = path.join(mathaDir, 'hippocampus', 'danger-zones.json')
      const content = JSON.parse(await fs.readFile(zonePath, 'utf-8'))
      expect(content.zones).toEqual([zone])
    })

    it('appends zone to existing danger-zones.json', async () => {
      const hippocampusDir = path.join(mathaDir, 'hippocampus')
      await fs.mkdir(hippocampusDir, { recursive: true })

      const existingZone: DangerZone = {
        id: 'dz-001',
        component: 'auth',
        pattern: 'missing check',
        description: 'Always validate',
      }

      await fs.writeFile(
        path.join(hippocampusDir, 'danger-zones.json'),
        JSON.stringify({ zones: [existingZone] }),
        'utf-8',
      )

      const newZone: DangerZone = {
        id: 'dz-002',
        component: 'storage',
        pattern: 'non-atomic write',
        description: 'Use atomic pattern',
      }

      await recordDangerZone(mathaDir, newZone)

      const zonePath = path.join(hippocampusDir, 'danger-zones.json')
      const content = JSON.parse(await fs.readFile(zonePath, 'utf-8'))
      expect(content.zones).toHaveLength(2)
      expect(content.zones[1]).toEqual(newZone)
    })
  })
})
