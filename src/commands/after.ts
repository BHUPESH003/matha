import * as fs from 'fs/promises';
import * as path from 'path';
import { readJsonOrNull } from '@/storage/reader.js';
import { writeAtomic, appendToArray } from '@/storage/writer.js';
import { recordDecision, recordDangerZone } from '@/brain/hippocampus.js';
import { checkSchemaVersion, getSchemaMessage } from '@/utils/schema-version.js';

interface AfterDeps {
  ask?: (question: string) => Promise<string>;
  log?: (msg: string) => void;
  now?: () => Date;
}

interface AfterResult {
  exitCode: 0 | 1;
  message?: string;
  sessionId?: string;
  scope?: string;
  decisionRecorded?: boolean;
  dangerZoneRecorded?: boolean;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function generateSessionId(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const randomHex = Array.from({ length: 4 })
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join('');

  return `${year}${month}${day}-${hours}${minutes}${seconds}-${randomHex}`;
}

async function findMostRecentPredictionFile(predictionsDir: string): Promise<string | null> {
  try {
    const files = await fs.readdir(predictionsDir);
    if (files.length === 0) return null;

    // Sort filenames descending to get most recent
    const sorted = files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''))
      .sort()
      .reverse();

    return sorted.length > 0 ? sorted[0] : null;
  } catch {
    return null;
  }
}

async function getLinkedSessionBrief(mathaDir: string, sessionId: string): Promise<any> {
  try {
    const briefPath = path.join(mathaDir, `sessions/${sessionId}.brief`);
    return await readJsonOrNull(briefPath);
  } catch {
    return null;
  }
}

