import * as path from 'path';
import * as fs from 'fs/promises';
import { getDangerZones, getDecisions } from '../brain/hippocampus.js';
import { getSnapshot } from '../brain/cortex.js';
const STOP_WORDS = new Set([
    'should', 'never', 'always', 'before', 'after', 'every', 'which',
    'their', 'there', 'where', 'when', 'would', 'could', 'might',
    'using', 'being', 'having'
]);
export function extractKeywords(text) {
    const words = text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/);
    return words.filter(word => word.length > 4 && !STOP_WORDS.has(word));
}
export function matchDangerZones(context, dangerZones) {
    const results = [];
    const scopeLower = context.scope.toLowerCase();
    const intentLower = context.intent.toLowerCase();
    for (const zone of dangerZones) {
        const compLower = (zone.component || '').toLowerCase();
        // Check scope match
        let matched = scopeLower.includes(compLower);
        // Check intent match
        if (!matched) {
            matched = intentLower.includes(compLower);
        }
        // Check keyword match
        if (!matched && zone.description) {
            const zoneKeywords = extractKeywords(zone.description);
            matched = zoneKeywords.some(kw => intentLower.includes(kw));
        }
        if (matched) {
            results.push({
                matchType: 'danger_zone',
                severity: 'critical',
                title: `Danger Zone: ${zone.component}`,
                description: zone.description || '',
                source: 'danger-zones.json',
                component: zone.component,
                recommendation: 'Review danger zone before proceeding. Consider matha_record_decision after session.',
            });
        }
    }
    return results;
}
export function matchContracts(context, contracts) {
    const results = [];
    const scopeLower = context.scope.toLowerCase();
    for (const [key, contract] of Object.entries(contracts)) {
        const compLower = (contract.component || '').toLowerCase();
        if (scopeLower.includes(compLower)) {
            const violations = (contract.assertions || []).filter((a) => a.violation_count > 0);
            const hasViolations = violations.length > 0;
            results.push({
                matchType: 'contract',
                severity: hasViolations ? 'critical' : 'info',
                title: `Contract: ${contract.component}`,
                description: hasViolations
                    ? `Previously violated ${violations.length} times.`
                    : 'Contract is currently clean.',
                source: 'contracts',
                component: contract.component,
                recommendation: `Verify all ${(contract.assertions || []).length} contract assertions pass after changes.`,
            });
        }
    }
    return results;
}
export function matchFrozenFiles(context, stabilityRecords) {
    const results = [];
    // Create a map of frozen files for quick lookup
    const frozenFiles = stabilityRecords.filter(r => r.stability === 'frozen');
    if (context.filepaths && context.filepaths.length > 0) {
        for (const filepath of context.filepaths) {
            // Find matching frozen record by exact path
            const record = frozenFiles.find(r => r.filepath === filepath);
            if (record) {
                results.push({
                    matchType: 'frozen_file',
                    severity: 'critical',
                    title: `Frozen File: ${filepath}`,
                    description: record.reason || 'No reason provided',
                    source: 'cortex/stability.json',
                    component: filepath,
                    recommendation: 'This file is classified FROZEN. Confirm owner approval before modifying.',
                });
            }
        }
    }
    else {
        // Fall back to scope substring match
        const scopeLower = context.scope.toLowerCase();
        const scopeParts = scopeLower.split(',').map(s => s.trim()).filter(Boolean);
        for (const record of frozenFiles) {
            const recordFpLower = record.filepath.toLowerCase();
            // Match if the scope part is a substring of the filepath, OR if filepath is a substring of the scope part
            const isMatched = scopeParts.some(part => recordFpLower.includes(part) || part.includes(recordFpLower));
            if (isMatched) {
                results.push({
                    matchType: 'frozen_file',
                    severity: 'critical',
                    title: `Frozen File: ${record.filepath}`,
                    description: record.reason || 'No reason provided',
                    source: 'cortex/stability.json',
                    component: record.filepath,
                    recommendation: 'This file is classified FROZEN. Confirm owner approval before modifying.',
                });
            }
        }
    }
    return results;
}
export function matchDecisionPatterns(context, decisions) {
    const results = [];
    const scopeLower = context.scope.toLowerCase();
    // Sort decisions by timestamp descending
    const sortedDecisions = [...decisions].sort((a, b) => {
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
    // Filter only active decisions
    const activeDecisions = sortedDecisions.filter(d => d.status === 'active');
    let matchCount = 0;
    for (const decision of activeDecisions) {
        if (matchCount >= 3)
            break;
        const compLower = (decision.component || '').toLowerCase();
        if (scopeLower.includes(compLower)) {
            results.push({
                matchType: 'decision_pattern',
                severity: 'warning',
                title: `Prior Decision: ${decision.component}`,
                description: `Previous assumption: ${decision.previous_assumption}. Correction: ${decision.correction}.`,
                source: 'hippocampus/decisions',
                component: decision.component,
                recommendation: 'Be aware of this prior correction when working in this area.',
            });
            matchCount++;
        }
    }
    return results;
}
// Helper to determine sort order
const SEVERITY_ORDER = {
    critical: 0,
    warning: 1,
    info: 2,
};
export async function matchAll(context, mathaDir) {
    try {
        const allResults = [];
        // 1. Fetch Danger Zones
        try {
            const dangerZones = await getDangerZones(mathaDir).catch(() => []);
            allResults.push(...matchDangerZones(context, dangerZones));
        }
        catch {
            // Ignore errors for danger zones
        }
        // 2. Fetch Contracts
        try {
            const contractsDir = path.join(mathaDir, 'cerebellum', 'contracts');
            const contractsFiles = await fs.readdir(contractsDir).catch(() => []);
            const contracts = {};
            for (const file of contractsFiles) {
                if (file.endsWith('.json')) {
                    try {
                        const content = await fs.readFile(path.join(contractsDir, file), 'utf-8');
                        const parsed = JSON.parse(content);
                        if (parsed.component) {
                            contracts[parsed.component] = parsed;
                        }
                    }
                    catch {
                        // ignore bad files
                    }
                }
            }
            allResults.push(...matchContracts(context, contracts));
        }
        catch {
            // Ignore errors for contracts
        }
        // 3. Fetch Frozen Files
        try {
            const snapshot = await getSnapshot(mathaDir).catch(() => null);
            if (snapshot && snapshot.stability) {
                allResults.push(...matchFrozenFiles(context, snapshot.stability));
            }
        }
        catch {
            // Ignore errors for frozen files
        }
        // 4. Fetch Decisions
        try {
            const decisions = await getDecisions(mathaDir).catch(() => []);
            allResults.push(...matchDecisionPatterns(context, decisions));
        }
        catch {
            // Ignore errors for decisions
        }
        // Deduplicate by matchType + component
        const seen = new Set();
        const deduplicated = [];
        for (const result of allResults) {
            const key = `${result.matchType}:${result.component.toLowerCase()}`;
            if (!seen.has(key)) {
                seen.add(key);
                deduplicated.push(result);
            }
        }
        // Sort by severity (critical -> warning -> info)
        deduplicated.sort((a, b) => {
            return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        });
        return deduplicated;
    }
    catch {
        // Never throw - return empty array on catastrophic failure
        return [];
    }
}
