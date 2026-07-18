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
const { version } = require('../package.json')

const program = new Command();

program
  .name("matha")
  .description("MATHA: Persistent cognitive layer for AI-assisted development");
program.version(version);

program
  .command("init")
  .description("Initialize MATHA in a project (one-time setup)")
  .option("--project <path>", "Project root path (default: current directory)")
  .option(
    "--from <filepath>",
    "Parse a markdown/text file to pre-fill init prompts",
  )
  .action(async (options) => {
    try {
      const projectRoot = options.project || process.cwd();

      let seed = undefined;
      if (options.from) {
        try {
          seed = await parseMarkdownFile(options.from);
        } catch (err: any) {
          console.error(err.message);
          process.exit(1);
        }
      }

      await runInit(projectRoot, { seed });
    } catch (err: any) {
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
    } catch (err: any) {
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
    } catch (err: any) {
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
  .command("review")
  .description("Review unconfirmed and possibly-stale records: confirm, retire, or skip")
  .option("--project <path>", "Project root path (default: current directory)")
  .action(async (options) => {
    const { runReview } = await import("./commands/review.js");
    const result = await runReview(options.project || process.cwd());
    process.exit(result.exitCode);
  });

const boundary = program
  .command("boundary")
  .description("Admin-declared boundaries: pinned records, always CRITICAL on path match");
boundary
  .command("add")
  .description("Declare a boundary (stored in .matha/, PR-reviewed like any other change)")
  .requiredOption("--paths <paths>", "File or directory paths the boundary covers (comma-separated)")
  .requiredOption("--rule <rule>", "The rule — what must not happen here without sign-off")
  .option("--by <name>", "Who declares it (default: git user.name)")
  .option("--project <path>", "Project root path (default: current directory)")
  .action(async (options) => {
    const { runBoundaryAdd } = await import("./commands/boundary.js");
    const result = await runBoundaryAdd(options.project || process.cwd(), {
      paths: options.paths,
      rule: options.rule,
      by: options.by,
    });
    process.exit(result.exitCode);
  });
boundary
  .command("list")
  .description("List declared boundaries")
  .option("--project <path>", "Project root path (default: current directory)")
  .action(async (options) => {
    const { runBoundaryList } = await import("./commands/boundary.js");
    const result = await runBoundaryList(options.project || process.cwd());
    process.exit(result.exitCode);
  });

program
  .command("check")
  .description("Match changed files against the brain (advisory; --strict fails on criticals)")
  .option("--project <path>", "Project root path (default: current directory)")
  .option("--diff <base>", "Git base ref to diff against (default: working tree vs HEAD)")
  .option("--strict", "Exit 1 when a CRITICAL record matches the change")
  .action(async (options) => {
    const { runCheck } = await import("./commands/check.js");
    const result = await runCheck(options.project || process.cwd(), {
      diff: options.diff,
      strict: options.strict,
    });
    process.exit(result.exitCode);
  });

program
  .command("export")
  .description("Export a human-readable, PR-diffable markdown summary of the brain")
  .option("--project <path>", "Project root path (default: current directory)")
  .option("--md", "Markdown output (the only format, default)")
  .option("--out <path>", "Write to a file instead of stdout")
  .action(async (options) => {
    const { runExport } = await import("./commands/export.js");
    const result = await runExport(options.project || process.cwd(), { out: options.out });
    process.exit(result.exitCode);
  });

program
  .command("ui")
  .description("Generate a self-contained HTML brain report at .matha/report.html")
  .option("--project <path>", "Project root path (default: current directory)")
  .action(async (options) => {
    const { runUi } = await import("./commands/ui.js");
    const result = await runUi(options.project || process.cwd());
    process.exit(result.exitCode);
  });

program
  .command("onboard")
  .description("Print an agent prompt that seeds the brain from your project docs")
  .option("--project <path>", "Project root path (default: current directory)")
  .action(async (options) => {
    const { runOnboard } = await import("./commands/onboard.js");
    const result = await runOnboard(options.project || process.cwd());
    process.exit(result.exitCode);
  });

program
  .command("hooks")
  .description("Print (or --install) the Claude Code SessionStart hook that injects the brief")
  .option("--project <path>", "Project root path (default: current directory)")
  .option("--install", "Merge the hook into <project>/.claude/settings.json")
  .action(async (options) => {
    const { runHooks } = await import("./commands/hooks.js");
    const result = await runHooks(options.project || process.cwd(), { install: options.install });
    process.exit(result.exitCode);
  });

program
  .command("catchup")
  .description("List commits since the last recorded knowledge that no record covers (unaccounted work)")
  .option("--project <path>", "Project root path (default: current directory)")
  .action(async (options) => {
    const { runCatchup } = await import("./commands/catchup.js");
    const result = await runCatchup(options.project || process.cwd());
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
    } catch (err: any) {
      console.error("Failed to start MCP server:", err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
