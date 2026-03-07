import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { simpleGit } from 'simple-git'
import {
  refreshFromGit,
  getStability,
  overrideStability,
  getCoChanges,
  getSnapshot,
} from '../../src/brain/cortex.js'

// ──────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'matha-cortex-test-'))
}

async function createMathaDir(base: string): Promise<string> {
  const mathaDir = path.join(base, '.matha')
  await fs.mkdir(path.join(mathaDir, 'cortex'), { recursive: true })
  return mathaDir
}

async function createTempRepo(): Promise<string> {
  const tmpDir = await createTempDir()
  const git = simpleGit(tmpDir)
  await git.init()
  await git.addConfig('user.email', 'test@matha.dev')
  await git.addConfig('user.name', 'Test User')
  return tmpDir
}

async function commitFile(
  repoPath: string,
  filepath: string,
  content: string,
  message: string,
): Promise<void> {
  const fullPath = path.join(repoPath, filepath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, content)
  const git = simpleGit(repoPath)
  await git.add(filepath)
  await git.commit(message)
}

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

async function readJsonFile<T>(filepath: string): Promise<T> {
  const raw = await fs.readFile(filepath, 'utf-8')
  return JSON.parse(raw) as T
}

describe('cortex', () => {
  let tmpDir: string

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────
  // refreshFromGit
  // ──────────────────────────────────────────────────────────────

  it('refreshFromGit on non-git dir → empty snapshot, no throw', async () => {
    tmpDir = await createTempDir()
    const mathaDir = await createMathaDir(tmpDir)

    const snapshot = await refreshFromGit(tmpDir, mathaDir)

    expect(snapshot.commitCount).toBe(0)
    expect(snapshot.fileCount).toBe(0)
    expect(snapshot.stability).toEqual([])
    expect(snapshot.coChanges).toEqual([])
  })

  it('refreshFromGit on real repo → stability.json written correctly', async () => {
    tmpDir = await createTempRepo()
    const mathaDir = await createMathaDir(tmpDir)

    await commitFile(tmpDir, 'src/app.ts', 'v1', 'initial')
    await commitFile(tmpDir, 'src/app.ts', 'v2', 'update')

    const snapshot = await refreshFromGit(tmpDir, mathaDir)

    expect(snapshot.commitCount).toBe(2)
    expect(snapshot.fileCount).toBeGreaterThan(0)
    expect(snapshot.stability.length).toBeGreaterThan(0)

    // Verify file was written
    const stabilityPath = path.join(mathaDir, 'cortex', 'stability.json')
    const written = await readJsonFile<any[]>(stabilityPath)
    expect(Array.isArray(written)).toBe(true)
    expect(written.length).toBeGreaterThan(0)
  })

  it('refreshFromGit preserves declared records (declared-wins invariant)', async () => {
    tmpDir = await createTempRepo()
    const mathaDir = await createMathaDir(tmpDir)

    await commitFile(tmpDir, 'src/core.ts', 'v1', 'initial')

    // First refresh → derives classification
    await refreshFromGit(tmpDir, mathaDir)

    // Override to declared
    await overrideStability(mathaDir, 'src/core.ts', 'frozen', 'Critical business logic', 'bhupesh')

    // Verify it's declared
    const beforeRefresh = await getStability(mathaDir, ['src/core.ts'])
    expect(beforeRefresh['src/core.ts']?.classificationSource).toBe('declared')
    expect(beforeRefresh['src/core.ts']?.stability).toBe('frozen')

    // Run refresh again — declared must survive
    await commitFile(tmpDir, 'src/core.ts', 'v2', 'update')
    await refreshFromGit(tmpDir, mathaDir)

    const afterRefresh = await getStability(mathaDir, ['src/core.ts'])
    expect(afterRefresh['src/core.ts']?.classificationSource).toBe('declared')
    expect(afterRefresh['src/core.ts']?.stability).toBe('frozen')
    expect(afterRefresh['src/core.ts']?.reason).toBe('Critical business logic')
  })

  it('refreshFromGit updates lastDerivedAt on declared records', async () => {
    tmpDir = await createTempRepo()
    const mathaDir = await createMathaDir(tmpDir)

    await commitFile(tmpDir, 'src/core.ts', 'v1', 'initial')
    await refreshFromGit(tmpDir, mathaDir)

    // Override
    await overrideStability(mathaDir, 'src/core.ts', 'frozen', 'Critical', 'bhupesh')

    // Wait briefly and refresh again
    await commitFile(tmpDir, 'src/core.ts', 'v2', 'update')
    const snapshot = await refreshFromGit(tmpDir, mathaDir)

    const record = snapshot.stability.find(s => s.filepath === 'src/core.ts')
    expect(record).toBeDefined()
    expect(record!.lastDerivedAt).toBeTruthy()
  })

  // ──────────────────────────────────────────────────────────────
  // getStability
  // ──────────────────────────────────────────────────────────────

  it('getStability for known file → returns correct record', async () => {
    tmpDir = await createTempRepo()
    const mathaDir = await createMathaDir(tmpDir)

    await commitFile(tmpDir, 'src/app.ts', 'v1', 'initial')
    await refreshFromGit(tmpDir, mathaDir)

    const result = await getStability(mathaDir, ['src/app.ts'])
    expect(result['src/app.ts']).toBeDefined()
    expect(result['src/app.ts']!.filepath).toBe('src/app.ts')
    expect(result['src/app.ts']!.stability).toBeTruthy()
  })

  it('getStability for unknown file → returns null', async () => {
    tmpDir = await createTempRepo()
    const mathaDir = await createMathaDir(tmpDir)

    await commitFile(tmpDir, 'src/app.ts', 'v1', 'initial')
    await refreshFromGit(tmpDir, mathaDir)

    const result = await getStability(mathaDir, ['nonexistent.ts'])
    expect(result['nonexistent.ts']).toBeNull()
  })

  // ──────────────────────────────────────────────────────────────
  // overrideStability
  // ──────────────────────────────────────────────────────────────

  it('overrideStability on existing file → updates to declared', async () => {
    tmpDir = await createTempRepo()
    const mathaDir = await createMathaDir(tmpDir)

    await commitFile(tmpDir, 'src/app.ts', 'v1', 'initial')
    await refreshFromGit(tmpDir, mathaDir)

    await overrideStability(mathaDir, 'src/app.ts', 'frozen', 'Core module', 'bhupesh')

    const result = await getStability(mathaDir, ['src/app.ts'])
    expect(result['src/app.ts']!.classificationSource).toBe('declared')
    expect(result['src/app.ts']!.stability).toBe('frozen')
    expect(result['src/app.ts']!.reason).toBe('Core module')
  })

  it('overrideStability on unknown file → creates minimal declared record', async () => {
    tmpDir = await createTempDir()
    const mathaDir = await createMathaDir(tmpDir)

    await overrideStability(mathaDir, 'src/new-file.ts', 'volatile', 'Under active dev', 'alice')

    const result = await getStability(mathaDir, ['src/new-file.ts'])
    expect(result['src/new-file.ts']).toBeDefined()
    expect(result['src/new-file.ts']!.classificationSource).toBe('declared')
    expect(result['src/new-file.ts']!.stability).toBe('volatile')
    expect(result['src/new-file.ts']!.changeCount).toBe(0)
  })

  it('overrideStability sets declaredBy and declaredAt correctly', async () => {
    tmpDir = await createTempDir()
    const mathaDir = await createMathaDir(tmpDir)

    const beforeTime = new Date().toISOString()
    await overrideStability(mathaDir, 'src/file.ts', 'frozen', 'Reason', 'bob')

    const result = await getStability(mathaDir, ['src/file.ts'])
    const record = result['src/file.ts']!

    expect(record.declaredBy).toBe('bob')
    expect(record.declaredAt).toBeTruthy()
    expect(new Date(record.declaredAt!).toISOString()).toBe(record.declaredAt)
    expect(record.declaredAt! >= beforeTime).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────
  // getCoChanges
  // ──────────────────────────────────────────────────────────────

  it('getCoChanges with no filepath → returns all pairs', async () => {
    tmpDir = await createTempRepo()
    const mathaDir = await createMathaDir(tmpDir)

    // Create commits with co-changes
    await commitFiles(tmpDir, [
      { path: 'a.ts', content: 'a1' },
      { path: 'b.ts', content: 'b1' },
    ], 'commit1')
    await commitFiles(tmpDir, [
      { path: 'a.ts', content: 'a2' },
      { path: 'b.ts', content: 'b2' },
    ], 'commit2')

    await refreshFromGit(tmpDir, mathaDir)
    const pairs = await getCoChanges(mathaDir)

    expect(Array.isArray(pairs)).toBe(true)
    // a.ts and b.ts co-changed 2 times → should appear
    expect(pairs.length).toBeGreaterThan(0)
  })

  it('getCoChanges with filepath → filters correctly', async () => {
    tmpDir = await createTempRepo()
    const mathaDir = await createMathaDir(tmpDir)

    await commitFiles(tmpDir, [
      { path: 'a.ts', content: 'a1' },
      { path: 'b.ts', content: 'b1' },
      { path: 'c.ts', content: 'c1' },
    ], 'commit1')
    await commitFiles(tmpDir, [
      { path: 'a.ts', content: 'a2' },
      { path: 'b.ts', content: 'b2' },
      { path: 'c.ts', content: 'c2' },
    ], 'commit2')

    await refreshFromGit(tmpDir, mathaDir)
    const pairs = await getCoChanges(mathaDir, 'a.ts')

    for (const pair of pairs) {
      expect(pair.fileA === 'a.ts' || pair.fileB === 'a.ts').toBe(true)
    }
  })

  it('getCoChanges missing file → returns empty array', async () => {
    tmpDir = await createTempDir()
    const mathaDir = await createMathaDir(tmpDir)

    const pairs = await getCoChanges(mathaDir)
    expect(pairs).toEqual([])
  })

  // ──────────────────────────────────────────────────────────────
  // getSnapshot
  // ──────────────────────────────────────────────────────────────

  it('getSnapshot with no stability.json → returns null', async () => {
    tmpDir = await createTempDir()
    const mathaDir = await createMathaDir(tmpDir)

    const snapshot = await getSnapshot(mathaDir)
    expect(snapshot).toBeNull()
  })

  it('getSnapshot with data → assembles correct CortexSnapshot', async () => {
    tmpDir = await createTempRepo()
    const mathaDir = await createMathaDir(tmpDir)

    await commitFile(tmpDir, 'src/app.ts', 'v1', 'initial')
    await refreshFromGit(tmpDir, mathaDir)

    const snapshot = await getSnapshot(mathaDir)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.stability.length).toBeGreaterThan(0)
    expect(snapshot!.updatedAt).toBeTruthy()
    expect(snapshot!.fileCount).toBe(snapshot!.stability.length)
  })

  // ──────────────────────────────────────────────────────────────
  // SUMMARY COUNTS
  // ──────────────────────────────────────────────────────────────

  it('summary.declared count is accurate', async () => {
    tmpDir = await createTempRepo()
    const mathaDir = await createMathaDir(tmpDir)

    await commitFile(tmpDir, 'src/a.ts', 'v1', 'init a')
    await commitFile(tmpDir, 'src/b.ts', 'v1', 'init b')
    await refreshFromGit(tmpDir, mathaDir)

    // Override one file
    await overrideStability(mathaDir, 'src/a.ts', 'frozen', 'Core', 'owner')

    const snapshot = await getSnapshot(mathaDir)
    expect(snapshot!.summary.declared).toBe(1)
  })

  // ──────────────────────────────────────────────────────────────
  // FILEPATH NORMALISATION
  // ──────────────────────────────────────────────────────────────

  it('filepath normalisation: backslash input → forward slash stored', async () => {
    tmpDir = await createTempDir()
    const mathaDir = await createMathaDir(tmpDir)

    // Use backslash path
    await overrideStability(mathaDir, 'src\\core\\engine.ts', 'frozen', 'Core', 'dev')

    const result = await getStability(mathaDir, ['src/core/engine.ts'])
    expect(result['src/core/engine.ts']).toBeDefined()
    expect(result['src/core/engine.ts']!.filepath).toBe('src/core/engine.ts')
  })
})
