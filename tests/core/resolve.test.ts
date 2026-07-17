import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { resolveBrainDir, BrainNotFoundError } from '../../src/core/resolve.js'

describe('resolveBrainDir', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-resolve-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function makeBrain(root: string): Promise<string> {
    const mathaDir = path.join(root, '.matha')
    await fs.mkdir(mathaDir, { recursive: true })
    return mathaDir
  }

  it('explicit root with .matha → resolves with source explicit', async () => {
    const mathaDir = await makeBrain(tmpDir)
    const result = await resolveBrainDir({ explicitRoot: tmpDir })
    expect(result.mathaDir).toBe(mathaDir)
    expect(result.projectRoot).toBe(tmpDir)
    expect(result.source).toBe('explicit')
  })

  it('explicit root WITHOUT .matha → throws, does not fall through to cwd', async () => {
    // cwd has a brain that would match if we (wrongly) fell through
    await makeBrain(process.cwd())
    const bare = path.join(tmpDir, 'bare')
    await fs.mkdir(bare)
    await expect(resolveBrainDir({ explicitRoot: bare })).rejects.toThrow(BrainNotFoundError)
  })

  it('explicit root failure NEVER creates a .matha directory (0.1.x regression)', async () => {
    const bare = path.join(tmpDir, 'bare')
    await fs.mkdir(bare)
    await expect(resolveBrainDir({ explicitRoot: bare })).rejects.toThrow()
    await expect(fs.access(path.join(bare, '.matha'))).rejects.toThrow()
  })

  it('walks up from a filepath to find the brain', async () => {
    const mathaDir = await makeBrain(tmpDir)
    const deep = path.join(tmpDir, 'src', 'payments')
    await fs.mkdir(deep, { recursive: true })
    const file = path.join(deep, 'retry.ts')
    await fs.writeFile(file, '// x')

    const result = await resolveBrainDir({ filepaths: [file], cwd: os.tmpdir() })
    expect(result.mathaDir).toBe(mathaDir)
    expect(result.source).toBe('filepaths')
  })

  it('ignores non-existent and relative filepaths', async () => {
    const mathaDir = await makeBrain(tmpDir)
    const result = await resolveBrainDir({
      filepaths: ['relative/path.ts', path.join(tmpDir, 'no-such-file.ts')],
      cwd: tmpDir,
    })
    // falls through to cwd resolution
    expect(result.mathaDir).toBe(mathaDir)
    expect(result.source).toBe('cwd')
  })

  it('walks up from cwd', async () => {
    const mathaDir = await makeBrain(tmpDir)
    const deep = path.join(tmpDir, 'a', 'b', 'c')
    await fs.mkdir(deep, { recursive: true })
    const result = await resolveBrainDir({ cwd: deep })
    expect(result.mathaDir).toBe(mathaDir)
    expect(result.source).toBe('cwd')
  })

  it('error lists every tried path', async () => {
    const deep = path.join(tmpDir, 'a', 'b')
    await fs.mkdir(deep, { recursive: true })
    try {
      await resolveBrainDir({ cwd: deep })
      // If the temp dir's ancestors contain a .matha this test cannot assert;
      // os.tmpdir() ancestors normally do not.
      expect.unreachable('should have thrown')
    } catch (err: any) {
      expect(err).toBeInstanceOf(BrainNotFoundError)
      expect(err.tried).toContain(path.join(deep, '.matha'))
      expect(err.tried).toContain(path.join(tmpDir, '.matha'))
      expect(err.message).toContain('matha init')
    }
  })
})
