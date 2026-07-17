import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { runMigrate } from '../../src/commands/migrate.js'
import { CURRENT_SCHEMA_VERSION } from '../../src/core/schema.js'

describe('migrate command', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-migrate-'))
    configPath = path.join(tmpDir, '.matha', 'config.json')
    await fs.mkdir(path.dirname(configPath), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const log = () => {}

  it('uninitialised project → exit 1', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-migrate-bare-'))
    const result = await runMigrate(bare, { log })
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('matha init')
    await fs.rm(bare, { recursive: true, force: true })
  })

  it('legacy config (no schema_version) → stamped to current, other keys preserved', async () => {
    await fs.writeFile(configPath, JSON.stringify({ version: '0.1.0', project_root: '/old' }))
    const result = await runMigrate(tmpDir, { log })
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('legacy')

    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'))
    expect(config.schema_version).toBe(CURRENT_SCHEMA_VERSION)
    expect(config.version).toBe('0.1.0')
    expect(config.project_root).toBe('/old')
  })

  it('outdated schema → stamped to current', async () => {
    await fs.writeFile(configPath, JSON.stringify({ schema_version: '0.1.0' }))
    const result = await runMigrate(tmpDir, { log })
    expect(result.exitCode).toBe(0)
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'))
    expect(config.schema_version).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('already current → exit 0, no rewrite', async () => {
    await fs.writeFile(configPath, JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION }))
    const before = await fs.stat(configPath)
    const result = await runMigrate(tmpDir, { log })
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('nothing to migrate')
    const after = await fs.stat(configPath)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('newer schema than this MATHA → exit 1 with upgrade hint', async () => {
    await fs.writeFile(configPath, JSON.stringify({ schema_version: '99.0.0' }))
    const result = await runMigrate(tmpDir, { log })
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('Upgrade MATHA')
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'))
    expect(config.schema_version).toBe('99.0.0') // untouched
  })
})
