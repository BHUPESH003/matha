import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readJson, readJsonOrNull } from '@/storage/reader.js'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('reader', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // ── readJson ─────────────────────────────────────────────────────

  describe('readJson', () => {
    it('reads and parses a valid JSON object', async () => {
      const filePath = path.join(tmpDir, 'obj.json')
      await fs.writeFile(filePath, JSON.stringify({ hello: 'world' }), 'utf-8')
      const result = await readJson(filePath)
      expect(result).toEqual({ hello: 'world' })
    })

    it('reads and parses a valid JSON array', async () => {
      const filePath = path.join(tmpDir, 'arr.json')
      await fs.writeFile(filePath, JSON.stringify([1, 2, 3]), 'utf-8')
      const result = await readJson(filePath)
      expect(result).toEqual([1, 2, 3])
    })

    it('throws on missing file', async () => {
      const filePath = path.join(tmpDir, 'missing.json')
      await expect(readJson(filePath)).rejects.toThrow()
    })

    it('throws on invalid JSON', async () => {
      const filePath = path.join(tmpDir, 'invalid.json')
      await fs.writeFile(filePath, '{not valid json!!!', 'utf-8')
      await expect(readJson(filePath)).rejects.toThrow()
    })
  })

  // ── readJsonOrNull ───────────────────────────────────────────────

  describe('readJsonOrNull', () => {
    it('returns parsed JSON for an existing file', async () => {
      const filePath = path.join(tmpDir, 'exists.json')
      await fs.writeFile(filePath, JSON.stringify({ data: 42 }), 'utf-8')
      const result = await readJsonOrNull(filePath)
      expect(result).toEqual({ data: 42 })
    })

    it('returns null if file does not exist', async () => {
      const filePath = path.join(tmpDir, 'nope.json')
      const result = await readJsonOrNull(filePath)
      expect(result).toBeNull()
    })

    it('returns null for a deeply nested missing path', async () => {
      const filePath = path.join(tmpDir, 'a', 'b', 'c', 'missing.json')
      const result = await readJsonOrNull(filePath)
      expect(result).toBeNull()
    })

    it('throws on invalid JSON content (not a missing-file issue)', async () => {
      const filePath = path.join(tmpDir, 'bad.json')
      await fs.writeFile(filePath, '{{garbage}}', 'utf-8')
      await expect(readJsonOrNull(filePath)).rejects.toThrow()
    })
  })
})