import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
/**
 * Atomically writes JSON data to a file.
 *
 * Pattern: serialize → validate → write to .tmp → rename to final path.
 * Never writes directly to the target file.
 *
 * @param filePath  Absolute path to the target file.
 * @param data      Data to serialize as JSON. Must be JSON-serializable.
 * @param options.overwrite  If true, replaces an existing file. Default: false.
 */
export async function writeAtomic(filePath, data, options) {
    // ── 1. Validate JSON serialization ────────────────────────────
    let json;
    try {
        json = JSON.stringify(data, null, 2);
    }
    catch (err) {
        throw new Error(`Data is not JSON-serializable: ${err.message}`);
    }
    if (typeof json !== 'string') {
        throw new Error('Data cannot be serialized to JSON');
    }
    // ── 2. Guard against silent overwrite ─────────────────────────
    if (!options?.overwrite) {
        let exists = true;
        try {
            await fs.access(filePath);
        }
        catch {
            exists = false;
        }
        if (exists) {
            throw new Error(`File already exists and overwrite is not enabled: ${filePath}`);
        }
    }
    // ── 3. Ensure parent directories exist ────────────────────────
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // ── 4. Atomic write: temp file → rename ───────────────────────
    const tmpSuffix = `${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const tmpPath = `${filePath}.${tmpSuffix}`;
    try {
        await fs.writeFile(tmpPath, json, 'utf-8');
        await fs.rename(tmpPath, filePath);
    }
    catch (err) {
        // Best-effort cleanup of the temp file
        try {
            await fs.unlink(tmpPath);
        }
        catch {
            /* ignore cleanup errors */
        }
        throw err;
    }
}
/**
 * Appends an item to a JSON array file.
 *
 * - Creates the file with `[item]` if it does not yet exist.
 * - Throws if the existing file does not contain a JSON array.
 * - Uses the atomic-write pattern internally.
 */
export async function appendToArray(filePath, item) {
    let existing = [];
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            throw new Error(`Cannot append to non-array. File contains ${typeof parsed}`);
        }
        existing = parsed;
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
        // File does not exist — start with an empty array
    }
    existing.push(item);
    await writeAtomic(filePath, existing, { overwrite: true });
}
/**
 * Shallow-merges a partial object into a JSON object file.
 *
 * - Creates the file with `partial` if it does not yet exist.
 * - Throws if the existing file is not a plain JSON object (rejects arrays
 *   and primitives).
 * - Uses the atomic-write pattern internally.
 */
export async function mergeObject(filePath, partial) {
    let existing = {};
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed)) {
            throw new Error(`Cannot merge into non-object. File contains ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
        }
        existing = parsed;
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
        // File does not exist — start with an empty object
    }
    const merged = { ...existing, ...partial };
    await writeAtomic(filePath, merged, { overwrite: true });
}
