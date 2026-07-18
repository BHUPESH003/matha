import * as fs from 'fs/promises'
import * as path from 'path'
import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js'

/**
 * `matha onboard` — existing-codebase onboarding (§5.2). matha itself never
 * interprets prose; it emits a ready-to-paste agent prompt pointing at the
 * project's own docs, with instructions to propose knowledge via
 * matha_record (which lands as `probable`) — the human then confirms via
 * `matha review`. Agent proposes, human disposes.
 *
 * ponytail: report-only, like catchup — the printed prompt IS the feature.
 */

const DOC_PATTERNS = /^(readme|contributing|architecture|decisions|conventions|adr)/i
const MAX_DOCS = 20

interface OnboardDeps {
  log?: (msg: string) => void
}

export interface OnboardResult {
  exitCode: 0 | 1
  message?: string
  docs?: string[]
}

async function findDocs(projectRoot: string): Promise<string[]> {
  const docs: string[] = []
  const rootEntries = await fs.readdir(projectRoot).catch(() => [] as string[])
  for (const f of rootEntries) {
    if (f.endsWith('.md') && DOC_PATTERNS.test(f)) docs.push(f)
  }
  // one level of docs/ is enough signal — deep doc trees are rarely rules
  for (const dir of ['docs', 'doc']) {
    const entries = await fs.readdir(path.join(projectRoot, dir)).catch(() => [] as string[])
    for (const f of entries) {
      if (f.endsWith('.md')) docs.push(path.join(dir, f))
    }
  }
  return docs.slice(0, MAX_DOCS)
}

export async function runOnboard(
  projectRoot: string = process.cwd(),
  deps?: OnboardDeps,
): Promise<OnboardResult> {
  const log = deps?.log ?? console.log

  try {
    await resolveBrainDir({ explicitRoot: projectRoot })
  } catch (err) {
    if (err instanceof BrainNotFoundError) {
      const message = 'MATHA is not initialised. Run `matha init` first (it creates the brain onboard fills).'
      log(message)
      return { exitCode: 1, message }
    }
    throw err
  }

  const docs = await findDocs(projectRoot)

  log('════════════════════════════════════════')
  log('MATHA ONBOARD — seed the brain from your docs')
  log('════════════════════════════════════════')
  if (docs.length === 0) {
    log('No project docs found (README/CONTRIBUTING/docs/*.md).')
    log('You can still seed interactively: matha init --from <file>, or record as you work.')
    return { exitCode: 0, docs }
  }

  log('Found project docs:')
  for (const d of docs) log(`  · ${d}`)
  log('')
  log('Paste this prompt into an agent session with the matha MCP server connected:')
  log('────────────────────────────────────────')
  log(
    [
      `Read these project docs: ${docs.join(', ')}.`,
      '',
      'For each durable, non-obvious piece of project knowledge you find, record it with matha_record:',
      "- type=danger for things that break non-obviously (deploy gotchas, ordering constraints, 'never do X here')",
      '- type=contract for invariants a component must uphold (component + assertions)',
      '- type=decision for documented corrections of earlier assumptions',
      'Always set component to concrete file/directory paths where possible. Everything you record lands as',
      "confidence=probable — do not try to mark anything confirmed; a human will review with `matha review`.",
      'Skip anything obvious from the code itself, style preferences, and generic best practices.',
      'Finish by listing anything that looks like a hard admin boundary — the human can pin those with',
      '`matha boundary add`.',
    ].join('\n'),
  )
  log('────────────────────────────────────────')
  log('Afterwards: run `matha review` to confirm or retire what the agent proposed.')
  log('════════════════════════════════════════')
  return { exitCode: 0, docs }
}
