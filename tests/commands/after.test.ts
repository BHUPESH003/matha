import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { runAfter } from '@/commands/after.js';

// Test helpers
async function createTmpDir(): Promise<string> {
  const tmpBase = path.join('/tmp', `matha-after-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(tmpBase, { recursive: true });
  return tmpBase;
}

async function initProject(projectRoot: string): Promise<void> {
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

  await fs.writeFile(
    path.join(projectRoot, '.matha/config.json'),
    JSON.stringify({ initialised: true }, null, 2),
  );

  await fs.writeFile(
    path.join(projectRoot, '.matha/hippocampus/intent.json'),
    JSON.stringify({ why: 'Test' }, null, 2),
  );

  await fs.writeFile(
    path.join(projectRoot, '.matha/hippocampus/rules.json'),
    JSON.stringify({ rules: [] }, null, 2),
  );
}

async function createPredictionFile(
  projectRoot: string,
  sessionId: string,
  operationType: string = 'business_logic',
): Promise<void> {
  const prediction = {
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    operation_type: operationType,
    scope: 'src/test.ts',
    predicted: {
      model_tier: 'capable',
      token_budget: 8000,
    },
    actual: null,
    delta: null,
  };

  const predictionPath = path.join(projectRoot, `.matha/dopamine/predictions/${sessionId}.json`);
  await fs.writeFile(predictionPath, JSON.stringify(prediction, null, 2));
}

describe('after command', () => {
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
    const result = await runAfter(tmpDir, {
      ask: async () => 'unused',
      log: () => {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('not initialised');
  });

  it('should find and link to most recent prediction file', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId);

    let linkedSessionId = '';
    const result = await runAfter(tmpDir, {
      ask: async () => '', // Skip all prompts
      log: (msg: string) => {
        if (msg.includes('Linking to session:')) {
          linkedSessionId = msg.split('Linking to session: ')[1].trim();
        }
      },
    });

    expect(result.exitCode).toBe(0);
    expect(linkedSessionId).toBe(sessionId);
    expect(result.sessionId).toBe(sessionId);
  });

  it('should generate new session ID if no prediction files exist', async () => {
    await initProject(tmpDir);

    const result = await runAfter(tmpDir, {
      ask: async () => '', // Skip all prompts
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toMatch(/^\d{8}-\d{6}-[a-f0-9]{4}$/);
  });

  it('should complete with all prompts skipped and write actuals', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId);

    const result = await runAfter(tmpDir, {
      ask: async () => '', // All prompts return empty
      log: () => {},
    });

    expect(result.exitCode).toBe(0);

    // Verify dopamine actual was written
    const actualPath = path.join(tmpDir, `.matha/dopamine/actuals/${sessionId}.json`);
    const actualContent = await fs.readFile(actualPath, 'utf-8');
    const actual = JSON.parse(actualContent);

    expect(actual.session_id).toBe(sessionId);
    expect(actual.contract_result).toBe('none');
    expect(actual.actual.files_changed).toBe(0);
    expect(actual.actual.tokens_used).toBeNull();
  });

  it('should write decision entry when both assumption and correction provided', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId);

    let decisionRecorded = false;
    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('assumption')) {
          return 'Previous design was too complex';
        }
        if (question.includes('correction')) {
          return 'Use simpler pattern instead';
        }
        if (question.includes('danger')) {
          return '';
        }
        if (question.includes('contract')) {
          return '1'; // passed
        }
        if (question.includes('files')) {
          return '5';
        }
        if (question.includes('tokens')) {
          return '';
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.decisionRecorded).toBe(true);
  });

  it('should not write decision if only assumption (no correction)', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId);

    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('assumption')) {
          return 'Some assumption';
        }
        // Simulate user pressing enter to skip correction
        if (question.includes('correction')) {
          return '';
        }
        if (question.includes('danger')) {
          return '';
        }
        if (question.includes('contract')) {
          return '1';
        }
        if (question.includes('files')) {
          return '0';
        }
        if (question.includes('tokens')) {
          return '';
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.decisionRecorded).toBe(false);
  });

  it('should write danger zone entry when pattern provided', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId);

    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('assumption')) {
          return '';
        }
        if (question.includes('danger')) {
          return 'Watch out for infinite loops in state updates';
        }
        if (question.includes('contract')) {
          return '1';
        }
        if (question.includes('files')) {
          return '3';
        }
        if (question.includes('tokens')) {
          return '';
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.dangerZoneRecorded).toBe(true);
  });

  it('should write violation log when contract violated', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId);

    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('contract')) {
          return '3'; // No - contract violated
        }
        if (question.includes('files')) {
          return '2';
        }
        if (question.includes('tokens')) {
          return '';
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);

    // Verify violation log was written
    const violationPath = path.join(tmpDir, '.matha/cerebellum/violation-log.json');
    const violationContent = await fs.readFile(violationPath, 'utf-8');
    const violations = JSON.parse(violationContent);

    expect(Array.isArray(violations)).toBe(true);
    expect(violations[0].result).toBe('violated');
  });

  it('should not write violation log when contract passed', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId);

    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('contract')) {
          return '1'; // passed
        }
        if (question.includes('files')) {
          return '1';
        }
        if (question.includes('tokens')) {
          return '';
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);

    // Verify violation log was NOT created
    const violationPath = path.join(tmpDir, '.matha/cerebellum/violation-log.json');
    const exists = await fs
      .access(violationPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('should calculate dopamine delta when prediction file exists', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId, 'business_logic');

    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('contract')) {
          return '1';
        }
        if (question.includes('files')) {
          return '10';
        }
        if (question.includes('tokens')) {
          return '6500'; // Less than predicted 8000
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);

    // Verify dopamine delta was written
    const deltaPath = path.join(tmpDir, '.matha/dopamine/deltas.json');
    const deltaContent = await fs.readFile(deltaPath, 'utf-8');
    const deltas = JSON.parse(deltaContent);

    expect(Array.isArray(deltas)).toBe(true);
    const delta = deltas[0];
    expect(delta.session_id).toBe(sessionId);
    expect(delta.token_delta).toBe(-1500); // 6500 - 8000
    expect(delta.operation_type).toBe('business_logic');
  });

  it('should write delta with null token_delta if no prediction file', async () => {
    await initProject(tmpDir);
    const newSessionId = '20260305-123456-c3d4'; // No prediction file for this

    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('contract')) {
          return '1';
        }
        if (question.includes('files')) {
          return '5';
        }
        if (question.includes('tokens')) {
          return '';
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);

    // Verify dopamine delta was written with null token_delta
    const deltaPath = path.join(tmpDir, '.matha/dopamine/deltas.json');
    const deltaContent = await fs.readFile(deltaPath, 'utf-8');
    const deltas = JSON.parse(deltaContent);

    expect(deltas[0].token_delta).toBeNull();
  });

  it('should append to existing deltas.json without overwriting', async () => {
    await initProject(tmpDir);

    // Create first delta entry
    const deltaPath = path.join(tmpDir, '.matha/dopamine/deltas.json');
    await fs.writeFile(
      deltaPath,
      JSON.stringify(
        [
          {
            session_id: 'session-1',
            timestamp: new Date().toISOString(),
            operation_type: 'rename',
            contract_result: 'passed',
            token_delta: 100,
            files_changed: 1,
            model_tier_used: 'lightweight',
          },
        ],
        null,
        2,
      ),
    );

    // Run after for session-2
    const sessionId2 = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId2);

    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('contract')) {
          return '1';
        }
        if (question.includes('files')) {
          return '3';
        }
        if (question.includes('tokens')) {
          return '7500';
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);

    // Verify both deltas exist
    const deltaContent = await fs.readFile(deltaPath, 'utf-8');
    const deltas = JSON.parse(deltaContent);

    expect(deltas.length).toBe(2);
    expect(deltas[0].session_id).toBe('session-1');
    expect(deltas[1].session_id).toBe(sessionId2);
  });

  it('should handle contract partial result', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId);

    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('contract')) {
          return '2'; // partial
        }
        if (question.includes('files')) {
          return '4';
        }
        if (question.includes('tokens')) {
          return '';
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);

    // Verify violation log was written for partial
    const violationPath = path.join(tmpDir, '.matha/cerebellum/violation-log.json');
    const violationContent = await fs.readFile(violationPath, 'utf-8');
    const violations = JSON.parse(violationContent);

    expect(violations[0].result).toBe('partial');
  });

  it('should print summary output with correct formatting', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId);

    let output: string[] = [];
    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('assumption')) {
          return 'Assumption text';
        }
        if (question.includes('correction')) {
          return 'Correction text';
        }
        if (question.includes('danger')) {
          return 'Danger pattern';
        }
        if (question.includes('contract')) {
          return '1';
        }
        if (question.includes('files')) {
          return '5';
        }
        if (question.includes('tokens')) {
          return '7000';
        }
        return '';
      },
      log: (msg: string) => {
        output.push(msg);
      },
    });

    expect(result.exitCode).toBe(0);

    // Check for summary format
    const outputStr = output.join('\n');
    expect(outputStr).toContain('MATHA WRITE-BACK COMPLETE');
    expect(outputStr).toContain(sessionId);
    expect(outputStr).toContain('Brain updated');
  });

  it('should extract scope from linked session brief if available', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId);

    // Create a session brief file
    const briefPath = path.join(tmpDir, `.matha/sessions/${sessionId}.brief`);
    await fs.writeFile(
      briefPath,
      JSON.stringify(
        {
          sessionId,
          scope: 'src/api.ts, src/utils.ts',
          operationType: 'business_logic',
        },
        null,
        2,
      ),
    );

    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('assumption')) {
          return 'Bad assumption';
        }
        if (question.includes('correction')) {
          return 'Good correction';
        }
        if (question.includes('danger')) {
          return '';
        }
        if (question.includes('contract')) {
          return '1';
        }
        if (question.includes('files')) {
          return '2';
        }
        if (question.includes('tokens')) {
          return '';
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.scope).toBe('src/api.ts, src/utils.ts');
  });

  it('should accept numeric input for files and tokens', async () => {
    await initProject(tmpDir);
    const sessionId = '20260304-143022-a1b2';
    await createPredictionFile(tmpDir, sessionId);

    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('files')) {
          return '42';
        }
        if (question.includes('tokens')) {
          return '12345';
        }
        if (question.includes('contract')) {
          return '1';
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);

    // Verify actuals were written with correct numbers
    const actualPath = path.join(tmpDir, `.matha/dopamine/actuals/${sessionId}.json`);
    const actualContent = await fs.readFile(actualPath, 'utf-8');
    const actual = JSON.parse(actualContent);

    expect(actual.actual.files_changed).toBe(42);
    expect(actual.actual.tokens_used).toBe(12345);
  });

  it('should use unknown component when no session brief available', async () => {
    await initProject(tmpDir);
    // Don't create a session brief - force unknown scope

    const result = await runAfter(tmpDir, {
      ask: async (question: string) => {
        if (question.includes('assumption')) {
          return 'Test assumption';
        }
        if (question.includes('correction')) {
          return 'Test correction';
        }
        if (question.includes('danger')) {
          return '';
        }
        if (question.includes('contract')) {
          return '1';
        }
        if (question.includes('files')) {
          return '1';
        }
        if (question.includes('tokens')) {
          return '';
        }
        return '';
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.scope).toBe('unknown');
  });

  describe('Automatic Contract Validation', () => {
    it('should show per-assertion prompts and log violations if any fail', async () => {
      await initProject(tmpDir);
      const sessionId = '20260304-143022-a1b2';
      await createPredictionFile(tmpDir, sessionId);
      
      const briefPath = path.join(tmpDir, `.matha/sessions/${sessionId}.brief`);
      await fs.writeFile(
        briefPath,
        JSON.stringify({ sessionId, scope: 'src/test.ts', contract: ['Wait for init', 'Do not use eval'] }, null, 2)
      );

      let askCount = 0;
      const result = await runAfter(tmpDir, {
        ask: async (q) => {
          if (q.includes('Did this pass?')) {
            askCount++;
            return askCount === 1 ? 'n' : 'y';
          }
          if (q.includes('files')) return '1';
          return '';
        },
        log: () => {}
      });

      expect(result.exitCode).toBe(0);
      const violationPath = path.join(tmpDir, '.matha/cerebellum/violation-log.json');
      const violations = JSON.parse(await fs.readFile(violationPath, 'utf8'));
      
      expect(violations.length).toBe(1);
      expect(violations[0].assertion).toBe('Wait for init');
      expect(violations[0].result).toBe('violated');
    });

    it('should pass with no violations if all assertions pass', async () => {
      await initProject(tmpDir);
      const sessionId = '20260304-143022-a1b2';
      await createPredictionFile(tmpDir, sessionId);
      
      const briefPath = path.join(tmpDir, `.matha/sessions/${sessionId}.brief`);
      await fs.writeFile(
        briefPath,
        JSON.stringify({ sessionId, scope: 'src/test.ts', contract: ['A1', 'A2'] }, null, 2)
      );

      const result = await runAfter(tmpDir, {
        ask: async (q) => {
          if (q.includes('Did this pass?')) return 'y';
          if (q.includes('files')) return '1';
          return '';
        },
        log: () => {}
      });

      expect(result.exitCode).toBe(0);
      const violationPath = path.join(tmpDir, '.matha/cerebellum/violation-log.json');
      const exists = await fs.access(violationPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('should handle partial if some pass and some skipped', async () => {
      await initProject(tmpDir);
      const sessionId = '20260304-143022-a1b2';
      await createPredictionFile(tmpDir, sessionId);
      
      const briefPath = path.join(tmpDir, `.matha/sessions/${sessionId}.brief`);
      await fs.writeFile(
        briefPath,
        JSON.stringify({ sessionId, scope: 'src/test.ts', contract: ['A1', 'A2'] }, null, 2)
      );

      let askCount = 0;
      const result = await runAfter(tmpDir, {
        ask: async (q) => {
          if (q.includes('Did this pass?')) {
            askCount++;
            return askCount === 1 ? 'y' : 'skip';
          }
          if (q.includes('files')) return '1';
          return '';
        },
        log: () => {}
      });

      expect(result.exitCode).toBe(0);
      
      // Dopamine delta should show partial
      const deltaPath = path.join(tmpDir, '.matha/dopamine/deltas.json');
      const deltas = JSON.parse(await fs.readFile(deltaPath, 'utf8'));
      expect(deltas[deltas.length - 1].contract_result).toBe('partial');
    });

    it('should handle none if all skipped', async () => {
      await initProject(tmpDir);
      const sessionId = '20260304-143022-a1b2';
      await createPredictionFile(tmpDir, sessionId);
      
      const briefPath = path.join(tmpDir, `.matha/sessions/${sessionId}.brief`);
      await fs.writeFile(
        briefPath,
        JSON.stringify({ sessionId, scope: 'src/test.ts', contract: ['A1', 'A2'] }, null, 2)
      );

      const result = await runAfter(tmpDir, {
        ask: async (q) => {
          if (q.includes('Did this pass?')) return 's';
          if (q.includes('files')) return '1';
          return '';
        },
        log: () => {}
      });

      expect(result.exitCode).toBe(0);
      const deltaPath = path.join(tmpDir, '.matha/dopamine/deltas.json');
      const deltas = JSON.parse(await fs.readFile(deltaPath, 'utf8'));
      expect(deltas[deltas.length - 1].contract_result).toBe('none');
    });

    it('should log separate entries for multiple failed assertions', async () => {
      await initProject(tmpDir);
      const sessionId = '20260304-143022-a1b2';
      await createPredictionFile(tmpDir, sessionId);
      
      const briefPath = path.join(tmpDir, `.matha/sessions/${sessionId}.brief`);
      await fs.writeFile(
        briefPath,
        JSON.stringify({ sessionId, scope: 'src/test.ts', contract: ['Fail1', 'Fail2'] }, null, 2)
      );

      const result = await runAfter(tmpDir, {
        ask: async (q) => {
          if (q.includes('Did this pass?')) return 'no';
          if (q.includes('files')) return '1';
          return '';
        },
        log: () => {}
      });

      expect(result.exitCode).toBe(0);
      const violationPath = path.join(tmpDir, '.matha/cerebellum/violation-log.json');
      const violations = JSON.parse(await fs.readFile(violationPath, 'utf8'));
      expect(violations.length).toBe(2);
      expect(violations[0].assertion).toBe('Fail1');
      expect(violations[1].assertion).toBe('Fail2');
    });

    it('should update component contract violation count if exists', async () => {
      await initProject(tmpDir);
      const sessionId = '20260304-143022-a1b2';
      await createPredictionFile(tmpDir, sessionId);
      
      const contractPath = path.join(tmpDir, '.matha/cerebellum/contracts/src_test_ts.json');
      await fs.writeFile(
        contractPath,
        JSON.stringify({
          component: 'src/test.ts',
          assertions: [{ description: 'Must not use global state', violation_count: 0 }]
        }, null, 2)
      );

      const briefPath = path.join(tmpDir, `.matha/sessions/${sessionId}.brief`);
      await fs.writeFile(
        briefPath,
        JSON.stringify({ sessionId, scope: 'src/test.ts', contract: ['Must not use global state'] }, null, 2)
      );

      const result = await runAfter(tmpDir, {
        ask: async (q) => {
          if (q.includes('Did this pass?')) return 'n';
          if (q.includes('files')) return '1';
          return '';
        },
        log: () => {}
      });

      expect(result.exitCode).toBe(0);
      const updatedContract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
      expect(updatedContract.assertions[0].violation_count).toBe(1);
      expect(updatedContract.assertions[0].last_violated).toBeDefined();
    });

    it('updateContractViolation matches trimmed lowercase assertion', async () => {
      await initProject(tmpDir);
      const sessionId = '20260304-143022-a1b2';
      await createPredictionFile(tmpDir, sessionId);
      
      const contractPath = path.join(tmpDir, '.matha/cerebellum/contracts/src_test_ts.json');
      await fs.writeFile(
        contractPath,
        JSON.stringify({
          component: 'src/test.ts',
          assertions: [{ description: 'Case INsensItiVE', violation_count: 5 }]
        }, null, 2)
      );

      const briefPath = path.join(tmpDir, `.matha/sessions/${sessionId}.brief`);
      await fs.writeFile(
        briefPath,
        JSON.stringify({ sessionId, scope: 'src/test.ts', contract: ['  case insensitive  '] }, null, 2)
      );

      await runAfter(tmpDir, {
        ask: async (q) => {
          if (q.includes('Did this pass?')) return 'fail';
          if (q.includes('files')) return '1';
          return '';
        },
        log: () => {}
      });

      const updatedContract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
      expect(updatedContract.assertions[0].violation_count).toBe(6);
    });

    it('should not throw if updateContractViolation finds no contract', async () => {
      await initProject(tmpDir);
      const sessionId = '20260304-143022-a1b2';
      await createPredictionFile(tmpDir, sessionId);
      
      const briefPath = path.join(tmpDir, `.matha/sessions/${sessionId}.brief`);
      await fs.writeFile(
        briefPath,
        JSON.stringify({ sessionId, scope: 'src/missing.ts', contract: ['Some rule'] }, null, 2)
      );

      const result = await runAfter(tmpDir, {
        ask: async (q) => {
          if (q.includes('Did this pass?')) return 'n';
          if (q.includes('files')) return '1';
          return '';
        },
        log: () => {}
      });

      expect(result.exitCode).toBe(0);
      
      const violationPath = path.join(tmpDir, '.matha/cerebellum/violation-log.json');
      const violations = JSON.parse(await fs.readFile(violationPath, 'utf8'));
      expect(violations[0].assertion).toBe('Some rule');
    });

    it('SIGINT safety test: no writes if interrupted before completion', async () => {
      await initProject(tmpDir);
      const sessionId = '20260304-143022-a1b2';
      await createPredictionFile(tmpDir, sessionId);
      
      const briefPath = path.join(tmpDir, `.matha/sessions/${sessionId}.brief`);
      await fs.writeFile(
        briefPath,
        JSON.stringify({ sessionId, scope: 'src/test.ts', contract: ['A1', 'A2', 'A3'] }, null, 2)
      );

      let askCount = 0;
      await expect(runAfter(tmpDir, {
        ask: async (q) => {
          if (q.includes('Did this pass?')) {
            askCount++;
            if (askCount === 1) return 'n';
            if (askCount === 2) throw new Error('SIGINT');
          }
          return '';
        },
        log: () => {}
      })).rejects.toThrow('SIGINT');

      const violationPath = path.join(tmpDir, '.matha/cerebellum/violation-log.json');
      const violationExists = await fs.access(violationPath).then(() => true).catch(() => false);
      expect(violationExists).toBe(false);
      
      const deltasPath = path.join(tmpDir, '.matha/dopamine/deltas.json');
      const deltasExists = await fs.access(deltasPath).then(() => true).catch(() => false);
      expect(deltasExists).toBe(false);
    });
  });
});
