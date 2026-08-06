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

  it('mcp-config.json is written after init completes', async () => {
    // Create dist/index.js as fallback so we have a predictable path
    await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'dist/index.js'), 'module.exports = {}', 'utf-8')

    const logs: string[] = []
    await runInit(tmpDir, {
      ask: makeAsk(['why', '', '', '']),
      log: (msg: string) => logs.push(msg),
    })

    // Check that mcp-config.json exists
    const mcpConfigPath = path.join(tmpDir, '.matha/mcp-config.json')
    await expect(fs.access(mcpConfigPath)).resolves.toBeUndefined()

    // Check mcp-config.json structure and content
    const mcpConfig = JSON.parse(
      await fs.readFile(mcpConfigPath, 'utf-8'),
    )

    expect(mcpConfig.mcpServers).toBeDefined()
    expect(mcpConfig.mcpServers.matha).toBeDefined()
    // Local install → node + entry path; otherwise npx fallback. Either way
    // the config must pass the project root explicitly via --project.
    expect(['node', 'npx']).toContain(mcpConfig.mcpServers.matha.command)
    expect(mcpConfig.mcpServers.matha.description).toBe('MATHA persistent cognitive layer')
    const args = mcpConfig.mcpServers.matha.args
    expect(Array.isArray(args)).toBe(true)
    expect(args).toContain('serve')
    const projectFlagIdx = args.indexOf('--project')
    expect(projectFlagIdx).toBeGreaterThan(-1)
    expect(path.isAbsolute(args[projectFlagIdx + 1])).toBe(true)

    // Check that log message was printed
    const allLogs = logs.join('\n')
    expect(allLogs).toContain('MCP server config written to .matha/mcp-config.json')
    expect(allLogs).toContain('Add this to your IDE MCP settings')
  })

  // ── .gitignore for the derived cortex files only (merge-conflict prevention) ────

  it('adds only the three auto-regenerated cortex files to a fresh .gitignore — never the whole dir', async () => {
    await runInit(tmpDir, { ask: makeAsk(['why', '', '', '']) })
    const gitignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.matha/cortex/analysis.json')
    expect(gitignore).toContain('.matha/cortex/stability.json')
    expect(gitignore).toContain('.matha/cortex/co-changes.json')
    // boundaries/ownership/shape are init-time-authored and constant — must stay OUT of .gitignore
    expect(gitignore).not.toContain('.matha/cortex/boundaries.json')
    expect(gitignore).not.toContain('.matha/cortex/ownership.json')
    expect(gitignore).not.toContain('.matha/cortex/shape.json')
    expect(gitignore).not.toContain('.matha/cortex/\n') // never the bare directory
  })

  it('appends to an existing .gitignore without disturbing its content', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'node_modules\ndist\n')
    await runInit(tmpDir, { ask: makeAsk(['why', '', '', '']) })
    const gitignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('node_modules')
    expect(gitignore).toContain('dist')
    expect(gitignore).toContain('.matha/cortex/analysis.json')
  })

  it('does not add anything if .matha/ is already ignored wholesale', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '.matha/\n')
    await runInit(tmpDir, { ask: makeAsk(['why', '', '', '']) })
    const gitignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(gitignore.match(/\.matha/g)).toHaveLength(1)
  })

  it('re-running init does not duplicate the .gitignore entries', async () => {
    await runInit(tmpDir, { ask: makeAsk(['why', '', '', '']) })
    await runInit(tmpDir, { ask: makeAsk(['', '', '', '']) })
    const gitignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(gitignore.match(/\.matha\/cortex\/analysis\.json/g)).toHaveLength(1)
    expect(gitignore.match(/\.matha\/cortex\/stability\.json/g)).toHaveLength(1)
    expect(gitignore.match(/\.matha\/cortex\/co-changes\.json/g)).toHaveLength(1)
  })

  // ── decision file consolidation (pre-1.1 upgrade path) ──────────────

  it('re-running init on a pre-1.1 repo consolidates one-file-per-decision into per-component files', async () => {
    const decisionsDir = path.join(tmpDir, '.matha', 'hippocampus', 'decisions')
    await fs.mkdir(decisionsDir, { recursive: true })
    await fs.writeFile(
      path.join(decisionsDir, 'session-001.json'),
      JSON.stringify({
        id: 'session-001', timestamp: '2026-01-01T00:00:00Z', component: 'src/auth.ts',
        previous_assumption: 'a', correction: 'b', trigger: 't', confidence: 'confirmed',
        status: 'active', supersedes: null, session_id: 'session-001',
      }),
    )
    await fs.writeFile(
      path.join(decisionsDir, 'session-002.json'),
      JSON.stringify({
        id: 'session-002', timestamp: '2026-01-02T00:00:00Z', component: 'src/auth.ts',
        previous_assumption: 'c', correction: 'd', trigger: 't', confidence: 'confirmed',
        status: 'active', supersedes: null, session_id: 'session-002',
      }),
    )

    const logs: string[] = []
    await runInit(tmpDir, { ask: makeAsk(['why', '', '', '']), log: (msg: string) => logs.push(msg) })

    const remaining = await fs.readdir(decisionsDir)
    expect(remaining).toEqual(['src-auth.ts.json'])
    const group = JSON.parse(await fs.readFile(path.join(decisionsDir, 'src-auth.ts.json'), 'utf-8'))
    expect(group.decisions.map((d: { id: string }) => d.id).sort()).toEqual(['session-001', 'session-002'])
    expect(logs.some((l) => l.includes('Consolidated 2 legacy decision file'))).toBe(true)
  })
})

