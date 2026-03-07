import * as fs from 'fs/promises';
import * as path from 'path';
import { writeAtomic } from '../storage/writer.js';
import { getRules } from '../brain/hippocampus.js';
import { checkSchemaVersion, getSchemaMessage } from '../utils/schema-version.js';
import { getSnapshot, getStability } from '../brain/cortex.js';
import { matchAll } from '../analysis/contract-matcher.js';
// Operation type mapping from menu choice to operation_type
const operationTypeMap = {
    '1': 'rename',
    '2': 'crud',
    '3': 'business_logic',
    '4': 'architecture',
    '5': 'frozen_component',
};
// Model tier and token budget mapping
const modelTierBudget = {
    rename: { modelTier: 'lightweight', tokenBudget: 2000 },
    crud: { modelTier: 'lightweight', tokenBudget: 2000 },
    business_logic: { modelTier: 'capable', tokenBudget: 8000 },
    architecture: { modelTier: 'capable', tokenBudget: 16000 },
    frozen_component: { modelTier: 'capable', tokenBudget: 16000 },
};
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
async function runBefore(projectRoot = process.cwd(), deps) {
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
    if (schemaMsg)
        log(schemaMsg);
    if (schemaResult.status === 'newer') {
        return { exitCode: 1, message: schemaMsg };
    }
    // Generate session ID
    const sessionId = generateSessionId(now());
    const timestamp = now().toISOString();
    // GATE 01 — UNDERSTAND: What are you about to build or change?
    const operationDescription = await ask('What are you about to build or change?');
    // GATE 02 — BOUND: Which components or files will this affect?
    const scopeInput = await ask('Which components or files will this affect? (comma separated)');
    const scope = scopeInput;
    // GATE 03 — ORIENT: Read cortex (via cortex module)
    let cortexSnapshot = null;
    let frozenFiles = [];
    try {
        cortexSnapshot = await getSnapshot(mathaDir);
    }
    catch {
        cortexSnapshot = null;
    }
    if (cortexSnapshot && cortexSnapshot.stability && cortexSnapshot.stability.length > 0) {
        const s = cortexSnapshot.summary;
        log(`\nCORTEX (${cortexSnapshot.fileCount} files mapped):`);
        log(`  frozen: ${s.frozen}  stable: ${s.stable}  volatile: ${s.volatile}  disposable: ${s.disposable}`);
        // If scope was provided, check for frozen files in scope
        if (scope) {
            const scopeFiles = scope.split(',').map((f) => f.trim().replace(/\\/g, '/'));
            try {
                const stabilityMap = await getStability(mathaDir, scopeFiles);
                for (const [fp, record] of Object.entries(stabilityMap)) {
                    if (record && record.stability === 'frozen') {
                        log(`  ⚠ ${fp} — FROZEN (${record.reason})`);
                        frozenFiles.push(fp);
                    }
                    else if (record && record.stability === 'stable') {
                        log(`  · ${fp} — STABLE`);
                    }
                }
            }
            catch {
                // Gracefully handle stability lookup errors
            }
        }
        log('');
    }
    else {
        log('\n  Cortex empty — run matha init or commit some code\n');
    }
    // GATE 04 — SENSE PAST HISTORY: Run Contract Matcher
    const matchContext = {
        scope,
        intent: operationDescription,
        operationType: 'unknown',
        filepaths: scope.split(',').map((s) => s.trim()).filter(Boolean),
    };
    let matchResults = [];
    try {
        matchResults = await matchAll(matchContext, mathaDir);
    }
    catch {
        matchResults = [];
    }
    const criticals = matchResults.filter(r => r.severity === 'critical');
    const warnings = matchResults.filter(r => r.severity === 'warning');
    const infos = matchResults.filter(r => r.severity === 'info');
    const hasCritical = criticals.length > 0;
    if (matchResults.length === 0) {
        log('\n✓ No issues detected for this scope.\n');
    }
    else {
        log('');
        if (criticals.length > 0) {
            log(`🚨 CRITICAL — ${criticals.length} issue(s) require attention:`);
            for (const res of criticals) {
                log(`  ✗ ${res.title}`);
                log(`    ${res.description}`);
                log(`    → ${res.recommendation}`);
            }
        }
        if (warnings.length > 0) {
            log(`⚠  WARNINGS — ${warnings.length} prior finding(s):`);
            for (const res of warnings) {
                log(`  · ${res.title}`);
                log(`    ${res.description}`);
            }
        }
        if (infos.length > 0) {
            log(`ℹ  CONTEXT — ${infos.length} relevant contract(s):`);
            for (const res of infos) {
                log(`  · ${res.title} — ${res.description}`);
            }
        }
        log('');
    }
    // GATE 05 — CONTRACT: Write the behaviour contract
    const contractInput = await ask('Write the behaviour contract for this session.\nWhat must be true after your changes? (one assertion per line, empty line to finish)');
    const assertions = contractInput
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (assertions.length === 0) {
        log('⚠ No contract written — build gate will be advisory only.\n');
    }
    // GATE 06 — COST CHECK: What type of operation?
    log('\nWhat type of operation is this?');
    log('  1. Rename / Format');
    log('  2. CRUD / Boilerplate');
    log('  3. Business Logic');
    log('  4. Architecture Change');
    log('  5. Frozen Component Change');
    log('');
    const operationTypeChoice = await ask('What type of operation is this? (1-5):');
    const operationType = operationTypeMap[operationTypeChoice] || 'rename';
    const { modelTier, tokenBudget } = modelTierBudget[operationType];
    // Read hippocampus context
    let businessRules = [];
    try {
        businessRules = await getRules(mathaDir);
    }
    catch {
        businessRules = [];
    }
    // Build session brief directly
    const readyToBuild = assertions.length > 0; // Only ready if contract provided
    const brief = {
        sessionId,
        scope,
        operationType,
        timestamp,
        operation_description: operationDescription,
        why: '', // Not collected interactively - would be from Gate 01 in full flow
        business_rules: businessRules,
        matchResults,
        hasCritical,
        contract: assertions,
        assertions,
        modelTier,
        tokenBudget,
        gatesCompleted: [1, 2, 3, 4, 5, 6],
        readyToBuild,
        cortexSummary: cortexSnapshot?.summary ?? null,
        frozenFiles,
    };
    // Write session brief to .matha/sessions/[sessionId].brief
    const briefPath = path.join(mathaDir, `sessions/${sessionId}.brief`);
    await writeAtomic(briefPath, brief);
    // Write dopamine prediction to .matha/dopamine/predictions/[sessionId].json
    const prediction = {
        session_id: sessionId,
        timestamp,
        operation_type: operationType,
        scope,
        predicted: {
            model_tier: modelTier,
            token_budget: tokenBudget,
        },
        actual: null,
        delta: null,
    };
    const predictionPath = path.join(mathaDir, `dopamine/predictions/${sessionId}.json`);
    await writeAtomic(predictionPath, prediction);
    // Print human-readable brief to terminal
    log('\n════════════════════════════════════════');
    log(`MATHA SESSION BRIEF — ${sessionId}`);
    log('════════════════════════════════════════\n');
    log(`SCOPE:    ${scope}`);
    log(`WHAT:     ${operationDescription}`);
    log(`TYPE:     ${operationType}`);
    log(`MODEL:    ${modelTier} (budget: ${tokenBudget} tokens)\n`);
    log('BUSINESS RULES:');
    if (businessRules.length > 0) {
        for (const rule of businessRules) {
            log(`  · ${rule}`);
        }
    }
    else {
        log('  (none defined)');
    }
    log('');
    log('MATCH RESULTS:');
    if (matchResults.length > 0) {
        for (const res of matchResults) {
            log(`  · [${res.severity.toUpperCase()}] ${res.title}`);
        }
    }
    else {
        log('  None detected');
    }
    log('');
    log('CONTRACT:');
    if (assertions.length > 0) {
        for (const assertion of assertions) {
            log(`  · ${assertion}`);
        }
    }
    else {
        log('  (no contract written — advisory only)');
    }
    log('');
    log('════════════════════════════════════════');
    log(`READY TO BUILD: ${brief.readyToBuild ? 'YES' : 'NO (advisory only)'}`);
    if (hasCritical) {
        log('⚠ Critical issues detected — proceed with caution');
    }
    log('════════════════════════════════════════\n');
    log('Paste this brief into your AI agent before starting.\n');
    return {
        exitCode: 0,
        sessionId,
        brief,
        readyToBuild: brief.readyToBuild,
    };
}
// Default ask implementation using @inquirer/prompts
async function defaultAsk(question) {
    // Dynamically import to avoid ESM issues
    const { input } = await import('@inquirer/prompts');
    // Handle multiline input
    if (question.includes('behaviour contract')) {
        let lines = [];
        let lineCount = 1;
        log(question);
        while (true) {
            const line = await input({
                message: `Line ${lineCount}:`,
                default: '',
            });
            if (line.trim() === '') {
                break;
            }
            lines.push(line);
            lineCount++;
        }
        return lines.join('\n');
    }
    // Regular single-line input
    return await input({ message: question });
}
// Log helper
function log(msg) {
    console.log(msg);
}
export { runBefore };
