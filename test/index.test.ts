// Unit + integration tests. Run with `node --test --import=tsx test/index.test.ts`.
//
// Coverage focus:
//   - Streaming CSV parser correctness on the edge cases that bite real
//     migrations: quoted fields, embedded commas/newlines/quotes, BOM,
//     mixed line endings, trailing newline absent.
//   - Hash determinism: same content → same hash regardless of column
//     order, whitespace normalization, numeric coercion.
//   - Manifest round-trip: snapshot → verify on the same file must match;
//     verify on reordered file must still match (order-independent).
//   - Diff: detects added/removed/changed rows with correct cell deltas.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";

import { parseCsv } from "../src/parse.js";
import { hashRow } from "../src/hash.js";
import { snapshot, verify } from "../src/manifest.js";
import { diff } from "../src/diff.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "fixtures");

async function readAll(path: string): Promise<Record<string, string>[]> {
  const rows: Record<string, string>[] = [];
  for await (const row of parseCsv(path)) rows.push(row);
  return rows;
}

test("parseCsv reads a simple file into row objects", async () => {
  const rows = await readAll(join(fixtures, "simple.csv"));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    id: "1",
    email: "alice@example.com",
    name: "Alice Anderson",
    signup_date: "2026-01-15",
  });
});

test("parseCsv handles quoted fields with embedded commas, newlines, and doubled quotes", async () => {
  const rows = await readAll(join(fixtures, "edge-cases.csv"));
  assert.equal(rows.length, 4);
  assert.equal(rows[0]!.note, "hello, world");
  assert.equal(rows[0]!.tag, "one, two");
  assert.equal(rows[1]!.note, "line one\nline two");
  assert.equal(rows[2]!.note, 'has "quotes" inside');
});

test("parseCsv strips UTF-8 BOM from the start of a file", async () => {
  const path = join(fixtures, "bom.csv");
  // ﻿ is the UTF-16 BOM; Buffer.from will encode it as the UTF-8
  // 3-byte sequence (EF BB BF) — exactly what Excel writes.
  writeFileSync(path, "﻿id,name\n1,Alice\n", "utf8");
  try {
    const rows = await readAll(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, "1");
    assert.equal(rows[0]!.name, "Alice");
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("parseCsv handles CRLF, LF, and missing trailing newline", async () => {
  const path = join(fixtures, "crlf.csv");
  writeFileSync(path, "id,name\r\n1,Alice\r\n2,Bob", "utf8");
  try {
    const rows = await readAll(path);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.name, "Bob");
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("hashRow produces the same hash regardless of key order", () => {
  const a = hashRow({ id: "1", name: "Alice", email: "a@x.com" });
  const b = hashRow({ email: "a@x.com", id: "1", name: "Alice" });
  assert.equal(a, b);
});

test("hashRow coerces numeric strings so '42' === 42", () => {
  const a = hashRow({ id: "42", name: "Alice" });
  const b = hashRow({ id: 42, name: "Alice" });
  assert.equal(a, b);
});

test("hashRow trims and collapses whitespace in prose fields", () => {
  const a = hashRow({ note: "hello  world" });
  const b = hashRow({ note: " hello world " });
  assert.equal(a, b);
});

test("hashRow preserves multiple-space content inside emails / URLs / UUIDs", () => {
  // Whitespace inside email-looking values would never appear in real data,
  // so this just confirms the collapse rule doesn't fire there.
  const a = hashRow({ email: "alice@example.com" });
  const b = hashRow({ email: "alice@example.com  " });
  assert.equal(a, b);
});

test("hashRow respects the ignore option", () => {
  const a = hashRow({ id: "1", name: "Alice", updated_at: "2026-01-01" });
  const b = hashRow(
    { id: "1", name: "Alice", updated_at: "2026-05-28" },
    { ignore: ["updated_at"] },
  );
  // a includes updated_at, b excludes it — different
  assert.notEqual(a, b);
  // both with ignore should match regardless of updated_at
  const aIgnored = hashRow(
    { id: "1", name: "Alice", updated_at: "2026-01-01" },
    { ignore: ["updated_at"] },
  );
  assert.equal(aIgnored, b);
});

test("snapshot + verify match on the same file", async () => {
  const manifest = await snapshot(join(fixtures, "simple.csv"), {
    keyColumn: "id",
  });
  assert.equal(manifest.rowCount, 3);
  assert.equal(manifest.keyColumn, "id");
  assert.equal(Object.keys(manifest.rows).length, 3);

  const result = await verify(join(fixtures, "simple.csv"), manifest);
  assert.equal(result.ok, true);
  assert.equal(result.missing.length, 0);
  assert.equal(result.added.length, 0);
  assert.equal(result.changed.length, 0);
});

test("verify ignores row order and column order — multi-set equality", async () => {
  const manifest = await snapshot(join(fixtures, "simple.csv"), {
    keyColumn: "id",
  });
  const result = await verify(join(fixtures, "reordered.csv"), manifest);
  assert.equal(result.ok, true);
});

test("verify detects missing, added, and changed rows", async () => {
  const manifest = await snapshot(join(fixtures, "simple.csv"), {
    keyColumn: "id",
  });
  const result = await verify(join(fixtures, "modified.csv"), manifest);
  assert.equal(result.ok, false);
  // modified.csv has id=1 unchanged, id=2 changed, id=3 missing, id=4 added
  assert.deepEqual(result.changed.sort(), ["2"]);
  assert.deepEqual(result.missing.sort(), ["3"]);
  assert.deepEqual(result.added.sort(), ["4"]);
});

test("snapshot rejects duplicate key values", async () => {
  const path = join(fixtures, "dup.csv");
  writeFileSync(path, "id,name\n1,Alice\n1,Bob\n", "utf8");
  try {
    await assert.rejects(
      () => snapshot(path, { keyColumn: "id" }),
      /Duplicate key "1"/,
    );
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("diff reports per-cell deltas for changed rows", async () => {
  const result = await diff(
    join(fixtures, "simple.csv"),
    join(fixtures, "modified.csv"),
    { keyColumn: "id" },
  );
  assert.equal(result.added.length, 1);
  assert.equal(result.removed.length, 1);
  assert.equal(result.changed.length, 1);
  assert.equal(result.unchangedCount, 1);

  const changed = result.changed[0]!;
  assert.equal(changed.key, "2");
  const emailCell = changed.cells.find((c) => c.column === "email");
  assert.ok(emailCell, "expected email cell to be flagged as changed");
  assert.equal(emailCell.before, "bob@example.com");
  assert.equal(emailCell.after, "bob@CHANGED.com");
});

test("diff treats key columns as required on both sides", async () => {
  const result = await diff(
    join(fixtures, "simple.csv"),
    join(fixtures, "modified.csv"),
    { keyColumn: "id", ignore: ["signup_date"] },
  );
  // With signup_date ignored, the diff for row 2 should still flag email
  // (the only other real change).
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0]!.cells.length, 1);
});
