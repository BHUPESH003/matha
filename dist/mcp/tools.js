import * as path from 'path';
import * as crypto from 'crypto';
import { validateContractInput, validateDangerInput, validateDecisionInput, } from '../core/schema.js';
import { recordContract, recordDangerZone, recordDecision } from '../store/records.js';
import { refreshFromGit } from '../codemap/index.js';
import { assembleBrief } from '../retrieve/brief.js';
/**
 * MCP tool implementations. Thin: every read goes through the Engine
 * (cached), every write through store/records with schema validation.
 * All results are JSON strings; every success carries `diagnostics` so a
 * wrong-brain failure is visible instead of silently empty.
 */
function generateId() {
    return crypto.randomBytes(8).toString('hex');
}
function withDiagnostics(engine, payload) {
    return JSON.stringify({ ...payload, diagnostics: { brainDir: engine.mathaDir } });
}
// ── READ TOOLS ───────────────────────────────────────────────────────
export async function mathaGetRules(engine) {
    const rules = await engine.getRules();
    return withDiagnostics(engine, { rules });
}
export async function mathaGetDangerZones(engine, context) {
    const zones = await engine.getDangerZones(context);
    return withDiagnostics(engine, { zones });
}
export async function mathaGetDecisions(engine, component, limit) {
    const decisions = await engine.getDecisions(component, limit ?? 20);
    return withDiagnostics(engine, { decisions });
}
export async function mathaGetStability(engine, files) {
    const stability = await engine.stabilityFor(files);
    return withDiagnostics(engine, { stability });
}
export async function mathaBrief(engine, scope, intent, filepaths) {
    const brief = await assembleBrief(engine, { scope, intent, filepaths });
    return JSON.stringify(brief);
}
export async function mathaMatch(engine, scope, intent, filepaths = []) {
    const context = { scope, intent, filepaths };
    const { results, diagnostics } = await engine.match(context);
    const hasCritical = results.some((r) => r.severity === 'critical');
    return JSON.stringify({
        results,
        hasCritical,
        summary: {
            critical: results.filter((r) => r.severity === 'critical').length,
            warning: results.filter((r) => r.severity === 'warning').length,
            info: results.filter((r) => r.severity === 'info').length,
            total: results.length,
        },
        diagnostics,
    });
}
// ── WRITE TOOLS ──────────────────────────────────────────────────────
export async function mathaRecordDecision(engine, component, previousAssumption, correction, confidence = 'probable') {
    const valid = validateDecisionInput({
        component,
        previous_assumption: previousAssumption,
        correction,
    });
    if (!valid.ok) {
        return JSON.stringify({ success: false, error: `Rejected: ${valid.reason}` });
    }
    const id = `${Date.now()}-${generateId()}`;
    await recordDecision(engine.mathaDir, {
        id,
        timestamp: new Date().toISOString(),
        component,
        previous_assumption: previousAssumption,
        correction,
        trigger: 'mcp-call',
        confidence,
        status: 'active',
        supersedes: null,
        session_id: id,
    });
    return withDiagnostics(engine, { success: true, id });
}
export async function mathaRecordDanger(engine, component, description) {
    const valid = validateDangerInput({ component, description });
    if (!valid.ok) {
        return JSON.stringify({ success: false, error: `Rejected: ${valid.reason}` });
    }
    const id = `danger-${Date.now()}-${generateId()}`;
    await recordDangerZone(engine.mathaDir, {
        id,
        component,
        pattern: description,
        description,
    });
    return withDiagnostics(engine, { success: true, id });
}
export async function mathaRecordContract(engine, component, assertions) {
    const valid = validateContractInput({ component, assertions });
    if (!valid.ok) {
        return JSON.stringify({ success: false, error: `Rejected: ${valid.reason}` });
    }
    await recordContract(engine.mathaDir, component, assertions);
    return withDiagnostics(engine, { success: true, component });
}
// ── CODEMAP ──────────────────────────────────────────────────────────
export async function mathaRefresh(engine) {
    const repoPath = path.dirname(engine.mathaDir);
    const snapshot = await refreshFromGit(repoPath, engine.mathaDir);
    return withDiagnostics(engine, {
        success: true,
        commitCount: snapshot.commitCount,
        fileCount: snapshot.fileCount,
        summary: snapshot.summary,
    });
}
