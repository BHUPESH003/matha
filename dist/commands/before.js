import * as fs from 'fs/promises';
import * as path from 'path';
import { readJsonOrNull } from '../storage/reader.js';
import { writeAtomic } from '../storage/writer.js';
import { getRules, getDangerZones } from '../brain/hippocampus.js';
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
    // Generate session ID
    const sessionId = generateSessionId(now());
    const timestamp = now().toISOString();
    // GATE 01 — UNDERSTAND: What are you about to build or change?
    const operationDescription = await ask('What are you about to build or change?');
    // GATE 02 — BOUND: Which components or files will this affect?
    const scopeInput = await ask('Which components or files will this affect? (comma separated)');
    const scope = scopeInput;
    // GATE 03 — ORIENT: Read cortex files (no prompt)
    let shape = null;
    let stability = null;
    try {
        shape = await readJsonOrNull(path.join(mathaDir, 'cortex/shape.json'));
        stability = await readJsonOrNull(path.join(mathaDir, 'cortex/stability.json'));
    }
    catch {
        // Gracefully handle missing cortex files
        shape = null;
        stability = null;
    }
    // GATE 04 — SURFACE DANGER: Get danger zones and display
    let dangerZones = [];
    try {
        dangerZones = await getDangerZones(mathaDir, scope);
    }
    catch {
        // Gracefully handle missing danger zones
        dangerZones = [];
    }
    if (dangerZones.length > 0) {
        log('\n⚠ DANGER ZONES DETECTED:');
        for (const zone of dangerZones) {
            log(`  · ${zone.component}: ${zone.description}`);
        }
        log('');
    }
    else {
        log('\n✓ No danger zones match this scope.\n');
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
        bounds: businessRules,
        dangerZones,
        contract: assertions,
        business_rules: businessRules,
        assertions,
        modelTier,
        tokenBudget,
        gatesCompleted: [1, 2, 3, 4, 5, 6],
        readyToBuild,
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
    log('DANGER ZONES:');
    if (dangerZones.length > 0) {
        for (const zone of dangerZones) {
            log(`  · ${zone.component}: ${zone.description}`);
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
