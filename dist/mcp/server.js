import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as url from 'url';
import { createRequire } from 'module';
import { Engine } from '../core/engine.js';
import { resolveBrainDir, BrainNotFoundError } from '../core/resolve.js';
import { checkSchemaVersion, getSchemaMessage } from '../utils/schema-version.js';
import { mathaBrief, mathaGetDangerZones, mathaGetDecisions, mathaGetRules, mathaGetStability, mathaMatch, mathaRecordContract, mathaRecordDanger, mathaRecordDecision, mathaRefresh, } from './tools.js';
/**
 * MATHA MCP Server.
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
const require = createRequire(import.meta.url);
const { version } = require('../../package.json');
// ── TOOL DEFINITIONS ─────────────────────────────────────────────────
const tools = [
    {
        name: 'matha_brief',
        description: 'Returns project context: why the project exists, business rules, recent decisions, ' +
            'and matches against the given scope. Call this FIRST in any session, before touching code.',
        inputSchema: {
            type: 'object',
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
        description: 'Matches your planned change against known danger zones, contracts, frozen files, and ' +
            'prior decisions. Call BEFORE modifying files. hasCritical:true means proceed with caution.',
        inputSchema: {
            type: 'object',
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
        name: 'matha_get_rules',
        description: 'Returns all non-negotiable business rules for the project.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'matha_get_danger_zones',
        description: 'Returns known danger zones (patterns to avoid). Optionally filter by context.',
        inputSchema: {
            type: 'object',
            properties: {
                context: { type: 'string', description: 'Optional filter (e.g. component name)' },
            },
            required: [],
        },
    },
    {
        name: 'matha_get_decisions',
        description: 'Returns past decisions (broken assumptions and their corrections).',
        inputSchema: {
            type: 'object',
            properties: {
                component: { type: 'string', description: 'Optional component filter' },
                limit: { type: 'number', description: 'Max results (default 20)' },
            },
            required: [],
        },
    },
    {
        name: 'matha_get_stability',
        description: 'Returns git-derived stability classification (frozen/stable/volatile/disposable) for files.',
        inputSchema: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'File paths to check (repo-relative)',
                },
            },
            required: ['files'],
        },
    },
    {
        name: 'matha_record_decision',
        description: 'Records a durable learning: a stated assumption about this codebase that proved wrong, ' +
            'and the correction. Call when you discover the code behaves differently than documented ' +
            'or expected. Not for trivial observations — for corrections a future session must know.',
        inputSchema: {
            type: 'object',
            properties: {
                component: {
                    type: 'string',
                    description: 'File path(s) or component this applies to (prefer paths)',
                },
                previous_assumption: { type: 'string', description: 'What was believed to be true' },
                correction: { type: 'string', description: 'What is actually true' },
                confidence: {
                    type: 'string',
                    enum: ['confirmed', 'probable', 'uncertain'],
                    description: 'Default: probable. Use confirmed only for human-verified facts.',
                },
            },
            required: ['component', 'previous_assumption', 'correction'],
        },
    },
    {
        name: 'matha_record_danger',
        description: 'Records a danger zone: a pattern that breaks something non-obvious. Call when a change ' +
            'in one place caused unexpected breakage elsewhere, so future sessions get warned.',
        inputSchema: {
            type: 'object',
            properties: {
                component: {
                    type: 'string',
                    description: 'File path(s) or component where the danger lives (prefer paths)',
                },
                description: { type: 'string', description: 'The pattern to watch for, specifically' },
            },
            required: ['component', 'description'],
        },
    },
    {
        name: 'matha_record_contract',
        description: 'Records the behaviour contract for a component: assertions that must remain true after ' +
            'any change. Overwrites the existing contract for the same component (version increments).',
        inputSchema: {
            type: 'object',
            properties: {
                component: { type: 'string', description: 'File path or component the contract covers' },
                assertions: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Invariant assertions (must remain true)',
                },
            },
            required: ['component', 'assertions'],
        },
    },
    {
        name: 'matha_refresh',
        description: 'Re-analyses git history to refresh file stability and co-change data. Call if stability ' +
            'results look stale (many commits since last analysis).',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
];
// ── SERVER ───────────────────────────────────────────────────────────
export async function startServer(explicitRoot) {
    let engine = null;
    let triedPaths = [];
    // 1. Explicit root is authoritative — a wrong path is a loud startup error.
    if (explicitRoot) {
        const resolved = await resolveBrainDir({ explicitRoot }); // throws BrainNotFoundError
        engine = new Engine(resolved.mathaDir);
    }
    else {
        // 2. Best-effort cwd resolution; failure is fine, we retry per-call.
        try {
            const resolved = await resolveBrainDir({ cwd: process.cwd() });
            engine = new Engine(resolved.mathaDir);
        }
        catch (err) {
            if (err instanceof BrainNotFoundError)
                triedPaths = err.tried;
            else
                throw err;
        }
    }
    const server = new Server({ name: 'matha', version }, { capabilities: { tools: {} } });
    /** Per-call resolution fallback using the tool call's own filepaths. */
    async function getEngine(args) {
        if (engine)
            return engine;
        const filepaths = [
            ...(Array.isArray(args?.filepaths) ? args.filepaths : []),
            ...(Array.isArray(args?.files) ? args.files : []),
        ];
        try {
            const resolved = await resolveBrainDir({ filepaths });
            engine = new Engine(resolved.mathaDir);
            return engine;
        }
        catch (err) {
            if (err instanceof BrainNotFoundError) {
                triedPaths = [...new Set([...triedPaths, ...err.tried])];
                return null;
            }
            throw err;
        }
    }
    // 3. MCP roots: once the client is initialised, ask it for workspace roots.
    server.oninitialized = async () => {
        if (engine)
            return;
        try {
            if (!server.getClientCapabilities()?.roots)
                return;
            const res = await server.listRoots();
            for (const root of res.roots ?? []) {
                if (!root.uri?.startsWith('file://'))
                    continue;
                try {
                    const resolved = await resolveBrainDir({ explicitRoot: url.fileURLToPath(root.uri) });
                    engine = new Engine(resolved.mathaDir);
                    console.error(`matha: brain resolved from client root: ${resolved.mathaDir}`);
                    return;
                }
                catch (err) {
                    if (err instanceof BrainNotFoundError) {
                        triedPaths = [...new Set([...triedPaths, ...err.tried])];
                    }
                }
            }
        }
        catch {
            // Client declared roots capability but the request failed — per-call
            // filepath resolution still applies.
        }
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params?.name;
        const args = request.params?.arguments ?? {};
        try {
            const eng = await getEngine(args);
            if (!eng) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                error: 'No .matha brain found. Run `matha init` in your project root, or start the ' +
                                    'server with `matha serve --project <path>`.',
                                triedPaths,
                            }),
                        },
                    ],
                    isError: true,
                };
            }
            let result;
            switch (name) {
                case 'matha_brief':
                    result = await mathaBrief(eng, args.scope, args.intent, args.filepaths);
                    break;
                case 'matha_match':
                    result = await mathaMatch(eng, args.scope, args.intent, args.filepaths);
                    break;
                case 'matha_get_rules':
                    result = await mathaGetRules(eng);
                    break;
                case 'matha_get_danger_zones':
                    result = await mathaGetDangerZones(eng, args.context);
                    break;
                case 'matha_get_decisions':
                    result = await mathaGetDecisions(eng, args.component, args.limit);
                    break;
                case 'matha_get_stability':
                    result = await mathaGetStability(eng, args.files || []);
                    break;
                case 'matha_record_decision':
                    result = await mathaRecordDecision(eng, args.component, args.previous_assumption, args.correction, args.confidence || 'probable');
                    break;
                case 'matha_record_danger':
                    result = await mathaRecordDanger(eng, args.component, args.description);
                    break;
                case 'matha_record_contract':
                    result = await mathaRecordContract(eng, args.component, args.assertions);
                    break;
                case 'matha_refresh':
                    result = await mathaRefresh(eng);
                    break;
                default:
                    return {
                        content: [
                            { type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) },
                        ],
                        isError: true,
                    };
            }
            return { content: [{ type: 'text', text: result }] };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ error: `Tool execution failed: ${err.message}` }),
                    },
                ],
                isError: true,
            };
        }
    });
    // Schema version warning (stderr only, never blocks the stdio protocol)
    if (engine) {
        const schemaResult = await checkSchemaVersion(engine.mathaDir);
        const schemaMsg = getSchemaMessage(schemaResult);
        if (schemaMsg)
            console.error(schemaMsg);
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(engine
        ? `MATHA MCP server running on stdio, brain: ${engine.mathaDir}`
        : `MATHA MCP server running on stdio, brain NOT yet resolved (will retry from client roots / tool filepaths). Tried: ${triedPaths.join(', ')}`);
}
