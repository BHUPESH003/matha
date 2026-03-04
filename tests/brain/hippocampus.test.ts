import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getIntent,
  getRules,
  recordDecision,
  getDecisions,
  getDangerZones,
  recordDangerZone,
  getOpenQuestions,
  recordOpenQuestion,
  type DecisionEntry,
  type DangerZone,
  type OpenQuestion,
} from '@/brain/hippocampus.js'
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
    it('writes a decision entry to decisions/ directory', async () => {
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

      const decisionPath = path.join(
        mathaDir,
        'hippocampus',
        'decisions',
        'decision-001.json',
      )
      const content = JSON.parse(await fs.readFile(decisionPath, 'utf-8'))
      expect(content).toEqual(entry)
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

      const decisionPath = path.join(
        mathaDir,
        'hippocampus',
        'decisions',
        'decision-002.json',
      )
      await expect(fs.access(decisionPath)).resolves.toBeUndefined()
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
        path.join(decisionsDir, 'decision-001.json'),
        JSON.stringify(entry1),
        'utf-8',
      )
      await fs.writeFile(
        path.join(decisionsDir, 'decision-002.json'),
        JSON.stringify(entry2),
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
        path.join(decisionsDir, 'decision-001.json'),
        JSON.stringify(entry1),
        'utf-8',
      )
      await fs.writeFile(
        path.join(decisionsDir, 'decision-002.json'),
        JSON.stringify(entry2),
        'utf-8',
      )

      const result = await getDecisions(mathaDir, 'storage')
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('decision-002')
    })

    it('limits results when limit parameter is provided', async () => {
      const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')
      await fs.mkdir(decisionsDir, { recursive: true })

      for (let i = 1; i <= 5; i++) {
        const entry: DecisionEntry = {
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
        }
        await fs.writeFile(
          path.join(decisionsDir, `decision-00${i}.json`),
          JSON.stringify(entry),
          'utf-8',
        )
      }

      const result = await getDecisions(mathaDir, undefined, 2)
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('decision-005') // most recent
      expect(result[1].id).toBe('decision-004')
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

  // ── getOpenQuestions ─────────────────────────────────────────────

  describe('getOpenQuestions', () => {
    it('returns empty array when open-questions.json does not exist', async () => {
      const result = await getOpenQuestions(mathaDir)
      expect(result).toEqual([])
    })

    it('returns all open questions when file exists', async () => {
      const hippocampusDir = path.join(mathaDir, 'hippocampus')
      await fs.mkdir(hippocampusDir, { recursive: true })

      const questions: OpenQuestion[] = [
        {
          id: 'oq-001',
          question: 'How should conflicts be resolved?',
          context: 'Decision log',
          status: 'open',
        },
        {
          id: 'oq-002',
          question: 'Team vs solo ownership?',
          context: 'Cortex',
          status: 'open',
        },
      ]

      await fs.writeFile(
        path.join(hippocampusDir, 'open-questions.json'),
        JSON.stringify({ questions }),
        'utf-8',
      )

      const result = await getOpenQuestions(mathaDir)
      expect(result).toEqual(questions)
    })

    it('returns empty array when open-questions.json has no questions field', async () => {
      const hippocampusDir = path.join(mathaDir, 'hippocampus')
      await fs.mkdir(hippocampusDir, { recursive: true })
      await fs.writeFile(
        path.join(hippocampusDir, 'open-questions.json'),
        JSON.stringify({ other: 'data' }),
        'utf-8',
      )

      const result = await getOpenQuestions(mathaDir)
      expect(result).toEqual([])
    })
  })

  // ── recordOpenQuestion ───────────────────────────────────────────

  describe('recordOpenQuestion', () => {
    it('creates open-questions.json with the question if file does not exist', async () => {
      const question: OpenQuestion = {
        id: 'oq-001',
        question: 'How to handle cold start?',
        context: 'New projects',
        status: 'open',
      }

      await recordOpenQuestion(mathaDir, question)

      const questionPath = path.join(
        mathaDir,
        'hippocampus',
        'open-questions.json',
      )
      const content = JSON.parse(await fs.readFile(questionPath, 'utf-8'))
      expect(content.questions).toEqual([question])
    })

    it('appends question to existing open-questions.json', async () => {
      const hippocampusDir = path.join(mathaDir, 'hippocampus')
      await fs.mkdir(hippocampusDir, { recursive: true })

      const existingQuestion: OpenQuestion = {
        id: 'oq-001',
        question: 'First question?',
        context: 'Context A',
        status: 'open',
      }

      await fs.writeFile(
        path.join(hippocampusDir, 'open-questions.json'),
        JSON.stringify({ questions: [existingQuestion] }),
        'utf-8',
      )

      const newQuestion: OpenQuestion = {
        id: 'oq-002',
        question: 'Second question?',
        context: 'Context B',
        status: 'open',
      }

      await recordOpenQuestion(mathaDir, newQuestion)

      const questionPath = path.join(hippocampusDir, 'open-questions.json')
      const content = JSON.parse(await fs.readFile(questionPath, 'utf-8'))
      expect(content.questions).toHaveLength(2)
      expect(content.questions[1]).toEqual(newQuestion)
    })
  })
})
