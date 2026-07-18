import * as path from 'path'
import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js'
import { Engine } from '@/core/engine.js'
import { writeTextAtomic } from '@/storage/writer.js'

/**
 * `matha export --md` — human-readable, PR-diffable brain summary (§5.4).
 * Deterministic: content derives only from record data (no generation
 * timestamp), so re-exporting an unchanged brain produces an identical file
 * and the diff in a PR shows exactly what knowledge changed.
 */

interface ExportDeps {
  log?: (msg: string) => void
}

export interface ExportResult {
  exitCode: 0 | 1
  message?: string
  markdown?: string
  outPath?: string
}

export async function runExport(
  projectRoot: string = process.cwd(),
  opts: { out?: string } = {},
  deps?: ExportDeps,
): Promise<ExportResult> {
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

  const engine = new Engine(mathaDir)
  const [intent, rules, brain] = await Promise.all([
    engine.getIntent(),
    engine.getRules(),
    engine.loadBrain(),
  ])

  const lines: string[] = ['# Project brain (matha export)', '']
  if (intent?.why) lines.push('## Why', '', intent.why, '')

  if (rules.length > 0) {
    lines.push('## Business rules', '')
    for (const r of rules) lines.push(`- ${r}`)
    lines.push('')
  }

  const boundaries = (brain.boundaries ?? []).filter((b) => !b.status || b.status === 'active')
  if (boundaries.length > 0) {
    lines.push('## Declared boundaries', '')
    for (const b of [...boundaries].sort((a, z) => a.id.localeCompare(z.id))) {
      lines.push(`- **${b.component}** — ${b.rule} _(by ${b.declaredBy}, ${b.created.slice(0, 10)})_`)
    }
    lines.push('')
  }

  const zones = brain.dangerZones.filter((z) => !z.status || z.status === 'active')
  if (zones.length > 0) {
    lines.push('## Danger zones', '')
    for (const z of [...zones].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- **${z.component}** — ${z.description}${z.confidence ? ` _(${z.confidence})_` : ''}`)
    }
    lines.push('')
  }

  if (brain.contracts.length > 0) {
    lines.push('## Contracts', '')
    for (const c of [...brain.contracts].sort((a, b) => a.component.localeCompare(b.component))) {
      lines.push(`### ${c.component} (v${c.version})`, '')
      for (const a of c.assertions) {
        const violated =
          a.violation_count > 0
            ? ` — ⚠ violated ${a.violation_count}× (last ${a.last_violated?.slice(0, 10)})`
            : ''
        lines.push(`- ${a.description}${violated}`)
      }
      lines.push('')
    }
  }

  const active = brain.decisions
    .filter((d) => d.status === 'active')
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  const inactive = brain.decisions.length - active.length
  if (active.length > 0) {
    lines.push('## Decisions (active, newest first)', '')
    for (const d of active) {
      lines.push(
        `- **${d.component}** _(${d.confidence}, ${d.timestamp.slice(0, 10)})_`,
        `  - assumed: ${d.previous_assumption}`,
        `  - actually: ${d.correction}`,
      )
    }
    lines.push('')
    if (inactive > 0) lines.push(`_${inactive} superseded/retired decision(s) not shown._`, '')
  }

  if (brain.stability.length > 0) {
    const byClass = new Map<string, number>()
    for (const s of brain.stability) byClass.set(s.stability, (byClass.get(s.stability) ?? 0) + 1)
    lines.push('## Stability (from git history)', '')
    for (const cls of ['frozen', 'stable', 'volatile', 'disposable']) {
      if (byClass.has(cls)) lines.push(`- ${cls}: ${byClass.get(cls)} file(s)`)
    }
    const frozen = brain.stability
      .filter((s) => s.stability === 'frozen')
      .sort((a, b) => a.filepath.localeCompare(b.filepath))
    if (frozen.length > 0) {
      lines.push('', '### Frozen files', '')
      for (const f of frozen) lines.push(`- \`${f.filepath}\` — ${f.reason}`)
    }
    lines.push('')
  }

  const topPairs = [...brain.coChanges]
    .sort((a, b) => b.coChangeCount - a.coChangeCount || a.fileA.localeCompare(b.fileA))
    .slice(0, 10)
  if (topPairs.length > 0) {
    lines.push('## Co-change hotspots (top 10)', '')
    for (const p of topPairs) {
      lines.push(`- \`${p.fileA}\` ↔ \`${p.fileB}\` (${p.coChangeCount}×)`)
    }
    lines.push('')
  }

  const markdown = lines.join('\n')

  if (opts.out) {
    const outPath = path.isAbsolute(opts.out) ? opts.out : path.join(projectRoot, opts.out)
    await writeTextAtomic(outPath, markdown)
    log(`✓ Exported brain to ${outPath}`)
    return { exitCode: 0, markdown, outPath }
  }
  log(markdown)
  return { exitCode: 0, markdown }
}
