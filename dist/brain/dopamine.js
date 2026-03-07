import * as path from 'path';
import { readJsonOrNull } from '../storage/reader.js';
import { writeAtomic } from '../storage/writer.js';
const DEFAULT_TIERS = {
    'rename/crud': { tier: 'lightweight', budget: 2000 },
    'business_logic': { tier: 'capable', budget: 8000 },
    'architecture': { tier: 'capable', budget: 16000 },
    'frozen_component': { tier: 'capable', budget: 16000 },
    'unknown': { tier: 'mid', budget: 4000 }
};
export async function analyseDeltas(mathaDir) {
    const emptyAnalysis = {
        analysedAt: new Date().toISOString(),
        sessionCount: 0,
        routingRules: [],
        componentConfidence: [],
        globalAvgTokenDelta: 0,
        overBudgetRate: 0
    };
    try {
        const deltasPath = path.join(mathaDir, 'dopamine/deltas.json');
        const deltas = await readJsonOrNull(deltasPath);
        if (!deltas || !Array.isArray(deltas) || deltas.length === 0) {
            return emptyAnalysis;
        }
        const validDeltas = deltas.filter(d => d.token_delta !== null);
        let globalAvgTokenDelta = 0;
        let overBudgetRate = 0;
        if (validDeltas.length > 0) {
            const sum = validDeltas.reduce((acc, d) => acc + d.token_delta, 0);
            globalAvgTokenDelta = sum / validDeltas.length;
            const overBudgetCount = validDeltas.filter(d => d.token_delta > 0).length;
            overBudgetRate = overBudgetCount / validDeltas.length;
        }
        return {
            analysedAt: new Date().toISOString(),
            sessionCount: deltas.length,
            routingRules: buildRoutingRules(deltas),
            componentConfidence: buildConfidence(deltas),
            globalAvgTokenDelta,
            overBudgetRate
        };
    }
    catch {
        return emptyAnalysis;
    }
}
export function buildRoutingRules(deltas) {
    const groups = {};
    for (const d of deltas) {
        if (!groups[d.operation_type]) {
            groups[d.operation_type] = [];
        }
        groups[d.operation_type].push(d);
    }
    const rules = [];
    for (const [opType, records] of Object.entries(groups)) {
        if (records.length < 3)
            continue;
        const validRecords = records.filter(r => r.token_delta !== null);
        if (validRecords.length === 0)
            continue;
        const sum = validRecords.reduce((acc, r) => acc + r.token_delta, 0);
        const avgTokenDelta = sum / validRecords.length;
        const defaultDef = DEFAULT_TIERS[opType] || DEFAULT_TIERS['unknown'];
        let recommendedTier = defaultDef.tier;
        if (avgTokenDelta > 5000) {
            if (recommendedTier === 'lightweight')
                recommendedTier = 'mid';
            else if (recommendedTier === 'mid')
                recommendedTier = 'capable';
        }
        else if (avgTokenDelta < -2000) {
            if (recommendedTier === 'capable')
                recommendedTier = 'mid';
            else if (recommendedTier === 'mid')
                recommendedTier = 'lightweight';
        }
        let recommendedBudget = defaultDef.budget + avgTokenDelta;
        if (recommendedBudget < 500) {
            recommendedBudget = 500;
        }
        let confidence = 'low';
        if (records.length >= 10)
            confidence = 'high';
        else if (records.length >= 5)
            confidence = 'medium';
        rules.push({
            operation_type: opType,
            component_pattern: '', // global rule
            recommended_tier: recommendedTier,
            recommended_budget: recommendedBudget,
            confidence,
            sample_size: records.length,
            avg_token_delta: avgTokenDelta,
            last_updated: new Date().toISOString()
        });
    }
    return rules;
}
export function buildConfidence(deltas) {
    const groups = {};
    for (const d of deltas) {
        if (!groups[d.model_tier_used]) {
            groups[d.model_tier_used] = [];
        }
        groups[d.model_tier_used].push(d);
    }
    const confidences = [];
    for (const [tier, records] of Object.entries(groups)) {
        const defaultVal = 0.0;
        let adjustment = 0.0;
        let violationCount = 0;
        const validTokens = records.filter(r => r.token_delta !== null);
        let avgTokenDelta = 0;
        if (validTokens.length > 0) {
            avgTokenDelta = validTokens.reduce((s, r) => s + r.token_delta, 0) / validTokens.length;
        }
        for (const r of records) {
            if (r.contract_result === 'violated' || r.contract_result === 'partial') {
                violationCount++;
            }
            if (r.contract_result === 'passed')
                adjustment += 0.1;
            else if (r.contract_result === 'violated')
                adjustment -= 0.2;
            else if (r.contract_result === 'partial')
                adjustment -= 0.1;
            if (r.token_delta !== null) {
                if (r.token_delta > 5000)
                    adjustment -= 0.1;
                else if (r.token_delta < 0)
                    adjustment += 0.05;
            }
        }
        adjustment = Math.max(-1.0, Math.min(1.0, adjustment));
        confidences.push({
            component: tier,
            confidence_adjustment: adjustment,
            violation_rate: violationCount / records.length,
            avg_token_delta: avgTokenDelta,
            session_count: records.length,
            last_updated: new Date().toISOString()
        });
    }
    return confidences;
}
export async function getRecommendation(mathaDir, operationType) {
    try {
        const rulesPath = path.join(mathaDir, 'dopamine/routing-rules.json');
        const analysis = await readJsonOrNull(rulesPath);
        if (analysis && Array.isArray(analysis.routingRules)) {
            const rule = analysis.routingRules.find(r => r.operation_type === operationType);
            if (rule) {
                return {
                    tier: rule.recommended_tier,
                    budget: rule.recommended_budget,
                    source: 'learned',
                    confidence: rule.confidence,
                    sample_size: rule.sample_size
                };
            }
        }
    }
    catch {
        // silently fallback
    }
    const def = DEFAULT_TIERS[operationType] || DEFAULT_TIERS['unknown'];
    return {
        tier: def.tier,
        budget: def.budget,
        source: 'default',
        confidence: null
    };
}
export async function persistAnalysis(mathaDir, analysis) {
    try {
        const rulesPath = path.join(mathaDir, 'dopamine/routing-rules.json');
        await writeAtomic(rulesPath, analysis, { overwrite: true });
    }
    catch {
        // silently fail
    }
}
