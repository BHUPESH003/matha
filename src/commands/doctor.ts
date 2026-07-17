import * as path from 'path';
import { simpleGit } from 'simple-git';
import { Engine } from '@/core/engine.js';
import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js';
import { readJsonOrNull } from '@/storage/reader.js';
import { checkSchemaVersion, getSchemaMessage } from '@/utils/schema-version.js';
import { CURRENT_SCHEMA_VERSION } from '@/core/schema.js';

export interface DoctorResult {
  exitCode: 0 | 1;
}

/**
 * `matha doctor` — diagnose the setup. Answers the questions that were
 * undiagnosable in 0.1.x: WHICH brain is being served, is the schema
 * current, what does the brain actually contain, and is the codemap stale.
 */
export async function runDoctor(opts?: {
  explicitRoot?: string;
  log?: (msg: string) => void;
}): Promise<DoctorResult> {
  const log = opts?.log ?? console.log;

  log('MATHA DOCTOR');
  log('────────────────────────────────────────');

  // 1. Brain resolution
  let mathaDir: string;
  let source: string;
  try {
    const resolved = await resolveBrainDir({
      explicitRoot: opts?.explicitRoot,
      cwd: process.cwd(),
    });
    mathaDir = resolved.mathaDir;
    source = resolved.source;
  } catch (err) {
    if (err instanceof BrainNotFoundError) {
      log('✗ Brain: NOT FOUND');
      for (const t of err.tried) log(`    tried: ${t}`);
      log('  Run `matha init` in your project root.');
      return { exitCode: 1 };
    }
    throw err;
  }
  log(`✓ Brain: ${mathaDir} (resolved via ${source})`);

  // 2. Schema version
  const schemaResult = await checkSchemaVersion(mathaDir);
  if (schemaResult.status === 'ok') {
    log(`✓ Schema: v${schemaResult.version} (current)`);
  } else {
    log(`✗ Schema: ${schemaResult.status} (found: ${schemaResult.version ?? 'none'}, current: v${CURRENT_SCHEMA_VERSION})`);
    const msg = getSchemaMessage(schemaResult);
    if (msg) log(`    ${msg}`);
  }

  // 3. Config sanity
  const config = await readJsonOrNull<Record<string, unknown>>(path.join(mathaDir, 'config.json'));
  const actualRoot = path.dirname(mathaDir);
  if (config?.project_root && config.project_root !== actualRoot) {
    log(`⚠ Config: project_root is stale ('${config.project_root}' — actual: '${actualRoot}'). Harmless; resolution no longer depends on it.`);
  } else {
    log('✓ Config: consistent');
  }

  // 4. Record counts
  const engine = new Engine(mathaDir);
  const counts = await engine.counts();
  log(
    `✓ Records: ${counts.rules} rules · ${counts.decisions} decisions · ` +
      `${counts.dangerZones} danger zones · ${counts.contracts} contracts · ` +
      `${counts.stabilityRecords} stability records · ${counts.coChangePairs} co-change pairs`,
  );

  // 5. Codemap staleness
  const stability = await engine.getStabilityRecords();
  const lastDerived = stability
    .map((r) => r.lastDerivedAt ?? '')
    .filter(Boolean)
    .sort()
    .pop();
  if (!lastDerived) {
    log('⚠ Codemap: never derived — run `matha init` or the matha_refresh MCP tool');
  } else {
    try {
      const git = simpleGit(actualRoot);
      const headLog = await git.log({ maxCount: 1 });
      const headDate = headLog.latest?.date ? new Date(headLog.latest.date) : null;
      if (headDate && headDate > new Date(lastDerived)) {
        log(`⚠ Codemap: stale (last derived ${lastDerived}, HEAD is newer). Run matha_refresh.`);
      } else {
        log(`✓ Codemap: current (last derived ${lastDerived})`);
      }
    } catch {
      log(`✓ Codemap: last derived ${lastDerived} (no git history readable to compare)`);
    }
  }

  log('────────────────────────────────────────');
  return { exitCode: 0 };
}
