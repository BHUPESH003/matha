import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { runBefore } from '@/commands/before.js';
import { vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  matchAll: vi.fn().mockResolvedValue([]),
  getRecommendation: vi.fn().mockResolvedValue({
    tier: 'lightweight',
    budget: 2000,
    source: 'default',
    confidence: null
  }),
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

const modelTierBudget: Record<string, { modelTier: string; tokenBudget: number }> = {
  rename: { modelTier: 'lightweight', tokenBudget: 2000 },
  crud: { modelTier: 'lightweight', tokenBudget: 2000 },
  business_logic: { modelTier: 'capable', tokenBudget: 8000 },
  architecture: { modelTier: 'capable', tokenBudget: 16000 },
  frozen_component: { modelTier: 'capable', tokenBudget: 16000 },
};

// Test helpers
async function createTmpDir(): Promise<string> {
  const tmpBase = path.join('/tmp', `matha-before-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(tmpBase, { recursive: true });
  return tmpBase;
}

async function initProject(projectRoot: string): Promise<void> {
  // Create .matha structure
  const dirs = [
    '.matha',
    '.matha/hippocampus',
    '.matha/hippocampus/decisions',
    '.matha/cerebellum',
    '.matha/cerebellum/contracts',
    '.matha/cortex',
    '.matha/dopamine',
    '.matha/dopamine/predictions',
    '.matha/dopamine/actuals',
    '.matha/sessions',
  ];

  for (const dir of dirs) {
    await fs.mkdir(path.join(projectRoot, dir), { recursive: true });
  }

  // Write required files
  await fs.writeFile(
    path.join(projectRoot, '.matha/config.json'),
    JSON.stringify({ initialised: true }, null, 2),
  );

  // Seed hippocampus
  await fs.writeFile(
    path.join(projectRoot, '.matha/hippocampus/intent.json'),
    JSON.stringify(
      {
        why: 'Test project',
        core_problem: 'Test',
        core_insight: 'Test',
      },
      null,
      2,
    ),
  );

  await fs.writeFile(
    path.join(projectRoot, '.matha/hippocampus/rules.json'),
    JSON.stringify(
      {
        rules: ['rule1', 'rule2'],
      },
      null,
      2,
    ),
  );

  // Seed cortex
  await fs.writeFile(
    path.join(projectRoot, '.matha/cortex/shape.json'),
    JSON.stringify(
      {
        directories: ['src', 'tests'],
        detected_stack: ['typescript'],
        file_count: 10,
        derived_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  // Seed danger zones
  await fs.writeFile(
    path.join(projectRoot, '.matha/hippocampus/danger-zones.json'),
    JSON.stringify(
      {
        zones: [
          {
            component: 'storage',
            pattern: 'Non-atomic writes',
            description: 'DANGER ZONE 001: Always use atomic write pattern',
          },
          {
            component: 'brain/frontal-lobe',
            pattern: 'Gate 05 bypass',
            description: 'DANGER ZONE 002: Never skip Gate 05 (CONTRACT FIRST)',
          },
        ],
      },
      null,
      2,
    ),
  );
}

describe('before command', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    vi.clearAllMocks();
  });

  it('should exit with code 1 if .matha/config.json does not exist', async () => {
    const result = await runBefore(tmpDir, {
      ask: async () => 'unused',
      log: () => {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('not initialised');
  });

  it('should complete a full run with all gates', async () => {
    await initProject(tmpDir);

    let prompts: string[] = [];
    const result = await runBefore(tmpDir, {
      ask: async (question: string) => {
        prompts.push(question);
        // Simulate user responses
        if (question.includes('about to build')) {
          return 'Add new feature';
        }
        if (question.includes('components')) {
          return 'src/api.ts, src/utils.ts';
        }
        if (question.includes('behaviour contract')) {
          return 'API returns valid JSON\nUtils validate input\n';
        }
        if (question.includes('type of operation')) {
          return '3'; // Business Logic
        }
        return '';
      },
      log: () => {},
      now: () => new Date('2026-03-04T14:30:22.000Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toMatch(/^\d{8}-\d{6}-[a-f0-9]{4}$/);
    expect(result.brief).toBeDefined();
    expect(result.brief.sessionId).toBe(result.sessionId);
    expect(result.brief.scope).toBe('src/api.ts, src/utils.ts');
    expect(result.brief.operationType).toBe('business_logic');
    expect(result.brief.assertions).toContain('API returns valid JSON');
    expect(result.brief.matchResults).toEqual([]);
    expect(result.brief.hasCritical).toBe(false);
  });

  describe('Contract Matcher Integration (Gate 04)', () => {
    afterEach(() => {
      mocks.matchAll.mockReset();
      mocks.matchAll.mockResolvedValue([]);
    });

    it('should surface critical, warning, and info results gracefully', async () => {
      await initProject(tmpDir);

      mocks.matchAll.mockResolvedValue([
        {
          matchType: 'danger_zone',
          severity: 'critical',
          title: 'Danger Zone: storage',
          description: 'Always use atomic write pattern',
          source: 'danger-zones.json',
          component: 'storage',
          recommendation: 'Review danger zone before proceeding',
        },
        {
          matchType: 'decision_pattern',
          severity: 'warning',
          title: 'Prior Decision: storage',
          description: 'Previous: X. Correction: Y',
          source: 'hippocampus/decisions',
          component: 'storage',
          recommendation: 'Be aware',
        },
        {
          matchType: 'contract',
          severity: 'info',
          title: 'Contract: storage',
          description: 'Contract is currently clean.',
          source: 'contracts',
          component: 'storage',
          recommendation: 'Verify assertions',
        }
      ]);

      let logs: string[] = [];
      const result = await runBefore(tmpDir, {
        ask: async (question: string) => {
          if (question.includes('components')) return 'storage';
          if (question.includes('about to build')) return 'Update storage';
          if (question.includes('behaviour contract')) return 'A\n';
          if (question.includes('type of operation')) return '2';
          return '';
        },
        log: (msg: string) => logs.push(msg),
        now: () => new Date('2026-03-04T14:30:22.000Z'),
      });

      expect(result.exitCode).toBe(0);
      const output = logs.join('\n');
      
      // Verification of display formatting
      expect(output).toContain('🚨 CRITICAL — 1 issue(s) require attention:');
      expect(output).toContain('✗ Danger Zone: storage');
      expect(output).toContain('Always use atomic write pattern');
      expect(output).toContain('→ Review danger zone before proceeding');
      
      expect(output).toContain('⚠  WARNINGS — 1 prior finding(s):');
      expect(output).toContain('· Prior Decision: storage');
      expect(output).toContain('Previous: X. Correction: Y');
      
      expect(output).toContain('ℹ  CONTEXT — 1 relevant contract(s):');
      expect(output).toContain('· Contract: storage — Contract is currently clean.');
      
      // Verification of SessionBrief
      expect(result.brief.matchResults).toHaveLength(3);
      expect(result.brief.hasCritical).toBe(true);
      
      // READY TO BUILD is distinct
      expect(output).toContain('⚠ Critical issues detected — proceed with caution');
      expect(result.readyToBuild).toBe(true); // never blocks
    });

    it('should show clean checkmark if no issues found', async () => {
      await initProject(tmpDir);
      mocks.matchAll.mockResolvedValue([]);

      let logs: string[] = [];
      const result = await runBefore(tmpDir, {
        ask: async (question: string) => {
          if (question.includes('components')) return 'storage';
          if (question.includes('about to build')) return 'Update storage';
          if (question.includes('behaviour contract')) return 'A\n';
          if (question.includes('type of operation')) return '2';
          return '';
        },
        log: (msg: string) => logs.push(msg),
        now: () => new Date('2026-03-04T14:30:22.000Z'),
      });

      expect(result.exitCode).toBe(0);
      const output = logs.join('\n');
      
      expect(output).toContain('✓ No issues detected for this scope.');
      expect(result.brief.matchResults).toEqual([]);
      expect(result.brief.hasCritical).toBe(false);
      expect(output).not.toContain('⚠ Critical issues detected');
    });
  });

  it('should handle skipped contract gracefully', async () => {
    await initProject(tmpDir);

    const result = await runBefore(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('about to build')) {
          return 'Fix bug';
        }
        if (question.includes('components')) {
          return 'src/bug.ts';
        }
        if (question.includes('behaviour contract')) {
          return ''; // Empty contract
        }
        if (question.includes('type of operation')) {
          return '1'; // Rename
        }
        return '';
      },
      log: () => {},
      now: () => new Date('2026-03-04T14:30:22.000Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.brief.assertions.length).toBe(0);
    expect(result.readyToBuild).toBe(false); // No contract = advisory only
  });

  it('should write session brief to .matha/sessions/', async () => {
    await initProject(tmpDir);

    const result = await runBefore(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('about to build')) {
          return 'Refactor code';
        }
        if (question.includes('components')) {
          return 'src/refactor.ts';
        }
        if (question.includes('behaviour contract')) {
          return 'Tests still pass\n';
        }
        if (question.includes('type of operation')) {
          return '1';
        }
        return '';
      },
      log: () => {},
      now: () => new Date('2026-03-04T14:30:22.000Z'),
    });

    expect(result.exitCode).toBe(0);

    const briefPath = path.join(tmpDir, `.matha/sessions/${result.sessionId}.brief`);
    const briefContent = await fs.readFile(briefPath, 'utf-8');
    const brief = JSON.parse(briefContent);

    expect(brief.sessionId).toBe(result.sessionId);
    expect(brief.timestamp).toBeDefined();
    expect(brief.scope).toBe('src/refactor.ts');
  });

  it('should write dopamine prediction to .matha/dopamine/predictions/', async () => {
    await initProject(tmpDir);

    const result = await runBefore(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('about to build')) {
          return 'Add feature';
        }
        if (question.includes('components')) {
          return 'src/feature.ts';
        }
        if (question.includes('behaviour contract')) {
          return 'Works as expected\n';
        }
        if (question.includes('type of operation')) {
          return '4'; // Architecture change
        }
        return '';
      },
      log: () => {},
      now: () => new Date('2026-03-04T14:30:22.000Z'),
    });

    expect(result.exitCode).toBe(0);

    const predictionPath = path.join(tmpDir, `.matha/dopamine/predictions/${result.sessionId}.json`);
    const predictionContent = await fs.readFile(predictionPath, 'utf-8');
    const prediction = JSON.parse(predictionContent);

    expect(prediction.session_id).toBe(result.sessionId);
    expect(prediction.operation_type).toBe('architecture');
    expect(prediction.scope).toBe('src/feature.ts');
    expect(prediction.predicted.model_tier).toBeDefined();
    expect(prediction.predicted.token_budget).toBeDefined();
    expect(prediction.actual).toBeNull();
    expect(prediction.delta).toBeNull();
  });

  it('should handle operation type selection correctly', async () => {
    await initProject(tmpDir);

    const testCases = [
      { input: '1', expected: 'rename' },
      { input: '2', expected: 'crud' },
      { input: '3', expected: 'business_logic' },
      { input: '4', expected: 'architecture' },
      { input: '5', expected: 'frozen_component' },
    ];

    for (const testCase of testCases) {
      mocks.getRecommendation.mockResolvedValueOnce({
        tier: modelTierBudget[testCase.expected as any].modelTier,
        budget: modelTierBudget[testCase.expected as any].tokenBudget,
        source: 'default',
        confidence: null
      });
      const result = await runBefore(tmpDir, {
        ask: async (question: string) => {
          if (question.includes('about to build')) {
            return 'Test';
          }
          if (question.includes('components')) {
            return 'src/test.ts';
          }
          if (question.includes('behaviour contract')) {
            return '';
          }
          if (question.includes('type of operation')) {
            return testCase.input;
          }
          return '';
        },
        log: () => {},
        now: () => new Date('2026-03-04T14:30:22.000Z'),
      });

      expect(result.brief.operationType).toBe(testCase.expected);
    }
  });

  it('should format session ID as [YYYYMMDD]-[HHMMSS]-[4 hex]', async () => {
    await initProject(tmpDir);

    const result = await runBefore(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('about to build')) {
          return 'Test';
        }
        if (question.includes('components')) {
          return 'src/test.ts';
        }
        if (question.includes('behaviour contract')) {
          return '';
        }
        if (question.includes('type of operation')) {
          return '1';
        }
        return '';
      },
      log: () => {},
      now: () => new Date('2026-03-04T14:30:22.123Z'),
    });

    // Session ID should match [YYYYMMDD]-[HHMMSS]-[4 hex]
    expect(result.sessionId).toMatch(/^20260304-\d{6}-[a-f0-9]{4}$/);
  });

  it('should include business rules in brief', async () => {
    await initProject(tmpDir);

    const result = await runBefore(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('about to build')) {
          return 'Test';
        }
        if (question.includes('components')) {
          return 'src/test.ts';
        }
        if (question.includes('behaviour contract')) {
          return '';
        }
        if (question.includes('type of operation')) {
          return '1';
        }
        return '';
      },
      log: () => {},
      now: () => new Date('2026-03-04T14:30:22.000Z'),
    });

    expect(result.brief.business_rules).toContain('rule1');
    expect(result.brief.business_rules).toContain('rule2');
  });

  it('should display "No issues detected" when none match scope', async () => {
    await initProject(tmpDir);
    mocks.matchAll.mockResolvedValue([]);

    let outputLog: string[] = [];
    const result = await runBefore(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('about to build')) return 'Test';
        if (question.includes('components')) return 'nonexistent/component.ts';
        if (question.includes('behaviour contract')) return '';
        if (question.includes('type of operation')) return '1';
        return '';
      },
      log: (msg: string) => outputLog.push(msg),
      now: () => new Date('2026-03-04T14:30:22.000Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.brief.matchResults.length).toBe(0);
    expect(outputLog.join('\n')).toContain('No issues detected for this scope');
  });

  describe('Dopamine Routing Integration (Gate 06)', () => {
    it('should display learned routing info with sample size and confidence', async () => {
      await initProject(tmpDir);
      
      mocks.getRecommendation.mockResolvedValue({
        tier: 'capable',
        budget: 12000,
        source: 'learned',
        confidence: 'high',
        sample_size: 15
      });

      let logs: string[] = [];
      const result = await runBefore(tmpDir, {
        ask: async (question: string) => {
          if (question.includes('components')) return 'src/test.ts';
          if (question.includes('about to build')) return 'Test';
          if (question.includes('behaviour contract')) return 'A\n';
          if (question.includes('type of operation')) return '3'; // business_logic
          return '';
        },
        log: (msg: string) => logs.push(msg),
      });

      const output = logs.join('\n');
      expect(output).toContain('Model: capable (budget: 12000 tokens) — learned from 15 sessions (high confidence)');
      expect(result.brief.routingSource).toBe('learned');
      expect(result.brief.routingConfidence).toBe('high');
      expect(result.brief.modelTier).toBe('capable');
      expect(result.brief.tokenBudget).toBe(12000);
    });

    it('should show upgrade arrow when learned tier is higher than default', async () => {
      await initProject(tmpDir);
      
      mocks.getRecommendation.mockResolvedValue({
        tier: 'capable',
        budget: 9000,
        source: 'learned',
        confidence: 'medium',
        sample_size: 5
      });

      let logs: string[] = [];
      await runBefore(tmpDir, {
        ask: async (question: string) => {
          if (question.includes('type of operation')) return '2'; // crud, default is lightweight
          return 'test';
        },
        log: (msg: string) => logs.push(msg),
      });

      const output = logs.join('\n');
      expect(output).toContain('↑ Upgraded from lightweight based on history');
    });

    it('should show insufficient history when source is default', async () => {
      await initProject(tmpDir);
      
      mocks.getRecommendation.mockResolvedValue({
        tier: 'lightweight',
        budget: 2000,
        source: 'default',
        confidence: null
      });

      let logs: string[] = [];
      await runBefore(tmpDir, {
        ask: async (question: string) => {
          if (question.includes('type of operation')) return '1';
          return 'test';
        },
        log: (msg: string) => logs.push(msg),
      });

      const output = logs.join('\n');
      expect(output).toContain('Model: lightweight (budget: 2000 tokens) — default (insufficient history for this operation type)');
      expect(output).not.toContain('learned from');
    });
  });
});
