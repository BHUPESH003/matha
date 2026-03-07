import * as fs from 'fs/promises';
import * as path from 'path';
import { readJsonOrNull } from '@/storage/reader.js';
import { writeAtomic, appendToArray } from '@/storage/writer.js';
import {
  getRules,
  getDangerZones,
  getDecisions,
  recordDecision,
  recordDangerZone,
} from '@/brain/hippocampus.js';

// Simple UUID-like ID generator
function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

// ──────────────────────────────────────────────────────────────────────
// READ TOOLS
// ──────────────────────────────────────────────────────────────────────

/**
 * matha_get_rules: Returns all business rules.
 */
export async function mathaGetRules(mathaDir: string): Promise<string> {
  try {
    const rules = await getRules(mathaDir);
    return JSON.stringify({ rules });
  } catch (err: any) {
    return JSON.stringify({ error: `Failed to get rules: ${err.message}` });
  }
}

/**
 * matha_get_danger_zones: Returns danger zones, optionally filtered by context.
 */
export async function mathaGetDangerZones(
  mathaDir: string,
  context?: string,
): Promise<string> {
  try {
    const zones = await getDangerZones(mathaDir, context);
    return JSON.stringify({ zones });
  } catch (err: any) {
    return JSON.stringify({ error: `Failed to get danger zones: ${err.message}` });
  }
}

/**
 * matha_get_decisions: Returns decisions, optionally filtered by component and limit.
 */
export async function mathaGetDecisions(
  mathaDir: string,
  component?: string,
  limit?: number,
): Promise<string> {
  try {
    const decisions = await getDecisions(mathaDir, component, limit);
    return JSON.stringify({ decisions });
  } catch (err: any) {
    return JSON.stringify({ error: `Failed to get decisions: ${err.message}` });
  }
}

/**
 * matha_get_stability: Returns stability classification for requested files.
 */
export async function mathaGetStability(
  mathaDir: string,
  files: string[],
): Promise<string> {
  try {
    const stabilityPath = path.join(mathaDir, 'cortex/stability.json');
    const stabilityData = await readJsonOrNull<any[]>(stabilityPath);

    const stability: Record<string, string> = {};

    // Default all files to 'unknown'
    for (const file of files) {
      stability[file] = 'unknown';
    }

    // If stability data exists, find matches
    if (stabilityData && Array.isArray(stabilityData)) {
      for (const file of files) {
        const match = stabilityData.find((item) => item.path === file);
        if (match) {
          stability[file] = match.stability || 'unknown';
        }
      }
    }

    return JSON.stringify({ stability });
  } catch (err: any) {
    // On any error, return unknown for all
    const stability: Record<string, string> = {};
    for (const file of files) {
      stability[file] = 'unknown';
    }
    return JSON.stringify({ stability });
  }
}

/**
 * matha_brief: Returns the most recent session brief, or intent + rules.
 */
export async function mathaBrief(mathaDir: string, scope?: string): Promise<string> {
  try {
    const sessionsDir = path.join(mathaDir, 'sessions');

    // Try to find the most recent .brief file
    let briefData: any = null;
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
    } catch {
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

    // If we have valid brief data, return it
    if (briefData) {
      return JSON.stringify(briefData);
    }

    // Otherwise return intent + rules
    const intentPath = path.join(mathaDir, 'hippocampus/intent.json');
    const intent = await readJsonOrNull<{ why?: string }>(intentPath);

    const rules = await getRules(mathaDir).catch(() => []);
    const parsedRules = typeof rules === 'string' ? JSON.parse(rules).rules : [];

    return JSON.stringify({
      why: intent?.why ?? '',
      rules: parsedRules,
    });
  } catch (err: any) {
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
export async function mathaRecordDecision(
  mathaDir: string,
  component: string,
  previousAssumption: string,
  correction: string,
  confidence: 'confirmed' | 'probable' | 'uncertain' = 'probable',
): Promise<string> {
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
      status: 'active' as const,
      supersedes: null,
      session_id: id,
    };

    await recordDecision(mathaDir, decision);

    return JSON.stringify({ success: true, id });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      error: `Failed to record decision: ${err.message}`,
    });
  }
}

/**
 * matha_record_danger: Records a danger zone discovered by an agent.
 */
export async function mathaRecordDanger(
  mathaDir: string,
  component: string,
  description: string,
): Promise<string> {
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
  } catch (err: any) {
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
export async function mathaRecordContract(
  mathaDir: string,
  component: string,
  assertions: string[],
): Promise<string> {
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
        type: 'invariant' as const,
        status: 'active' as const,
        violation_count: 0,
        last_violated: null,
      })),
    };

    await writeAtomic(contractPath, contract, { overwrite: true });

    return JSON.stringify({ success: true, component });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      error: `Failed to record contract: ${err.message}`,
    });
  }
}
