import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { refreshFromGit, overrideStability, type AnalysisState } from '../../src/codemap/index.js'

/**
 * Incremental codemap refresh (Phase 3): commit cursor, merge-not-rescan,
 * no-op when current, prune on delete, survive rebase.
 */

describe('incremental codemap refresh', () => {
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

  async function readState(): Promise<AnalysisState> {
    return JSON.parse(await fs.readFile(path.join(mathaDir, 'cortex', 'analysis.json'), 'utf-8'))
  }

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-incr-'))
    mathaDir = path.join(repo, '.matha')
    await fs.mkdir(path.join(mathaDir, 'cortex'), { recursive: true })
    sh('git init -q && git config user.email t@t.io && git config user.name t')
    await commitFile('src/a.ts', 'a1', 'one')
    await commitFile('src/b.ts', 'b1', 'two')
  })

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true })
  })

  it('first run persists a cursor at HEAD with merged counts', async () => {
    const snap = await refreshFromGit(repo, mathaDir)
    expect(snap.commitCount).toBe(2)
    expect(snap.newCommits).toBe(2)

    const state = await readState()
    const head = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
    expect(state.newestHash).toBe(head)
    expect(state.files['src/a.ts'].changeCount).toBe(1)
  })

  it('second refresh scans ONLY new commits and merges counts', async () => {
    await refreshFromGit(repo, mathaDir)
    await commitFile('src/a.ts', 'a2', 'three')
    await commitFile('src/a.ts', 'a3', 'four')

    const snap = await refreshFromGit(repo, mathaDir)
    expect(snap.newCommits).toBe(2) // only the two commits since the cursor
    expect(snap.commitCount).toBe(4) // cumulative

    const state = await readState()
    expect(state.files['src/a.ts'].changeCount).toBe(3) // 1 + 2 merged
    expect(state.files['src/b.ts'].changeCount).toBe(1) // untouched, preserved
  })

  it('no new commits → no-op: newCommits 0 and stability.json not rewritten', async () => {
    await refreshFromGit(repo, mathaDir)
    const before = await fs.stat(path.join(mathaDir, 'cortex', 'stability.json'))

    const snap = await refreshFromGit(repo, mathaDir)
    expect(snap.newCommits).toBe(0)
    expect(snap.commitCount).toBe(2)

    const after = await fs.stat(path.join(mathaDir, 'cortex', 'stability.json'))
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('deleted files are pruned from state, stability, and co-changes', async () => {
    // make a+b co-change so a pair exists
    await fs.writeFile(path.join(repo, 'src/a.ts'), 'a2')
    await fs.writeFile(path.join(repo, 'src/b.ts'), 'b2')
    sh('git add -A && git commit -qm both')
    sh('git rm -q src/b.ts && git commit -qm "drop b"')

    const snap = await refreshFromGit(repo, mathaDir)
    const state = await readState()
    expect(state.files['src/b.ts']).toBeUndefined()
    expect(Object.keys(state.coChangeCounts).some((k) => k.includes('src/b.ts'))).toBe(false)
    expect(snap.stability.some((r) => r.filepath === 'src/b.ts')).toBe(false)
    expect(snap.stability.some((r) => r.filepath === 'src/a.ts')).toBe(true)
  })

  it('a cursor invalidated by rebase falls back to a full rescan, never throws', async () => {
    await refreshFromGit(repo, mathaDir)

    // simulate rebase/force-push: cursor hash no longer exists
    const state = await readState()
    state.newestHash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    await fs.writeFile(
      path.join(mathaDir, 'cortex', 'analysis.json'),
      JSON.stringify(state),
    )

    const snap = await refreshFromGit(repo, mathaDir)
    expect(snap.commitCount).toBe(2) // full rescan result, not merged garbage
    const healed = await readState()
    const head = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
    expect(healed.newestHash).toBe(head)
  })

  it('declared stability records survive incremental refreshes', async () => {
    await refreshFromGit(repo, mathaDir)
    await overrideStability(mathaDir, 'src/a.ts', 'frozen', 'core file', 'admin')
    await commitFile('src/c.ts', 'c1', 'five')

    const snap = await refreshFromGit(repo, mathaDir)
    const a = snap.stability.find((r) => r.filepath === 'src/a.ts')
    expect(a?.stability).toBe('frozen')
    expect(a?.classificationSource).toBe('declared')
  })
})
