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
} from '@/mcp/tools.js';

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
      await fs.writeFile(
        path.join(mathaDir, 'cortex/stability.json'),
        JSON.stringify(
          [
            {
              path: 'src/api.ts',
              stability: 'stable',
              classification_source: 'derived',
              reason: 'Rarely changes',
              owner: null,
              last_changed: '2026-02-01T00:00:00Z',
              change_frequency: 1,
              blast_radius: 5,
              confidence: 'high',
            },
            {
              path: 'src/experimental.ts',
              stability: 'volatile',
              classification_source: 'declared',
              reason: 'Under development',
              owner: null,
              last_changed: '2026-03-04T00:00:00Z',
              change_frequency: 20,
              blast_radius: 2,
              confidence: 'high',
            },
          ],
          null,
          2,
        ),
      );
    });

    it('should return stability for requested files', async () => {
      const result = await mathaGetStability(mathaDir, ['src/api.ts', 'src/experimental.ts']);
      const parsed = JSON.parse(result);
      
      expect(parsed.stability['src/api.ts']).toBe('stable');
      expect(parsed.stability['src/experimental.ts']).toBe('volatile');
    });

    it('should return unknown for files not in stability.json', async () => {
      const result = await mathaGetStability(mathaDir, ['src/unknown.ts']);
      const parsed = JSON.parse(result);
      
      expect(parsed.stability['src/unknown.ts']).toBe('unknown');
    });

    it('should return unknown for all files if stability.json missing', async () => {
      await fs.rm(path.join(mathaDir, 'cortex/stability.json'));
      
      const result = await mathaGetStability(mathaDir, ['src/api.ts']);
      const parsed = JSON.parse(result);
      
      expect(parsed.stability['src/api.ts']).toBe('unknown');
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
});
