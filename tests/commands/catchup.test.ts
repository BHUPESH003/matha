import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { runCatchup } from '../../src/commands/catchup.js'
import { CURRENT_SCHEMA_VERSION, componentToFilename } from '../../src/core/schema.js'

describe('matha catchup (unaccounted work)', () => {
  let repo: string
  let mathaDir: string

  function sh(cmd: string) {
    execSync(cmd, { cwd: repo, stdio: 'pipe' })
  }

  async function commitFile(rel: string, content: string, msg: string) {
    const abs = path.join(repo, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
    sh(`git add -A && git commit -qm "${msg}"`)
  }

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-catchup-'))
    mathaDir = path.join(repo, '.matha')
    await fs.mkdir(path.join(mathaDir, 'hippocampus', 'decisions'), { recursive: true })
    await fs.writeFile(
      path.join(mathaDir, 'config.json'),
      JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION }),
    )
    sh('git init -q && git config user.email t@t.io && git config user.name t')
    await commitFile('src/payments/retry.ts', 'v1', 'base')

    // A decision recorded YESTERDAY covering src/payments/
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'decisions', `${componentToFilename('src/payments/')}.jsonl`),
      JSON.stringify({
        id: 'd1', timestamp: yesterday, component: 'src/payments/',
        previous_assumption: 'assumed X', correction: 'actually Y',
        trigger: 't', confidence: 'confirmed', status: 'active',
        supersedes: null, session_id: 'd1',
      }) + '\n',
    )
  })

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true })
  })

  it('commits touching covered paths are accounted; others are listed', async () => {
    await commitFile('src/payments/retry.ts', 'v2', 'covered work')
    await commitFile('src/auth/session.ts', 's1', 'uncovered work')

    const result = await runCatchup(repo, { log: () => {} })
    expect(result.exitCode).toBe(0)
    const messages = result.unaccounted!.map((c) => c.message)
    expect(messages).toContain('uncovered work')
    expect(messages).not.toContain('covered work')
    expect(result.unaccounted![0].uncoveredFiles).toEqual(['src/auth/session.ts'])
  })

  it('nothing new since the last record → clean report', async () => {
    const result = await runCatchup(repo, { log: () => {} })
    expect(result.exitCode).toBe(0)
    expect(result.unaccounted).toEqual([])
  })

  it('no decisions at all → bounded default window, still works', async () => {
    await fs.rm(path.join(mathaDir, 'hippocampus', 'decisions', `${componentToFilename('src/payments/')}.jsonl`))
    await commitFile('src/auth/session.ts', 's1', 'any work')

    const result = await runCatchup(repo, { log: () => {} })
    expect(result.exitCode).toBe(0)
    expect(result.unaccounted!.length).toBeGreaterThanOrEqual(1)
  })

  it('uninitialised project → exit 1', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-catchup-bare-'))
    const result = await runCatchup(bare, { log: () => {} })
    expect(result.exitCode).toBe(1)
    await fs.rm(bare, { recursive: true, force: true })
  })
})
