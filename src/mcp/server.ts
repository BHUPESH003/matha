import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  mathaGetRules,
  mathaGetDangerZones,
  mathaGetDecisions,
  mathaGetStability,
  mathaBrief,
  mathaRecordDecision,
  mathaRecordDanger,
  mathaRecordContract,
} from './tools.js';
import { checkSchemaVersion, getSchemaMessage } from '@/utils/schema-version.js';

/**
 * MATHA MCP Server
 *
 * Exposes the MATHA brain via MCP protocol for IDE integration.
 * Loads config from .matha/config.json or uses project root if not initialized.
 *
 * Tools:
 * - READ: matha_get_rules, matha_get_danger_zones, matha_get_decisions, matha_get_stability, matha_brief
 * - WRITE: matha_record_decision, matha_record_danger, matha_record_contract
 */

const server = new Server(
  {
    name: 'matha',
    version: '0.1.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
)

let mathaDir: string;

// ──────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// ──────────────────────────────────────────────────────────────────────

const tools: Tool[] = [
  {
    name: 'matha_get_rules',
    description:
      'Returns all non-negotiable business rules for the project. Used to understand project constraints.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'matha_get_danger_zones',
    description:
      'Returns identified danger zones (patterns to avoid). Optionally filter by context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        context: {
          type: 'string',
          description: 'Optional context to filter danger zones (e.g., component name)',
        },
      },
      required: [],
    },
  },
  {
    name: 'matha_get_decisions',
    description:
      'Returns past decisions made on this project. Optionally filter by component.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component: {
          type: 'string',
          description: 'Optional component name to filter decisions',
        },
        limit: {
          type: 'number',
          description: 'Optional limit on number of results',
        },
      },
      required: [],
    },
  },
  {
    name: 'matha_get_stability',
    description:
      'Returns stability classification for specified files. Stability indicates how mature/frozen a file is.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of file paths to check stability for',
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'matha_brief',
    description:
      'Returns the most recent session brief, or intent + rules if no session exists. Used to understand current project state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          description: 'Optional scope to filter session brief',
        },
      },
      required: [],
    },
  },
  {
    name: 'matha_record_decision',
    description:
      'Records a decision (learning) about what was assumed vs. what was discovered. Confidence defaults to "probable" (not "confirmed" which requires human verification).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component: {
          type: 'string',
          description: 'Component or file this decision relates to',
        },
        previous_assumption: {
          type: 'string',
          description: 'What was previously thought to be true',
        },
        correction: {
          type: 'string',
          description: 'What was discovered to actually be true',
        },
        confidence: {
          type: 'string',
          enum: ['confirmed', 'probable', 'uncertain'],
          description:
            'Confidence level. Default: probable (agent-level). Use "confirmed" only for human-verified facts.',
        },
      },
      required: ['component', 'previous_assumption', 'correction'],
    },
  },
  {
    name: 'matha_record_danger',
    description:
      'Records a danger zone (pattern to avoid) discovered during development.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component: {
          type: 'string',
          description: 'Component or file where danger zone was found',
        },
        description: {
          type: 'string',
          description: 'Description of the danger pattern',
        },
      },
      required: ['component', 'description'],
    },
  },
  {
    name: 'matha_record_contract',
    description:
      'Records a behaviour contract (set of invariant assertions) for a component. Overwrites existing contract for the same component.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component: {
          type: 'string',
          description: 'Component or file this contract applies to',
        },
        assertions: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of invariant assertions (must remain true)',
        },
      },
      required: ['component', 'assertions'],
    },
  },
];

// ──────────────────────────────────────────────────────────────────────
// REQUEST HANDLERS
// ──────────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const name = request.params?.name;
  const args = request.params?.arguments;

  try {
    let result: string;

    switch (name) {
      case 'matha_get_rules':
        result = await mathaGetRules(mathaDir);
        break;

      case 'matha_get_danger_zones':
        result = await mathaGetDangerZones(mathaDir, args?.context);
        break;

      case 'matha_get_decisions':
        result = await mathaGetDecisions(mathaDir, args?.component, args?.limit);
        break;

      case 'matha_get_stability':
        result = await mathaGetStability(mathaDir, args?.files || []);
        break;

      case 'matha_brief':
        result = await mathaBrief(mathaDir, args?.scope);
        break;

      case 'matha_record_decision':
        result = await mathaRecordDecision(
          mathaDir,
          args?.component,
          args?.previous_assumption,
          args?.correction,
          args?.confidence || 'probable',
        );
        break;

      case 'matha_record_danger':
        result = await mathaRecordDanger(mathaDir, args?.component, args?.description);
        break;

      case 'matha_record_contract':
        result = await mathaRecordContract(mathaDir, args?.component, args?.assertions);
        break;

      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
        };
    }

    // All tool results are JSON strings
    return {
      content: [
        {
          type: 'text',
          text: result,
        },
      ],
    };
  } catch (err: any) {
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

// ──────────────────────────────────────────────────────────────────────
// INITIALIZATION & STARTUP
// ──────────────────────────────────────────────────────────────────────

/**
 * Initialize the server by locating and validating the MATHA directory.
 *
 * Strategy:
 * 1. Look for .matha/ directory in current working directory or parent directories
 * 2. If found, use that
 * 3. If not found, use CWD/.matha (will use defaults gracefully)
 * 4. Write mcp-config.json with absolute paths for this session
 */
async function initialize(): Promise<void> {
  const cwd = process.cwd();

  // Try to find existing .matha directory
  let found = false;
  let searchDir = cwd;

  for (let i = 0; i < 10; i++) {
    const candidate = path.join(searchDir, '.matha');
    try {
      await fs.access(candidate);
      mathaDir = candidate;
      found = true;
      break;
    } catch {
      // Not found, try parent
    }

    const parent = path.dirname(searchDir);
    if (parent === searchDir) break; // Reached root
    searchDir = parent;
  }

  // If not found, use default location
  if (!found) {
    mathaDir = path.join(cwd, '.matha');
  }

  // Write mcp-config.json with absolute paths
  try {
    const configPath = path.join(mathaDir, 'mcp-config.json');
    const config = {
      matha_dir: mathaDir,
      cwd: cwd,
      initialized: found,
      timestamp: new Date().toISOString(),
    };

    await fs.mkdir(mathaDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  } catch {
    // Ignore write errors - server can still run in degraded mode
  }

  // SCHEMA VERSION CHECK
  const schemaResult = await checkSchemaVersion(mathaDir);
  const schemaMsg = getSchemaMessage(schemaResult);
  if (schemaMsg) console.error(schemaMsg);
  if (schemaResult.status === 'newer') {
    process.exit(1);
  }
}

/**
 * Start the MCP server on stdio
 */
async function main(): Promise<void> {
  await initialize();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log startup info to stderr so it doesn't interfere with stdio protocol
  const msg = `MATHA MCP server running on stdio, mathaDir: ${mathaDir}`;
  console.error(msg);
}

main().catch((err) => {
  console.error('Server initialization failed:', err);
  process.exit(1);
});
