import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  CURRENT_SCHEMA_VERSION,
  checkSchemaVersion,
  getSchemaMessage,
} from '../../src/utils/schema-version.js'

describe('schema-version', () => {
  let tmpDir: string
  let mathaDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-schema-test-'))
    mathaDir = path.join(tmpDir, '.matha')
    await fs.mkdir(mathaDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // ──────────────────────────────────────────────────────────────
  // CURRENT_SCHEMA_VERSION
  // ──────────────────────────────────────────────────────────────

  it('CURRENT_SCHEMA_VERSION is a valid semver string', () => {
    expect(CURRENT_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(CURRENT_SCHEMA_VERSION).toBe('0.1.0')
  })

  // ──────────────────────────────────────────────────────────────
  // checkSchemaVersion
  // ──────────────────────────────────────────────────────────────

  it('missing config.json → returns uninitialised', async () => {
    const result = await checkSchemaVersion(mathaDir)
    expect(result.status).toBe('uninitialised')
    expect(result.version).toBeNull()
  })

  it('config.json with no schema_version → returns legacy', async () => {
    await fs.writeFile(
      path.join(mathaDir, 'config.json'),
      JSON.stringify({ version: '0.1.0', project_root: tmpDir }),
    )
    const result = await checkSchemaVersion(mathaDir)
    expect(result.status).toBe('legacy')
    expect(result.version).toBeNull()
  })

  it('config.json with matching version → returns ok', async () => {
    await fs.writeFile(
      path.join(mathaDir, 'config.json'),
      JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION }),
    )
    const result = await checkSchemaVersion(mathaDir)
    expect(result.status).toBe('ok')
    expect(result.version).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('config.json with older version → returns outdated', async () => {
    await fs.writeFile(
      path.join(mathaDir, 'config.json'),
      JSON.stringify({ schema_version: '0.0.1' }),
    )
    const result = await checkSchemaVersion(mathaDir)
    expect(result.status).toBe('outdated')
    expect(result.version).toBe('0.0.1')
  })

  it('config.json with newer version → returns newer', async () => {
    await fs.writeFile(
      path.join(mathaDir, 'config.json'),
      JSON.stringify({ schema_version: '99.0.0' }),
    )
    const result = await checkSchemaVersion(mathaDir)
    expect(result.status).toBe('newer')
    expect(result.version).toBe('99.0.0')
  })

  it('config.json with newer minor version → returns newer', async () => {
    await fs.writeFile(
      path.join(mathaDir, 'config.json'),
      JSON.stringify({ schema_version: '0.2.0' }),
    )
    const result = await checkSchemaVersion(mathaDir)
    expect(result.status).toBe('newer')
    expect(result.version).toBe('0.2.0')
  })

  it('config.json with newer patch version → returns newer', async () => {
    await fs.writeFile(
      path.join(mathaDir, 'config.json'),
      JSON.stringify({ schema_version: '0.1.1' }),
    )
    const result = await checkSchemaVersion(mathaDir)
    expect(result.status).toBe('newer')
    expect(result.version).toBe('0.1.1')
  })

  // ──────────────────────────────────────────────────────────────
  // checkSchemaVersion — never throws
  // ──────────────────────────────────────────────────────────────

  it('never throws on malformed config.json', async () => {
    await fs.writeFile(
      path.join(mathaDir, 'config.json'),
      '{ this is not valid json !!!',
    )
    const result = await checkSchemaVersion(mathaDir)
    // Malformed JSON → treat as uninitialised (safe fallback)
    expect(result.status).toBe('uninitialised')
    expect(result.version).toBeNull()
  })

  it('never throws on empty config.json', async () => {
    await fs.writeFile(path.join(mathaDir, 'config.json'), '')
    const result = await checkSchemaVersion(mathaDir)
    expect(result.status).toBe('uninitialised')
    expect(result.version).toBeNull()
  })

  it('never throws when .matha dir does not exist', async () => {
    const result = await checkSchemaVersion('/tmp/nonexistent-matha-dir-12345')
    expect(result.status).toBe('uninitialised')
    expect(result.version).toBeNull()
  })

  // ──────────────────────────────────────────────────────────────
  // getSchemaMessage
  // ──────────────────────────────────────────────────────────────

  it('getSchemaMessage returns null for ok', () => {
    const msg = getSchemaMessage({ status: 'ok', version: '0.1.0' })
    expect(msg).toBeNull()
  })

  it('getSchemaMessage returns null for uninitialised', () => {
    const msg = getSchemaMessage({ status: 'uninitialised', version: null })
    expect(msg).toBeNull()
  })

  it('getSchemaMessage returns warning for legacy', () => {
    const msg = getSchemaMessage({ status: 'legacy', version: null })
    expect(msg).not.toBeNull()
    expect(msg).toContain('⚠')
    expect(msg).toContain('matha migrate')
    expect(msg).toContain('Coming in v0.2.0')
  })

  it('getSchemaMessage returns warning for outdated', () => {
    const msg = getSchemaMessage({ status: 'outdated', version: '0.0.1' })
    expect(msg).not.toBeNull()
    expect(msg).toContain('⚠')
    expect(msg).toContain('0.0.1')
    expect(msg).toContain(CURRENT_SCHEMA_VERSION)
    expect(msg).toContain('matha migrate')
    expect(msg).toContain('Coming in v0.2.0')
  })

  it('getSchemaMessage returns error for newer', () => {
    const msg = getSchemaMessage({ status: 'newer', version: '99.0.0' })
    expect(msg).not.toBeNull()
    expect(msg).toContain('✗')
    expect(msg).toContain('99.0.0')
    expect(msg).toContain(CURRENT_SCHEMA_VERSION)
    expect(msg).toContain('npm install -g matha')
  })
})
