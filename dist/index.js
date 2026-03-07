#!/usr/bin/env node
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runBefore } from './commands/before.js';
import { runAfter } from './commands/after.js';
const program = new Command();
program
    .name('matha')
    .description('MATHA: Persistent cognitive layer for AI-assisted development')
    .version('1.0.0');
// ──────────────────────────────────────────────────────────────────────
// INIT COMMAND
// ──────────────────────────────────────────────────────────────────────
program
    .command('init')
    .description('Initialize MATHA in a project (one-time setup)')
    .option('--project <path>', 'Project root path (default: current directory)')
    .action(async (options) => {
    try {
        const projectRoot = options.project || process.cwd();
        await runInit(projectRoot, {});
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
