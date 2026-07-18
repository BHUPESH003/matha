import * as crypto from 'crypto'
import { simpleGit } from 'simple-git'
import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js'
import { findNearDuplicate, validateBoundaryInput } from '@/core/schema.js'
import { getBoundaries, recordBoundary } from '@/store/records.js'

/**
 * `matha boundary` — admin-declared boundaries (§5.5). Deliberately CLI-only
 * (never writable over MCP): boundaries live in .matha/ and change through
 * PRs, so declaring one is a reviewed human act, not an agent side effect.
 */

interface BoundaryDeps {
  log?: (msg: string) => void
  now?: () => Date
}

export interface BoundaryResult {
  exitCode: 0 | 1
  message?: string
  id?: string
}

export async function runBoundaryAdd(
  projectRoot: string,
  opts: { paths: string; rule: string; by?: string },
  deps?: BoundaryDeps,
): Promise<BoundaryResult> {
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

  const valid = validateBoundaryInput({ component: opts.paths, rule: opts.rule })
  if (!valid.ok) {
    log(`✗ Boundary not added: ${valid.reason}`)
    return { exitCode: 1, message: valid.reason }
  }

  const existing = (await getBoundaries(mathaDir)).filter(
    (b) => !b.status || b.status === 'active',
  )
  const dup = findNearDuplicate(opts.rule, existing, (b) => b.rule)
  if (dup) {
    const message = `near-duplicate of existing boundary '${dup.id}' on '${dup.component}'`
    log(`✗ Boundary not added: ${message}`)
    return { exitCode: 1, message }
  }

  let declaredBy = opts.by?.trim()
  if (!declaredBy) {
    try {
      declaredBy = (await simpleGit(projectRoot).raw(['config', 'user.name'])).trim()
    } catch {
      /* not a git repo or no user.name */
    }
  }

  const id = `boundary-${crypto.randomBytes(4).toString('hex')}`
  await recordBoundary(mathaDir, {
    id,
    component: opts.paths,
    rule: opts.rule,
    declaredBy: declaredBy || 'admin',
    created: now().toISOString(),
  })
  log(`✓ Boundary ${id} declared on '${opts.paths}' — CRITICAL on any direct path match.`)
  return { exitCode: 0, id }
}

export async function runBoundaryList(
  projectRoot: string,
  deps?: BoundaryDeps,
): Promise<BoundaryResult> {
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

  const boundaries = await getBoundaries(mathaDir)
  if (boundaries.length === 0) {
    log('No boundaries declared. Add one: matha boundary add --paths <paths> --rule <rule>')
    return { exitCode: 0 }
  }
  for (const b of boundaries) {
    const status = b.status && b.status !== 'active' ? ` [${b.status}]` : ''
    log(`· ${b.id}${status} ${b.component}`)
    log(`    ${b.rule}  (by ${b.declaredBy}, ${b.created.slice(0, 10)})`)
  }
  return { exitCode: 0 }
}
