import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { appendToArray, mergeObject, writeAtomic } from '../../src/storage/writer'

describe('writer', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // ── writeAtomic ──────────────────────────────────────────────────

  describe('writeAtomic', () => {
    it('writes valid JSON to a new file', async () => {
      const filePath = path.join(tmpDir, 'test.json')
      const data = { key: 'value', num: 42 }
      await writeAtomic(filePath, data)
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content).toEqual(data)
    })

    it('creates parent directories if they do not exist', async () => {
      const filePath = path.join(tmpDir, 'a', 'b', 'c', 'deep.json')
      await writeAtomic(filePath, { deep: true })
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content).toEqual({ deep: true })
    })

    it('does not leave temp files after successful write', async () => {
      const filePath = path.join(tmpDir, 'clean.json')
      await writeAtomic(filePath, { clean: true })
      const files = await fs.readdir(tmpDir)
      const tmpFiles = files.filter(f => f.endsWith('.tmp'))
      expect(tmpFiles).toHaveLength(0)
    })

    it('does not overwrite an existing file without overwrite flag', async () => {
      const filePath = path.join(tmpDir, 'existing.json')
      await fs.writeFile(filePath, JSON.stringify({ original: true }), 'utf-8')

      await expect(writeAtomic(filePath, { replaced: true })).rejects.toThrow()

      // original content must be untouched
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content).toEqual({ original: true })
    })

    it('overwrites an existing file when overwrite flag is true', async () => {
      const filePath = path.join(tmpDir, 'overwrite.json')
      await fs.writeFile(filePath, JSON.stringify({ original: true }), 'utf-8')

      await writeAtomic(filePath, { replaced: true }, { overwrite: true })
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content).toEqual({ replaced: true })
    })

    it('rejects non-JSON-serializable data (circular reference)', async () => {
      const filePath = path.join(tmpDir, 'circular.json')
      const circular: any = {}
      circular.self = circular
      await expect(writeAtomic(filePath, circular)).rejects.toThrow()
    })

    it('rejects undefined as top-level data', async () => {
      const filePath = path.join(tmpDir, 'undef.json')
      await expect(writeAtomic(filePath, undefined)).rejects.toThrow()
    })

    it('does not leave temp files after failed validation', async () => {
      const filePath = path.join(tmpDir, 'fail.json')
      const circular: any = {}
      circular.self = circular
      try { await writeAtomic(filePath, circular) } catch { /* expected */ }

      const files = await fs.readdir(tmpDir)
      const tmpFiles = files.filter(f => f.endsWith('.tmp'))
      expect(tmpFiles).toHaveLength(0)
    })
  })

  // ── appendToArray ────────────────────────────────────────────────

  describe('appendToArray', () => {
    it('creates a new file with the item wrapped in an array when file does not exist', async () => {
      const filePath = path.join(tmpDir, 'arr.json')
      await appendToArray(filePath, { id: 1 })
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content).toEqual([{ id: 1 }])
    })

    it('appends item to an existing JSON array', async () => {
      const filePath = path.join(tmpDir, 'arr.json')
      await fs.writeFile(filePath, JSON.stringify([{ id: 1 }]), 'utf-8')
      await appendToArray(filePath, { id: 2 })
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content).toEqual([{ id: 1 }, { id: 2 }])
    })

    it('rejects if existing file contains a non-array', async () => {
      const filePath = path.join(tmpDir, 'obj.json')
      await fs.writeFile(filePath, JSON.stringify({ not: 'array' }), 'utf-8')
      await expect(appendToArray(filePath, { id: 1 })).rejects.toThrow()
    })

    it('does not leave temp files after append', async () => {
      const filePath = path.join(tmpDir, 'arr-clean.json')
      await appendToArray(filePath, { id: 1 })
      const files = await fs.readdir(tmpDir)
      const tmpFiles = files.filter(f => f.endsWith('.tmp'))
      expect(tmpFiles).toHaveLength(0)
    })

    it('creates parent directories if they do not exist', async () => {
      const filePath = path.join(tmpDir, 'sub', 'dir', 'arr.json')
      await appendToArray(filePath, 'item')
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content).toEqual(['item'])
    })
  })

  // ── mergeObject ──────────────────────────────────────────────────

  describe('mergeObject', () => {
    it('creates a new file with the object when file does not exist', async () => {
      const filePath = path.join(tmpDir, 'obj.json')
      await mergeObject(filePath, { key: 'value' })
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content).toEqual({ key: 'value' })
    })

    it('shallow-merges into an existing JSON object', async () => {
      const filePath = path.join(tmpDir, 'obj.json')
      await fs.writeFile(filePath, JSON.stringify({ a: 1, b: 2 }), 'utf-8')
      await mergeObject(filePath, { b: 99, c: 3 })
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content).toEqual({ a: 1, b: 99, c: 3 })
    })

    it('rejects if existing file contains an array', async () => {
      const filePath = path.join(tmpDir, 'arr.json')
      await fs.writeFile(filePath, JSON.stringify([1, 2, 3]), 'utf-8')
      await expect(mergeObject(filePath, { key: 'value' })).rejects.toThrow()
    })

    it('rejects if existing file contains a primitive', async () => {
      const filePath = path.join(tmpDir, 'str.json')
      await fs.writeFile(filePath, JSON.stringify('just a string'), 'utf-8')
      await expect(mergeObject(filePath, { key: 'value' })).rejects.toThrow()
    })

    it('does not leave temp files after merge', async () => {
      const filePath = path.join(tmpDir, 'obj-clean.json')
      await mergeObject(filePath, { key: 'value' })
      const files = await fs.readdir(tmpDir)
      const tmpFiles = files.filter(f => f.endsWith('.tmp'))
      expect(tmpFiles).toHaveLength(0)
    })

    it('creates parent directories if they do not exist', async () => {
      const filePath = path.join(tmpDir, 'sub', 'dir', 'obj.json')
      await mergeObject(filePath, { deep: true })
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content).toEqual({ deep: true })
    })
  })
})