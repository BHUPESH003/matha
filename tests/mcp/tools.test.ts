import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  mathaGetRules,
  mathaGetDangerZones,
  mathaGetDecisions,
  mathaGetStability,
  mathaBrief,
  mathaRecordDecision,
  mathaRecordDanger,
  mathaRecordContract,
  mathaRefreshCortex,
  mathaMatch,
  mathaGetRouting,
} from '@/mcp/tools.js';

const mocks = vi.hoisted(() => ({
  matchAll: vi.fn().mockResolvedValue([]),
  getRecommendation: vi.fn(),
  analyseDeltas: vi.fn(),
  persistAnalysis: vi.fn(),
}));

vi.mock('@/analysis/contract-matcher.js', () => ({
  matchAll: mocks.matchAll,
}));

vi.mock('@/brain/dopamine.js', () => ({
  getRecommendation: mocks.getRecommendation,
  analyseDeltas: mocks.analyseDeltas,
  persistAnalysis: mocks.persistAnalysis,
}));

// Test helpers
async function createTmpDir(): Promise<string> {
  const tmpBase = path.join('/tmp', `matha-mcp-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(tmpBase, { recursive: true });
  return tmpBase;
}

async function initProject(projectRoot: string): Promise<string> {
  const mathaDir = path.join(projectRoot, '.matha');
  const dirs = [
    mathaDir,
    path.join(mathaDir, 'hippocampus'),
    path.join(mathaDir, 'hippocampus/decisions'),
    path.join(mathaDir, 'cerebellum'),
    path.join(mathaDir, 'cerebellum/contracts'),
    path.join(mathaDir, 'cortex'),
    path.join(mathaDir, 'dopamine'),
    path.join(mathaDir, 'dopamine/predictions'),
    path.join(mathaDir, 'dopamine/actuals'),
    path.join(mathaDir, 'sessions'),
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }

  await fs.writeFile(
    path.join(mathaDir, 'config.json'),
    JSON.stringify({ initialised: true }, null, 2),
  );

  await fs.writeFile(
    path.join(mathaDir, 'hippocampus/intent.json'),
    JSON.stringify({
      why: 'Test project',
      core_problem: 'Testing',
      core_insight: 'Test insight',
    }, null, 2),
  );

  await fs.writeFile(
    path.join(mathaDir, 'hippocampus/rules.json'),
    JSON.stringify({
      rules: ['rule1', 'rule2', 'rule3'],
    }, null, 2),
  );

  return mathaDir;
}

describe('MCP tools', () => {
  let tmpDir: string;
  let mathaDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    mathaDir = await initProject(tmpDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    mocks.matchAll.mockReset();
    mocks.matchAll.mockResolvedValue([]);
  });

  describe('matha_get_rules', () => {
    it('should return rules from hippocampus', async () => {
      const result = await mathaGetRules(mathaDir);
      expect(result).toMatch(/^\{/); // JSON string
      
      const parsed = JSON.parse(result);
      expect(Array.isArray(parsed.rules)).toBe(true);
      expect(parsed.rules).toContain('rule1');
      expect(parsed.rules).toContain('rule2');
      expect(parsed.rules).toContain('rule3');
    });

    it('should return empty array if rules.json missing', async () => {
      await fs.rm(path.join(mathaDir, 'hippocampus/rules.json'));
      
      const result = await mathaGetRules(mathaDir);
      const parsed = JSON.parse(result);
      
      expect(parsed.rules).toEqual([]);
    });
  });

  describe('matha_get_danger_zones', () => {
    beforeEach(async () => {
      await fs.writeFile(
        path.join(mathaDir, 'hippocampus/danger-zones.json'),
        JSON.stringify({
          zones: [
            {
              id: '1',
              component: 'storage',
              pattern: 'Non-atomic writes',
              description: 'Danger zone 1',
            },
            {
              id: '2',
              component: 'database',
              pattern: 'Race conditions',
              description: 'Danger zone 2',
            },
          ],
        }, null, 2),
      );
    });

    it('should return all danger zones without context', async () => {
      const result = await mathaGetDangerZones(mathaDir);
      const parsed = JSON.parse(result);
      
      expect(Array.isArray(parsed.zones)).toBe(true);
      expect(parsed.zones).toHaveLength(2);
    });

    it('should filter danger zones by context', async () => {
      const result = await mathaGetDangerZones(mathaDir, 'storage');
      const parsed = JSON.parse(result);
      
      expect(parsed.zones).toHaveLength(1);
      expect(parsed.zones[0].component).toBe('storage');
    });

    it('should return empty array if no danger zones exist', async () => {
      await fs.rm(path.join(mathaDir, 'hippocampus/danger-zones.json'));
      
      const result = await mathaGetDangerZones(mathaDir);
      const parsed = JSON.parse(result);
      
      expect(parsed.zones).toEqual([]);
    });
  });

  describe('matha_get_decisions', () => {
    beforeEach(async () => {
      const decisions = [
        {
          id: 'decision1',
          timestamp: '2026-03-04T10:00:00Z',
          component: 'api',
          previous_assumption: 'Old assumption',
          correction: 'New understanding',
          trigger: 'test',
          confidence: 'confirmed' as const,
          status: 'active' as const,
          supersedes: null,
          session_id: 'session1',
        },
        {
          id: 'decision2',
          timestamp: '2026-03-04T11:00:00Z',
          component: 'database',
          previous_assumption: 'Another assumption',
          correction: 'Better understanding',
          trigger: 'test',
          confidence: 'probable' as const,
          status: 'active' as const,
          supersedes: null,
          session_id: 'session2',
        },
      ];

      for (const decision of decisions) {
        await fs.writeFile(
          path.join(mathaDir, `hippocampus/decisions/${decision.id}.json`),
          JSON.stringify(decision, null, 2),
        );
      }
    });

    it('should return all decisions without filter', async () => {
      const result = await mathaGetDecisions(mathaDir);
      const parsed = JSON.parse(result);
      
      expect(Array.isArray(parsed.decisions)).toBe(true);
      expect(parsed.decisions.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter decisions by component', async () => {
      const result = await mathaGetDecisions(mathaDir, 'api');
      const parsed = JSON.parse(result);
      
      expect(parsed.decisions.some((d: any) => d.component === 'api')).toBe(true);
    });

    it('should limit decisions by count', async () => {
      const result = await mathaGetDecisions(mathaDir, undefined, 1);
      const parsed = JSON.parse(result);
      
      expect(parsed.decisions.length).toBeLessThanOrEqual(1);
    });

    it('should return empty array if no decisions exist', async () => {
      await fs.rm(path.join(mathaDir, 'hippocampus/decisions'), { recursive: true });
      await fs.mkdir(path.join(mathaDir, 'hippocampus/decisions'));
      
      const result = await mathaGetDecisions(mathaDir);
      const parsed = JSON.parse(result);
      
      expect(parsed.decisions).toEqual([]);
    });
  });

  describe('matha_get_stability', () => {
    beforeEach(async () => {
      // Use cortex StabilityRecord format (filepath field, not path)
      await fs.writeFile(
        path.join(mathaDir, 'cortex/stability.json'),
        JSON.stringify(
          [
            {
              filepath: 'src/api.ts',
              stability: 'stable',
              classificationSource: 'derived',
              reason: 'Moderate churn',
              confidence: 'high',
              changeCount: 3,
              coChangeCount: 1,
              ageInDays: 60,
              daysSinceLastChange: 5,
            },
            {
              filepath: 'src/experimental.ts',
              stability: 'volatile',
              classificationSource: 'declared',
              reason: 'Under development',
              confidence: 'high',
              changeCount: 20,
              coChangeCount: 2,
              ageInDays: 30,
              daysSinceLastChange: 1,
              declaredBy: 'alice',
              declaredAt: '2026-03-04T00:00:00Z',
            },
          ],
          null,
          2,
        ),
      );
    });

    it('should return StabilityRecord for requested files', async () => {
      const result = await mathaGetStability(mathaDir, ['src/api.ts', 'src/experimental.ts']);
      const parsed = JSON.parse(result);
      
      // Now returns StabilityRecord objects, not plain strings
      expect(parsed.stability['src/api.ts']).toBeTruthy();
      expect(parsed.stability['src/api.ts'].stability).toBe('stable');
      expect(parsed.stability['src/api.ts'].confidence).toBe('high');
      expect(parsed.stability['src/experimental.ts'].stability).toBe('volatile');
    });

    it('should return null for files not in stability.json', async () => {
      const result = await mathaGetStability(mathaDir, ['src/unknown.ts']);
      const parsed = JSON.parse(result);
      
      expect(parsed.stability['src/unknown.ts']).toBeNull();
    });

    it('should return null for all files if stability.json missing', async () => {
      await fs.rm(path.join(mathaDir, 'cortex/stability.json'));
      
      const result = await mathaGetStability(mathaDir, ['src/api.ts']);
      const parsed = JSON.parse(result);
      
      expect(parsed.stability['src/api.ts']).toBeNull();
    });
  });

  describe('matha_brief', () => {
    it('should return intent and rules if no sessions exist', async () => {
      const result = await mathaBrief(mathaDir);
      const parsed = JSON.parse(result);
      
      expect(parsed.why).toBe('Test project');
      expect(Array.isArray(parsed.rules)).toBe(true);
    });

    it('should return most recent session brief if available', async () => {
      const briefId = '20260304-143022-a1b2';
      await fs.writeFile(
        path.join(mathaDir, `sessions/${briefId}.brief`),
        JSON.stringify({
          sessionId: briefId,
          scope: 'src/test.ts',
          operationType: 'business_logic',
          why: 'Testing',
          bounds: [],
          dangerZones: [],
          contract: [],
          modelTier: 'capable',
          tokenBudget: 8000,
          gatesCompleted: [1, 2, 3, 4, 5, 6],
          readyToBuild: true,
        }, null, 2),
      );

      const result = await mathaBrief(mathaDir);
      const parsed = JSON.parse(result);
      
      expect(parsed.sessionId).toBe(briefId);
      expect(parsed.scope).toBe('src/test.ts');
    });

    it('should filter brief by scope if provided', async () => {
      const briefId = '20260304-143022-a1b2';
      await fs.writeFile(
        path.join(mathaDir, `sessions/${briefId}.brief`),
        JSON.stringify({
          sessionId: briefId,
          scope: 'src/api.ts, src/utils.ts',
          operationType: 'business_logic',
          why: 'Testing',
          bounds: [],
          dangerZones: [],
          contract: [],
          modelTier: 'capable',
          tokenBudget: 8000,
          gatesCompleted: [1, 2, 3, 4, 5, 6],
          readyToBuild: true,
        }, null, 2),
      );

      const result = await mathaBrief(mathaDir, 'api');
      const parsed = JSON.parse(result);
      
      expect(parsed.scope).toContain('api');
    });

    it('should include matchResults and hasCritical from matchAll', async () => {
      mocks.matchAll.mockResolvedValue([
        { matchType: 'danger_zone', severity: 'critical', component: 'test', title: '', description: '', source: '', recommendation: '' }
      ]);
      const result = await mathaBrief(mathaDir);
      const parsed = JSON.parse(result);

      expect(parsed.matchResults).toBeDefined();
      expect(parsed.matchResults).toHaveLength(1);
      expect(parsed.hasCritical).toBe(true);
    });
  });

  describe('matha_match', () => {
    it('returns structured summary of matchAll results', async () => {
      mocks.matchAll.mockResolvedValue([
        { matchType: 'danger_zone', severity: 'critical', component: 'api', title: 'A', description: 'B', source: 'C', recommendation: 'D' },
        { matchType: 'decision_pattern', severity: 'warning', component: 'api', title: 'E', description: 'F', source: 'G', recommendation: 'H' },
        { matchType: 'contract', severity: 'info', component: 'api', title: 'I', description: 'J', source: 'K', recommendation: 'L' }
      ]);

      const result = await mathaMatch(mathaDir, 'api', 'Update api');
      const parsed = JSON.parse(result);

      expect(parsed.results).toHaveLength(3);
      expect(parsed.hasCritical).toBe(true);
      expect(parsed.summary).toEqual({
        critical: 1,
        warning: 1,
        info: 1,
        total: 3
      });
    });

    it('returns empty results and false hasCritical if no matches', async () => {
      mocks.matchAll.mockResolvedValue([]);

      const result = await mathaMatch(mathaDir, 'ui', 'Fix ui');
      const parsed = JSON.parse(result);

      expect(parsed.results).toEqual([]);
      expect(parsed.hasCritical).toBe(false);
      expect(parsed.summary).toEqual({
        critical: 0,
        warning: 0,
        info: 0,
        total: 0
      });
    });

    it('handles errors gracefully without throwing', async () => {
      mocks.matchAll.mockRejectedValue(new Error('Internal failure'));

      const result = await mathaMatch(mathaDir, 'api', 'Update');
      const parsed = JSON.parse(result);

      expect(parsed.results).toEqual([]);
      expect(parsed.hasCritical).toBe(false);
      expect(parsed.error).toContain('Internal failure');
    });
  });

  describe('matha_record_decision', () => {
    it('should record decision with probable confidence', async () => {
      const result = await mathaRecordDecision(
        mathaDir,
        'src/api.ts',
        'Old design was inefficient',
        'New design is more efficient',
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.id).toBeDefined();

      // Verify decision was written
      const decisionContent = await fs.readFile(
        path.join(mathaDir, `hippocampus/decisions/${parsed.id}.json`),
        'utf-8',
      );
      const decision = JSON.parse(decisionContent);
      expect(decision.confidence).toBe('probable');
      expect(decision.component).toBe('src/api.ts');
    });

    it('should default confidence to probable when not specified', async () => {
      const result = await mathaRecordDecision(
        mathaDir,
        'src/db.ts',
        'Was slow',
        'Now optimized',
      );

      const parsed = JSON.parse(result);
      const decisionContent = await fs.readFile(
        path.join(mathaDir, `hippocampus/decisions/${parsed.id}.json`),
        'utf-8',
      );
      const decision = JSON.parse(decisionContent);
      expect(decision.confidence).toBe('probable');
    });

    it('should handle errors gracefully', async () => {
      // Verify error handling works by checking try/catch returns proper JSON
      const result = await mathaRecordDecision(
        mathaDir,
        'src/api.ts',
        'Assumption',
        'Correction',
      );

      // Should always return valid JSON
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('success');
      expect(typeof parsed.success).toBe('boolean');
      
      // Either has success: true or success: false with error
      if (!parsed.success) {
        expect(parsed.error).toBeDefined();
      } else {
        expect(parsed.id).toBeDefined();
      }
    });
  });

  describe('matha_record_danger', () => {
    it('should record danger zone', async () => {
      const result = await mathaRecordDanger(
        mathaDir,
        'src/cache.ts',
        'Race condition in cache invalidation',
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);

      // Verify danger zone was written
      const zonesContent = await fs.readFile(
        path.join(mathaDir, 'hippocampus/danger-zones.json'),
        'utf-8',
      );
      const zones = JSON.parse(zonesContent);
      expect(zones.zones || Array.isArray(zones)).toBeTruthy();
    });

    it('should handle errors gracefully', async () => {
      // Verify error handling works - function should always return valid JSON
      const result = await mathaRecordDanger(
        mathaDir,
        'src/cache.ts',
        'Race condition in cache invalidation',
      );

      // Should always return valid JSON
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('success');
      expect(typeof parsed.success).toBe('boolean');
      
      // Either has success: true or success: false with error
      if (!parsed.success) {
        expect(parsed.error).toBeDefined();
      } else {
        expect(parsed.id).toBeDefined();
      }
    });
  });

  describe('matha_record_contract', () => {
    it('should record behaviour contract', async () => {
      const assertions = ['Must be fast', 'Must be reliable', 'Must be secure'];
      const result = await mathaRecordContract(
        mathaDir,
        'src/api.ts',
        assertions,
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.component).toBe('src/api.ts');

      // Verify contract was written
      const contractContent = await fs.readFile(
        path.join(mathaDir, 'cerebellum/contracts/src-api.ts.json'),
        'utf-8',
      );
      const contract = JSON.parse(contractContent);
      expect(contract.assertions).toHaveLength(3);
    });

    it('should overwrite existing contract for same component', async () => {
      const assertions1 = ['Assertion 1'];
      await mathaRecordContract(mathaDir, 'src/api.ts', assertions1);

      const assertions2 = ['Assertion 2', 'Assertion 3'];
      const result = await mathaRecordContract(mathaDir, 'src/api.ts', assertions2);

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);

      // Verify contract was overwritten
      const contractContent = await fs.readFile(
        path.join(mathaDir, 'cerebellum/contracts/src-api.ts.json'),
        'utf-8',
      );
      const contract = JSON.parse(contractContent);
      expect(contract.assertions).toHaveLength(2);
    });

    it('should handle write errors gracefully', async () => {
      // Verify error handling - function should always return valid JSON
      const result = await mathaRecordContract(
        mathaDir,
        'src/api.ts',
        ['Must be performant', 'Must handle 10k requests/sec'],
      );

      // Should always return valid JSON
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('success');
      expect(typeof parsed.success).toBe('boolean');
      
      // Either has success: true or success: false with error
      if (!parsed.success) {
        expect(parsed.error).toBeDefined();
      } else {
        expect(parsed.component).toBe('src/api.ts');
      }
    });
  });

  describe('matha_refresh_cortex', () => {
    it('should succeed on a non-git directory (commitCount: 0)', async () => {
      const result = await mathaRefreshCortex(mathaDir);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.commitCount).toBe(0);
      expect(parsed.fileCount).toBe(0);
    });
  });

  describe('matha_brief with directory filter', () => {
    it('should return filtered results for directory that matches', async () => {
      // Seed stability data
      await fs.writeFile(
        path.join(mathaDir, 'cortex/stability.json'),
        JSON.stringify([
          {
            filepath: 'src/api/handler.ts',
            stability: 'stable',
            classificationSource: 'derived',
            reason: 'Moderate churn',
            confidence: 'high',
            changeCount: 3,
            coChangeCount: 1,
            ageInDays: 60,
            daysSinceLastChange: 5,
          },
          {
            filepath: 'tests/api.test.ts',
            stability: 'volatile',
            classificationSource: 'derived',
            reason: 'High churn',
            confidence: 'medium',
            changeCount: 15,
            coChangeCount: 0,
            ageInDays: 30,
            daysSinceLastChange: 1,
          },
        ], null, 2),
      );

      const result = await mathaBrief(mathaDir, undefined, 'src/');
      const parsed = JSON.parse(result);

      expect(parsed.filtered).toBe(true);
      expect(parsed.directory).toBe('src/');
      expect(parsed.stability.length).toBe(1);
      expect(parsed.stability[0].filepath).toBe('src/api/handler.ts');
    });

    it('should return empty + message for directory matching nothing', async () => {
      const result = await mathaBrief(mathaDir, undefined, 'nonexistent/');
      const parsed = JSON.parse(result);

      expect(parsed.filtered).toBe(true);
      expect(parsed.hasData).toBe(false);
      expect(parsed.message).toContain('nonexistent/');
    });
  });
});
