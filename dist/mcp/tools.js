import * as fs from 'fs/promises';
import * as path from 'path';
import { readJsonOrNull } from '../storage/reader.js';
import { writeAtomic } from '../storage/writer.js';
import { getRules, getDangerZones, getDecisions, recordDecision, recordDangerZone, } from '../brain/hippocampus.js';
import { refreshFromGit, getStability, getSnapshot, } from '../brain/cortex.js';
import { matchAll } from '../analysis/contract-matcher.js';
// Simple UUID-like ID generator
function generateId() {
    return Math.random().toString(36).substring(2, 15) +
        Math.random().toString(36).substring(2, 15);
}
// ──────────────────────────────────────────────────────────────────────
// READ TOOLS
// ──────────────────────────────────────────────────────────────────────
/**
 * matha_get_rules: Returns all business rules.
 */
export async function mathaGetRules(mathaDir) {
    try {
        const rules = await getRules(mathaDir);
        return JSON.stringify({ rules });
    }
    catch (err) {
        return JSON.stringify({ error: `Failed to get rules: ${err.message}` });
    }
}
/**
 * matha_get_danger_zones: Returns danger zones, optionally filtered by context.
 */
export async function mathaGetDangerZones(mathaDir, context) {
    try {
        const zones = await getDangerZones(mathaDir, context);
        return JSON.stringify({ zones });
    }
    catch (err) {
        return JSON.stringify({ error: `Failed to get danger zones: ${err.message}` });
    }
}
/**
 * matha_get_decisions: Returns decisions, optionally filtered by component and limit.
 */
export async function mathaGetDecisions(mathaDir, component, limit) {
    try {
        const decisions = await getDecisions(mathaDir, component, limit);
        return JSON.stringify({ decisions });
    }
    catch (err) {
        return JSON.stringify({ error: `Failed to get decisions: ${err.message}` });
    }
}
/**
 * matha_get_stability: Returns stability classification for requested files.
 * Uses cortex.getStability — returns StabilityRecord | null per file.
 * repoPath assumption: process.cwd() is the project root.
 */
export async function mathaGetStability(mathaDir, files) {
    try {
        const stability = await getStability(mathaDir, files);
        return JSON.stringify({ stability });
    }
    catch (err) {
        // On any error, return null for all
        const stability = {};
        for (const file of files) {
            stability[file] = null;
        }
        return JSON.stringify({ stability });
    }
}
/**
 * matha_brief: Returns the most recent session brief, or intent + rules.
 * If directory provided, filters decisions/danger zones/stability to that directory.
 */
export async function mathaBrief(mathaDir, scope, directory) {
    try {
        // DIRECTORY FILTER MODE
        if (directory) {
            const dirLower = directory.toLowerCase();
            // Filter decisions by component matching directory
            let decisions = [];
            try {
                const allDecisions = await getDecisions(mathaDir);
                decisions = allDecisions.filter((d) => (d.component || '').toLowerCase().includes(dirLower));
            }
            catch {
                decisions = [];
            }
            // Filter danger zones by component matching directory
            let zones = [];
            try {
                zones = await getDangerZones(mathaDir, directory);
            }
            catch {
                zones = [];
            }
            // Filter stability records where filepath starts with directory
            let stabilityRecords = [];
            try {
                const snapshot = await getSnapshot(mathaDir);
                if (snapshot && snapshot.stability) {
                    stabilityRecords = snapshot.stability.filter((s) => s.filepath.toLowerCase().startsWith(dirLower));
                }
            }
            catch {
                stabilityRecords = [];
            }
            const hasData = decisions.length > 0 || zones.length > 0 || stabilityRecords.length > 0;
            const matchContext = {
                scope: directory,
                intent: '',
                operationType: 'unknown',
                filepaths: [directory],
            };
            let matchResults = [];
            try {
                matchResults = await matchAll(matchContext, mathaDir);
            }
            catch {
                matchResults = [];
            }
            const hasCritical = matchResults.some((r) => r.severity === 'critical');
            return JSON.stringify({
                directory,
                filtered: true,
                hasData,
                message: hasData ? null : `No MATHA data found for directory: ${directory}`,
                decisions,
                dangerZones: zones,
                stability: stabilityRecords,
                matchResults,
                hasCritical,
            });
        }
        // STANDARD MODE — most recent session brief
        const sessionsDir = path.join(mathaDir, 'sessions');
        // Try to find the most recent .brief file
        let briefData = null;
        try {
            const files = await fs.readdir(sessionsDir);
            const briefFiles = files
                .filter((f) => f.endsWith('.brief'))
                .sort()
                .reverse();
            if (briefFiles.length > 0) {
                const briefPath = path.join(sessionsDir, briefFiles[0]);
                briefData = await readJsonOrNull(briefPath);
            }
        }
        catch {
            // Sessions directory might not exist
            briefData = null;
        }
        // If we have a brief and scope provided, check if it matches
        if (briefData && scope) {
            const briefScope = briefData.scope || '';
            if (!briefScope.toLowerCase().includes(scope.toLowerCase())) {
                briefData = null;
            }
        }
        // Determine base response
        let baseResponse;
        if (briefData) {
            baseResponse = briefData;
        }
        else {
            // Otherwise return intent + rules
            const intentPath = path.join(mathaDir, 'hippocampus/intent.json');
            const intent = await readJsonOrNull(intentPath);
            const rules = await getRules(mathaDir).catch(() => []);
            const parsedRules = typeof rules === 'string' ? JSON.parse(rules).rules : [];
            baseResponse = {
                why: intent?.why ?? '',
                rules: parsedRules,
            };
        }
        // Augment with matchAll
        const matchContext = {
            scope: baseResponse.scope || '',
            intent: baseResponse.operation_description || baseResponse.why || '',
            operationType: baseResponse.operationType || 'unknown',
            filepaths: (baseResponse.scope || '').split(',').map((s) => s.trim()).filter(Boolean),
        };
        let matchResults = [];
        try {
            matchResults = await matchAll(matchContext, mathaDir);
        }
        catch {
            matchResults = [];
        }
        const hasCritical = matchResults.some((r) => r.severity === 'critical');
        return JSON.stringify({
            ...baseResponse,
            matchResults,
            hasCritical,
        });
    }
    catch (err) {
        return JSON.stringify({ error: `Failed to get brief: ${err.message}` });
    }
}
// ──────────────────────────────────────────────────────────────────────
// WRITE TOOLS
// ──────────────────────────────────────────────────────────────────────
/**
 * matha_record_decision: Records a decision from an AI agent.
 * Uses 'probable' confidence (not 'confirmed' — that is human-verified).
 */
