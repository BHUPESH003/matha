import * as crypto from 'crypto';
import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js';
import { recordDecision, recordDangerZone } from '@/store/records.js';
import { validateDecisionInput, validateDangerInput } from '@/core/schema.js';
import { checkSchemaVersion, getSchemaMessage } from '@/utils/schema-version.js';

interface AfterDeps {
  ask?: (question: string) => Promise<string>;
  log?: (msg: string) => void;
  now?: () => Date;
}

interface AfterResult {
  exitCode: 0 | 1;
  message?: string;
  decisionRecorded?: boolean;
  dangerZoneRecorded?: boolean;
}

/**
 * `matha after` — record what a session learned. Interactive fallback for
 * agents without MCP support (with MCP, the agent calls matha_record_*
 * directly). Inputs are schema-validated: trivial answers ("y") are
 * rejected instead of becoming permanent memory, which happened in 0.1.x.
 */
export async function runAfter(
  projectRoot: string = process.cwd(),
  deps?: AfterDeps,
): Promise<AfterResult> {
  const ask = deps?.ask ?? defaultAsk;
  const log = deps?.log ?? console.log;
  const now = deps?.now ?? (() => new Date());

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

  const timestamp = now().toISOString();
  const sessionId = `${timestamp.slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;

  let decisionRecorded = false;
  let dangerZoneRecorded = false;

  // ── DECISION ─────────────────────────────────────────────────────
  const assumption = (
    await ask('What assumption broke or needed correction? (press enter to skip)')
  ).trim();

  if (assumption) {
    const correction = (
      await ask('What was the correction? What is the right understanding?')
    ).trim();
    const component = (
      await ask('Which files or components does this apply to? (comma-separated paths preferred)')
    ).trim();

    const valid = validateDecisionInput({
      component,
      previous_assumption: assumption,
      correction,
    });
    if (!valid.ok) {
      log(`✗ Decision not recorded: ${valid.reason}`);
    } else {
      await recordDecision(mathaDir, {
        id: `${sessionId}-decision`,
        timestamp,
        component,
        previous_assumption: assumption,
        correction,
        trigger: sessionId,
        confidence: 'confirmed', // human-entered
        status: 'active',
        supersedes: null,
        session_id: sessionId,
      });
      decisionRecorded = true;
    }
  }

  // ── DANGER ZONE ──────────────────────────────────────────────────
  const dangerPattern = (
    await ask(
      'Record a danger zone for future sessions? Describe the pattern to watch for, or press enter to skip.',
    )
  ).trim();

  if (dangerPattern) {
    const component = (
      await ask('Which files or components does this danger apply to? (comma-separated paths preferred)')
    ).trim();

    const valid = validateDangerInput({ component, description: dangerPattern });
    if (!valid.ok) {
      log(`✗ Danger zone not recorded: ${valid.reason}`);
    } else {
      await recordDangerZone(mathaDir, {
        id: `${sessionId}-danger`,
        component,
        pattern: dangerPattern,
        description: dangerPattern,
        confidence: 'confirmed', // human-entered
      });
      dangerZoneRecorded = true;
    }
  }

  // ── SUMMARY ──────────────────────────────────────────────────────
  log('\n════════════════════════════════════════');
  log('MATHA WRITE-BACK COMPLETE');
  log('════════════════════════════════════════');
  log(`${decisionRecorded ? '✓' : '–'} Decision recorded${decisionRecorded ? '' : ' (none)'}`);
  log(`${dangerZoneRecorded ? '✓' : '–'} Danger zone recorded${dangerZoneRecorded ? '' : ' (none)'}`);
  log('════════════════════════════════════════\n');

  return { exitCode: 0, decisionRecorded, dangerZoneRecorded };
}

async function defaultAsk(question: string): Promise<string> {
  const { input } = await import('@inquirer/prompts');
  return await input({ message: question });
}