describe('init command --from (seed)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-init-from-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function makeAsk(answers: string[]) {
    let idx = 0
    return async () => answers[idx++] ?? ''
  }

  it('seed pre-fills WHY, rules, boundaries, and owner', async () => {
    const logs: string[] = []
    const seed = {
      why: 'Parsed WHY from file',
      rules: ['Seed Rule 1', 'Seed Rule 2'],
      boundaries: ['Seed Boundary 1'],
      owner: 'Seed Owner',
    }

    // All prompts answered with empty → accept seed defaults
    const summary = await runInit(tmpDir, {
      ask: makeAsk(['', '', '', '']),
      log: (msg: string) => logs.push(msg),
      seed,
    })

    expect(summary.created.length).toBeGreaterThan(0)

    // Check parsed summary was logged
    const allLogs = logs.join('\n')
    expect(allLogs).toContain('Parsed from file')
    expect(allLogs).toContain('2 found')  // rules
    expect(allLogs).toContain('1 found')  // boundaries

    // Check files have seed values
    const intent = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/hippocampus/intent.json'), 'utf-8'),
    )
    expect(intent.why).toBe('Parsed WHY from file')

    const rules = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/hippocampus/rules.json'), 'utf-8'),
    )
    expect(rules.rules).toContain('Seed Rule 1')
    expect(rules.rules).toContain('Seed Rule 2')

    const boundaries = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/boundaries.json'), 'utf-8'),
    )
    expect(boundaries.boundaries).toContain('Seed Boundary 1')

    const ownership = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/ownership.json'), 'utf-8'),
    )
    expect(ownership.owner).toBe('Seed Owner')
  })

  it('user can override seed values', async () => {
    const seed = {
      why: 'Seed WHY',
      rules: ['Seed Rule'],
      boundaries: ['Seed Boundary'],
      owner: 'Seed Owner',
    }

    const summary = await runInit(tmpDir, {
      ask: makeAsk([
        'User Overridden WHY',  // override WHY
        'Extra Rule',           // add one more rule
        '',                     // done with rules
        '',                     // done with boundaries (accept seed)
        'New Owner',            // override owner
      ]),
      log: () => {},
      seed,
    })

    const intent = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/hippocampus/intent.json'), 'utf-8'),
    )
    expect(intent.why).toBe('User Overridden WHY')

    const rules = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/hippocampus/rules.json'), 'utf-8'),
    )
    expect(rules.rules).toContain('Seed Rule')
    expect(rules.rules).toContain('Extra Rule')
    expect(rules.rules).toHaveLength(2)

    const ownership = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/ownership.json'), 'utf-8'),
    )
    expect(ownership.owner).toBe('New Owner')
  })

  it('empty seed behaves like no seed', async () => {
    const seed = {
      why: null,
      rules: [],
      boundaries: [],
      owner: null,
    }

    const summary = await runInit(tmpDir, {
      ask: makeAsk(['Manual WHY', 'Manual Rule', '', 'Manual Boundary', '', 'Manual Owner']),
      log: () => {},
      seed,
    })

    const intent = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/hippocampus/intent.json'), 'utf-8'),
    )
    expect(intent.why).toBe('Manual WHY')

    const rules = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/hippocampus/rules.json'), 'utf-8'),
    )
    expect(rules.rules).toContain('Manual Rule')

    const ownership = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/ownership.json'), 'utf-8'),
    )
    expect(ownership.owner).toBe('Manual Owner')
  })

  it('seed with null owner and empty prompt → owner is null', async () => {
    const seed = {
      why: 'Some why',
      rules: [],
      boundaries: [],
      owner: null,
    }

    await runInit(tmpDir, {
      ask: makeAsk(['', '', '', '']),
      log: () => {},
      seed,
    })

    const ownership = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.matha/cortex/ownership.json'), 'utf-8'),
    )
    expect(ownership.owner).toBeNull()
  })
})
