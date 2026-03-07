import { describe, it, expect, beforeEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import {
  matchAll,
  matchDangerZones,
  matchContracts,
  matchFrozenFiles,
  matchDecisionPatterns,
  extractKeywords,
  MatchContext,
} from '@/analysis/contract-matcher.js'

describe('Contract Matcher', () => {
  const mathaDir = path.join(process.cwd(), '.matha-test-matcher')

  beforeEach(async () => {
    // Clean and setup temp dir
    await fs.rm(mathaDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('extractKeywords', () => {
    it('filters out short words (<= 4 chars)', () => {
      const result = extractKeywords('cat dog house tree')
      expect(result).toEqual(['house'])
    })

    it('filters out common stop words', () => {
      const text = 'should never always before after every which their there where when would could might using being having actual relevant'
      const result = extractKeywords(text)
      expect(result).toEqual(['actual', 'relevant'])
    })

    it('ignores case and punctuation', () => {
      const result = extractKeywords('Hello, World! This is GREAT.')
      expect(result).toEqual(['hello', 'world', 'great'])
    })
  })

  describe('matchDangerZones', () => {
    const zones = [
      {
        component: 'database/schema',
        description: 'Migration scripts must be backwards compatible',
        severity: 'critical' as const,
      },
    ]

    it('matches by component in scope', () => {
      const context: MatchContext = { scope: 'Database/Schema, other', intent: 'Add column', operationType: 'build' }
      const results = matchDangerZones(context, zones)
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe('critical')
      expect(results[0].title).toBe('Danger Zone: database/schema')
      expect(results[0].matchType).toBe('danger_zone')
    })

    it('matches by component in intent', () => {
      const context: MatchContext = { scope: 'api', intent: 'Updating database/schema for user table', operationType: 'build' }
      const results = matchDangerZones(context, zones)
      expect(results).toHaveLength(1)
      expect(results[0].component).toBe('database/schema')
    })

    it('matches by keyword extracted from description', () => {
      // 'Migration' and 'compatible' are long words in the description
      const context: MatchContext = { scope: 'api', intent: 'Writing new migration script', operationType: 'build' }
      const results = matchDangerZones(context, zones)
      expect(results).toHaveLength(1)
      expect(results[0].component).toBe('database/schema')
    })

    it('returns empty array when no match', () => {
      const context: MatchContext = { scope: 'ui', intent: 'Fix button color', operationType: 'build' }
      const results = matchDangerZones(context, zones)
      expect(results).toHaveLength(0)
    })
  })

  describe('matchContracts', () => {
    const contracts = {
      'src/payments': {
        component: 'src/payments',
        version: 1,
        last_updated: '2026-01-01T00:00:00Z',
        assertions: [
          { id: '1', description: 'must mock stripe', type: 'test', status: 'active', violation_count: 0, last_violated: null },
        ],
      },
      'src/auth': {
        component: 'src/auth',
        version: 1,
        last_updated: '2026-01-01T00:00:00Z',
        assertions: [
          { id: '2', description: 'no cleartext passwords', type: 'security', status: 'active', violation_count: 3, last_violated: '2026-03-01' },
          { id: '3', description: 'use latest crypto', type: 'security', status: 'active', violation_count: 0, last_violated: null },
        ],
      },
    }

    it('matches scope and returns info when no violations', () => {
      const context: MatchContext = { scope: 'src/payments', intent: 'Update gateway', operationType: 'build' }
      const results = matchContracts(context, contracts)
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe('info')
      expect(results[0].matchType).toBe('contract')
    })

    it('matches scope and returns critical when violations exist', () => {
      const context: MatchContext = { scope: 'SRC/AUTH, another', intent: 'Add auth provider', operationType: 'build' }
      const results = matchContracts(context, contracts)
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe('critical')
      expect(results[0].description).toContain('Previously violated')
    })

    it('returns empty array when no scope match', () => {
      const context: MatchContext = { scope: 'src/components', intent: 'Fix ui', operationType: 'build' }
      const results = matchContracts(context, contracts)
      expect(results).toHaveLength(0)
    })
  })

  describe('matchFrozenFiles', () => {
    const stabilityRecords = [
      {
        filepath: 'core/engine.ts',
        stability: 'frozen',
        classificationSource: 'declared',
        reason: 'Mission critical performance',
        confidence: 'high',
        changeCount: 1,
        coChangeCount: 0,
        ageInDays: 100,
        daysSinceLastChange: 50,
      },
      {
        filepath: 'ui/button.ts',
        stability: 'volatile',
        classificationSource: 'derived',
        reason: 'High churn',
        confidence: 'medium',
        changeCount: 10,
        coChangeCount: 2,
        ageInDays: 10,
        daysSinceLastChange: 1,
      },
    ]

    it('matches specified filepaths that are frozen', () => {
      const context: MatchContext = { scope: 'core', intent: 'refactor', operationType: 'build', filepaths: ['core/engine.ts', 'ui/button.ts'] }
      const results = matchFrozenFiles(context, stabilityRecords)
      expect(results).toHaveLength(1)
      expect(results[0].severity).toBe('critical')
      expect(results[0].matchType).toBe('frozen_file')
      expect(results[0].component).toBe('core/engine.ts')
    })

    it('matches frozen files by scope substring if filepaths omitted', () => {
      const context: MatchContext = { scope: 'engine', intent: 'refactor', operationType: 'build' }
      const results = matchFrozenFiles(context, stabilityRecords)
      expect(results).toHaveLength(1)
      expect(results[0].component).toBe('core/engine.ts')
    })

    it('returns empty array if no frozen files matched', () => {
      const context: MatchContext = { scope: 'engine', intent: 'refactor', operationType: 'build', filepaths: ['ui/button.ts'] }
      const results = matchFrozenFiles(context, stabilityRecords)
      expect(results).toHaveLength(0)
    })
  })

  describe('matchDecisionPatterns', () => {
    const decisions = [
      { id: '1', component: 'auth', status: 'active', previous_assumption: 'A', correction: 'B', timestamp: '2026-03-01T00:00:00Z' },
      { id: '2', component: 'auth', status: 'deprecated', previous_assumption: 'C', correction: 'D', timestamp: '2026-03-02T00:00:00Z' },
      { id: '3', component: 'auth', status: 'active', previous_assumption: 'E', correction: 'F', timestamp: '2026-03-03T00:00:00Z' },
      { id: '4', component: 'auth', status: 'active', previous_assumption: 'G', correction: 'H', timestamp: '2026-03-04T00:00:00Z' },
      { id: '5', component: 'auth', status: 'active', previous_assumption: 'I', correction: 'J', timestamp: '2026-03-05T00:00:00Z' },
    ]

    it('returns active matches as warnings', () => {
      const context: MatchContext = { scope: 'auth', intent: 'update', operationType: 'build' }
      const results = matchDecisionPatterns(context, decisions)
      // Expect 3 most recent active (5, 4, 3)
      expect(results).toHaveLength(3)
      expect(results[0].severity).toBe('warning')
      expect(results[0].matchType).toBe('decision_pattern')
      
      const corrections = results.map(r => r.description)
      // They should contain the corrections from the 3 most recent active decisions
      expect(corrections.some(c => c.includes('Correction: J'))).toBe(true)
      expect(corrections.some(c => c.includes('Correction: H'))).toBe(true)
      expect(corrections.some(c => c.includes('Correction: F'))).toBe(true)
      expect(corrections.some(c => c.includes('Correction: B'))).toBe(false) // too old
      expect(corrections.some(c => c.includes('Correction: D'))).toBe(false) // deprecated
    })

    it('returns empty when no scope match', () => {
      const context: MatchContext = { scope: 'ui', intent: 'update', operationType: 'build' }
      const results = matchDecisionPatterns(context, decisions)
      expect(results).toHaveLength(0)
    })
  })

  describe('matchAll integration', () => {
    it('returns empty array cleanly when no data exists (no throw)', async () => {
      // mathaDir is totally empty
      const context: MatchContext = { scope: 'test', intent: 'testing', operationType: 'build' }
      const results = await matchAll(context, mathaDir)
      expect(results).toEqual([])
    })

    it('returns deduplicated and sorted results', async () => {
      // Populate mock data into the filesystem
      await fs.mkdir(path.join(mathaDir, 'hippocampus', 'decisions'), { recursive: true })
      await fs.mkdir(path.join(mathaDir, 'cortex'), { recursive: true })
      await fs.mkdir(path.join(mathaDir, 'cerebellum', 'contracts'), { recursive: true })

      // Danger Zone
      await fs.writeFile(
        path.join(mathaDir, 'hippocampus', 'danger-zones.json'),
        JSON.stringify({ zones: [{ component: 'auth', description: 'Be careful with auth' }] })
      )

      // Contract
      await fs.writeFile(
        path.join(mathaDir, 'cerebellum', 'contracts', 'auth.json'),
        JSON.stringify({ component: 'auth', assertions: [] })
      )

      // Frozen File
      await fs.writeFile(
        path.join(mathaDir, 'cortex', 'stability.json'),
        JSON.stringify([
          { filepath: 'auth/token.ts', stability: 'frozen', reason: 'critical' }
        ])
      )

      // Decision
      await fs.writeFile(
        path.join(mathaDir, 'hippocampus', 'decisions', '1.json'),
        JSON.stringify({ id: '1', component: 'auth', status: 'active', previous_assumption: 'A', correction: 'B', timestamp: '2026-03-01' })
      )

      const context: MatchContext = { scope: 'auth', intent: 'update auth/token.ts', filepaths: ['auth/token.ts'], operationType: 'build' }
      const results = await matchAll(context, mathaDir)

      // We expect matches from all 4 systems
      // Danger zone (critical)
      // Frozen file (critical)
      // Contract (info - no violations)
      // Decision (warning)

      expect(results.length).toBe(4)
      
      // Check sorting: critical -> warning -> info
      expect(results[0].severity).toBe('critical')
      expect(results[1].severity).toBe('critical')
      expect(results[2].severity).toBe('warning') // Decision
      expect(results[3].severity).toBe('info') // Contract
    })

    it('deduplicates exact same matchType and component', async () => {
      // If we somehow get two danger zones for 'auth', dedup them
      await fs.mkdir(path.join(mathaDir, 'hippocampus'), { recursive: true })
      await fs.writeFile(
        path.join(mathaDir, 'hippocampus', 'danger-zones.json'),
        JSON.stringify({ zones: [
          { component: 'auth', description: 'desc 1' },
          { component: 'auth', description: 'desc 2' }
        ]})
      )

      const context: MatchContext = { scope: 'auth', intent: 'test', operationType: 'build' }
      const results = await matchAll(context, mathaDir)
      
      expect(results.length).toBe(1) // deduped
      expect(results[0].matchType).toBe('danger_zone')
    })
  })
})
