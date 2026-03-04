import * as fs from 'fs/promises'

/**
 * Reads and parses a JSON file.
 *
 * Throws if the file does not exist or contains invalid JSON.
 * Use {@link readJsonOrNull} when a missing file is an expected case.
 */
export async function readJson<T = unknown>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(content) as T
}

/**
 * Reads and parses a JSON file, returning `null` when the file is absent.
 *
 * - Returns `null` if the file (or any parent directory) does not exist.
 * - **Never throws on missing files.**
 * - Still throws on invalid JSON — that is a data-integrity issue, not a
 *   missing-file issue.
 */
export async function readJsonOrNull<T = unknown>(
  filePath: string,
): Promise<T | null> {
  try {
    return await readJson<T>(filePath)
  } catch (err: any) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}
