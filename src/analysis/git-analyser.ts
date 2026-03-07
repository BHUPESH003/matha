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

// ──────────────────────────────────────────────────────────────
// CONSTANTS
// ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_COMMITS = 500
const DEFAULT_MAX_CO_CHANGE_PAIRS = 50
const DEFAULT_EXCLUDE_PATHS = ['node_modules', '.git', 'dist', '.matha', 'coverage']
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

function shouldIncludeFile(filepath: string, excludePaths: string[]): boolean {
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
 * Analyse a git repository and produce structured change data.
 *
 * **Never throws** — returns an empty result for non-git directories,
 * empty repos, or any other error condition.
 */
export async function analyseRepository(
  repoPath: string,
  options?: AnalysisOptions,
): Promise<GitAnalysisResult> {
  try {
    // Check if .git exists
    try {
      await fs.access(path.join(repoPath, '.git'))
    } catch {
      return emptyResult()
    }

    const git: SimpleGit = simpleGit(repoPath)
    const maxCommits = options?.maxCommits ?? DEFAULT_MAX_COMMITS
    const excludePaths = options?.excludePaths ?? DEFAULT_EXCLUDE_PATHS
    const maxCoChangePairs = options?.maxCoChangePairs ?? DEFAULT_MAX_CO_CHANGE_PAIRS

    // Build log options
    const logOptions: Record<string, any> = {
      maxCount: maxCommits,
      '--name-only': null,
    }
    if (options?.since) {
      logOptions['--after'] = options.since
    }

    // Get commit log
    let logResult: { all: ReadonlyArray<DefaultLogFields & ListLogLine>; total: number }
    try {
      logResult = await git.log(logOptions)
    } catch {
      // Empty repo or other git error
      return emptyResult()
    }

    const commits = logResult.all
    if (commits.length === 0) {
      return emptyResult()
    }

    // ────────────────────────────────────────────────────────────
    // SCAN COMMITS
    // ────────────────────────────────────────────────────────────

    // Per-file tracking
    const fileData = new Map<string, {
      changeCount: number
      lastChanged: string
      firstSeen: string
      authors: Set<string>
    }>()

    // Co-change pair tracking
    const coChangeMap = new Map<string, number>()

    let oldestDate = ''
    let newestDate = ''

    for (const commit of commits) {
      const commitDate = toISO(commit.date)
      const author = commit.author_name || 'unknown'

      // Track oldest/newest
      if (!oldestDate || commitDate < oldestDate) oldestDate = commitDate
      if (!newestDate || commitDate > newestDate) newestDate = commitDate

      // Get files from this commit
      // simple-git log with --name-only puts files in diff.files or body
      const rawFiles = extractFilesFromCommit(commit)
      const filteredFiles = rawFiles
        .map(normalisePath)
        .filter(f => shouldIncludeFile(f, excludePaths))

      // Update per-file data
      for (const filepath of filteredFiles) {
        const existing = fileData.get(filepath)
        if (existing) {
          existing.changeCount++
          if (commitDate > existing.lastChanged) existing.lastChanged = commitDate
          if (commitDate < existing.firstSeen) existing.firstSeen = commitDate
          existing.authors.add(author)
        } else {
          fileData.set(filepath, {
            changeCount: 1,
            lastChanged: commitDate,
            firstSeen: commitDate,
            authors: new Set([author]),
          })
        }
      }

      // Co-change pairs (skip if too many files in this commit)
      if (filteredFiles.length >= 2 && filteredFiles.length <= CO_CHANGE_FILES_PER_COMMIT_CAP) {
        for (let i = 0; i < filteredFiles.length; i++) {
          for (let j = i + 1; j < filteredFiles.length; j++) {
            const key = makeCoChangeKey(filteredFiles[i], filteredFiles[j])
            coChangeMap.set(key, (coChangeMap.get(key) ?? 0) + 1)
          }
        }
      }
    }

    // ────────────────────────────────────────────────────────────
    // BUILD CO-CHANGE RECORDS
    // ────────────────────────────────────────────────────────────

    // Filter out pairs with count < 2, sort descending, take top N
    const coChangePairs: CoChangeRecord[] = []
    for (const [key, count] of coChangeMap) {
      if (count >= 2) {
        const [fileA, fileB] = key.split('|')
        coChangePairs.push({ fileA, fileB, coChangeCount: count })
      }
    }
    coChangePairs.sort((a, b) => b.coChangeCount - a.coChangeCount)
    const topCoChanges = coChangePairs.slice(0, maxCoChangePairs)

    // ────────────────────────────────────────────────────────────
    // BUILD FILE RECORDS with coChangedWith
    // ────────────────────────────────────────────────────────────

    // Build per-file co-change index for top 5
    const perFileCoChange = new Map<string, Map<string, number>>()
    for (const [key, count] of coChangeMap) {
      if (count < 2) continue
      const [a, b] = key.split('|')
      if (!perFileCoChange.has(a)) perFileCoChange.set(a, new Map())
      if (!perFileCoChange.has(b)) perFileCoChange.set(b, new Map())
      perFileCoChange.get(a)!.set(b, count)
      perFileCoChange.get(b)!.set(a, count)
    }

    const files: FileChangeRecord[] = []
    for (const [filepath, data] of fileData) {
      // Top 5 co-changed files
      const coMap = perFileCoChange.get(filepath)
      let coChangedWith: string[] = []
      if (coMap) {
        coChangedWith = Array.from(coMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([f]) => f)
      }

      files.push({
        filepath,
        changeCount: data.changeCount,
        lastChanged: data.lastChanged,
        firstSeen: data.firstSeen,
        authors: Array.from(data.authors),
        coChangedWith,
      })
    }

    // Sort files by changeCount descending
    files.sort((a, b) => b.changeCount - a.changeCount)

    return {
      analysedAt: new Date().toISOString(),
      commitCount: commits.length,
      fileCount: files.length,
      files,
      coChanges: topCoChanges,
      oldestCommit: oldestDate,
      newestCommit: newestDate,
    }
  } catch {
    // Catch-all: never throw
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
