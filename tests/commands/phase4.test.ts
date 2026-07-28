import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { CURRENT_SCHEMA_VERSION } from '../../src/core/schema.js'
import { runReview } from '../../src/commands/review.js'
import { runBoundaryAdd, runBoundaryList } from '../../src/commands/boundary.js'
import { runCheck } from '../../src/commands/check.js'
import { runExport } from '../../src/commands/export.js'
import { runUi } from '../../src/commands/ui.js'
import { runOnboard } from '../../src/commands/onboard.js'
import { runHooks } from '../../src/commands/hooks.js'

describe('Phase 4 commands', () => {
  let repo: string
  let mathaDir: string

  async function writeDecision(id: string, overrides: Record<string, unknown> = {}) {
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'decisions', `${id}.json`),
      JSON.stringify({
        id, timestamp: '2026-07-01T00:00:00Z', component: 'src/pay.ts',
        previous_assumption: 'assumed retries idempotent', correction: 'they double-charge',
        trigger: 't', confidence: 'probable', status: 'active',
        supersedes: null, session_id: id, ...overrides,
      }),
    )
  }

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-p4-'))
    mathaDir = path.join(repo, '.matha')
    await fs.mkdir(path.join(mathaDir, 'hippocampus', 'decisions'), { recursive: true })
    await fs.writeFile(
      path.join(mathaDir, 'config.json'),
      JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION }),
    )
  })

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true })
  })

  // ── review ─────────────────────────────────────────────────────────

  it('review confirms, retires, and skips queued records', async () => {
    await writeDecision('d-confirm')
    await writeDecision('d-retire', { component: 'src/auth.ts', previous_assumption: 'assumed TTL fixed', correction: 'TTL is sliding' })
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'danger-zones.json'),
      JSON.stringify({ zones: [{ id: 'z-skip', component: 'src/z.ts', pattern: 'p', description: 'suspicious race', confidence: 'uncertain' }] }),
    )

    const answers = ['c', 'r', 'stale — endpoint removed in v2', 's']
    const result = await runReview(repo, { ask: async () => answers.shift()!, log: () => {} })

    expect(result.queued).toBe(3)
    expect(result.confirmed).toBe(1)
    expect(result.retired).toBe(1)
    expect(result.skipped).toBe(1)

    const confirmed = JSON.parse(
      await fs.readFile(path.join(mathaDir, 'hippocampus', 'decisions', 'd-confirm.json'), 'utf-8'),
    )
    expect(confirmed.confidence).toBe('confirmed')
    expect(confirmed.last_confirmed).toBeTruthy()

    const retired = JSON.parse(
      await fs.readFile(path.join(mathaDir, 'hippocampus', 'decisions', 'd-retire.json'), 'utf-8'),
    )
    expect(retired.status).toBe('retired')
    expect(retired.retired_reason).toContain('v2')
  })

  it('review with a fully-confirmed brain reports an empty queue', async () => {
    await writeDecision('d-ok', { confidence: 'confirmed' })
    const result = await runReview(repo, { ask: async () => 's', log: () => {} })
    expect(result.queued).toBe(0)
  })

  it('review degrades to a report instead of crashing on non-TTY stdin (field bug)', async () => {
    await writeDecision('d1')
    const lines: string[] = []
    // No `ask` override — exercises the real isTTY branch; vitest's stdin is
    // never a TTY, so this must fall back to printing rather than prompting
    // (the reported bug: inquirer threw ExitPromptError and crashed instead).
    const result = await runReview(repo, { log: (m) => lines.push(m) })
    expect(result.exitCode).toBe(0)
    expect(result.queued).toBe(1)
    expect(result.confirmed).toBe(0)
    expect(lines.join('\n')).toContain('no interactive terminal')
  })

  // ── boundary ───────────────────────────────────────────────────────

  it('boundary add/list works and rejects near-duplicates', async () => {
    const added = await runBoundaryAdd(
      repo,
      { paths: 'db/schema/', rule: 'Schema changes require DBA sign-off', by: 'alice' },
      { log: () => {} },
    )
    expect(added.exitCode).toBe(0)

    const dup = await runBoundaryAdd(
      repo,
      { paths: 'db/', rule: 'schema changes require DBA sign-off' },
      { log: () => {} },
    )
    expect(dup.exitCode).toBe(1)
    expect(dup.message).toContain('near-duplicate')

    const lines: string[] = []
    await runBoundaryList(repo, { log: (m) => lines.push(m) })
    expect(lines.join('\n')).toContain('db/schema/')
    expect(lines.join('\n')).toContain('alice')
  })

  // ── check ──────────────────────────────────────────────────────────

  it('check matches a diff against the brain; --strict fails on criticals', async () => {
    execSync('git init -q && git config user.email t@t.io && git config user.name t', { cwd: repo })
    await fs.mkdir(path.join(repo, 'db', 'schema'), { recursive: true })
    await fs.writeFile(path.join(repo, 'db', 'schema', 'users.sql'), 'v1')
    execSync('git add -A && git commit -qm base', { cwd: repo })

    await runBoundaryAdd(
      repo,
      { paths: 'db/schema/', rule: 'Schema changes require DBA sign-off', by: 'alice' },
      { log: () => {} },
    )

    await fs.writeFile(path.join(repo, 'db', 'schema', 'users.sql'), 'v2')
    execSync('git add -A && git commit -qm "change schema"', { cwd: repo })

    const advisory = await runCheck(repo, { diff: 'HEAD~1' }, { log: () => {} })
    expect(advisory.exitCode).toBe(0)
    expect(advisory.hasCritical).toBe(true)
    expect(advisory.results!.some((r) => r.matchType === 'boundary')).toBe(true)

    const strict = await runCheck(repo, { diff: 'HEAD~1', strict: true }, { log: () => {} })
    expect(strict.exitCode).toBe(1)

    // a change nowhere near the boundary is clean
    await fs.writeFile(path.join(repo, 'notes.md'), 'hello')
    execSync('git add -A && git commit -qm notes', { cwd: repo })
    const clean = await runCheck(repo, { diff: 'HEAD~1', strict: true }, { log: () => {} })
    expect(clean.exitCode).toBe(0)
    expect(clean.hasCritical).toBe(false)
  })

  // ── export / ui ────────────────────────────────────────────────────

  it('export --md renders a deterministic summary of every section', async () => {
    await writeDecision('d1')
    await runBoundaryAdd(
      repo,
      { paths: 'db/schema/', rule: 'Schema changes require DBA sign-off', by: 'alice' },
      { log: () => {} },
    )
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'rules.json'),
      JSON.stringify({ rules: ['Never charge twice'] }),
    )

    const first = await runExport(repo, {}, { log: () => {} })
    expect(first.exitCode).toBe(0)
    expect(first.markdown).toContain('## Business rules')
    expect(first.markdown).toContain('Never charge twice')
    expect(first.markdown).toContain('## Declared boundaries')
    expect(first.markdown).toContain('DBA sign-off')
    expect(first.markdown).toContain('they double-charge')

    const second = await runExport(repo, {}, { log: () => {} })
    expect(second.markdown).toBe(first.markdown) // PR-diffable: deterministic

    const toFile = await runExport(repo, { out: 'BRAIN.md' }, { log: () => {} })
    expect(await fs.readFile(path.join(repo, 'BRAIN.md'), 'utf-8')).toBe(toFile.markdown)
  })

  it('ui writes a self-contained report.html flagging review candidates', async () => {
    await writeDecision('d1') // probable → needs review
    const result = await runUi(repo, { log: () => {} })
    expect(result.exitCode).toBe(0)

    const html = await fs.readFile(path.join(mathaDir, 'report.html'), 'utf-8')
    expect(html).toContain('d1')
    expect(html).toContain('"needsReview":true')
    expect(html).not.toContain('src="http') // self-contained: no external assets
  })

  // ── onboard / hooks ────────────────────────────────────────────────

  it('onboard finds project docs and emits the agent prompt', async () => {
    await fs.writeFile(path.join(repo, 'README.md'), '# hi')
    await fs.mkdir(path.join(repo, 'docs'))
    await fs.writeFile(path.join(repo, 'docs', 'conventions.md'), 'rules')

    const lines: string[] = []
    const result = await runOnboard(repo, { log: (m) => lines.push(m) })
    expect(result.exitCode).toBe(0)
    expect(result.docs).toContain('README.md')
    expect(result.docs).toContain(path.join('docs', 'conventions.md'))
    const out = lines.join('\n')
    expect(out).toContain('matha_record')
    expect(out).toContain('matha review')
  })

  it('hooks --install merges into .claude/settings.json without clobbering', async () => {
    const settingsPath = path.join(repo, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, JSON.stringify({ permissions: { allow: ['Bash'] } }))

    const result = await runHooks(repo, { install: true }, { log: () => {} })
    expect(result.exitCode).toBe(0)

    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(settings.permissions.allow).toEqual(['Bash']) // untouched
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('matha')

    // idempotent
    await runHooks(repo, { install: true }, { log: () => {} })
    const again = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(again.hooks.SessionStart).toHaveLength(1)
  })
})
