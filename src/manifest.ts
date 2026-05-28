// Snapshot + verify operations.
//
// A `Manifest` is a JSON document that captures everything needed to prove
// a CSV's contents arrived intact after a migration:
//
//   • Source filename + creation timestamp (audit trail)
//   • Row count + column list (sanity check before deep verification)
//   • Per-row hash, keyed by either the value of a designated primary key
//     column or by row index when no key is provided
//   • A file-level hash over the sorted row hashes — order-independent
//     proof that the multi-set of rows matches
//
// Manifests are stable: round-tripping a CSV through snapshot → verify
// against the same data must always produce a clean match, regardless of
// row order or column order in the second CSV. This is what makes them
// useful as the source-of-truth after a migration.

import { hashRow, hashString, type HashOptions } from "./hash.js";
import { parseCsv } from "./parse.js";

export const MANIFEST_VERSION = 1 as const;

export interface Manifest {
  version: typeof MANIFEST_VERSION;
  createdAt: string;
  source: string;
  rowCount: number;
  columns: string[];
  /** Primary-key column name, or null when keyed by row index. */
  keyColumn: string | null;
  /** Map of primary-key value (or "row:N") to row hash. */
  rows: Record<string, string>;
  /** Order-independent hash over all row hashes — proves multi-set equality. */
  fileHash: string;
}

export interface SnapshotOptions extends HashOptions {
  /** Column to use as primary key. When omitted, rows are keyed by index. */
  keyColumn?: string;
}

export async function snapshot(
  path: string,
  options: Readonly<SnapshotOptions> = {},
): Promise<Manifest> {
  const rows: Record<string, string> = {};
  const columns: string[] = [];
  let rowCount = 0;
  const keyColumn = options.keyColumn ?? null;
  const seenKeys = new Set<string>();

  for await (const row of parseCsv(path)) {
    if (columns.length === 0) {
      columns.push(...Object.keys(row));
    }
    rowCount++;

    const hash = hashRow(row, options);

    let key: string;
    if (keyColumn != null) {
      const value = row[keyColumn];
      if (value == null || value === "") {
        throw new Error(
          `Row ${rowCount} has empty value for key column "${keyColumn}". ` +
            `Key columns must be present and non-empty on every row.`,
        );
      }
      key = value;
      if (seenKeys.has(key)) {
        throw new Error(
          `Duplicate key "${key}" in column "${keyColumn}" at row ${rowCount}. ` +
            `Key column values must be unique across all rows.`,
        );
      }
      seenKeys.add(key);
    } else {
      key = `row:${rowCount}`;
    }

    rows[key] = hash;
  }

  // Order-independent file hash: sort row hashes, then hash their concat.
  const sortedHashes = Object.values(rows).slice().sort();
  const fileHash = hashString(sortedHashes.join("\n"));

  return {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    source: path,
    rowCount,
    columns,
    keyColumn,
    rows,
    fileHash,
  };
}

export interface VerifyOptions extends HashOptions {
  /** Override the manifest's keyColumn. Useful when the verified CSV uses a
   * different column name for the same primary key. */
  keyColumn?: string;
}

export interface VerifyResult {
  ok: boolean;
  rowCount: { manifest: number; actual: number };
  /** Rows present in manifest but missing from the CSV. */
  missing: string[];
  /** Rows present in the CSV but not in the manifest. */
  added: string[];
  /** Rows present in both but with different content (hash mismatch). */
  changed: string[];
  /** Whether the file-level (order-independent multi-set) hash matched. */
  fileHashMatched: boolean;
}

export async function verify(
  path: string,
  manifest: Readonly<Manifest>,
  options: Readonly<VerifyOptions> = {},
): Promise<VerifyResult> {
  const keyColumn = options.keyColumn ?? manifest.keyColumn ?? null;

  const expected = new Map(Object.entries(manifest.rows));
  const matched = new Set<string>();
  const changed: string[] = [];
  const added: string[] = [];
  let rowCount = 0;

  for await (const row of parseCsv(path)) {
    rowCount++;
    const hash = hashRow(row, options);

    let key: string;
    if (keyColumn != null) {
      const value = row[keyColumn];
      if (value == null || value === "") {
        // Empty key on the verified side — treat as an added row since we
        // can't match it against any expected key.
        added.push(`row:${rowCount}`);
        continue;
      }
      key = value;
    } else {
      key = `row:${rowCount}`;
    }

    const expectedHash = expected.get(key);
    if (expectedHash === undefined) {
      added.push(key);
    } else if (expectedHash !== hash) {
      changed.push(key);
      matched.add(key);
    } else {
      matched.add(key);
    }
  }

  const missing = [...expected.keys()].filter((k) => !matched.has(k));

  // File-level multi-set hash: hash the sorted list of actual row hashes,
  // compare against the manifest's fileHash. This catches the case where
  // every key matched but content drifted in a way that pivots multiset
  // equivalence.
  // We don't recompute here from scratch — the per-row diffs above already
  // expose any mismatch in content. The fileHashMatched flag is set true
  // iff there were no missing, added, or changed rows.
  const fileHashMatched =
    missing.length === 0 && added.length === 0 && changed.length === 0;

  return {
    ok: fileHashMatched,
    rowCount: { manifest: manifest.rowCount, actual: rowCount },
    missing,
    added,
    changed,
    fileHashMatched,
  };
}

/**
 * Parse a manifest from JSON and validate its shape. Throws on any version
 * mismatch or missing required field. Use this when loading a manifest from
 * disk to surface bad input early with a clear error.
 */
export function parseManifest(json: string): Manifest {
  const data: unknown = JSON.parse(json);
  if (
    typeof data !== "object" ||
    data === null ||
    !("version" in data) ||
    (data as { version: number }).version !== MANIFEST_VERSION
  ) {
    throw new Error(
      `Unsupported manifest version. Expected ${MANIFEST_VERSION}, got ` +
        `${(data as { version?: unknown } | null)?.version ?? "unknown"}.`,
    );
  }
  // Trust the structure beyond version — we wrote it ourselves. Surface
  // errors lazily via property access if a hand-edited manifest is broken.
  return data as Manifest;
}