async function runAfter(projectRoot: string = process.cwd(), deps?: AfterDeps): Promise<AfterResult> {
  const ask = deps?.ask ?? defaultAsk;
  const log = deps?.log ?? console.log;
  const now = deps?.now ?? (() => new Date());

  const mathaDir = path.join(projectRoot, '.matha');
  const configPath = path.join(mathaDir, 'config.json');

  // GUARD: Check if .matha/config.json exists
  const configExists = await pathExists(configPath);
  if (!configExists) {
    const message = 'MATHA is not initialised. Run `matha init` first.';
    log(message);
    return { exitCode: 1, message };
  }

  // SCHEMA VERSION CHECK
  const schemaResult = await checkSchemaVersion(mathaDir);
  const schemaMsg = getSchemaMessage(schemaResult);
  if (schemaMsg) log(schemaMsg);
  if (schemaResult.status === 'newer') {
    return { exitCode: 1, message: schemaMsg! };
  }

  const timestamp = now().toISOString();
  const predictionsDir = path.join(mathaDir, 'dopamine/predictions');

  // Find most recent prediction file
  const linkedSessionId = await findMostRecentPredictionFile(predictionsDir);
  const sessionId = linkedSessionId ?? generateSessionId(now());

  if (linkedSessionId) {
    log(`\nLinking to session: ${linkedSessionId}\n`);
  }

  // Get scope and contract from linked session brief if available
  const brief = await getLinkedSessionBrief(mathaDir, sessionId);
  let scope = brief?.scope ?? 'unknown';
  const assertions: string[] = brief?.contract && Array.isArray(brief.contract) ? brief.contract : [];

  // PROMPT 01 — DISCOVERY: What assumption broke?
  const assumptionInput = await ask(
    'What assumption broke or needed correction? (press enter to skip)',
  );
  const assumption = assumptionInput.trim() || null;

  // PROMPT 02 — CORRECTION: Only show if assumption provided
  let correction: string | null = null;
  if (assumption) {
    const correctionInput = await ask(
      'What was the correction? What is the right understanding?',
    );
    correction = correctionInput.trim() || null;
  }

  // PROMPT 03 — DANGER ZONE
  const dangerPatternInput = await ask(
    'Should this be recorded as a danger zone for future sessions?\n' +
      'Describe the pattern to watch for, or press enter to skip.',
  );
  const dangerPattern = dangerPatternInput.trim() || null;

  // PROMPT 04 — CONTRACT RESULT
  let contractResult: 'passed' | 'partial' | 'violated' | 'none' = 'none';
  const failedAssertions: string[] = [];

  if (assertions.length > 0) {
    log(`\nCONTRACT VALIDATION — ${assertions.length} assertion(s) to check:\n`);

    let passCount = 0;
    let failCount = 0;
    let skipCount = 0;

    for (let i = 0; i < assertions.length; i++) {
      const assertionText = assertions[i];
      log(`  [${i + 1}/${assertions.length}] ${assertionText}`);
      
      let valid = false;
      while (!valid) {
        let answer = await ask('  Did this pass? (y/n/skip)');
        answer = answer.trim().toLowerCase();
        
        if (answer === 'y' || answer === 'yes' || answer === 'pass') {
          passCount++;
          valid = true;
        } else if (answer === 'n' || answer === 'no' || answer === 'fail') {
          failCount++;
          failedAssertions.push(assertionText);
          valid = true;
        } else if (answer === 'skip' || answer === 's') {
          skipCount++;
          valid = true;
        } else {
          log('  Please answer y, n, or skip.');
        }
      }
    }

    if (failCount > 0) {
      contractResult = 'violated';
    } else if (passCount === 0 && skipCount > 0) {
      contractResult = 'none';
    } else if (passCount > 0 && skipCount > 0) {
      contractResult = 'partial';
    } else if (passCount > 0) {
      contractResult = 'passed';
    } else {
      contractResult = 'none';
    }

    const marks: Record<string, string> = { passed: 'PASSED ✓', violated: 'VIOLATED ✗', partial: 'PARTIAL ~', none: 'NONE –' };
    log(`\nContract result: ${marks[contractResult]}`);
  } else {
    log('\nDid the behaviour contract pass?');
    log('  1. Yes — all assertions passed');
    log('  2. Partial — some assertions passed');
    log('  3. No — contract was violated');
    log('  4. No contract was written');
    log('');

    const contractChoice = await ask('Did the behaviour contract pass? (1-4):');
    const contractResultMap: Record<string, 'passed' | 'partial' | 'violated' | 'none'> = {
      '1': 'passed',
      '2': 'partial',
      '3': 'violated',
      '4': 'none',
    };
    contractResult = contractResultMap[contractChoice] || 'none';
  }

  // PROMPT 05 — ACTUALS: Files changed
  const filesInput = await ask('Approximately how many files were changed in this session?');
  const filesChanged = parseInt(filesInput, 10) || 0;

  // PROMPT 05 — ACTUALS: Tokens used
  const tokensInput = await ask(
    'Roughly how many tokens did this session use? (press enter to skip)',
  );
  const tokensUsed = tokensInput.trim() ? parseInt(tokensInput, 10) : null;

  // ──────────────────────────────────────────────────────────────
  // WRITE-BACK OPERATIONS
  // ──────────────────────────────────────────────────────────────

  let decisionRecorded = false;
  let dangerZoneRecorded = false;

  // 1. DECISION ENTRY (if both assumption AND correction)
  if (assumption && correction) {
    try {
      await recordDecision(mathaDir, {
        id: `${sessionId}-decision`,
        timestamp,
        component: scope,
        previous_assumption: assumption,
        correction,
        trigger: sessionId,
        confidence: 'confirmed',
        status: 'active',
        supersedes: null,
        session_id: sessionId,
      });
      decisionRecorded = true;
    } catch (err) {
      // Gracefully handle duplicate decision (same sessionId)
      // Decision is still recorded from the first run
      if (linkedSessionId) {
        decisionRecorded = false; // Don't claim it was recorded on duplicate
      }
    }
  }

  // 2. DANGER ZONE (if pattern provided)
  if (dangerPattern) {
    try {
      const dangerZoneId = `${sessionId}-danger`;
      await recordDangerZone(mathaDir, {
        id: dangerZoneId,
        component: scope,
        pattern: 'Session-discovered pattern',
        description: dangerPattern,
      });
      dangerZoneRecorded = true;
    } catch {
      dangerZoneRecorded = false;
    }
  }

  // 3. DOPAMINE ACTUAL (always written)
  const actualRecord = {
    session_id: sessionId,
    timestamp,
    contract_result: contractResult,
    actual: {
      files_changed: filesChanged,
      tokens_used: tokensUsed,
    },
  };

  const actualPath = path.join(mathaDir, `dopamine/actuals/${sessionId}.json`);
  await writeAtomic(actualPath, actualRecord);

  // 4. DOPAMINE DELTA
  let predictionData: any = null;
  try {
    const predictionPath = path.join(mathaDir, `dopamine/predictions/${sessionId}.json`);
    predictionData = await readJsonOrNull(predictionPath);
  } catch {
    predictionData = null;
  }

  const tokenDelta = predictionData && tokensUsed ? tokensUsed - predictionData.predicted.token_budget : null;

  const deltaEntry = {
    session_id: sessionId,
    timestamp,
    operation_type: predictionData?.operation_type ?? 'unknown',
    contract_result: contractResult,
    token_delta: tokenDelta,
    files_changed: filesChanged,
    model_tier_used: predictionData?.predicted.model_tier ?? 'unknown',
  };

  const deltasPath = path.join(mathaDir, 'dopamine/deltas.json');
  await appendToArray(deltasPath, deltaEntry);

  // 5. CONTRACT VIOLATION LOG (only if violated or partial)
  if (failedAssertions.length > 0) {
    const violationPath = path.join(mathaDir, 'cerebellum/violation-log.json');
    for (const assertionText of failedAssertions) {
      const violationEntry = {
        session_id: sessionId,
        timestamp,
        result: 'violated',
        scope,
        assertion: assertionText,
        component: scope,
      };
      await appendToArray(violationPath, violationEntry);
      await updateContractViolation(mathaDir, scope, assertionText, timestamp);
    }
  } else if (contractResult === 'violated' || contractResult === 'partial') {
    const violationEntry = {
      session_id: sessionId,
      timestamp,
      result: contractResult,
      scope,
    };
    const violationPath = path.join(mathaDir, 'cerebellum/violation-log.json');
    await appendToArray(violationPath, violationEntry);
  }

  // ──────────────────────────────────────────────────────────────
  // TERMINAL OUTPUT
  // ──────────────────────────────────────────────────────────────

  log('\n════════════════════════════════════════');
  log(`MATHA WRITE-BACK COMPLETE — ${sessionId}`);
  log('════════════════════════════════════════\n');

  const decisionMark = decisionRecorded ? '✓' : '–';
  const dangerMark = dangerZoneRecorded ? '✓' : '–';
  const contractMark = '✓';
  const dopamineMark = '✓';

  log(
    `${decisionMark} Decision recorded` +
      (decisionRecorded ? ` (${scope}: ${correction?.substring(0, 40)})` : ''),
  );
  log(`${dangerMark} Danger zone recorded` + (dangerZoneRecorded ? ` (${dangerPattern})` : ' (none)'));
  log(`${contractMark} Contract result logged (${contractResult})`);

  const tokenDeltaStr = tokenDelta !== null ? `${tokenDelta > 0 ? '+' : ''}${tokenDelta}` : 'N/A';
  log(`${dopamineMark} Dopamine delta recorded (tokens: ${tokenDeltaStr} | files: ${filesChanged})`);

  log('\nBrain updated. Next session starts warmer.');
  log('════════════════════════════════════════\n');

  return {
    exitCode: 0,
    sessionId,
    scope,
    decisionRecorded,
    dangerZoneRecorded,
  };
}

async function updateContractViolation(mathaDir: string, component: string, assertionText: string, timestamp: string): Promise<void> {
  try {
    const sanitizedComponent = component.replace(/[^a-zA-Z0-9_-]/g, '_');
    const contractPath = path.join(mathaDir, `cerebellum/contracts/${sanitizedComponent}.json`);
    const contract = await readJsonOrNull<any>(contractPath);
    if (!contract || !Array.isArray(contract.assertions)) {
      return;
    }

    let modified = false;
    const searchTarget = assertionText.trim().toLowerCase();

    for (const assertion of contract.assertions) {
      if (assertion.description && assertion.description.trim().toLowerCase() === searchTarget) {
        assertion.violation_count = (assertion.violation_count || 0) + 1;
        assertion.last_violated = timestamp;
        modified = true;
      }
    }

    if (modified) {
      await writeAtomic(contractPath, contract, { overwrite: true });
    }
  } catch {
    // Fail silently
  }
}

// Default ask implementation using @inquirer/prompts
async function defaultAsk(question: string): Promise<string> {
  const { input } = await import('@inquirer/prompts');

  return await input({ message: question });
}

export { runAfter };
