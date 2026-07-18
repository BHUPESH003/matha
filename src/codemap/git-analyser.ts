import { simpleGit, type SimpleGit, type DefaultLogFields, type ListLogLine } from 'simple-git'
import * as fs from 'fs/promises'
import * as path from 'path'

// ──────────────────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────────────────

export interface FileChangeRecord {
  filepath: string
  changeCount: number
  lastChanged: string
  firstSeen: string
  authors: string[]
  coChangedWith: string[]
}

export interface CoChangeRecord {
  fileA: string
  fileB: string
  coChangeCount: number
}

export interface GitAnalysisResult {
  analysedAt: string
  commitCount: number
  fileCount: number
  files: FileChangeRecord[]
  coChanges: CoChangeRecord[]
  oldestCommit: string
  newestCommit: string
}

export interface AnalysisOptions {
  maxCommits?: number
  since?: string
  excludePaths?: string[]
  maxCoChangePairs?: number
}

/** Raw, mergeable scan output — plain JSON so it can be persisted and merged. */
export interface RawScan {
  commitCount: number
  /** Hash of the newest commit scanned — the next incremental cursor. */
  newestHash: string
  oldestDate: string
  newestDate: string
  files: Record<
    string,
    { changeCount: number; lastChanged: string; firstSeen: string; authors: string[] }
  >
  /** "a|b" (sorted) → co-change count. */
  coChangeCounts: Record<string, number>
}

export interface ScanOptions {
  /** Scan only commits AFTER this hash (exclusive) — the incremental path. */
  fromExclusive?: string
  maxCommits?: number
  since?: string
  excludePaths?: string[]
}

// ──────────────────────────────────────────────────────────────
// CONSTANTS
// ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_COMMITS = 500
const DEFAULT_MAX_CO_CHANGE_PAIRS = 50
export const DEFAULT_EXCLUDE_PATHS = ['node_modules', '.git', 'dist', '.matha', 'coverage']
const CO_CHANGE_FILES_PER_COMMIT_CAP = 20

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot',
  '.pdf', '.zip', '.tar', '.gz',
])

// ──────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────

function normalisePath(filepath: string): string {
  return filepath.replace(/\\/g, '/')
}

