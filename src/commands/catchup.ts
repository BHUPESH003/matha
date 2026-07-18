import { simpleGit } from 'simple-git'
import { Engine } from '@/core/engine.js'
import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js'
import { splitComponent, normalisePath } from '@/core/schema.js'
import { pathPairScore } from '@/retrieve/match.js'
import { DEFAULT_EXCLUDE_PATHS, shouldIncludeFile } from '@/codemap/git-analyser.js'

/**
 * `matha catchup` — list unaccounted work (target-architecture §5.1):
 * commits since the last recorded knowledge that touch paths no active
 * record covers. The codemap never misses this work (it reads git), but
 * the knowledge layer can — catchup makes that gap visible so a human or
 * agent can backfill it via `matha after` / matha_record.
 *
 * ponytail: report-only. Interactive backfill is deliberately not built —
 * the printed list IS the backfill prompt for an agent session.
 */

const DEFAULT_WINDOW_DAYS = 30
const MAX_COMMITS_SCANNED = 200

export interface UnaccountedCommit {
  hash: string
  date: string
  message: string
  uncoveredFiles: string[]
}

interface CatchupDeps {
  log?: (msg: string) => void
  now?: () => Date
}

interface CatchupResult {
  exitCode: 0 | 1
  message?: string
  since?: string
  unaccounted?: UnaccountedCommit[]
}

export async function runCatchup(
  projectRoot: string = process.cwd(),
  deps?: CatchupDeps,
): Promise<CatchupResult> {
  const log = deps?.log ?? console.log
  const now = deps?.now ?? (() => new Date())

  let mathaDir: string
  try {
    mathaDir = (await resolveBrainDir({ explicitRoot: projectRoot })).mathaDir
  } catch (err) {
    if (err instanceof BrainNotFoundError) {
      const message = 'MATHA is not initialised. Run `matha init` first.'
      log(message)
      return { exitCode: 1, message }
    }
    throw err
  }

  const engine = new Engine(mathaDir)
  const brain = await engine.loadBrain()

  // Knowledge coverage: every path an active record declares.
  const coveredPaths: string[] = []
  for (const d of brain.decisions) {
    if (d.status === 'active') coveredPaths.push(...splitComponent(d.component).paths)
  }
  for (const z of brain.dangerZones) {
    if (!z.status || z.status === 'active') coveredPaths.push(...splitComponent(z.component).paths)
  }
  for (const c of brain.contracts) {
    coveredPaths.push(...splitComponent(c.component).paths)
  }

  // Window: since the newest recorded decision; without any, a bounded default.
  const newestRecord = brain.decisions
    .map((d) => d.timestamp)
    .sort()
    .pop()
  const since =
    newestRecord ??
    new Date(now().getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  let commits
  try {
    commits = (
      await simpleGit(projectRoot).log({
        '--after': since,
        maxCount: MAX_COMMITS_SCANNED,
        '--name-only': null,
      })
    ).all
  } catch {
    const message = 'Not a git repository — catchup reads git history.'
    log(message)
    return { exitCode: 1, message }
  }

  const covered = (file: string) => coveredPaths.some((p) => pathPairScore(p, file) >= 0.8)

  const unaccounted: UnaccountedCommit[] = []
  for (const commit of commits) {
    const files = ((commit as any).diff?.files ?? [])
      .map((f: any) => normalisePath(f.file ?? ''))
      .filter((f: string) => shouldIncludeFile(f, DEFAULT_EXCLUDE_PATHS))
    const uncovered = files.filter((f: string) => !covered(f))
    if (uncovered.length > 0) {
      unaccounted.push({
        hash: commit.hash.slice(0, 8),
        date: commit.date,
        message: commit.message,
        uncoveredFiles: uncovered,
      })
    }
  }

  // ── report ──────────────────────────────────────────────────────
  log('════════════════════════════════════════')
  log('MATHA CATCHUP — unaccounted work')
  log('════════════════════════════════════════')
  log(`Window: commits after ${since}${newestRecord ? ' (newest recorded decision)' : ' (default window)'}\n`)

  if (unaccounted.length === 0) {
    log('✓ No unaccounted work — every commit in the window touches paths the brain already covers.')
  } else {
    for (const c of unaccounted) {
      log(`· ${c.hash} ${c.date.slice(0, 10)} ${c.message}`)
      for (const f of c.uncoveredFiles.slice(0, 5)) log(`    ${f}`)
      if (c.uncoveredFiles.length > 5) log(`    … and ${c.uncoveredFiles.length - 5} more`)
    }
    log('')
    log(`${unaccounted.length} commit(s) touched paths with no recorded knowledge.`)
    log('Backfill: run `matha after`, or ask your agent to review these commits and')
    log('record durable learnings with matha_record (they will land as probable).')
  }
  log('════════════════════════════════════════')

  return { exitCode: 0, since, unaccounted }
}
