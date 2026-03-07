/**
 * Runs an individual frontal-lobe gate.
 * Never throws on malformed input; returns completed: false instead.
 */
export function runGate(gateId, context, input) {
    try {
        switch (gateId) {
            case 1:
                return {
                    gateId,
                    completed: isNonEmptyString(input),
                    output: input,
                };
            case 2:
                return {
                    gateId,
                    completed: isNonEmptyStringArray(input),
                    output: input,
                };
            case 3: {
                const orient = isNonEmptyObject(input) || isNonEmptyObject(context.stabilityData);
                return {
                    gateId,
                    completed: orient,
                    output: isNonEmptyObject(input) ? input : context.stabilityData ?? {},
                };
            }
            case 4:
                return {
                    gateId,
                    completed: isPresent(input),
                    output: input,
                };
            case 5:
                return {
                    gateId,
                    completed: isNonEmptyStringArray(input),
                    output: input,
                };
            case 6:
                return {
                    gateId,
                    completed: isPresent(input),
                    output: input,
                };
            case 7: {
                const states = Array.isArray(input) ? input : [];
                const missing = findMissingRequiredBuildGates(states);
                const readyToBuild = missing.length === 0;
                return {
                    gateId,
                    completed: readyToBuild,
                    output: { readyToBuild, missing },
                };
            }
            case 8:
                return {
                    gateId,
                    completed: isPresent(input),
                    output: input,
                };
            default:
                return {
                    gateId,
                    completed: false,
                    output: input,
                };
        }
    }
    catch {
        return {
            gateId,
            completed: false,
            output: input,
        };
    }
}
/**
 * Validates that gates 01-06 are completed.
 */
export function validateSequence(states) {
    const missing = [];
    for (let gateId = 1; gateId <= 6; gateId++) {
        const state = states.find((s) => s.gateId === gateId);
        if (!state || !state.completed) {
            missing.push(gateId);
        }
    }
    return {
        valid: missing.length === 0,
        missing,
    };
}
/**
 * Builds the session brief from gate outputs and hippocampus danger zone lookup.
 */
export async function generateBrief(context, states, hippocampus) {
    const stateMap = new Map();
    for (const s of states)
        stateMap.set(s.gateId, s);
    const why = asString(stateMap.get(1)?.output);
    const bounds = asStringArray(stateMap.get(2)?.output);
    const contract = asStringArray(stateMap.get(5)?.output);
    const dangerZones = await hippocampus.getDangerZones(context.scope);
    const routing = routeOperation(context.operationType);
    const gate7 = stateMap.get(7);
    const readyFromGate7 = typeof gate7?.output === 'object' &&
        gate7?.output !== null &&
        'readyToBuild' in gate7.output
        ? Boolean(gate7.output.readyToBuild)
        : undefined;
    const readyToBuild = readyFromGate7 ?? findMissingRequiredBuildGates(states).length === 0;
    return {
        sessionId: context.sessionId,
        scope: context.scope,
        operationType: context.operationType,
        why,
        bounds,
        dangerZones,
        contract,
        modelTier: routing.modelTier,
        tokenBudget: routing.tokenBudget,
        gatesCompleted: states.filter((s) => s.completed).map((s) => s.gateId),
        readyToBuild,
    };
}
/**
 * Gate 08 write-back.
 * Writes discovery to hippocampus if correction and/or danger pattern are present.
 */
export async function runWriteBack(context, discovery, hippocampus) {
    const correction = discovery.correction?.trim() ?? '';
    const dangerPattern = discovery.dangerPattern?.trim() ?? '';
    if (!correction && !dangerPattern)
        return;
    if (correction) {
        const timestamp = new Date().toISOString();
        const decision = {
            id: `${context.sessionId}-${Date.now()}-decision`,
            timestamp,
            component: context.scope,
            previous_assumption: discovery.previousAssumption?.trim() || 'No previous assumption recorded',
            correction,
            trigger: discovery.trigger?.trim() || 'Session write-back',
            confidence: discovery.confidence ?? 'probable',
            status: 'active',
            supersedes: null,
            session_id: context.sessionId,
        };
        await hippocampus.recordDecision(hippocampus.mathaDir, decision);
    }
    if (dangerPattern) {
        const zone = {
            id: `${context.sessionId}-${Date.now()}-danger`,
            component: context.scope,
            pattern: dangerPattern,
            description: discovery.dangerDescription?.trim() ||
                'Discovered during session write-back',
        };
        await hippocampus.recordDangerZone(hippocampus.mathaDir, zone);
    }
}
function findMissingRequiredBuildGates(states) {
    const required = [1, 2, 3, 4, 5];
    const missing = [];
    for (const gateId of required) {
        const state = states.find((s) => s.gateId === gateId);
        if (!state || !state.completed)
            missing.push(gateId);
    }
    return missing;
}
function routeOperation(operationType) {
    switch (operationType) {
        case 'rename':
        case 'crud':
            return { modelTier: 'lightweight', tokenBudget: 2000 };
        case 'business_logic':
            return { modelTier: 'capable', tokenBudget: 8000 };
        case 'architecture':
        case 'frozen_component':
            return { modelTier: 'capable', tokenBudget: 16000 };
        default:
            return { modelTier: 'mid', tokenBudget: 4000 };
    }
}
function isPresent(value) {
    if (value === null || value === undefined)
        return false;
    if (typeof value === 'string')
        return value.trim().length > 0;
    if (Array.isArray(value))
        return value.length > 0;
    if (typeof value === 'object')
        return Object.keys(value).length > 0;
    return true;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function isNonEmptyStringArray(value) {
    return (Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === 'string' && item.trim().length > 0));
}
function isNonEmptyObject(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length > 0);
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function asStringArray(value) {
    return Array.isArray(value)
        ? value.filter((v) => typeof v === 'string')
        : [];
}
