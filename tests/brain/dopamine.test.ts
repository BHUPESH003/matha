import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

vi.mock('fs/promises');
vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return {
    ...actual,
    join: vi.fn((...args) => actual.join(...args)),
  };
});

// We must mock readJsonOrNull and writeAtomic which are used internally
vi.mock('@/storage/reader.js', () => ({
  readJsonOrNull: vi.fn()
}));

vi.mock('@/storage/writer.js', () => ({
  writeAtomic: vi.fn()
}));

import { readJsonOrNull } from '@/storage/reader.js';
import { writeAtomic } from '@/storage/writer.js';
import {
  analyseDeltas,
  buildRoutingRules,
  buildConfidence,
  getRecommendation,
  persistAnalysis,
  DeltaRecord
} from '@/brain/dopamine.js';

describe('Dopamine Loop Analytics', () => {
  const mockMathaDir = '/mock/matha/dir';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('analyseDeltas', () => {
    it('should return empty analysis and not throw if deltas.json is missing or invalid', async () => {
      vi.mocked(readJsonOrNull).mockResolvedValueOnce(null);

      const result = await analyseDeltas(mockMathaDir);
      
      expect(result.sessionCount).toBe(0);
      expect(result.globalAvgTokenDelta).toBe(0);
      expect(result.overBudgetRate).toBe(0);
      expect(result.routingRules).toEqual([]);
      expect(result.componentConfidence).toEqual([]);
      expect(vi.mocked(readJsonOrNull)).toHaveBeenCalledWith(path.join(mockMathaDir, 'dopamine/deltas.json'));
    });

    it('should return empty analysis and not throw if deltas array is empty', async () => {
      vi.mocked(readJsonOrNull).mockResolvedValueOnce([]);

      const result = await analyseDeltas(mockMathaDir);
      
      expect(result.sessionCount).toBe(0);
    });

    it('should calculate globalAvgTokenDelta and overBudgetRate excluding null tokens', async () => {
      const mockDeltas: DeltaRecord[] = [
        { session_id: '1', timestamp: '2026-01-01', operation_type: 'test', contract_result: 'passed', token_delta: 2000, files_changed: 1, model_tier_used: 'lightweight' },
        { session_id: '2', timestamp: '2026-01-01', operation_type: 'test', contract_result: 'passed', token_delta: -1000, files_changed: 1, model_tier_used: 'lightweight' },
        { session_id: '3', timestamp: '2026-01-01', operation_type: 'test', contract_result: 'passed', token_delta: null, files_changed: 1, model_tier_used: 'lightweight' }
      ];
      vi.mocked(readJsonOrNull).mockResolvedValueOnce(mockDeltas);

      const result = await analyseDeltas(mockMathaDir);
      
      // Avg of 2000 and -1000 = 500. Null is ignored.
      expect(result.globalAvgTokenDelta).toBe(500);
      // 1 over budget out of 2 valid entries = 0.5
      expect(result.overBudgetRate).toBe(0.5);
      expect(result.sessionCount).toBe(3);
    });
  });

  describe('buildRoutingRules', () => {
    const baseRecord: Omit<DeltaRecord, 'session_id'|'token_delta'|'contract_result'> = {
      timestamp: '2026-01-01', files_changed: 1, model_tier_used: 'lightweight', operation_type: 'business_logic'
    };

    it('should generate no rule for operation types with < 3 samples', () => {
      const deltas: DeltaRecord[] = [
        { ...baseRecord, session_id: '1', token_delta: 6000, contract_result: 'passed' },
        { ...baseRecord, session_id: '2', token_delta: 6000, contract_result: 'passed' }
      ];
      
      const rules = buildRoutingRules(deltas);
      expect(rules).toHaveLength(0);
    });

    it('should upgrade tier and set HIGH confidence for >5000 avg delta with 10+ samples', () => {
      const deltas: DeltaRecord[] = Array(10).fill(null).map((_, i) => ({
        ...baseRecord, session_id: String(i), token_delta: 6000, contract_result: 'passed'
      }));
      
      const rules = buildRoutingRules(deltas);
      expect(rules).toHaveLength(1);
      
      const rule = rules[0];
      expect(rule.operation_type).toBe('business_logic');
      expect(rule.confidence).toBe('high');
      expect(rule.sample_size).toBe(10);
      // original business_logic default is 'capable' (8000).
      // > 5000 means upgrade. capable -> capable (no higher tier).
      // budget: 8000 + 6000 = 14000.
      expect(rule.recommended_tier).toBe('capable');
      expect(rule.recommended_budget).toBe(14000);
      expect(rule.component_pattern).toBe('');
      expect(rule.avg_token_delta).toBe(6000);
    });

    it('should downgrade tier for consistently under budget (<-2000) and set MEDIUM confidence (5+ samples)', () => {
      const deltas: DeltaRecord[] = Array(5).fill(null).map((_, i) => ({
        ...baseRecord, session_id: String(i), token_delta: -3000, contract_result: 'passed'
      }));
      
      const rules = buildRoutingRules(deltas);
      expect(rules).toHaveLength(1);
      
      const rule = rules[0];
      // original business_logic default is 'capable' (8000).
      // downgrade capable -> mid.
      expect(rule.recommended_tier).toBe('mid');
      // budget: 8000 + -3000 = 5000.
      expect(rule.recommended_budget).toBe(5000);
      expect(rule.confidence).toBe('medium');
    });

    it('should keep original tier for neutral delta (-2000 to +5000) and set LOW confidence (3+ samples)', () => {
      const deltas: DeltaRecord[] = Array(3).fill(null).map((_, i) => ({
        ...baseRecord, session_id: String(i), token_delta: 1000, contract_result: 'passed',
        operation_type: 'rename/crud'
      }));
      
      const rules = buildRoutingRules(deltas);
      expect(rules).toHaveLength(1);
      
      const rule = rules[0];
      // original rename/crud default is 'lightweight' (2000).
      expect(rule.recommended_tier).toBe('lightweight');
      // budget: 2000 + 1000 = 3000.
      expect(rule.recommended_budget).toBe(3000);
      expect(rule.confidence).toBe('low');
    });

    it('should floor recommended budget at 500', () => {
      const deltas: DeltaRecord[] = Array(3).fill(null).map((_, i) => ({
        ...baseRecord, session_id: String(i), token_delta: -8000, contract_result: 'passed',
        operation_type: 'unknown'
      })); // default unknown is 'mid' (4000)
      
      const rules = buildRoutingRules(deltas);
      expect(rules[0].recommended_budget).toBe(500);
    });

    it('should exclude null token_deltas when calculating operations avg', () => {
      const deltas: DeltaRecord[] = [
        { ...baseRecord, session_id: '1', token_delta: 6000, contract_result: 'passed', operation_type: 'unknown' },
        { ...baseRecord, session_id: '2', token_delta: 6000, contract_result: 'passed', operation_type: 'unknown' },
        { ...baseRecord, session_id: '3', token_delta: 6000, contract_result: 'passed', operation_type: 'unknown' },
        { ...baseRecord, session_id: '4', token_delta: null, contract_result: 'passed', operation_type: 'unknown' },
        { ...baseRecord, session_id: '5', token_delta: null, contract_result: 'passed', operation_type: 'unknown' }
      ];
      
      const rules = buildRoutingRules(deltas);
      expect(rules).toHaveLength(1);
      expect(rules[0].avg_token_delta).toBe(6000); // 18000 / 3 valid = 6000
    });
  });

  describe('buildConfidence', () => {
    const baseRecord: Omit<DeltaRecord, 'session_id'|'contract_result'> = {
      timestamp: '2026-01-01', files_changed: 1, model_tier_used: 'mid', operation_type: 'business_logic',
      token_delta: 0
    };

    it('should group by model_tier_used and calculate violation rate', () => {
      const deltas: DeltaRecord[] = [
        { ...baseRecord, session_id: '1', contract_result: 'passed' },
        { ...baseRecord, session_id: '2', contract_result: 'violated' },
        { ...baseRecord, session_id: '3', contract_result: 'partial' },
        { ...baseRecord, session_id: '4', contract_result: 'none' }
      ];

      const confs = buildConfidence(deltas);
      expect(confs).toHaveLength(1);
      
      // 1 violated + 1 partial out of 4 total = 0.5 violation rate
      expect(confs[0].violation_rate).toBe(0.5);
      expect(confs[0].session_count).toBe(4);
    });

    it('should calculate confidence adjustment mapping properly and clamp to [-1.0, 1.0]', () => {
      const deltas: DeltaRecord[] = [
        // passed = +0.1, <0 delta = +0.05 => +0.15
        { ...baseRecord, session_id: '1', contract_result: 'passed', token_delta: -100 },
        // violated = -0.2
        { ...baseRecord, session_id: '2', contract_result: 'violated', token_delta: 100 },
        // partial = -0.1
        { ...baseRecord, session_id: '3', contract_result: 'partial', token_delta: 100 },
        // passed = +0.1, >5000 delta = -0.1 => 0
        { ...baseRecord, session_id: '4', contract_result: 'passed', token_delta: 6000 }
      ];
      
      // sum: +0.15 - 0.2 - 0.1 + 0 = -0.15
      const confs = buildConfidence(deltas);
      // Use toBeCloseTo due to floating point math
      expect(confs[0].confidence_adjustment).toBeCloseTo(-0.15, 5); 
    });

    it('should clamp values nicely below -1.0 or above 1.0', () => {
      const badDeltas: DeltaRecord[] = Array(20).fill(null).map((_, i) => ({
        ...baseRecord, session_id: String(i), contract_result: 'violated', token_delta: 6000
      })); // -0.2 and -0.1 per session = -0.3 => total -6.0 -> clamp -1.0
      
      const goodDeltas: DeltaRecord[] = Array(20).fill(null).map((_, i) => ({
        ...baseRecord, session_id: String(i+20), contract_result: 'passed', token_delta: -1000, model_tier_used: 'capable'
      })); // +0.1 and +0.05 per session = +0.15 => total +3.0 -> clamp 1.0
      
      const confs = buildConfidence([...badDeltas, ...goodDeltas]);
      expect(confs).toHaveLength(2);
      
      const midConf = confs.find(c => c.component === 'mid')!;
      const capConf = confs.find(c => c.component === 'capable')!;
      
      expect(midConf.confidence_adjustment).toBe(-1.0);
      expect(capConf.confidence_adjustment).toBe(1.0);
    });

    it('excludes null token_delta from average calculation', () => {
      const deltas: DeltaRecord[] = [
        { ...baseRecord, session_id: '1', contract_result: 'passed', token_delta: 2000 },
        { ...baseRecord, session_id: '2', contract_result: 'passed', token_delta: null }
      ];
      
      const confs = buildConfidence(deltas);
      expect(confs[0].avg_token_delta).toBe(2000);
    });
  });

  describe('getRecommendation', () => {
    it('returns default tier and handles missing rules file smoothly', async () => {
      vi.mocked(readJsonOrNull).mockResolvedValueOnce(null);

      const rec = await getRecommendation(mockMathaDir, 'business_logic');
      expect(rec.source).toBe('default');
      expect(rec.tier).toBe('capable');
      expect(rec.budget).toBe(8000);
      expect(rec.confidence).toBeNull();
    });

    it('returns learned rule if it exists', async () => {
      const mockRules = {
        routingRules: [{
          operation_type: 'business_logic',
          component_pattern: '',
          recommended_tier: 'mid',
          recommended_budget: 6500,
          confidence: 'high',
          sample_size: 10,
          avg_token_delta: -1500,
          last_updated: '2026-01-01'
        }]
      };
      vi.mocked(readJsonOrNull).mockResolvedValueOnce(mockRules);

      const rec = await getRecommendation(mockMathaDir, 'business_logic');
      expect(rec.source).toBe('learned');
      expect(rec.tier).toBe('mid');
      expect(rec.budget).toBe(6500);
      expect(rec.confidence).toBe('high');
    });

    it('returns default rule if analysis exists but no matching rule', async () => {
      const mockRules = {
        routingRules: []
      };
      vi.mocked(readJsonOrNull).mockResolvedValueOnce(mockRules);

      const rec = await getRecommendation(mockMathaDir, 'rename/crud');
      expect(rec.source).toBe('default');
      expect(rec.tier).toBe('lightweight');
      expect(rec.budget).toBe(2000);
      expect(rec.confidence).toBeNull();
    });
  });

  describe('persistAnalysis', () => {
    it('writes atomic to dopamine/routing-rules.json and does not throw', async () => {
      const analysis = {
        analysedAt: '2026-01-01',
        sessionCount: 0,
        routingRules: [],
        componentConfidence: [],
        globalAvgTokenDelta: 0,
        overBudgetRate: 0
      };
      
      // even if writeAtomic fails, persistAnalysis should not throw
      vi.mocked(writeAtomic).mockRejectedValueOnce(new Error('disk full'));
      
      await expect(persistAnalysis(mockMathaDir, analysis)).resolves.not.toThrow();
      expect(vi.mocked(writeAtomic)).toHaveBeenCalledWith(
        path.join(mockMathaDir, 'dopamine/routing-rules.json'), 
        analysis,
        { overwrite: true }
      );
    });
  });
});
