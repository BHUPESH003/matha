import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as url from 'url'
import { createRequire } from 'module'
import { Engine } from '@/core/engine.js'
import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js'
import { checkSchemaVersion, getSchemaMessage } from '@/utils/schema-version.js'
import { assembleBrief } from '@/retrieve/brief.js'
import { mathaBrief, mathaMatch, mathaRecord, mathaRefresh } from './tools.js'

/**
 * MATHA MCP Server — consolidated surface (target-architecture Phase 2):
 * two reads (matha_brief, matha_match), one write (matha_record), one
 * maintenance tool (matha_refresh), plus the matha_context prompt that
 * injects the brief and the standing record-what-you-learn instruction.
 *
 * Brain resolution order (see core/resolve.ts):
 *   1. explicit --project (authoritative: wrong path = startup error, loud)
 *   2. MCP client roots (workspace folders reported by the IDE)
 *   3. per-call: walk up from the tool call's filepaths
 *   4. walk up from cwd
 *
 * If no brain resolves, every tool returns an error naming the paths tried.
 * The server NEVER creates a .matha directory — that is `matha init`'s job.
 */

const require = createRequire(import.meta.url)
const { version } = require('../../package.json')

// ── TOOL DEFINITIONS ─────────────────────────────────────────────────

const tools: Tool[] = [
  {
    name: 'matha_brief',
    description:
      'Returns project context under a token budget: why the project exists, business rules, ' +
      'recent decisions, and scored matches against the given scope. Call this FIRST in any ' +
      'session, before touching code.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          description: 'Files or components you plan to work on (comma-separated)',
        },
        intent: { type: 'string', description: 'What you are trying to do' },
        filepaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific files that will be read or modified (absolute or repo-relative)',
        },
      },
      required: [],
    },
  },
  {
    name: 'matha_match',
    description:
      'Matches your planned change against known danger zones, contracts, frozen files, and ' +
      'prior decisions, ranked by relevance score. Call BEFORE modifying files. ' +
      'hasCritical:true means proceed with caution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          description: 'Files or components being changed (comma-separated)',
        },
        intent: { type: 'string', description: 'What you are trying to do' },
        filepaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific files that will be modified',
        },
      },
      required: ['scope', 'intent'],
    },
  },
  {
    name: 'matha_record',
    description:
      'Records durable project knowledge — the ONE write tool. type=decision: a stated ' +
      'assumption about this codebase that proved wrong, plus the correction (call when the ' +
      'code behaves differently than documented or expected). type=danger: a pattern that ' +
      'breaks something non-obvious (call when a change in one place caused unexpected ' +
      'breakage elsewhere). type=contract: assertions that must remain true for a component ' +
      '(overwrites the previous contract, version increments). Not for trivial observations — ' +
      'for knowledge a future session must have.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['decision', 'danger', 'contract'],
          description: 'What kind of knowledge this is',
        },
        component: {
          type: 'string',
          description: 'File path(s) or component this applies to (prefer paths)',
        },
        previous_assumption: {
          type: 'string',
          description: 'decision only: what was believed to be true',
        },
        correction: { type: 'string', description: 'decision only: what is actually true' },
        description: {
          type: 'string',
          description: 'danger only: the pattern to watch for, specifically',
        },
        assertions: {
          type: 'array',
          items: { type: 'string' },
          description: 'contract only: invariant assertions (must remain true)',
        },
        confidence: {
          type: 'string',
          enum: ['probable', 'uncertain'],
          description:
            'Default: probable. Use uncertain for unverified suspicions. (confirmed is ' +
            'reserved for human review and cannot be set over MCP.)',
        },
      },
      required: ['type', 'component'],
    },
  },
  {
    name: 'matha_refresh',
    description:
      'Re-analyses git history to refresh file stability and co-change data. Call if stability ' +
      'results look stale (many commits since last analysis).',
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  },
]

// ── SERVER ───────────────────────────────────────────────────────────

