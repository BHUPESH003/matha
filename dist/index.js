#!/usr/bin/env node
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runBefore } from './commands/before.js';
import { runAfter } from './commands/after.js';
import { runMigrate } from './commands/migrate.js';
import { parseMarkdownFile } from './utils/markdown-parser.js';
const program = new Command();
program
    .name('matha')
    .description('MATHA: Persistent cognitive layer for AI-assisted development')
    .version('0.1.0');
// ──────────────────────────────────────────────────────────────────────
// INIT COMMAND
// ──────────────────────────────────────────────────────────────────────
program
    .command('init')
    .description('Initialize MATHA in a project (one-time setup)')
    .option('--project <path>', 'Project root path (default: current directory)')
    .option('--from <filepath>', 'Parse a markdown/text file to pre-fill init prompts')
    .action(async (options) => {
    try {
        const projectRoot = options.project || process.cwd();
        let seed = undefined;
        if (options.from) {
            try {
                seed = await parseMarkdownFile(options.from);
            }
            catch (err) {
                console.error(err.message);
                process.exit(1);
            }
        }
        await runInit(projectRoot, { seed });
    }
    catch (err) {
        console.error('Init failed:', err.message);
        process.exit(1);
    }
});
// ──────────────────────────────────────────────────────────────────────
// BEFORE COMMAND
// ──────────────────────────────────────────────────────────────────────
program
    .command('before')
    .description('Run gates 01-06: pre-session context gathering')
    .option('--project <path>', 'Project root path (default: current directory)')
    .action(async (options) => {
    try {
        const projectRoot = options.project || process.cwd();
        await runBefore(projectRoot, {});
    }
    catch (err) {
        console.error('Before failed:', err.message);
        process.exit(1);
    }
});
// ──────────────────────────────────────────────────────────────────────
// AFTER COMMAND
// ──────────────────────────────────────────────────────────────────────
program
    .command('after')
    .description('Run gate 08: post-session write-back and loop closure')
    .option('--project <path>', 'Project root path (default: current directory)')
    .action(async (options) => {
    try {
        const projectRoot = options.project || process.cwd();
        await runAfter(projectRoot, {});
    }
    catch (err) {
        console.error('After failed:', err.message);
        process.exit(1);
    }
});
// ──────────────────────────────────────────────────────────────────────
// MIGRATE COMMAND
// ──────────────────────────────────────────────────────────────────────
program
    .command('migrate')
    .description('Migrate .matha/ to current schema version')
    .action(async () => {
    const result = await runMigrate();
    process.exit(result.exitCode);
});
// ──────────────────────────────────────────────────────────────────────
// SERVE COMMAND
// ──────────────────────────────────────────────────────────────────────
program
    .command('serve')
    .description('Start MCP server on stdio for IDE integration')
    .option('--project <path>', 'Project root path (default: current directory)')
    .action((options) => {
    try {
        const projectRoot = options.project || process.cwd();
        // Import and run the server directly instead of spawning
        // This keeps the stdio channel intact for MCP protocol
        import('./mcp/server.js').catch((err) => {
            console.error('Failed to start MCP server:', err.message);
            process.exit(1);
        });
    }
    catch (err) {
        console.error('Serve failed:', err.message);
        process.exit(1);
    }
});
// ──────────────────────────────────────────────────────────────────────
// PARSE & EXECUTE
// ──────────────────────────────────────────────────────────────────────
program.parse(process.argv);
// Show help if no command provided
if (!process.argv.slice(2).length) {
    program.outputHelp();
}