function isBinaryFile(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function isExcluded(filepath: string, excludePaths: string[]): boolean {
  const normalised = normalisePath(filepath)
  for (const exclude of excludePaths) {
    if (normalised.startsWith(exclude + '/') || normalised === exclude) {
      return true
    }
    // Also check path segments
    const segments = normalised.split('/')
    if (segments.includes(exclude)) {
      return true
    }
  }
  return false
}

export function shouldIncludeFile(filepath: string, excludePaths: string[]): boolean {
  if (!filepath || filepath.trim() === '') return false
  if (isBinaryFile(filepath)) return false
  if (isExcluded(filepath, excludePaths)) return false
  return true
}

function makeCoChangeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function toISO(dateStr: string): string {
  try {
    return new Date(dateStr).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

function emptyResult(): GitAnalysisResult {
  return {
    analysedAt: new Date().toISOString(),
    commitCount: 0,
    fileCount: 0,
    files: [],
    coChanges: [],
    oldestCommit: '',
    newestCommit: '',
  }
}

// ──────────────────────────────────────────────────────────────
// MAIN FUNCTION
// ──────────────────────────────────────────────────────────────

/**
 * Scan a commit range into raw, mergeable counts. The incremental engine:
 * with `fromExclusive` set, only commits after that hash are read — a
 * refresh on a 100k-commit repo costs only the commits since last time.
 *
 * Returns null when the repo/range is unreadable (not a git repo, empty
 * repo, or a cursor that no longer exists after a rebase) — callers decide
 * whether that means "empty result" or "fall back to a full rescan".
 */
export async function scanCommits(
  repoPath: string,
  options?: ScanOptions,
): Promise<RawScan | null> {
  try {
    await fs.access(path.join(repoPath, '.git'))
  } catch {
    return null
  }

  const git: SimpleGit = simpleGit(repoPath)
  const excludePaths = options?.excludePaths ?? DEFAULT_EXCLUDE_PATHS

  const logOptions: Record<string, any> = {
    maxCount: options?.maxCommits ?? DEFAULT_MAX_COMMITS,
    '--name-only': null,
  }
  if (options?.since) logOptions['--after'] = options.since
  if (options?.fromExclusive) {
    logOptions.from = options.fromExclusive
    logOptions.to = 'HEAD'
    logOptions.symmetric = false // from..to, not from...to
  }

  let commits: ReadonlyArray<DefaultLogFields & ListLogLine>
  try {
    commits = (await git.log(logOptions)).all
  } catch {
    return null // empty repo, or the cursor no longer exists (rebase/force-push)
  }

  const scan: RawScan = {
    commitCount: commits.length,
    newestHash: commits[0]?.hash ?? options?.fromExclusive ?? '',
    oldestDate: '',
    newestDate: '',
    files: {},
    coChangeCounts: {},
  }

  for (const commit of commits) {
    const commitDate = toISO(commit.date)
    const author = commit.author_name || 'unknown'
    if (!scan.oldestDate || commitDate < scan.oldestDate) scan.oldestDate = commitDate
    if (!scan.newestDate || commitDate > scan.newestDate) scan.newestDate = commitDate

    const filteredFiles = extractFilesFromCommit(commit)
      .map(normalisePath)
      .filter((f) => shouldIncludeFile(f, excludePaths))

    for (const filepath of filteredFiles) {
      const existing = scan.files[filepath]
      if (existing) {
        existing.changeCount++
        if (commitDate > existing.lastChanged) existing.lastChanged = commitDate
        if (commitDate < existing.firstSeen) existing.firstSeen = commitDate
        if (!existing.authors.includes(author)) existing.authors.push(author)
      } else {
        scan.files[filepath] = {
          changeCount: 1,
          lastChanged: commitDate,
          firstSeen: commitDate,
          authors: [author],
        }
      }
    }

    if (filteredFiles.length >= 2 && filteredFiles.length <= CO_CHANGE_FILES_PER_COMMIT_CAP) {
      for (let i = 0; i < filteredFiles.length; i++) {
        for (let j = i + 1; j < filteredFiles.length; j++) {
          const key = makeCoChangeKey(filteredFiles[i], filteredFiles[j])
          scan.coChangeCounts[key] = (scan.coChangeCounts[key] ?? 0) + 1
        }
      }
    }
  }

  return scan
}

/**
 * Build the derived analysis result (ranked files with coChangedWith,
 * top co-change pairs) from raw counts. Pure — used by both the one-shot
 * and the incremental paths.
 */
export function buildAnalysisResult(
  scan: Pick<RawScan, 'commitCount' | 'oldestDate' | 'newestDate' | 'files' | 'coChangeCounts'>,
  maxCoChangePairs = DEFAULT_MAX_CO_CHANGE_PAIRS,
): GitAnalysisResult {
  const coChangePairs: CoChangeRecord[] = []
  const perFileCoChange = new Map<string, Map<string, number>>()
  for (const [key, count] of Object.entries(scan.coChangeCounts)) {
    if (count < 2) continue
    const [a, b] = key.split('|')
    coChangePairs.push({ fileA: a, fileB: b, coChangeCount: count })
    if (!perFileCoChange.has(a)) perFileCoChange.set(a, new Map())
    if (!perFileCoChange.has(b)) perFileCoChange.set(b, new Map())
    perFileCoChange.get(a)!.set(b, count)
    perFileCoChange.get(b)!.set(a, count)
  }
  coChangePairs.sort((a, b) => b.coChangeCount - a.coChangeCount)

  const files: FileChangeRecord[] = []
  for (const [filepath, data] of Object.entries(scan.files)) {
    const coMap = perFileCoChange.get(filepath)
    const coChangedWith = coMap
      ? Array.from(coMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([f]) => f)
      : []
    files.push({ filepath, ...data, coChangedWith })
  }
  files.sort((a, b) => b.changeCount - a.changeCount)

  return {
    analysedAt: new Date().toISOString(),
    commitCount: scan.commitCount,
    fileCount: files.length,
    files,
    coChanges: coChangePairs.slice(0, maxCoChangePairs),
    oldestCommit: scan.oldestDate,
    newestCommit: scan.newestDate,
  }
}

/** Merge an incremental scan into accumulated raw counts (in place on a copy). */
export function mergeScans(base: RawScan, delta: RawScan): RawScan {
  const merged: RawScan = {
    commitCount: base.commitCount + delta.commitCount,
    newestHash: delta.newestHash || base.newestHash,
    oldestDate:
      base.oldestDate && (!delta.oldestDate || base.oldestDate < delta.oldestDate)
        ? base.oldestDate
        : delta.oldestDate,
    newestDate:
      base.newestDate && (!delta.newestDate || base.newestDate > delta.newestDate)
        ? base.newestDate
        : delta.newestDate,
    files: { ...base.files },
    coChangeCounts: { ...base.coChangeCounts },
  }
  for (const [filepath, d] of Object.entries(delta.files)) {
    const existing = merged.files[filepath]
    if (existing) {
      merged.files[filepath] = {
        changeCount: existing.changeCount + d.changeCount,
        lastChanged: d.lastChanged > existing.lastChanged ? d.lastChanged : existing.lastChanged,
        firstSeen: d.firstSeen < existing.firstSeen ? d.firstSeen : existing.firstSeen,
        authors: [...new Set([...existing.authors, ...d.authors])],
      }
    } else {
      merged.files[filepath] = { ...d, authors: [...d.authors] }
    }
  }
  for (const [key, count] of Object.entries(delta.coChangeCounts)) {
    merged.coChangeCounts[key] = (merged.coChangeCounts[key] ?? 0) + count
  }
  return merged
}

/** Files currently tracked by git — used to prune deleted/renamed paths. */
export async function listTrackedFiles(repoPath: string): Promise<Set<string> | null> {
  try {
    const git = simpleGit(repoPath)
    const out = await git.raw(['ls-files'])
    return new Set(out.split('\n').map((l) => normalisePath(l.trim())).filter(Boolean))
  } catch {
    return null
  }
}

/**
 * Analyse a git repository and produce structured change data (one-shot).
 *
 * **Never throws** — returns an empty result for non-git directories,
 * empty repos, or any other error condition.
 */
export async function analyseRepository(
  repoPath: string,
  options?: AnalysisOptions,
): Promise<GitAnalysisResult> {
  try {
    const scan = await scanCommits(repoPath, options)
    if (!scan || scan.commitCount === 0) return emptyResult()
    return buildAnalysisResult(scan, options?.maxCoChangePairs ?? DEFAULT_MAX_CO_CHANGE_PAIRS)
  } catch {
    return emptyResult()
  }
}

// ──────────────────────────────────────────────────────────────
// EXTRACT FILES FROM COMMIT
// ──────────────────────────────────────────────────────────────

/**
 * Extract file paths from a simple-git log entry.
 * simple-git puts the file list in `diff.files` when --name-only is used,
 * or sometimes in the `body` field as newline-separated paths.
 */
function extractFilesFromCommit(
  commit: DefaultLogFields & ListLogLine,
): string[] {
  const files: string[] = []

  // Try diff.files first (simple-git standard format)
  if (commit.diff && commit.diff.files && commit.diff.files.length > 0) {
    for (const f of commit.diff.files) {
      if (f.file) files.push(f.file)
    }
  }

  // Fallback: parse body for file paths (--name-only output)
  if (files.length === 0 && commit.body) {
    const bodyLines = commit.body.split('\n')
    for (const line of bodyLines) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('commit ') && !trimmed.startsWith('Author:') && !trimmed.startsWith('Date:')) {
        files.push(trimmed)
      }
    }
  }

  return files.filter(f => f.length > 0)
}