export async function startServer(explicitRoot?: string): Promise<void> {
  let engine: Engine | null = null
  let triedPaths: string[] = []

  // 1. Explicit root is authoritative — a wrong path is a loud startup error.
  if (explicitRoot) {
    const resolved = await resolveBrainDir({ explicitRoot }) // throws BrainNotFoundError
    engine = new Engine(resolved.mathaDir)
  } else {
    // 2. Best-effort cwd resolution; failure is fine, we retry per-call.
    try {
      const resolved = await resolveBrainDir({ cwd: process.cwd() })
      engine = new Engine(resolved.mathaDir)
    } catch (err) {
      if (err instanceof BrainNotFoundError) triedPaths = err.tried
      else throw err
    }
  }

  const server = new Server(
    { name: 'matha', version },
    { capabilities: { tools: {}, prompts: {} } },
  )

  /** Per-call resolution fallback using the tool call's own filepaths. */
  async function getEngine(args: any): Promise<Engine | null> {
    if (engine) return engine
    const filepaths: string[] = Array.isArray(args?.filepaths) ? args.filepaths : []
    try {
      const resolved = await resolveBrainDir({ filepaths })
      engine = new Engine(resolved.mathaDir)
      return engine
    } catch (err) {
      if (err instanceof BrainNotFoundError) {
        triedPaths = [...new Set([...triedPaths, ...err.tried])]
        return null
      }
      throw err
    }
  }

  // 3. MCP roots: once the client is initialised, ask it for workspace roots.
  server.oninitialized = async () => {
    if (engine) return
    try {
      if (!server.getClientCapabilities()?.roots) return
      const res = await server.listRoots()
      for (const root of res.roots ?? []) {
        if (!root.uri?.startsWith('file://')) continue
        try {
          const resolved = await resolveBrainDir({ explicitRoot: url.fileURLToPath(root.uri) })
          engine = new Engine(resolved.mathaDir)
          console.error(`matha: brain resolved from client root: ${resolved.mathaDir}`)
          return
        } catch (err) {
          if (err instanceof BrainNotFoundError) {
            triedPaths = [...new Set([...triedPaths, ...err.tried])]
          }
        }
      }
    } catch {
      // Client declared roots capability but the request failed — per-call
      // filepath resolution still applies.
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const name = request.params?.name
    const args = request.params?.arguments ?? {}

    try {
      const eng = await getEngine(args)
      if (!eng) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  'No .matha brain found. Run `matha init` in your project root, or start the ' +
                  'server with `matha serve --project <path>`.',
                triedPaths,
              }),
            },
          ],
          isError: true,
        }
      }

      let result: string
      switch (name) {
        case 'matha_brief':
          result = await mathaBrief(eng, args.scope, args.intent, args.filepaths)
          break
        case 'matha_match':
          result = await mathaMatch(eng, args.scope, args.intent, args.filepaths)
          break
        case 'matha_record':
          result = await mathaRecord(eng, args)
          break
        case 'matha_refresh':
          result = await mathaRefresh(eng)
          break
        default:
          return {
            content: [
              { type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) },
            ],
            isError: true,
          }
      }

      return { content: [{ type: 'text', text: result }] }
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Tool execution failed: ${err.message}` }),
          },
        ],
        isError: true,
      }
    }
  })

  // ── PROMPT: session-start brief + standing record instruction ──────

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'matha_context',
        description:
          'Project brief (intent, rules, recent decisions, scope matches) plus the standing ' +
          'instruction to record what the session learns. Use at session start.',
        arguments: [
          { name: 'scope', description: 'Files or components to be worked on', required: false },
          { name: 'intent', description: 'What this session is trying to do', required: false },
        ],
      },
    ],
  }))

  server.setRequestHandler(GetPromptRequestSchema, async (request: any) => {
    const args = request.params?.arguments ?? {}
    const eng = await getEngine(args)
    if (!eng) {
      throw new Error(
        `No .matha brain found (tried: ${triedPaths.join(', ')}). Run \`matha init\` or start with --project.`,
      )
    }
    const brief = await assembleBrief(eng, { scope: args.scope, intent: args.intent })
    const text = [
      'PROJECT CONTEXT (from matha — persistent project memory):',
      '```json',
      JSON.stringify(brief, null, 2),
      '```',
      '',
      'Standing instructions for this session:',
      '- Treat the rules above as non-negotiable; hasCritical:true matches must be reviewed before changing those areas.',
      '- Before modifying files not covered above, call matha_match with the files and your intent.',
      '- When an assumption about this codebase proves wrong, or a change breaks something non-obvious, record it with matha_record before ending the session.',
    ].join('\n')
    return {
      description: 'matha project brief',
      messages: [{ role: 'user', content: { type: 'text', text } }],
    }
  })

  // Schema version warning (stderr only, never blocks the stdio protocol)
  if (engine) {
    const schemaResult = await checkSchemaVersion(engine.mathaDir)
    const schemaMsg = getSchemaMessage(schemaResult)
    if (schemaMsg) console.error(schemaMsg)
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error(
    engine
      ? `MATHA MCP server running on stdio, brain: ${engine.mathaDir}`
      : `MATHA MCP server running on stdio, brain NOT yet resolved (will retry from client roots / tool filepaths). Tried: ${triedPaths.join(', ')}`,
  )
}
