// Deterministic per-row hashing.
//
// Goal: the same row content always produces the same hash, regardless of
// the source platform's quirks (column ordering, whitespace, CR/LF style,
// numeric vs string formatting). Two CSVs of the same data exported from
// two different systems should produce identical row hashes if the values
// are semantically equal.
//
// Normalization rules applied before hashing:
//   1. Keys are sorted alphabetically (column order doesn't matter).
//   2. String values are trimmed of leading/trailing whitespace.
//   3. Internal runs of whitespace collapse to a single space, but only
//      inside fields that look like prose. Numeric-looking and structured
//      fields (UUIDs, emails, URLs) are left intact.
//   4. Numbers are emitted as canonical JSON numbers (no leading zeros,
//      no trailing .0 for integers, scientific notation rules per JSON).
//   5. The empty string and `null` are treated as equivalent.
//
// Out of scope: locale-aware string normalization (Unicode NFC), timezone
// canonicalization for dates. Both can be layered on as preprocessing
// before passing rows to `hashRow`.

import { createHash } from "node:crypto";

export interface HashOptions {
  /**
   * Columns to ignore when computing the hash. Useful when one side of a
   * migration adds derived columns (timestamps, audit trails) the other
   * side doesn't have. Comparison example: ["created_at", "updated_at"].
   */
  ignore?: ReadonlyArray<string>;
  /**
   * Whether to collapse internal whitespace inside string values. Default
   * `true`. Disable for fields where multi-space is meaningful (e.g. fixed
   * indent in markdown content).
   */
  collapseWhitespace?: boolean;
}

const WHITESPACE_RUN = /\s+/g;
const NUMERIC_LIKE = /^-?\d+(\.\d+)?$/;
const STRUCTURED_LIKE = /^[\w.-]+@[\w.-]+\.[a-z]+$|^https?:\/\/|^[0-9a-f]{8}-[0-9a-f]{4}/i;

function normalizeValue(value: unknown, collapse: boolean): string | number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value);
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // Coerce numeric-looking strings to numbers so "42" and 42 hash identically.
  if (NUMERIC_LIKE.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }

  if (!collapse || STRUCTURED_LIKE.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(WHITESPACE_RUN, " ");
}

/**
 * Hash a single row to a hex SHA-256. The returned hash is prefixed with
 * `sha256:` so future versions can switch algorithms (sha512, blake3) and
 * old manifests remain interpretable.
 */
export function hashRow(
  row: Readonly<Record<string, unknown>>,
  options: Readonly<HashOptions> = {},
): string {
  const ignore = new Set(options.ignore ?? []);
  const collapse = options.collapseWhitespace ?? true;

  const keys = Object.keys(row).filter((k) => !ignore.has(k)).sort();
  const normalized: Array<[string, string | number | null]> = [];
  for (const k of keys) {
    normalized.push([k, normalizeValue(row[k], collapse)]);
  }

  // Use JSON of the sorted [key, value] pairs as the canonical wire form.
  // JSON.stringify produces deterministic output for our normalized values
  // (no objects nested under keys, no Dates, no functions).
  const canonical = JSON.stringify(normalized);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${digest}`;
}

/**
 * Hash an arbitrary string (used for the file-level hash and for incremental
 * hashing of large content streams).
 */
export function hashString(s: string): string {
  return `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
}