export async function mathaRecordDecision(mathaDir, component, previousAssumption, correction, confidence = 'probable') {
    try {
        const id = `${Date.now()}-${generateId()}`;
        const timestamp = new Date().toISOString();
        const decision = {
            id,
            timestamp,
            component,
            previous_assumption: previousAssumption,
            correction,
            trigger: 'mcp-call',
            confidence,
            status: 'active',
            supersedes: null,
            session_id: id,
        };
        await recordDecision(mathaDir, decision);
        return JSON.stringify({ success: true, id });
    }
    catch (err) {
        return JSON.stringify({
            success: false,
            error: `Failed to record decision: ${err.message}`,
        });
    }
}
/**
 * matha_record_danger: Records a danger zone discovered by an agent.
 */
export async function mathaRecordDanger(mathaDir, component, description) {
    try {
        const id = `danger-${Date.now()}-${generateId()}`;
        const zone = {
            id,
            component,
            pattern: description,
            description: description,
        };
        await recordDangerZone(mathaDir, zone);
        return JSON.stringify({ success: true, id });
    }
    catch (err) {
        return JSON.stringify({
            success: false,
            error: `Failed to record danger zone: ${err.message}`,
        });
    }
}
/**
 * matha_record_contract: Records a behaviour contract for a component.
 * Overwrites existing contract for same component (versioned).
 */
export async function mathaRecordContract(mathaDir, component, assertions) {
    try {
        // Sanitize component name for filename
        const filename = component
            .replace(/[^a-zA-Z0-9._-]/g, '-')
            .toLowerCase();
        const contractPath = path.join(mathaDir, `cerebellum/contracts/${filename}.json`);
        const contract = {
            component,
            version: 1,
            last_updated: new Date().toISOString(),
            assertions: assertions.map((description, idx) => ({
                id: `${component}-assertion-${idx}`,
                description,
                type: 'invariant',
                status: 'active',
                violation_count: 0,
                last_violated: null,
            })),
        };
        await writeAtomic(contractPath, contract, { overwrite: true });
        return JSON.stringify({ success: true, component });
    }
    catch (err) {
        return JSON.stringify({
            success: false,
            error: `Failed to record contract: ${err.message}`,
        });
    }
}
/**
 * matha_match: Runs the contract matcher independently to get danger/history warnings.
 */
export async function mathaMatch(mathaDir, scope, intent, operationType = 'unknown', filepaths = []) {
    try {
        const context = {
            scope,
            intent,
            operationType,
            filepaths: filepaths.length > 0 ? filepaths : scope.split(',').map((s) => s.trim()).filter(Boolean),
        };
        const results = await matchAll(context, mathaDir);
        const hasCritical = results.some((r) => r.severity === 'critical');
        const summary = {
            critical: results.filter((r) => r.severity === 'critical').length,
            warning: results.filter((r) => r.severity === 'warning').length,
            info: results.filter((r) => r.severity === 'info').length,
            total: results.length,
        };
        return JSON.stringify({
            results,
            hasCritical,
            summary,
        });
    }
    catch (err) {
        return JSON.stringify({ error: `Failed to run contract matcher: ${err.message}`, results: [], hasCritical: false });
    }
}
// ──────────────────────────────────────────────────────────────────────
// CORTEX TOOLS
// ──────────────────────────────────────────────────────────────────────
/**
 * matha_refresh_cortex: Triggers a git analysis refresh of the cortex.
 * repoPath assumption: process.cwd() is the project root.
 * Never throws to MCP caller.
 */
export async function mathaRefreshCortex(mathaDir) {
    try {
        // Use mathaDir to derive repoPath (go up from .matha)
        const repoPath = path.dirname(mathaDir);
        const snapshot = await refreshFromGit(repoPath, mathaDir);
        return JSON.stringify({
            success: true,
            commitCount: snapshot.commitCount,
            fileCount: snapshot.fileCount,
            summary: snapshot.summary,
        });
    }
    catch (err) {
        return JSON.stringify({
            success: false,
            error: `Failed to refresh cortex: ${err.message}`,
            commitCount: 0,
            fileCount: 0,
            summary: null,
        });
    }
}
