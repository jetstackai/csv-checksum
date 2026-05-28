#!/usr/bin/env node
// CLI entry point. Three commands: snapshot, verify, diff. Each parses
// its own flag set so we don't pull in a flag-parser dependency.
//
// Exit codes:
//   0 — success (verify/diff produced no differences, snapshot completed)
//   1 — differences found (verify/diff) or unrecoverable error (snapshot)
//   2 — bad CLI usage

import { readFileSync, writeFileSync } from "node:fs";
import { snapshot, verify, parseManifest } from "./manifest.js";
import { diff } from "./diff.js";

const USAGE = `csv-checksum — hash-verify CSV data migrations.

Usage:
  csv-checksum snapshot <input.csv> [--key <column>] [--ignore <col[,col...]>] [-o <out.json>]
  csv-checksum verify   <input.csv> <manifest.json> [--key <column>] [--ignore <col[,col...]>] [--json]
  csv-checksum diff     <a.csv> <b.csv> --key <column> [--ignore <col[,col...]>] [--json]

Common options:
  --key <column>          Primary-key column. Required for diff; recommended
                          for snapshot/verify so order-independent matching
                          works.
  --ignore <col[,col...]> Columns to exclude from hashing (e.g. audit
                          timestamps that differ between source and dest).
  --json                  Machine-readable JSON output (verify, diff).
  -o, --output <file>     Write to file instead of stdout.
  -h, --help              Show this message.

Examples:
  csv-checksum snapshot users.csv --key id -o users.manifest.json
  csv-checksum verify users.exported.csv users.manifest.json --key id
  csv-checksum diff source.csv destination.csv --key id --ignore updated_at
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--key") {
      flags.key = argv[++i] ?? "";
    } else if (arg === "--ignore") {
      flags.ignore = argv[++i] ?? "";
    } else if (arg === "-o" || arg === "--output") {
      flags.output = argv[++i] ?? "";
    } else if (arg.startsWith("--")) {
      die(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function die(message: string, code = 2): never {
  process.stderr.write(`csv-checksum: ${message}\n`);
  if (code === 2) process.stderr.write(`\n${USAGE}`);
  process.exit(code);
}

function writeOut(content: string, target: string | undefined): void {
  if (target) writeFileSync(target, content);
  else process.stdout.write(content);
}

function ignoreList(flag: string | true | undefined): string[] | undefined {
  if (typeof flag !== "string" || flag === "") return undefined;
  return flag.split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const { positional, flags } = parseArgs(rest);
  if (flags.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const ignore = ignoreList(flags.ignore);
  const key = typeof flags.key === "string" ? flags.key : undefined;

  switch (command) {
    case "snapshot": {
      const [csv] = positional;
      if (!csv) die("snapshot requires an input CSV path");
      const manifest = await snapshot(csv, {
        ...(key ? { keyColumn: key } : {}),
        ...(ignore ? { ignore } : {}),
      });
      const output = typeof flags.output === "string" ? flags.output : undefined;
      writeOut(JSON.stringify(manifest, null, 2) + "\n", output);
      process.exit(0);
      break;
    }

    case "verify": {
      const [csv, manifestPath] = positional;
      if (!csv || !manifestPath) {
        die("verify requires an input CSV path and a manifest path");
      }
      const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
      const result = await verify(csv, manifest, {
        ...(key ? { keyColumn: key } : {}),
        ...(ignore ? { ignore } : {}),
      });

      if (flags.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        process.stdout.write(formatVerifyHuman(result));
      }
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case "diff": {
      const [a, b] = positional;
      if (!a || !b) die("diff requires two CSV paths");
      if (!key) die("diff requires --key <column>");
      const result = await diff(a, b, {
        keyColumn: key,
        ...(ignore ? { ignore } : {}),
      });

      if (flags.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        process.stdout.write(formatDiffHuman(result));
      }
      const hasDiff =
        result.added.length > 0 ||
        result.removed.length > 0 ||
        result.changed.length > 0;
      process.exit(hasDiff ? 1 : 0);
      break;
    }

    default:
      die(`Unknown command: ${command}`);
  }
}

function formatVerifyHuman(result: Awaited<ReturnType<typeof verify>>): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(
      `✓ verified: ${result.rowCount.actual} rows match the manifest (${result.rowCount.manifest} expected)`,
    );
  } else {
    lines.push(
      `✗ verification failed: ${result.rowCount.actual} rows seen, ${result.rowCount.manifest} expected`,
    );
    if (result.missing.length > 0) {
      lines.push(`  missing (${result.missing.length}):`);
      for (const k of result.missing.slice(0, 10)) lines.push(`    - ${k}`);
      if (result.missing.length > 10) lines.push(`    ... ${result.missing.length - 10} more`);
    }
    if (result.added.length > 0) {
      lines.push(`  added (${result.added.length}):`);
      for (const k of result.added.slice(0, 10)) lines.push(`    + ${k}`);
      if (result.added.length > 10) lines.push(`    ... ${result.added.length - 10} more`);
    }
    if (result.changed.length > 0) {
      lines.push(`  changed (${result.changed.length}):`);
      for (const k of result.changed.slice(0, 10)) lines.push(`    ~ ${k}`);
      if (result.changed.length > 10) lines.push(`    ... ${result.changed.length - 10} more`);
    }
  }
  return lines.join("\n") + "\n";
}

function formatDiffHuman(result: Awaited<ReturnType<typeof diff>>): string {
  const lines: string[] = [];
  const total =
    result.added.length + result.removed.length + result.changed.length;
  if (total === 0) {
    lines.push(`✓ no differences (${result.unchangedCount} rows matched)`);
  } else {
    lines.push(
      `${total} difference${total === 1 ? "" : "s"} found ` +
        `(${result.unchangedCount} rows matched, ` +
        `+${result.added.length} added, ` +
        `-${result.removed.length} removed, ` +
        `~${result.changed.length} changed)`,
    );
    for (const r of result.removed.slice(0, 5)) lines.push(`  - ${r.key}`);
    for (const r of result.added.slice(0, 5)) lines.push(`  + ${r.key}`);
    for (const r of result.changed.slice(0, 5)) {
      lines.push(`  ~ ${r.key}`);
      for (const c of r.cells.slice(0, 3)) {
        lines.push(`      ${c.column}: ${c.before} → ${c.after}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`csv-checksum: ${message}\n`);
  process.exit(1);
});
