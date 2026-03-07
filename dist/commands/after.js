import * as fs from 'fs/promises';
import * as path from 'path';
import { readJsonOrNull } from '../storage/reader.js';
import { writeAtomic, appendToArray } from '../storage/writer.js';
import { recordDecision, recordDangerZone } from '../brain/hippocampus.js';
async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
function generateSessionId(now) {
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
async function findMostRecentPredictionFile(predictionsDir) {
    try {
        const files = await fs.readdir(predictionsDir);
        if (files.length === 0)
            return null;
        // Sort filenames descending to get most recent
        const sorted = files
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace('.json', ''))
            .sort()
            .reverse();
        return sorted.length > 0 ? sorted[0] : null;
    }
    catch {
        return null;
    }
}
async function getLinkedSessionBriefScope(mathaDir, sessionId) {
    try {
        const briefPath = path.join(mathaDir, `sessions/${sessionId}.brief`);
        const brief = await readJsonOrNull(briefPath);
        return brief?.scope ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
}
async function runAfter(projectRoot = process.cwd(), deps) {
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
    const timestamp = now().toISOString();
    const predictionsDir = path.join(mathaDir, 'dopamine/predictions');
    // Find most recent prediction file
    const linkedSessionId = await findMostRecentPredictionFile(predictionsDir);
    const sessionId = linkedSessionId ?? generateSessionId(now());
    if (linkedSessionId) {
        log(`\nLinking to session: ${linkedSessionId}\n`);
    }
    // Get scope from linked session brief if available
    let scope = await getLinkedSessionBriefScope(mathaDir, sessionId);
    // PROMPT 01 — DISCOVERY: What assumption broke?
    const assumptionInput = await ask('What assumption broke or needed correction? (press enter to skip)');
    const assumption = assumptionInput.trim() || null;
    // PROMPT 02 — CORRECTION: Only show if assumption provided
    let correction = null;
    if (assumption) {
        const correctionInput = await ask('What was the correction? What is the right understanding?');
        correction = correctionInput.trim() || null;
    }
    // PROMPT 03 — DANGER ZONE
    const dangerPatternInput = await ask('Should this be recorded as a danger zone for future sessions?\n' +
        'Describe the pattern to watch for, or press enter to skip.');
    const dangerPattern = dangerPatternInput.trim() || null;
    // PROMPT 04 — CONTRACT RESULT
    log('\nDid the behaviour contract pass?');
    log('  1. Yes — all assertions passed');
    log('  2. Partial — some assertions passed');
    log('  3. No — contract was violated');
    log('  4. No contract was written');
    log('');
    const contractChoice = await ask('Did the behaviour contract pass? (1-4):');
    const contractResultMap = {
        '1': 'passed',
        '2': 'partial',
        '3': 'violated',
        '4': 'none',
    };
    const contractResult = contractResultMap[contractChoice] || 'none';
    // PROMPT 05 — ACTUALS: Files changed
    const filesInput = await ask('Approximately how many files were changed in this session?');
    const filesChanged = parseInt(filesInput, 10) || 0;
    // PROMPT 05 — ACTUALS: Tokens used
    const tokensInput = await ask('Roughly how many tokens did this session use? (press enter to skip)');
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
        }
        catch (err) {
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
        }
        catch {
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
    let predictionData = null;
    try {
        const predictionPath = path.join(mathaDir, `dopamine/predictions/${sessionId}.json`);
        predictionData = await readJsonOrNull(predictionPath);
    }
    catch {
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
    if (contractResult === 'violated' || contractResult === 'partial') {
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
    log(`${decisionMark} Decision recorded` +
        (decisionRecorded ? ` (${scope}: ${correction?.substring(0, 40)})` : ''));
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
// Default ask implementation using @inquirer/prompts
async function defaultAsk(question) {
    const { input } = await import('@inquirer/prompts');
    return await input({ message: question });
}
export { runAfter };
