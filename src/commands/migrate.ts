import * as path from 'path';
import { readJsonOrNull } from '@/storage/reader.js';
import { writeAtomic } from '@/storage/writer.js';
import { CURRENT_SCHEMA_VERSION } from '@/core/schema.js';
import { migrateLegacyDecisions } from '@/store/records.js';

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
 *
 * 0.2.0 → 1.0.0: additive only — lifecycle metadata on decisions/zones
 * (retired_reason, superseded_by, last_confirmed), hippocampus/boundaries.json,
 * cortex/analysis.json. Old brains read fine without them; stamping the
 * version is the whole migration.
 *
 * 1.0.0 → 1.1.0: decisions storage moved from decisions/<component>.json
 * (array, read-modify-write) to decisions/<component>.jsonl (append-only).
 * This one is NOT just a version stamp — a 1.1.0 reader can't see 1.0.0's
 * .json decision files at all, so skipping this step silently drops every
 * recorded decision from matha_brief. migrateLegacyDecisions runs here too
 * (not just from `matha init`), since re-running init isn't the command a
 * returning user reaches for after a version bump.
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

  const decisionsMigrated = await migrateLegacyDecisions(mathaDir);

  await writeAtomic(
    configPath,
    { ...config, schema_version: CURRENT_SCHEMA_VERSION },
    { overwrite: true },
  );

  const decisionsNote = decisionsMigrated > 0 ? ` (${decisionsMigrated} legacy decision(s) consolidated)` : '';
  const message = `Migrated ${current ?? 'legacy (unversioned)'} → v${CURRENT_SCHEMA_VERSION}.${decisionsNote}`;
  log(message);
  return { exitCode: 0, message };
}
