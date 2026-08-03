import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js'
import { Engine } from '@/core/engine.js'
import { splitComponent, type DangerZone, type DecisionEntry } from '@/core/schema.js'
import { changedSince } from '@/retrieve/match.js'
import { updateDangerZoneLifecycle, updateDecisionLifecycle } from '@/store/records.js'

/**
 * `matha review` — the human curation loop (Phase 4). Lists every record
 * that needs a human eye — unconfirmed (agent-written `probable`/`uncertain`)
 * and possibly-stale (code changed after the record was written) — and
 * resolves each one: confirm, retire (with reason), or skip.
 *
 * Confirm on a stale record sets last_confirmed, which resets the staleness
 * clock without touching the record's content (append-only rule).
 */

interface ReviewDeps {
  ask?: (question: string) => Promise<string>
  log?: (msg: string) => void
  now?: () => Date
}

interface QueueItem {
  kind: 'decision' | 'danger'
  id: string
  component: string
  summary: string
  reasons: string[]
}

export interface ReviewResult {
  exitCode: 0 | 1
  message?: string
  queued: number
  confirmed: number
  retired: number
  skipped: number
}

export async function runReview(
  projectRoot: string = process.cwd(),
  deps?: ReviewDeps,
): Promise<ReviewResult> {
  const ask = deps?.ask ?? defaultAsk
  const log = deps?.log ?? console.log
  const now = deps?.now ?? (() => new Date())

  let mathaDir: string
  try {
    mathaDir = (await resolveBrainDir({ explicitRoot: projectRoot })).mathaDir
  } catch (err) {
    if (err instanceof BrainNotFoundError) {
      const message = 'MATHA is not initialised. Run `matha init` first.'
      log(message)
      return { exitCode: 1, message, queued: 0, confirmed: 0, retired: 0, skipped: 0 }
    }
    throw err
  }

  const engine = new Engine(mathaDir)
  const brain = await engine.loadBrain()

  const queue: QueueItem[] = []
  for (const d of brain.decisions as DecisionEntry[]) {
    if (d.status !== 'active') continue
    const reasons: string[] = []
    if (d.confidence !== 'confirmed') reasons.push(`unconfirmed (${d.confidence})`)
    if (
      changedSince(
        splitComponent(d.component).paths,
        d.last_confirmed ?? d.timestamp,
        brain.fileLastChanged,
      )
    ) {
      reasons.push('possibly stale — code changed since recorded')
    }
    if (reasons.length > 0) {
      queue.push({
        kind: 'decision',
        id: d.id,
        component: d.component,
        summary: `assumed: ${d.previous_assumption} → actually: ${d.correction}`,
        reasons,
      })
    }
  }
  for (const z of brain.dangerZones as DangerZone[]) {
    if (z.status && z.status !== 'active') continue
    if (!z.confidence || z.confidence === 'confirmed') continue
    queue.push({
      kind: 'danger',
      id: z.id,
      component: z.component,
      summary: z.description,
      reasons: [`unconfirmed (${z.confidence})`],
    })
  }

  log('════════════════════════════════════════')
  log('MATHA REVIEW — records needing a human eye')
  log('════════════════════════════════════════')

  if (queue.length === 0) {
    log('✓ Nothing to review — every active record is confirmed and current.')
    log('════════════════════════════════════════')
    return { exitCode: 0, queued: 0, confirmed: 0, retired: 0, skipped: 0 }
  }

  // Non-interactive stdin (CI, piped input, a scripted agent session): the
  // prompt library throws on the first read rather than degrading, so detect
  // it up front and fall back to a plain report — same posture as catchup.
  if (deps?.ask === undefined && !process.stdin.isTTY) {
    log(`${queue.length} record(s) need review (no interactive terminal — printing, not prompting):\n`)
    for (const [i, item] of queue.entries()) {
      log(`[${i + 1}/${queue.length}] ${item.kind} ${item.id}`)
      log(`  component: ${item.component}`)
      log(`  ${item.summary}`)
      for (const r of item.reasons) log(`  ⚠ ${r}`)
    }
    log('\nRun `matha review` from an interactive terminal to confirm/retire these.')
    log('════════════════════════════════════════')
    return { exitCode: 0, queued: queue.length, confirmed: 0, retired: 0, skipped: 0 }
  }

  let confirmed = 0
  let retired = 0
  let skipped = 0

  for (const [i, item] of queue.entries()) {
    log(`\n[${i + 1}/${queue.length}] ${item.kind} ${item.id}`)
    log(`  component: ${item.component}`)
    log(`  ${item.summary}`)
    for (const r of item.reasons) log(`  ⚠ ${r}`)

    const action = (await ask('[c]onfirm / [r]etire / [s]kip?')).trim().toLowerCase()
    const patch =
      item.kind === 'decision' ? updateDecisionLifecycle : updateDangerZoneLifecycle

    if (action === 'c' || action === 'confirm') {
      await patch(mathaDir, item.id, {
        confidence: 'confirmed',
        last_confirmed: now().toISOString(),
      })
      confirmed++
      log('  ✓ confirmed')
    } else if (action === 'r' || action === 'retire') {
      const reason = (await ask('Why does this record no longer hold?')).trim()
      if (reason.length < 3) {
        log('  ✗ not retired: a meaningful reason is required — skipped')
        skipped++
        continue
      }
      await patch(mathaDir, item.id, { status: 'retired', retired_reason: reason })
      retired++
      log('  ✓ retired')
    } else {
      skipped++
      log('  – skipped')
    }
  }

  log('\n════════════════════════════════════════')
  log(`Reviewed ${queue.length}: ${confirmed} confirmed, ${retired} retired, ${skipped} skipped.`)
  log('════════════════════════════════════════')
  return { exitCode: 0, queued: queue.length, confirmed, retired, skipped }
}

async function defaultAsk(question: string): Promise<string> {
  const { default: input } = await import('@inquirer/input')
  return await input({ message: question })
}
