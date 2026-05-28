// Diff two CSVs by primary key.
//
// Output shape mirrors a unified diff: which rows were added (in B not in A),
// removed (in A not in B), and changed (key matched but content differed).
// For changed rows, the per-column delta is computed so the caller can see
// exactly what drifted — useful for migration validation reports that need
// to show "this field changed from X to Y".

import { hashRow, type HashOptions } from "./hash.js";
import { parseCsv } from "./parse.js";

export interface DiffOptions extends HashOptions {
  /** Required: column to use as primary key in both inputs. */
  keyColumn: string;
}

export interface CellDiff {
  column: string;
  before: string;
  after: string;
}

export interface ChangedRow {
  key: string;
  cells: CellDiff[];
}

export interface DiffResult {
  /** Rows in A whose key has no match in B. */
  removed: Array<{ key: string; row: Record<string, string> }>;
  /** Rows in B whose key has no match in A. */
  added: Array<{ key: string; row: Record<string, string> }>;
  /** Rows whose key matched but at least one cell differed. */
  changed: ChangedRow[];
  /** Rows whose hash matched on both sides. */
  unchangedCount: number;
}

export async function diff(
  aPath: string,
  bPath: string,
  options: Readonly<DiffOptions>,
): Promise<DiffResult> {
  const aRows = new Map<string, Record<string, string>>();
  for await (const row of parseCsv(aPath)) {
    const key = row[options.keyColumn];
    if (key == null || key === "") continue;
    aRows.set(key, row);
  }

  const removed: DiffResult["removed"] = [];
  const added: DiffResult["added"] = [];
  const changed: ChangedRow[] = [];
  let unchangedCount = 0;
  const seenInB = new Set<string>();

  for await (const row of parseCsv(bPath)) {
    const key = row[options.keyColumn];
    if (key == null || key === "") continue;
    seenInB.add(key);

    const a = aRows.get(key);
    if (a === undefined) {
      added.push({ key, row });
      continue;
    }

    const aHash = hashRow(a, options);
    const bHash = hashRow(row, options);
    if (aHash === bHash) {
      unchangedCount++;
      continue;
    }

    // Build per-cell diff for changed rows. Union of keys from both sides
    // catches columns that exist on one side but not the other.
    const columns = new Set([...Object.keys(a), ...Object.keys(row)]);
    const cells: CellDiff[] = [];
    for (const col of columns) {
      const before = a[col] ?? "";
      const after = row[col] ?? "";
      if (before !== after) cells.push({ column: col, before, after });
    }
    if (cells.length > 0) changed.push({ key, cells });
  }

  for (const [key, row] of aRows) {
    if (!seenInB.has(key)) removed.push({ key, row });
  }

  return { removed, added, changed, unchangedCount };
}
