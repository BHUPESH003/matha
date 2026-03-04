import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { runInit } from '../../src/commands/init.js'

describe('init command', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-init-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function makeAsk(answers: string[]) {
    let idx = 0
    return async () => answers[idx++] ?? ''
  }

  it('fresh project: creates all required directories and files', async () => {
    const logs: string[] = []
    const summary = await runInit(tmpDir, {
      ask: makeAsk([
        'Persistent memory for AI sessions',
        'Rule A',
        'Rule B',
        '',
        'Does not deploy infrastructure',
        '',
        'Platform Team',
      ]),
      log: (msg: string) => logs.push(msg),
    })

    expect(summary.created.length).toBeGreaterThan(0)

    const requiredDirs = [
      '.matha/hippocampus',
      '.matha/hippocampus/decisions',
      '.matha/cerebellum',
      '.matha/cerebellum/contracts',
      '.matha/cortex',
      '.matha/dopamine',
      '.matha/dopamine/predictions',
      '.matha/dopamine/actuals',
      '.matha/sessions',
    ]

    for (const dir of requiredDirs) {
      await expect(fs.access(path.join(tmpDir, dir))).resolves.toBeUndefined()
    }

    const intent = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/hippocampus/intent.json'), 'utf-8'),
    )
    const rules = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/hippocampus/rules.json'), 'utf-8'),
    )
    const boundaries = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/boundaries.json'), 'utf-8'),
    )
    const ownership = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/ownership.json'), 'utf-8'),
    )
    const config = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/config.json'), 'utf-8'),
    )
    const shape = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/shape.json'), 'utf-8'),
    )

    expect(intent).toEqual({ why: 'Persistent memory for AI sessions' })
    expect(rules).toEqual({ rules: ['Rule A', 'Rule B'] })
    expect(boundaries).toEqual({ boundaries: ['Does not deploy infrastructure'] })
    expect(ownership).toEqual({ owner: 'Platform Team' })
    expect(config.version).toBe('0.1.0')
    expect(config.project_root).toBe(tmpDir)
    expect(config.brain_dir).toBe('.matha')
    expect(Array.isArray(shape.directories)).toBe(true)
    expect(Array.isArray(shape.detected_stack)).toBe(true)
    expect(typeof shape.file_count).toBe('number')
    expect(typeof shape.derived_at).toBe('string')

    expect(logs.join('\n')).toContain('matha init complete')
    expect(logs.join('\n')).toContain('created')
    expect(logs.join('\n')).toContain('skipped')
  })

  it('existing .matha: preserves existing files and creates missing files', async () => {
    await fs.mkdir(path.join(tmpDir, '.matha/hippocampus'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, '.matha/hippocampus/intent.json'),
      JSON.stringify({ why: 'Existing why' }),
      'utf-8',
    )

    await runInit(tmpDir, {
      ask: makeAsk([
        'New why should not overwrite',
        'New rule should not overwrite existing if file exists',
        '',
        'Boundary A',
        '',
        '',
      ]),
    })

    const intent = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/hippocampus/intent.json'), 'utf-8'),
    )
    expect(intent).toEqual({ why: 'Existing why' })

    await expect(
      fs.access(path.join(tmpDir, '.matha/hippocampus/rules.json')),
    ).resolves.toBeUndefined()
    await expect(
      fs.access(path.join(tmpDir, '.matha/cortex/boundaries.json')),
    ).resolves.toBeUndefined()
    await expect(
      fs.access(path.join(tmpDir, '.matha/config.json')),
    ).resolves.toBeUndefined()
  })

  it('skipped prompts: completes with empty/null values', async () => {
    await expect(
      runInit(tmpDir, { ask: makeAsk(['', '', '', '']) }),
    ).resolves.toBeDefined()

    const intent = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/hippocampus/intent.json'), 'utf-8'),
    )
    const rules = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/hippocampus/rules.json'), 'utf-8'),
    )
    const boundaries = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/boundaries.json'), 'utf-8'),
    )
    const ownership = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/ownership.json'), 'utf-8'),
    )

    expect(intent).toEqual({ why: '' })
    expect(rules).toEqual({ rules: [] })
    expect(boundaries).toEqual({ boundaries: [] })
    expect(ownership).toEqual({ owner: null })
  })

  it('malformed package.json: stack detection does not throw', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{ invalid json', 'utf-8')

    await expect(
      runInit(tmpDir, { ask: makeAsk(['why', '', '', '']) }),
    ).resolves.toBeDefined()

    const shape = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/shape.json'), 'utf-8'),
    )
    expect(shape.detected_stack).toContain('node')
  })

  it('large directory scan excludes node_modules and .git from file count', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    await fs.mkdir(path.join(tmpDir, 'node_modules/pkg'), { recursive: true })
    await fs.mkdir(path.join(tmpDir, '.git/objects'), { recursive: true })

    await fs.writeFile(path.join(tmpDir, 'src/a.ts'), 'export {}', 'utf-8')
    await fs.writeFile(path.join(tmpDir, 'src/b.ts'), 'export {}', 'utf-8')
    await fs.writeFile(path.join(tmpDir, 'node_modules/pkg/huge.js'), 'x', 'utf-8')
    await fs.writeFile(path.join(tmpDir, '.git/objects/blob'), 'x', 'utf-8')

    await runInit(tmpDir, { ask: makeAsk(['why', '', '', '']) })

    const shape = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/shape.json'), 'utf-8'),
    )

    expect(shape.file_count).toBeGreaterThanOrEqual(2)
    expect(shape.file_count).toBeLessThan(4)
    expect(shape.directories).toContain('src')
    expect(shape.directories).not.toContain('node_modules')
    expect(shape.directories).not.toContain('.git')
  })
})
