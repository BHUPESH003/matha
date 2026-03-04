import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { runBefore } from '@/commands/before.js';

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
  });

  it('should surface danger zones matching scope', async () => {
    await initProject(tmpDir);

    let dangerZonesSurfaced = false;
    const result = await runBefore(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('components')) {
          // Match "storage" which has a danger zone
          return 'storage';
        }
        if (question.includes('about to build')) {
          return 'Update storage';
        }
        if (question.includes('behaviour contract')) {
          return '';
        }
        if (question.includes('type of operation')) {
          return '2';
        }
        return '';
      },
      log: (msg: string) => {
        if (msg.includes('DANGER ZONES') || msg.includes('DANGER ZONE 001')) {
          dangerZonesSurfaced = true;
        }
      },
      now: () => new Date('2026-03-04T14:30:22.000Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(dangerZonesSurfaced).toBe(true);
    expect(result.brief.dangerZones.length).toBeGreaterThan(0);
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

  it('should display "No danger zones" when none match scope', async () => {
    await initProject(tmpDir);

    let outputLog: string[] = [];
    const result = await runBefore(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('about to build')) {
          return 'Test';
        }
        if (question.includes('components')) {
          return 'nonexistent/component.ts'; // No matching danger zone
        }
        if (question.includes('behaviour contract')) {
          return '';
        }
        if (question.includes('type of operation')) {
          return '1';
        }
        return '';
      },
      log: (msg: string) => {
        outputLog.push(msg);
      },
      now: () => new Date('2026-03-04T14:30:22.000Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.brief.dangerZones.length).toBe(0);
  });
});
