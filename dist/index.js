#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runBefore } from "./commands/before.js";
import { runAfter } from "./commands/after.js";
import { runMigrate } from "./commands/migrate.js";
import { runDoctor } from "./commands/doctor.js";
import { parseMarkdownFile } from "./utils/markdown-parser.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
const program = new Command();
program
    .name("matha")
    .description("MATHA: Persistent cognitive layer for AI-assisted development");
program.version(version);
program
    .command("init")
    .description("Initialize MATHA in a project (one-time setup)")
    .option("--project <path>", "Project root path (default: current directory)")
    .option("--from <filepath>", "Parse a markdown/text file to pre-fill init prompts")
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
        console.error("Init failed:", err.message);
        process.exit(1);
    }
});
program
    .command("before")
    .description("Print the project brief for a scope (paste into your agent, or use MCP)")
    .option("--project <path>", "Project root path (default: current directory)")
    .option("--scope <scope>", "Files or components you plan to work on (comma-separated)")
    .option("--intent <intent>", "What you are about to do")
    .action(async (options) => {
    try {
        const projectRoot = options.project || process.cwd();
        const result = await runBefore(projectRoot, {
            scope: options.scope,
            intent: options.intent,
        });
        process.exit(result.exitCode);
    }
    catch (err) {
        console.error("Before failed:", err.message);
        process.exit(1);
    }
});
program
    .command("after")
    .description("Record what this session learned (decision / danger zone)")
    .option("--project <path>", "Project root path (default: current directory)")
    .action(async (options) => {
    try {
        const projectRoot = options.project || process.cwd();
        const result = await runAfter(projectRoot, {});
        process.exit(result.exitCode);
    }
    catch (err) {
        console.error("After failed:", err.message);
        process.exit(1);
    }
});
program
    .command("migrate")
    .description("Migrate .matha/ to current schema version")
    .option("--project <path>", "Project root path (default: current directory)")
    .action(async (options) => {
    const projectRoot = options.project || process.cwd();
    const result = await runMigrate(projectRoot);
    process.exit(result.exitCode);
});
program
    .command("doctor")
    .description("Diagnose the MATHA setup: brain location, schema, record counts, staleness")
    .option("--project <path>", "Project root path (default: current directory)")
    .action(async (options) => {
    const result = await runDoctor({ explicitRoot: options.project });
    process.exit(result.exitCode);
});
program
    .command("serve")
    .description("Start MCP server on stdio for IDE integration")
    .option("--project <path>", "Project root path (default: resolve from client roots / cwd)")
    .action(async (options) => {
    try {
        const { startServer } = await import("./mcp/server.js");
        await startServer(options.project);
    }
    catch (err) {
        console.error("Failed to start MCP server:", err.message);
        process.exit(1);
    }
});
program.parse(process.argv);
// Show help if no command provided
if (!process.argv.slice(2).length) {
    program.outputHelp();
}
