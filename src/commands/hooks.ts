import * as fs from 'fs/promises'
import * as path from 'path'
import { createRequire } from 'module'
import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js'
import { writeAtomic } from '@/storage/writer.js'

/**
 * `matha hooks` — session-start capture wiring for Claude Code (Phase 3).
 * SessionStart runs `matha before`, whose output ends with the standing
 * record-what-you-learn instruction, so every session starts with context
 * and knows to write back — no human ceremony per session.
 *
 * ponytail: SessionStart only. A Stop-hook that prompts a structured
 * write-back needs per-session state (did this session already record?);
 * add it if dogfooding shows the standing instruction alone misses captures.
 */

const require = createRequire(import.meta.url)
const { name: PACKAGE_NAME, version } = require('../../package.json')
const MAJOR = String(version).split('.')[0]

interface HooksDeps {
  log?: (msg: string) => void
}

export interface HooksResult {
  exitCode: 0 | 1
  message?: string
  installedTo?: string
}

function mathaHookEntry() {
  return {
    hooks: [
      {
        type: 'command',
        // pinned to the current major — the field test flagged unpinned npx
        command: `npx -y ${PACKAGE_NAME}@${MAJOR} before`,
      },
    ],
  }
}

export async function runHooks(
  projectRoot: string = process.cwd(),
  opts: { install?: boolean } = {},
  deps?: HooksDeps,
): Promise<HooksResult> {
  const log = deps?.log ?? console.log

  try {
    await resolveBrainDir({ explicitRoot: projectRoot })
  } catch (err) {
    if (err instanceof BrainNotFoundError) {
      const message = 'MATHA is not initialised. Run `matha init` first.'
      log(message)
      return { exitCode: 1, message }
    }
    throw err
  }

  const snippet = { hooks: { SessionStart: [mathaHookEntry()] } }

  if (!opts.install) {
    log('Claude Code hook — injects the matha brief at every session start.')
    log('Merge into <project>/.claude/settings.json (or run `matha hooks --install`):\n')
    log(JSON.stringify(snippet, null, 2))
    log('\nOther agents: run `matha before` at session start and paste the output.')
    return { exitCode: 0 }
  }

  const settingsPath = path.join(projectRoot, '.claude', 'settings.json')
  let settings: Record<string, any> = {}
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
  } catch {
    /* no settings yet — start fresh */
  }

  settings.hooks = settings.hooks ?? {}
  const sessionStart: any[] = Array.isArray(settings.hooks.SessionStart)
    ? settings.hooks.SessionStart
    : []
  const already = JSON.stringify(sessionStart).includes(`${PACKAGE_NAME}@`)
  if (already) {
    log(`✓ matha SessionStart hook already present in ${settingsPath} — nothing to do.`)
    return { exitCode: 0, installedTo: settingsPath }
  }
  sessionStart.push(mathaHookEntry())
  settings.hooks.SessionStart = sessionStart

  await writeAtomic(settingsPath, settings, { overwrite: true })
  log(`✓ matha SessionStart hook installed in ${settingsPath}.`)
  log('  Every Claude Code session in this project now starts with the matha brief.')
  return { exitCode: 0, installedTo: settingsPath }
}
