# csv-checksum

**Hash-verify CSV data migrations.** Snapshot a CSV at the source, prove it arrived intact at the destination. Zero runtime dependencies.

```bash
npx csv-checksum snapshot users.csv --key id > manifest.json
# ... export from old system, import into new system ...
npx csv-checksum verify users.exported.csv manifest.json
# ✓ verified: 12,347 rows match the manifest (12,347 expected)
```

If a single record dropped, changed, or got reordered, you'll know about it before your customer does.

---

## Why this exists

Data migrations are scary because they're hard to verify. The usual approach — eyeballing record counts, spot-checking a few rows — misses the failure modes that actually matter: a silent type coercion that mangled phone numbers, a deduplication step that ate 0.4% of rows, a re-import that mapped two source fields to the same destination column.

`csv-checksum` gives you a cryptographic proof. Hash every row at the source. After the migration, re-hash the destination. If a single character is off in any field, the hash changes and the verification fails — loudly.

It's the same pattern you'd use for verifying a software download (`sha256sum`), applied to migration data.

---

## Install

```bash
# Run once with npx (no install)
npx csv-checksum --help

# Or install globally
npm i -g csv-checksum

# Or use the programmatic API
npm i csv-checksum
```

Requires Node.js 20+.

---

## The three commands

### `snapshot` — capture the source-of-truth

```bash
csv-checksum snapshot input.csv --key id -o input.manifest.json
```

Produces a JSON manifest containing one hash per row. The `--key` flag is the column to use as primary key — without it, rows are matched by position, which falls apart the moment the destination reorders them.

### `verify` — prove the destination matches

```bash
csv-checksum verify destination.csv input.manifest.json --key id
```

Exit code `0` if every row matches, `1` if anything's off. Add `--json` for machine-readable output you can pipe into a CI gate.

### `diff` — see exactly what changed

```bash
csv-checksum diff source.csv destination.csv --key id
```

Per-cell deltas for any row whose hash changed. Tells you the column, the before value, and the after value — so you can fix the mapping bug instead of guessing.

---

## How hashing works

For every row, the tool:

1. **Sorts the keys alphabetically** so column order doesn't affect the hash.
2. **Trims whitespace** from string values.
3. **Collapses internal runs of whitespace** to a single space — but only in prose fields. Numeric-looking values, emails, URLs, and UUIDs are left intact.
4. **Coerces numeric strings to numbers** so `"42"` and `42` hash identically.
5. **Treats empty string and null as equivalent**.
6. **Hashes the canonical [key, value] pairs** with SHA-256.

The hash is prefixed with `sha256:` so future versions can switch algorithms without breaking old manifests.

There's also a file-level hash computed over the sorted list of row hashes. This is order-independent — proves the two files contain the same set of rows regardless of what order each side emitted them.

If you need to ignore columns that are expected to differ between source and destination (e.g. `updated_at` timestamps that get refreshed on import), pass `--ignore`:

```bash
csv-checksum snapshot users.csv --key id --ignore updated_at,version
```

---

## Use it in CI

```yaml
# .github/workflows/migration-verify.yml
- name: Snapshot the source extract
  run: npx csv-checksum snapshot source.csv --key id -o source.manifest.json

- name: Run the migration
  run: ./migrate.sh

- name: Verify destination matches source
  run: npx csv-checksum verify destination.csv source.manifest.json --key id
  # Fails the job (exit 1) if any row drifted.
```

The verify command is idempotent and exits non-zero on any mismatch, so it slots cleanly into any CI step.

---

## Programmatic API

```ts
import { snapshot, verify, diff } from "csv-checksum";

const manifest = await snapshot("users.csv", { keyColumn: "id" });
const result = await verify("users.exported.csv", manifest);
if (!result.ok) {
  console.error(`Migration drift:`, result);
  process.exit(1);
}
```

Streaming under the hood — handles multi-gigabyte CSVs without loading them into memory. The full TypeScript API is exported from the package root and includes `parseCsv`, `hashRow`, `parseManifest`, and `diff` for finer-grained use.

---

## How is this different from…

- **`sha256sum users.csv`** — only proves the file is byte-identical. Won't survive a column reorder, a different line ending, or any export quirk. `csv-checksum` proves the *data* matches even when the file representation differs.
- **`diff source.csv dest.csv`** — line-based. Treats a row that moved to position 2 as a completely different row. Slow on large files. `csv-checksum diff` matches by primary key, ignores order, and reports per-cell deltas.
- **`comm`, `awk`, `jq`** — useful primitives that you can compose, but you'll spend a day rebuilding the type-coercion + whitespace normalization rules that make hash comparison actually robust against real-world exports.
- **CSV libraries with built-in validation (papaparse, csv-parse)** — those parse CSVs. `csv-checksum` uses parsing as a step toward integrity proof. Different layer of the stack.

---

## Limitations

- UTF-8 only. Latin-1 / Windows-1252 / Shift-JIS aren't auto-detected (yet).
- Single-character `,` delimiter only. Custom delimiters aren't supported (semicolon-separated "CSV" is technically TSV-adjacent and out of scope).
- No JSON / JSONL output yet — open a PR.
- Doesn't normalize timezones in date strings. If your source emits `2026-01-15T00:00:00-08:00` and your destination emits `2026-01-15T08:00:00Z`, those will hash differently. Parse and canonicalize dates before passing rows to `hashRow` if this matters.

---

## License

MIT. See [LICENSE](./LICENSE).

---

Made by the team behind [FlitStack AI](https://flitstack.ai) and [JetStack AI](https://jetstack.ai) — we move business data and run platform ops for a living. We open-sourced this because every migration we've ever shipped has needed some version of it.
