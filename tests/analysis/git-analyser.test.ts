import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { simpleGit } from 'simple-git'
import { analyseRepository } from '../../src/analysis/git-analyser.js'

// Helper: create a temp git repo and return its path
async function createTempRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-git-test-'))
  const git = simpleGit(tmpDir)
  await git.init()
  await git.addConfig('user.email', 'test@matha.dev')
  await git.addConfig('user.name', 'Test User')
  return tmpDir
}

// Helper: write a file and commit
async function commitFile(
  repoPath: string,
  filepath: string,
  content: string,
  message: string,
  author?: string,
): Promise<void> {
  const fullPath = path.join(repoPath, filepath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, content)
  const git = simpleGit(repoPath)
  await git.add(filepath)
  if (author) {
    await git.commit(message, undefined, { '--author': `${author} <${author}@test.dev>` })
  } else {
    await git.commit(message)
  }
}

// Helper: commit multiple files at once
async function commitFiles(
  repoPath: string,
  files: Array<{ path: string; content: string }>,
  message: string,
): Promise<void> {
  const git = simpleGit(repoPath)
  for (const f of files) {
    const fullPath = path.join(repoPath, f.path)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, f.content)
    await git.add(f.path)
  }
  await git.commit(message)
}

describe('git-analyser', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempRepo()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // ──────────────────────────────────────────────────────────────
  // NON-GIT DIRECTORY
  // ──────────────────────────────────────────────────────────────

  it('non-git directory → returns empty result, no throw', async () => {
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-nogit-'))
    try {
      const result = await analyseRepository(plainDir)
      expect(result.commitCount).toBe(0)
      expect(result.fileCount).toBe(0)
      expect(result.files).toEqual([])
      expect(result.coChanges).toEqual([])
    } finally {
      await fs.rm(plainDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────
  // EMPTY REPO (no commits)
  // ──────────────────────────────────────────────────────────────

  it('empty repo (no commits) → returns empty result, no throw', async () => {
    const result = await analyseRepository(tmpDir)
    expect(result.commitCount).toBe(0)
    expect(result.fileCount).toBe(0)
    expect(result.files).toEqual([])
    expect(result.coChanges).toEqual([])
  })

  // ──────────────────────────────────────────────────────────────
  // SINGLE COMMIT, SINGLE FILE
  // ──────────────────────────────────────────────────────────────

  it('single commit, single file → correct FileChangeRecord', async () => {
    await commitFile(tmpDir, 'src/app.ts', 'console.log("hi")', 'initial')

    const result = await analyseRepository(tmpDir)

    expect(result.commitCount).toBe(1)
    expect(result.fileCount).toBe(1)
    expect(result.files).toHaveLength(1)

    const file = result.files[0]
    expect(file.filepath).toBe('src/app.ts')
    expect(file.changeCount).toBe(1)
    expect(file.authors).toContain('Test User')
    expect(file.lastChanged).toBeTruthy()
    expect(file.firstSeen).toBeTruthy()
    // ISO8601 check
    expect(new Date(file.lastChanged).toISOString()).toBe(file.lastChanged)
  })

  // ──────────────────────────────────────────────────────────────
  // MULTIPLE COMMITS, SAME FILE
  // ──────────────────────────────────────────────────────────────

  it('multiple commits, same file → changeCount accumulates correctly', async () => {
    await commitFile(tmpDir, 'index.ts', 'v1', 'first')
    await commitFile(tmpDir, 'index.ts', 'v2', 'second')
    await commitFile(tmpDir, 'index.ts', 'v3', 'third')

    const result = await analyseRepository(tmpDir)

    expect(result.commitCount).toBe(3)
    expect(result.fileCount).toBe(1)

    const file = result.files[0]
    expect(file.filepath).toBe('index.ts')
    expect(file.changeCount).toBe(3)
    // firstSeen should be earlier than lastChanged
    expect(new Date(file.firstSeen).getTime()).toBeLessThanOrEqual(
      new Date(file.lastChanged).getTime(),
    )
  })

  // ──────────────────────────────────────────────────────────────
  // CO-CHANGE DETECTION
  // ──────────────────────────────────────────────────────────────

  it('co-change detection → files changed together show in coChangedWith', async () => {
    // Commit 1: a.ts + b.ts together
    await commitFiles(tmpDir, [
      { path: 'a.ts', content: 'a1' },
      { path: 'b.ts', content: 'b1' },
    ], 'commit1')

    // Commit 2: a.ts + b.ts together again
    await commitFiles(tmpDir, [
      { path: 'a.ts', content: 'a2' },
      { path: 'b.ts', content: 'b2' },
    ], 'commit2')

    // Commit 3: a.ts alone
    await commitFile(tmpDir, 'a.ts', 'a3', 'commit3')

    const result = await analyseRepository(tmpDir)

    // a.ts changed 3x, b.ts changed 2x
    const fileA = result.files.find(f => f.filepath === 'a.ts')
    const fileB = result.files.find(f => f.filepath === 'b.ts')
    expect(fileA).toBeDefined()
    expect(fileB).toBeDefined()
    expect(fileA!.changeCount).toBe(3)
    expect(fileB!.changeCount).toBe(2)

    // a and b co-changed in 2 commits
    expect(fileA!.coChangedWith).toContain('b.ts')
    expect(fileB!.coChangedWith).toContain('a.ts')

    // coChanges array should have the pair
    const pair = result.coChanges.find(
      c => (c.fileA === 'a.ts' && c.fileB === 'b.ts') ||
           (c.fileA === 'b.ts' && c.fileB === 'a.ts'),
    )
    expect(pair).toBeDefined()
    expect(pair!.coChangeCount).toBe(2)
  })

  // ──────────────────────────────────────────────────────────────
  // COCHANGE PAIRS WITH COUNT 1 EXCLUDED
  // ──────────────────────────────────────────────────────────────

  it('co-change pairs with count of 1 are excluded', async () => {
    // Only one commit with x.ts + y.ts
    await commitFiles(tmpDir, [
      { path: 'x.ts', content: 'x' },
      { path: 'y.ts', content: 'y' },
    ], 'once')

    const result = await analyseRepository(tmpDir)

    // Pair only co-changed once — should not appear in coChanges
    expect(result.coChanges).toHaveLength(0)
  })

  // ──────────────────────────────────────────────────────────────
  // EXCLUDE PATHS
  // ──────────────────────────────────────────────────────────────

  it('excludePaths → node_modules files never appear in results', async () => {
    await commitFiles(tmpDir, [
      { path: 'src/app.ts', content: 'app' },
      { path: 'node_modules/pkg/index.js', content: 'pkg' },
    ], 'mixed')

    const result = await analyseRepository(tmpDir)

    expect(result.files.some(f => f.filepath.includes('node_modules'))).toBe(false)
    expect(result.files.some(f => f.filepath === 'src/app.ts')).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────
  // BINARY FILES
  // ──────────────────────────────────────────────────────────────

  it('binary files → .png files never appear in results', async () => {
    await commitFiles(tmpDir, [
      { path: 'src/app.ts', content: 'app' },
      { path: 'assets/logo.png', content: 'fake-binary' },
    ], 'with binary')

    const result = await analyseRepository(tmpDir)

    expect(result.files.some(f => f.filepath.includes('.png'))).toBe(false)
    expect(result.files.some(f => f.filepath === 'src/app.ts')).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────
  // MAX COMMITS CAP
  // ──────────────────────────────────────────────────────────────

  it('maxCommits cap → only analyses up to cap', async () => {
    // Create 5 commits
    for (let i = 0; i < 5; i++) {
      await commitFile(tmpDir, 'counter.ts', `v${i}`, `commit ${i}`)
    }

    const result = await analyseRepository(tmpDir, { maxCommits: 3 })

    // Should only see 3 commits worth of data
    expect(result.commitCount).toBe(3)
  })

  // ──────────────────────────────────────────────────────────────
  // PATH NORMALISATION
  // ──────────────────────────────────────────────────────────────

  it('path normalisation → all paths use forward slashes', async () => {
    await commitFile(tmpDir, 'src/deep/nested/file.ts', 'content', 'nested')

    const result = await analyseRepository(tmpDir)

    for (const file of result.files) {
      expect(file.filepath).not.toContain('\\')
    }
    expect(result.files[0].filepath).toBe('src/deep/nested/file.ts')
  })

  // ──────────────────────────────────────────────────────────────
  // MULTIPLE AUTHORS
  // ──────────────────────────────────────────────────────────────

  it('multiple authors → authors array has unique entries', async () => {
    await commitFile(tmpDir, 'shared.ts', 'v1', 'alice writes', 'Alice')
    await commitFile(tmpDir, 'shared.ts', 'v2', 'bob writes', 'Bob')
    await commitFile(tmpDir, 'shared.ts', 'v3', 'alice again', 'Alice')

    const result = await analyseRepository(tmpDir)
    const file = result.files.find(f => f.filepath === 'shared.ts')

    expect(file).toBeDefined()
    expect(file!.authors).toContain('Alice')
    expect(file!.authors).toContain('Bob')
    expect(file!.authors).toHaveLength(2)
  })

  // ──────────────────────────────────────────────────────────────
  // coChangedWith MAX 5
  // ──────────────────────────────────────────────────────────────

  it('coChangedWith contains max 5 entries per file', async () => {
    // Create commits that co-change 7 files with a target file
    const files = Array.from({ length: 7 }, (_, i) => ({
      path: `f${i}.ts`,
      content: `f${i}`,
    }))

    // Commit all 8 files together twice (to pass the coChange min of 2)
    await commitFiles(tmpDir, [
      { path: 'target.ts', content: 'v1' },
      ...files,
    ], 'batch1')

    await commitFiles(tmpDir, [
      { path: 'target.ts', content: 'v2' },
      ...files.map(f => ({ ...f, content: f.content + '2' })),
    ], 'batch2')

    const result = await analyseRepository(tmpDir)
    const target = result.files.find(f => f.filepath === 'target.ts')

    expect(target).toBeDefined()
    expect(target!.coChangedWith.length).toBeLessThanOrEqual(5)
  })

  // ──────────────────────────────────────────────────────────────
  // TIMESTAMPS
  // ──────────────────────────────────────────────────────────────

  it('all timestamps are valid ISO8601 strings', async () => {
    await commitFile(tmpDir, 'a.ts', 'v1', 'first')
    await commitFile(tmpDir, 'a.ts', 'v2', 'second')

    const result = await analyseRepository(tmpDir)

    expect(result.analysedAt).toBeTruthy()
    expect(new Date(result.analysedAt).toISOString()).toBe(result.analysedAt)
    expect(new Date(result.oldestCommit).toISOString()).toBe(result.oldestCommit)
    expect(new Date(result.newestCommit).toISOString()).toBe(result.newestCommit)

    for (const file of result.files) {
      expect(new Date(file.lastChanged).toISOString()).toBe(file.lastChanged)
      expect(new Date(file.firstSeen).toISOString()).toBe(file.firstSeen)
    }
  })

  // ──────────────────────────────────────────────────────────────
  // REAL REPO INTEGRATION
  // ──────────────────────────────────────────────────────────────

  it('analyseRepository works on real repo (MATHA itself)', async () => {
    const result = await analyseRepository(process.cwd(), { maxCommits: 20 })

    // MATHA repo should have commits
    expect(result.commitCount).toBeGreaterThan(0)
    expect(result.fileCount).toBeGreaterThan(0)
    expect(result.files.length).toBeGreaterThan(0)
    expect(result.analysedAt).toBeTruthy()
    expect(result.oldestCommit).toBeTruthy()
    expect(result.newestCommit).toBeTruthy()

    // No excluded paths should appear
    for (const file of result.files) {
      expect(file.filepath.startsWith('node_modules/')).toBe(false)
      expect(file.filepath.startsWith('.git/')).toBe(false)
    }
  })

  // ──────────────────────────────────────────────────────────────
  // SINCE OPTION
  // ──────────────────────────────────────────────────────────────

  it('since option filters commits by date', async () => {
    await commitFile(tmpDir, 'old.ts', 'v1', 'old commit')

    // Add a small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 1100))
    const cutoff = new Date().toISOString()
    await new Promise(r => setTimeout(r, 100))

    await commitFile(tmpDir, 'new.ts', 'v1', 'new commit')

    const result = await analyseRepository(tmpDir, { since: cutoff })

    // Should only see the newer commit
    expect(result.commitCount).toBe(1)
    expect(result.files.some(f => f.filepath === 'new.ts')).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────
  // CUSTOM EXCLUDE PATHS
  // ──────────────────────────────────────────────────────────────

  it('custom excludePaths filters additional directories', async () => {
    await commitFiles(tmpDir, [
      { path: 'src/app.ts', content: 'app' },
      { path: 'vendor/lib.js', content: 'lib' },
    ], 'mixed')

    const result = await analyseRepository(tmpDir, {
      excludePaths: ['vendor', 'node_modules'],
    })

    expect(result.files.some(f => f.filepath.includes('vendor'))).toBe(false)
    expect(result.files.some(f => f.filepath === 'src/app.ts')).toBe(true)
  })
})
