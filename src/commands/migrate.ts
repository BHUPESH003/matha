import * as path from 'path';
import { readJsonOrNull } from '@/storage/reader.js';
import { writeAtomic } from '@/storage/writer.js';
import { CURRENT_SCHEMA_VERSION } from '@/core/schema.js';

export interface MigrateResult {
  exitCode: number;
  message: string;
}

/**
 * `matha migrate` — bring .matha/ to the current schema version.
 *
 * 0.1.x → 0.2.0: stamp schema_version into config.json. The 0.2.0 readers
 * are tolerant of 0.1.x record shapes, so no data rewriting is needed;
 * abandoned 0.1.x artifacts (dopamine/, sessions/) are left in place —
 * harmless, and deleting user data is not migrate's job.
 */
export async function runMigrate(
  projectRoot: string = process.cwd(),
  deps?: { log?: (msg: string) => void },
): Promise<MigrateResult> {
  const log = deps?.log ?? console.log;
  const mathaDir = path.join(projectRoot, '.matha');
  const configPath = path.join(mathaDir, 'config.json');

  const config = await readJsonOrNull<Record<string, unknown>>(configPath);
  if (!config) {
    const message = 'MATHA is not initialised (no .matha/config.json). Run `matha init` first.';
    log(message);
    return { exitCode: 1, message };
  }

  const current = typeof config.schema_version === 'string' ? config.schema_version : null;

  if (current === CURRENT_SCHEMA_VERSION) {
    const message = `Already at schema v${CURRENT_SCHEMA_VERSION} — nothing to migrate.`;
    log(message);
    return { exitCode: 0, message };
  }

  if (current && current > CURRENT_SCHEMA_VERSION) {
    const message =
      `This .matha/ uses schema v${current}, newer than this MATHA (v${CURRENT_SCHEMA_VERSION}). ` +
      'Upgrade MATHA: npm install -g @10kdevs/matha';
    log(message);
    return { exitCode: 1, message };
  }

  await writeAtomic(
    configPath,
    { ...config, schema_version: CURRENT_SCHEMA_VERSION },
    { overwrite: true },
  );

  const message = `Migrated ${current ?? 'legacy (unversioned)'} → v${CURRENT_SCHEMA_VERSION}.`;
  log(message);
  return { exitCode: 0, message };
}
