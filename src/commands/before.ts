import * as path from 'path';
import { Engine } from '@/core/engine.js';
import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js';
import { assembleBrief, type Brief } from '@/retrieve/brief.js';
import { checkSchemaVersion, getSchemaMessage } from '@/utils/schema-version.js';

interface BeforeDeps {
  scope?: string;
  intent?: string;
  log?: (msg: string) => void;
}

interface BeforeResult {
  exitCode: 0 | 1;
  message?: string;
  brief?: Brief;
}

/**
 * `matha before` — print the project brief for a scope.
 * Non-interactive: scope/intent come from flags. The MCP `matha_brief` tool
 * is the primary surface; this is the copy-paste fallback for agents
 * without MCP support.
 */
export async function runBefore(
  projectRoot: string = process.cwd(),
  deps?: BeforeDeps,
): Promise<BeforeResult> {
  const log = deps?.log ?? console.log;

  let mathaDir: string;
  try {
    const resolved = await resolveBrainDir({ explicitRoot: projectRoot });
    mathaDir = resolved.mathaDir;
  } catch (err) {
    if (err instanceof BrainNotFoundError) {
      const message = 'MATHA is not initialised. Run `matha init` first.';
      log(message);
      return { exitCode: 1, message };
    }
    throw err;
  }

  const schemaResult = await checkSchemaVersion(mathaDir);
  const schemaMsg = getSchemaMessage(schemaResult);
  if (schemaMsg) log(schemaMsg);
  if (schemaResult.status === 'newer') {
    return { exitCode: 1, message: schemaMsg! };
  }

  const engine = new Engine(mathaDir);
  const scope = deps?.scope ?? '';
  const brief = await assembleBrief(engine, {
    scope,
    intent: deps?.intent,
    filepaths: scope ? scope.split(',').map((s) => s.trim()).filter(Boolean) : [],
  });

  // ── Human-readable output, designed to paste into an agent ──────────
  log('════════════════════════════════════════');
  log('MATHA PROJECT BRIEF');
  log('════════════════════════════════════════\n');

  if (brief.why) log(`WHY: ${brief.why}\n`);
  if (scope) log(`SCOPE: ${scope}\n`);

  log('BUSINESS RULES:');
  if (brief.rules.length > 0) {
    for (const rule of brief.rules) log(`  · ${rule}`);
  } else {
    log('  (none defined)');
  }
  log('');

  if (brief.recentDecisions.length > 0) {
    log('RECENT DECISIONS (corrections a past session learned):');
    for (const d of brief.recentDecisions) {
      const stale = d.possiblyStale ? ' (possibly stale — code changed since recorded)' : '';
      log(`  · [${d.component}]${stale} assumed: ${d.previous_assumption} → actually: ${d.correction}`);
    }
    log('');
  }

  log('MATCHES FOR THIS SCOPE:');
  if (brief.matchResults.length > 0) {
    for (const res of brief.matchResults) {
      const stale = res.possiblyStale ? ' (possibly stale)' : '';
      log(`  · [${res.severity.toUpperCase()}]${stale} ${res.title}`);
      log(`    ${res.description}`);
    }
  } else {
    log(scope ? '  None detected' : '  (no scope given — pass --scope to match)');
  }
  log('');

  if (brief.hasCritical) {
    log('⚠ Critical matches detected — review before changing these areas.');
  }
  log(`(brain: ${path.relative(projectRoot, brief.diagnostics.brainDir) || brief.diagnostics.brainDir}, ` +
      `${brief.diagnostics.recordsConsidered} records considered)`);
  log('════════════════════════════════════════');

  return { exitCode: 0, brief };
}
