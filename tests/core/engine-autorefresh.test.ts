import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Engine } from '../../src/core/engine.js'

/** Codemap auto-refresh on read (Phase 3): retrieval never serves a stale codemap. */

describe('engine codemap auto-refresh', () => {
  let repo: string
  let mathaDir: string

  function sh(cmd: string) {
    execSync(cmd, { cwd: repo, stdio: 'pipe' })
  }

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-autorefresh-'))
    mathaDir = path.join(repo, '.matha')
    await fs.mkdir(path.join(mathaDir, 'hippocampus', 'decisions'), { recursive: true })
    sh('git init -q && git config user.email t@t.io && git config user.name t')
    await fs.mkdir(path.join(repo, 'src'), { recursive: true })
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'a1')
    sh('git add -A && git commit -qm one')
  })

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true })
  })

  it('first loadBrain derives the codemap by itself (no manual refresh)', async () => {
    const engine = new Engine(mathaDir)
    const brain = await engine.loadBrain()
    expect(brain.stability.some((r) => r.filepath === 'src/a.ts')).toBe(true)
    await fs.access(path.join(mathaDir, 'cortex', 'analysis.json')) // cursor persisted
  })

  it('a new commit is picked up on the next read — work outside matha catches up', async () => {
    const engine = new Engine(mathaDir)
    await engine.loadBrain()

    await fs.writeFile(path.join(repo, 'src', 'b.ts'), 'b1')
    sh('git add -A && git commit -qm two')

    const brain = await engine.loadBrain()
    expect(brain.stability.some((r) => r.filepath === 'src/b.ts')).toBe(true)
  })

  it('when HEAD has not moved, no refresh runs (analysis.json untouched)', async () => {
    const engine = new Engine(mathaDir)
    await engine.loadBrain()
    const before = await fs.stat(path.join(mathaDir, 'cortex', 'analysis.json'))

    await engine.loadBrain()
    await engine.loadBrain()

    const after = await fs.stat(path.join(mathaDir, 'cortex', 'analysis.json'))
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('non-git brains read fine and never grow a cortex', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-nogit-'))
    const bareMatha = path.join(bare, '.matha')
    await fs.mkdir(path.join(bareMatha, 'hippocampus', 'decisions'), { recursive: true })

    const engine = new Engine(bareMatha)
    const brain = await engine.loadBrain()
    expect(brain.stability).toEqual([])
    await expect(fs.access(path.join(bareMatha, 'cortex', 'analysis.json'))).rejects.toThrow()
    await fs.rm(bare, { recursive: true, force: true })
  })
})
