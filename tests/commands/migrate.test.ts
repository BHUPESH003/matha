import { describe, it, expect } from 'vitest';
import { runMigrate } from '@/commands/migrate.js';

describe('migrate command', () => {
  it('runs without throwing', async () => {
    const logs: string[] = [];
    await expect(
      runMigrate({ log: (msg) => logs.push(msg) })
    ).resolves.not.toThrow();
  });

  it('exits with code 0', async () => {
    const result = await runMigrate({ log: () => {} });
    expect(result.exitCode).toBe(0);
  });

  it('outputs schema version and future roadmap note', async () => {
    const logs: string[] = [];
    await runMigrate({ log: (msg) => logs.push(msg) });
    const output = logs.join('\n');
    expect(output).toContain('matha migrate');
    expect(output).toContain('0.1.0');
    expect(output).toContain('v0.2.0');
  });
});
