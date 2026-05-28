// Public programmatic API. Use these imports in Node scripts to build
// migration validation into your own ETL pipeline. The CLI under `cli.ts`
// is the same API wrapped in argv handling.

export { parseCsv, parseCsvRaw } from "./parse.js";
export { hashRow, hashString, type HashOptions } from "./hash.js";
export {
  snapshot,
  verify,
  parseManifest,
  MANIFEST_VERSION,
  type Manifest,
  type SnapshotOptions,
  type VerifyOptions,
  type VerifyResult,
} from "./manifest.js";
export {
  diff,
  type DiffOptions,
  type DiffResult,
  type ChangedRow,
  type CellDiff,
} from "./diff.js";
