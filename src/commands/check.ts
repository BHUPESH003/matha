import { simpleGit } from 'simple-git'
import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js'
import { Engine } from '@/core/engine.js'
import type { MatchResult } from '@/retrieve/match.js'

/**
 * `matha check` — the retrieval engine pointed at a diff (§5.5). Matches the
 * changed files against boundaries, danger zones, contracts and decisions,
 * and reports what applies. Advisory by default (exit 0 with findings);
 * --strict exits 1 on any CRITICAL match — whether CI blocks on that is the
 * admin's pipeline config, not matha's. Capture-store-retrieve, no enforcer.
 */

interface CheckDeps {
  log?: (msg: string) => void
}

export interface CheckResult {
  exitCode: 0 | 1
  message?: string
  files?: string[]
  results?: MatchResult[]
  hasCritical?: boolean
}

export async function runCheck(
  projectRoot: string = process.cwd(),
  opts: { diff?: string; strict?: boolean } = {},
  deps?: CheckDeps,
): Promise<CheckResult> {
  const log = deps?.log ?? console.log

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

  // Changed files: against a base ref (CI / pre-merge), or the working tree.
  let files: string[]
  const range = opts.diff ? `${opts.diff}...HEAD` : 'HEAD'
  try {
    const out = await simpleGit(projectRoot).diff(['--name-only', range])
    files = out.split('\n').map((f) => f.trim()).filter(Boolean)
  } catch (err: any) {
    const message = `Could not diff against '${range}': ${err.message?.split('\n')[0] ?? err}`
    log(message)
    return { exitCode: 1, message }
  }

  log('════════════════════════════════════════')
  log(`MATHA CHECK — ${opts.diff ? `diff ${opts.diff}...HEAD` : 'working tree changes'}`)
  log('════════════════════════════════════════')

  if (files.length === 0) {
    log('✓ No changed files — nothing to check.')
    log('════════════════════════════════════════')
    return { exitCode: 0, files, results: [], hasCritical: false }
  }

  const engine = new Engine(mathaDir)
  const { results } = await engine.match({
    scope: files.join(', '),
    intent: 'pre-merge check of changed files',
    filepaths: files,
  })
  const hasCritical = results.some((r) => r.severity === 'critical')

  log(`${files.length} changed file(s) checked against the brain.\n`)
  if (results.length === 0) {
    log('✓ No matching records — nothing known applies to this change.')
  } else {
    for (const r of results) {
      const icon = r.severity === 'critical' ? '✗' : r.severity === 'warning' ? '⚠' : 'ℹ'
      log(`${icon} [${r.severity.toUpperCase()}] ${r.title}${r.possiblyStale ? ' (possibly stale)' : ''}`)
      log(`    ${r.description}`)
      log(`    → ${r.recommendation}`)
    }
  }
  log('')
  log(
    hasCritical
      ? `${results.filter((r) => r.severity === 'critical').length} CRITICAL finding(s).` +
          (opts.strict ? ' Failing (--strict).' : ' Advisory only — pass --strict to fail on criticals.')
      : '✓ No critical findings.',
  )
  log('════════════════════════════════════════')

  return {
    exitCode: opts.strict && hasCritical ? 1 : 0,
    files,
    results,
    hasCritical,
  }
}
