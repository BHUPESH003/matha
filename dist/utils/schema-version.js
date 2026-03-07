import * as fs from 'fs/promises';
import * as path from 'path';
/**
 * Single source of truth for the current schema version.
 * Bump this when the .matha/ directory structure changes.
 */
export const CURRENT_SCHEMA_VERSION = '0.1.0';
/**
 * Compare two semver strings (major.minor.patch).
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
function compareSemver(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const av = pa[i] ?? 0;
        const bv = pb[i] ?? 0;
        if (av < bv)
            return -1;
        if (av > bv)
            return 1;
    }
    return 0;
}
/**
 * Check the schema version in .matha/config.json.
 *
 * **Never throws** — always returns a result, even on malformed or
 * missing config files.
 */
export async function checkSchemaVersion(mathaDir) {
    try {
        const configPath = path.join(mathaDir, 'config.json');
        let raw;
        try {
            raw = await fs.readFile(configPath, 'utf-8');
        }
        catch {
            // File does not exist → uninitialised
            return { status: 'uninitialised', version: null };
        }
        let config;
        try {
            config = JSON.parse(raw);
        }
        catch {
            // Malformed JSON → treat as uninitialised (safe fallback)
            return { status: 'uninitialised', version: null };
        }
        if (config === null || typeof config !== 'object') {
            return { status: 'uninitialised', version: null };
        }
        const schemaVersion = config.schema_version;
        if (schemaVersion === undefined || schemaVersion === null) {
            return { status: 'legacy', version: null };
        }
        const version = String(schemaVersion);
        const cmp = compareSemver(version, CURRENT_SCHEMA_VERSION);
        if (cmp === 0)
            return { status: 'ok', version };
        if (cmp < 0)
            return { status: 'outdated', version };
        return { status: 'newer', version };
    }
    catch {
        // Catch-all: never throw, always return a result
        return { status: 'uninitialised', version: null };
    }
}
/**
 * Return a human-readable message for the given schema check result.
 * Returns `null` when no message is needed (ok, uninitialised).
 */
export function getSchemaMessage(result) {
    switch (result.status) {
        case 'ok':
        case 'uninitialised':
            return null;
        case 'legacy':
            return ('⚠ This .matha/ was created before schema versioning. ' +
                'Run `matha migrate` to upgrade. (Coming in v0.2.0)');
        case 'outdated':
            return (`⚠ This .matha/ uses schema v${result.version}. ` +
                `Current is v${CURRENT_SCHEMA_VERSION}. ` +
                'Run `matha migrate` to upgrade. (Coming in v0.2.0)');
        case 'newer':
            return (`✗ This .matha/ uses schema v${result.version} which is newer ` +
                `than this version of MATHA (v${CURRENT_SCHEMA_VERSION}). ` +
                'Upgrade MATHA: npm install -g matha');
    }
}
