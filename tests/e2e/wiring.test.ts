import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CURRENT_SCHEMA_VERSION } from '../../src/core/schema.js'

/**
 * End-to-end wiring test: builds dist, creates a real project brain,
 * spawns the MCP server as a SEPARATE PROCESS from a DIFFERENT cwd, and
 * round-trips knowledge through the real stdio protocol.
 *
 * This is the test 0.1.x never had: 262 unit tests passed while the served
 * product scored 9/100 in the field, because the brain-dir resolution and
 * tool registration were never exercised across a process boundary.
 */

const repoRoot = path.resolve(__dirname, '..', '..')
const distEntry = path.join(repoRoot, 'dist', 'index.js')

describe('e2e wiring (spawned MCP server)', () => {
  let projectDir: string
  let unrelatedCwd: string

  beforeAll(async () => {
    execSync('npm run build', { cwd: repoRoot, stdio: 'pipe', timeout: 180_000 })

    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-e2e-proj-'))
    unrelatedCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-e2e-cwd-'))

    // A real brain with knowledge in it
    const mathaDir = path.join(projectDir, '.matha')
    await fs.mkdir(path.join(mathaDir, 'hippocampus', 'decisions'), { recursive: true })
    await fs.writeFile(
      path.join(mathaDir, 'config.json'),
      JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION, version: '0.2.0' }),
    )
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'intent.json'),
      JSON.stringify({ why: 'e2e fixture project' }),
    )
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'rules.json'),
      JSON.stringify({ rules: ['all writes must be atomic'] }),
    )
    await fs.writeFile(
      path.join(mathaDir, 'hippocampus', 'danger-zones.json'),
      JSON.stringify({
        zones: [
          {
            id: 'z1',
            component: 'src/payments/',
            pattern: 'retry storm',
            description: 'retries here can double-charge customers',
          },
        ],
      }),
    )
    // A source file for filepath-based resolution
    await fs.mkdir(path.join(projectDir, 'src', 'payments'), { recursive: true })
    await fs.writeFile(path.join(projectDir, 'src', 'payments', 'retry.ts'), '// fixture')
  }, 200_000)

  afterAll(async () => {
    await fs.rm(projectDir, { recursive: true, force: true })
    await fs.rm(unrelatedCwd, { recursive: true, force: true })
  })

  async function connect(args: string[], cwd: string): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distEntry, ...args],
      cwd,
      stderr: 'pipe',
    })
    const client = new Client({ name: 'matha-e2e', version: '0.0.0' })
    await client.connect(transport)
    return client
  }

  function text(result: any): any {
    return JSON.parse(result.content[0].text)
  }

  it('serve --project from an unrelated cwd serves the RIGHT brain', async () => {
    const client = await connect(['serve', '--project', projectDir], unrelatedCwd)
    try {
      const tools = await client.listTools()
      const names = tools.tools.map((t) => t.name)
      expect(names).toContain('matha_brief')
      expect(names).toContain('matha_match')
      expect(names).toContain('matha_refresh')
      expect(names).not.toContain('matha_get_routing') // dead tool stays dead

      // Static knowledge comes from the fixture project, not the cwd
      const rules = text(await client.callTool({ name: 'matha_get_rules', arguments: {} }))
      expect(rules.rules).toEqual(['all writes must be atomic'])
      expect(rules.diagnostics.brainDir).toBe(path.join(projectDir, '.matha'))

      // Retrieval: dir-scoped danger zone fires for a file inside it
      const brief = text(
        await client.callTool({
          name: 'matha_brief',
          arguments: { scope: 'src/payments/retry.ts', intent: 'change retry logic' },
        }),
      )
      expect(brief.why).toBe('e2e fixture project')
      expect(brief.hasCritical).toBe(true)
      expect(brief.matchResults[0].title).toContain('src/payments/')

      // Write → read round-trip across the protocol
      const write = text(
        await client.callTool({
          name: 'matha_record_decision',
          arguments: {
            component: 'src/payments/retry.ts',
            previous_assumption: 'assumed the gateway is idempotent',
            correction: 'gateway double-charges on retry',
          },
        }),
      )
      expect(write.success).toBe(true)

      const decisions = text(
        await client.callTool({ name: 'matha_get_decisions', arguments: {} }),
      )
      expect(decisions.decisions).toHaveLength(1)

      // Garbage is rejected at the protocol boundary too
      const garbage = text(
        await client.callTool({
          name: 'matha_record_decision',
          arguments: { component: 'src/x.ts', previous_assumption: 'y', correction: 'y' },
        }),
      )
      expect(garbage.success).toBe(false)
    } finally {
      await client.close()
    }
  }, 30_000)

  it('server without --project from unrelated cwd: errors honestly, then resolves via tool filepaths', async () => {
    const client = await connect(['serve'], unrelatedCwd)
    try {
      // No brain resolvable from cwd → explicit error with tried paths,
      // NOT a silently-created empty brain (the 0.1.x failure mode)
      const noBrain = text(await client.callTool({ name: 'matha_get_rules', arguments: {} }))
      expect(noBrain.error).toContain('matha init')
      expect(Array.isArray(noBrain.triedPaths)).toBe(true)
      await expect(fs.access(path.join(unrelatedCwd, '.matha'))).rejects.toThrow()

      // A tool call carrying filepaths inside the project resolves the brain
      const brief = text(
        await client.callTool({
          name: 'matha_brief',
          arguments: {
            scope: 'src/payments/retry.ts',
            filepaths: [path.join(projectDir, 'src', 'payments', 'retry.ts')],
          },
        }),
      )
      expect(brief.rules).toEqual(['all writes must be atomic'])
      expect(brief.diagnostics.brainDir).toBe(path.join(projectDir, '.matha'))
    } finally {
      await client.close()
    }
  }, 30_000)

  it('serve --project with a wrong path fails loudly at startup', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distEntry, 'serve', '--project', path.join(os.tmpdir(), 'no-such-project-xyz')],
      cwd: unrelatedCwd,
      stderr: 'pipe',
    })
    const client = new Client({ name: 'matha-e2e', version: '0.0.0' })
    await expect(client.connect(transport)).rejects.toThrow()
  }, 30_000)
})
