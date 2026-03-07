import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeAtomic } from '../storage/writer.js';
import { readJsonOrNull } from '../storage/reader.js';
import { getIntent, getRules } from '../brain/hippocampus.js';
const REQUIRED_DIRS = [
    '.matha/hippocampus',
    '.matha/hippocampus/decisions',
    '.matha/cerebellum',
    '.matha/cerebellum/contracts',
    '.matha/cortex',
    '.matha/dopamine',
    '.matha/dopamine/predictions',
    '.matha/dopamine/actuals',
    '.matha/sessions',
];
const IGNORE_DIRS = new Set(['.matha', '.git', 'node_modules']);
export async function runInit(projectRoot = process.cwd(), deps) {
    const ask = deps?.ask ?? defaultAsk;
    const log = deps?.log ?? console.log;
    const now = deps?.now ?? (() => new Date());
    const created = [];
    const skipped = [];
    for (const relDir of REQUIRED_DIRS) {
        const absDir = path.join(projectRoot, relDir);
        const alreadyExists = await pathExists(absDir);
        await fs.mkdir(absDir, { recursive: true });
        (alreadyExists ? skipped : created).push(relDir);
    }
    const why = await safePrompt(ask, 'What problem does this project solve? (The WHY, not the features)');
    const rules = await collectLines(ask, 'What are the non-negotiable business rules? (Enter one per line, empty line to finish)');
    const boundaries = await collectLines(ask, 'What does this project explicitly NOT do? (Enter one per line, empty line to finish)');
    const ownerRaw = await safePrompt(ask, 'Who owns this project? (name or team, press enter to skip)');
    const owner = ownerRaw.trim() ? ownerRaw.trim() : null;
    const mathaDir = path.join(projectRoot, '.matha');
    // Hippocampus writes (idempotent: write only if file missing)
    const intentPath = path.join(mathaDir, 'hippocampus', 'intent.json');
    const existingIntent = await getIntent(mathaDir);
    if (existingIntent === null) {
        await writeAtomic(intentPath, { why });
        created.push('.matha/hippocampus/intent.json');
    }
    else {
        skipped.push('.matha/hippocampus/intent.json');
    }
    const rulesPath = path.join(mathaDir, 'hippocampus', 'rules.json');
    const existingRules = await getRules(mathaDir);
    if (existingRules.length === 0 && !(await pathExists(rulesPath))) {
        await writeAtomic(rulesPath, { rules });
        created.push('.matha/hippocampus/rules.json');
    }
    else {
        skipped.push('.matha/hippocampus/rules.json');
    }
    const boundariesPath = path.join(mathaDir, 'cortex', 'boundaries.json');
    await writeIfMissing(boundariesPath, { boundaries }, created, skipped, projectRoot);
    const ownershipPath = path.join(mathaDir, 'cortex', 'ownership.json');
    await writeIfMissing(ownershipPath, { owner }, created, skipped, projectRoot);
    const shape = await deriveShape(projectRoot, now);
    const shapePath = path.join(mathaDir, 'cortex', 'shape.json');
    await writeIfMissing(shapePath, shape, created, skipped, projectRoot);
    const configPath = path.join(mathaDir, 'config.json');
    await writeIfMissing(configPath, {
        version: '0.1.0',
        initialized_at: now().toISOString(),
        project_root: projectRoot,
        brain_dir: '.matha',
    }, created, skipped, projectRoot);
    log('matha init complete');
    log(`created: ${created.length}`);
    log(`skipped: ${skipped.length}`);
    return {
        projectRoot,
        brainDir: '.matha',
        created,
        skipped,
    };
}
async function deriveShape(projectRoot, now) {
    const directories = await listTopLevelDirectories(projectRoot);
    const detected_stack = await detectStack(projectRoot);
    const file_count = await countFiles(projectRoot);
    return {
        directories,
        detected_stack,
        file_count,
        derived_at: now().toISOString(),
    };
}
async function listTopLevelDirectories(projectRoot) {
    try {
        const entries = await fs.readdir(projectRoot, { withFileTypes: true });
        return entries
            .filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name))
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b));
    }
    catch {
        return [];
    }
}
async function detectStack(projectRoot) {
    const detected = new Set();
    if (await pathExists(path.join(projectRoot, 'package.json'))) {
        // malformed package.json must never crash init
        try {
            const raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf-8');
            JSON.parse(raw);
        }
        catch {
            // ignore parse issues; still detected as node
        }
        detected.add('node');
    }
    if (await pathExists(path.join(projectRoot, 'tsconfig.json')))
        detected.add('typescript');
    if (await pathExists(path.join(projectRoot, 'requirements.txt')))
        detected.add('python');
    if (await pathExists(path.join(projectRoot, 'Cargo.toml')))
        detected.add('rust');
    if (await pathExists(path.join(projectRoot, 'go.mod')))
        detected.add('go');
    if (await pathExists(path.join(projectRoot, 'pom.xml')))
        detected.add('java');
    return Array.from(detected);
}
async function countFiles(projectRoot) {
    let count = 0;
    const stack = [projectRoot];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current)
            continue;
        let entries;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory() && IGNORE_DIRS.has(entry.name))
                continue;
            const fullPath = path.join(current, entry.name);
            let stat;
            try {
                stat = await fs.lstat(fullPath);
            }
            catch {
                continue;
            }
            if (stat.isSymbolicLink())
                continue;
            if (stat.isDirectory()) {
                stack.push(fullPath);
            }
            else if (stat.isFile()) {
                count += 1;
            }
        }
    }
    return count;
}
async function writeIfMissing(filePath, data, created, skipped, projectRoot) {
    const existing = await readJsonOrNull(filePath);
    if (existing !== null) {
        skipped.push(path.relative(projectRoot, filePath).replaceAll('\\', '/'));
        return;
    }
    await writeAtomic(filePath, data);
    created.push(path.relative(projectRoot, filePath).replaceAll('\\', '/'));
}
async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
async function collectLines(ask, message) {
    const lines = [];
    while (true) {
        const line = (await safePrompt(ask, message)).trim();
        if (!line)
            break;
        lines.push(line);
    }
    return lines;
}
async function safePrompt(ask, message) {
    try {
        return await ask(message);
    }
    catch {
        return '';
    }
}
async function defaultAsk(message) {
    const prompts = await import('@inquirer/prompts');
    return prompts.input({ message });
}
