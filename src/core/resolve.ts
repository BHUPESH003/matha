import * as fs from 'fs/promises'
import * as path from 'path'

/**
 * Brain-directory resolution — the single place that decides which .matha/
 * a command or server call operates on.
 *
 * Resolution order:
 *   1. explicitRoot (from --project or MCP client roots) — must contain
 *      .matha/, otherwise this is an error, NOT a fallback.
 *   2. Walk up from the first existing filepath in `filepaths`.
 *   3. Walk up from cwd.
 *
 * NEVER silently creates a brain. An unresolved brain is an error carrying
 * every path that was tried, so the failure is diagnosable instead of the
 * 0.1.x behaviour (serve an empty brain from the wrong directory).
 */

export interface ResolveResult {
  mathaDir: string
  projectRoot: string
  source: 'explicit' | 'filepaths' | 'cwd'
}

export class BrainNotFoundError extends Error {
  constructor(public readonly tried: string[]) {
    super(
      `No .matha directory found. Tried: ${tried.join(', ')}. ` +
        `Run 'matha init' in your project root, or pass --project <path>.`,
    )
    this.name = 'BrainNotFoundError'
  }
}

const MAX_WALK_UP = 15

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/** Walk up from startDir looking for a .matha directory. Records tried paths. */
async function walkUp(startDir: string, tried: string[]): Promise<string | null> {
  let dir = path.resolve(startDir)
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const candidate = path.join(dir, '.matha')
    tried.push(candidate)
    if (await dirExists(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export async function resolveBrainDir(opts: {
  explicitRoot?: string
  filepaths?: string[]
  cwd?: string
}): Promise<ResolveResult> {
  const tried: string[] = []

  // 1. Explicit root: authoritative — do not fall through on failure.
  if (opts.explicitRoot) {
    const root = path.resolve(opts.explicitRoot)
    const candidate = path.join(root, '.matha')
    tried.push(candidate)
    if (await dirExists(candidate)) {
      return { mathaDir: candidate, projectRoot: root, source: 'explicit' }
    }
    throw new BrainNotFoundError(tried)
  }

  // 2. Walk up from the first existing filepath the caller is working on.
  for (const fp of opts.filepaths ?? []) {
    if (!fp || !path.isAbsolute(fp)) continue
    let start = fp
    try {
      const stat = await fs.stat(fp)
      if (!stat.isDirectory()) start = path.dirname(fp)
    } catch {
      continue
    }
    const found = await walkUp(start, tried)
    if (found) {
      return { mathaDir: found, projectRoot: path.dirname(found), source: 'filepaths' }
    }
    break // one existing filepath is enough to try; don't rescan for siblings
  }

  // 3. Walk up from cwd.
  const found = await walkUp(opts.cwd ?? process.cwd(), tried)
  if (found) {
    return { mathaDir: found, projectRoot: path.dirname(found), source: 'cwd' }
  }

  throw new BrainNotFoundError(tried)
}
