import * as path from 'path';
import { readJsonOrNull } from '../storage/reader.js';
import { writeAtomic } from '../storage/writer.js';
import * as fs from 'fs/promises';
// ── INTENT ───────────────────────────────────────────────────────────
/**
 * Returns the project intent, or null if not yet defined.
 */
export async function getIntent(mathaDir) {
    const intentPath = path.join(mathaDir, 'hippocampus', 'intent.json');
    return await readJsonOrNull(intentPath);
}
// ── RULES ────────────────────────────────────────────────────────────
/**
 * Returns all non-negotiable business rules, or an empty array if none exist.
 */
export async function getRules(mathaDir) {
    const rulesPath = path.join(mathaDir, 'hippocampus', 'rules.json');
    const data = await readJsonOrNull(rulesPath);
    return data?.rules ?? [];
}
// ── DECISIONS ────────────────────────────────────────────────────────
/**
 * Records a decision entry to the decision log.
 * Decision log is append-only: never modifies existing entries.
 *
 * @throws if a decision with the same id already exists
 */
export async function recordDecision(mathaDir, entry) {
    const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions');
    const decisionPath = path.join(decisionsDir, `${entry.id}.json`);
    // Guard: reject if decision with this id already exists
    try {
        await fs.access(decisionPath);
        throw new Error(`Decision with id '${entry.id}' already exists`);
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
        // File does not exist — proceed
    }
    await writeAtomic(decisionPath, entry);
}
/**
 * Returns all decision entries, optionally filtered by component.
 * Results are sorted by timestamp descending (most recent first).
 *
 * @param component - Optional filter by component name
 * @param limit - Optional limit on number of results
 */
export async function getDecisions(mathaDir, component, limit) {
    const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions');
    let files;
    try {
        files = await fs.readdir(decisionsDir);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    const entries = [];
    for (const file of jsonFiles) {
        const filePath = path.join(decisionsDir, file);
        try {
            const entry = await readJsonOrNull(filePath);
            if (entry)
                entries.push(entry);
        }
        catch {
            // Skip malformed files
        }
    }
    // Filter by component if provided
    let filtered = component
        ? entries.filter((e) => e.component === component)
        : entries;
    // Sort by timestamp descending (most recent first)
    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    // Apply limit if provided
    if (limit !== undefined && limit > 0) {
        filtered = filtered.slice(0, limit);
    }
    return filtered;
}
// ── DANGER ZONES ─────────────────────────────────────────────────────
/**
 * Returns all danger zones, optionally filtered by context string.
 *
 * Context matching checks both component and description fields
 * (case-insensitive).
 *
 * @param context - Optional context string to filter by
 */
export async function getDangerZones(mathaDir, context) {
    const dangerZonesPath = path.join(mathaDir, 'hippocampus', 'danger-zones.json');
    const data = await readJsonOrNull(dangerZonesPath);
    const zones = data?.zones ?? [];
    if (!context)
        return zones;
    const contextLower = context.toLowerCase();
    return zones.filter((zone) => zone.component.toLowerCase().includes(contextLower) ||
        zone.description.toLowerCase().includes(contextLower));
}
/**
 * Records a new danger zone.
 */
export async function recordDangerZone(mathaDir, zone) {
    const dangerZonesPath = path.join(mathaDir, 'hippocampus', 'danger-zones.json');
    const existing = await readJsonOrNull(dangerZonesPath);
    const zones = existing?.zones ?? [];
    zones.push(zone);
    await writeAtomic(dangerZonesPath, { zones }, { overwrite: true });
}
// ── OPEN QUESTIONS ───────────────────────────────────────────────────
/**
 * Returns all open questions, or an empty array if none exist.
 */
export async function getOpenQuestions(mathaDir) {
    const questionsPath = path.join(mathaDir, 'hippocampus', 'open-questions.json');
    const data = await readJsonOrNull(questionsPath);
    return data?.questions ?? [];
}
/**
 * Records a new open question.
 */
export async function recordOpenQuestion(mathaDir, question) {
    const questionsPath = path.join(mathaDir, 'hippocampus', 'open-questions.json');
    const existing = await readJsonOrNull(questionsPath);
    const questions = existing?.questions ?? [];
    questions.push(question);
    await writeAtomic(questionsPath, { questions }, { overwrite: true });
}
