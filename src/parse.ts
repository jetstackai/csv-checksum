// Streaming RFC 4180 CSV parser. Implemented from scratch so the published
// package has zero runtime dependencies — small surface area, easier to audit.
//
// Handles every quirk that RFC 4180 (and real-world exporters) actually
// produce:
//   • Quoted fields with embedded commas, CR, LF, and "" escapes
//   • CRLF, LF, or CR line endings (mixed within one file)
//   • Leading UTF-8 BOM (Excel exports add this)
//   • Trailing newline / no trailing newline
//   • Empty fields, empty rows (skipped)
//
// Out of scope: encodings other than UTF-8, custom delimiters, comment
// lines, multi-character quote chars. Add behind opt-in flags if needed.

import { createReadStream } from "node:fs";

const COMMA = 0x2c;
const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;

/**
 * Streaming async iterator over CSV rows. Each iteration yields a record
 * object whose keys are the header row's column names.
 *
 * The header is consumed from the first non-empty row of the file. If a
 * data row has more values than the header, extra values are dropped. If
 * fewer, missing columns map to the empty string.
 */
export async function* parseCsv(
  path: string,
): AsyncGenerator<Record<string, string>, void, void> {
  let header: string[] | null = null;
  for await (const row of parseCsvRaw(path)) {
    if (!header) {
      header = row;
      continue;
    }
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i];
      if (!key) continue;
      obj[key] = row[i] ?? "";
    }
    yield obj;
  }
}

/**
 * Lower-level form that yields raw arrays of strings (one per field) instead
 * of objects. Used by callers that need to inspect the header explicitly
 * (e.g. to validate it against an expected schema).
 */
export async function* parseCsvRaw(
  path: string,
): AsyncGenerator<string[], void, void> {
  const stream = createReadStream(path);
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let prevByte: number | null = null;
  let isFirstByte = true;

  const finishField = () => {
    row.push(field);
    field = "";
  };

  const finishRow = (): string[] | null => {
    finishField();
    const out = row;
    row = [];
    if (out.length === 1 && out[0] === "") return null;
    return out;
  };

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    for (let i = 0; i < chunk.length; i++) {
      let byte = chunk[i]!;

      // Strip UTF-8 BOM if it's the very first three bytes (0xEF 0xBB 0xBF).
      // We only need to check the first byte: if it's 0xEF, skip the BOM
      // sequence outright.
      if (isFirstByte) {
        isFirstByte = false;
        if (
          byte === 0xef &&
          chunk[i + 1] === 0xbb &&
          chunk[i + 2] === 0xbf
        ) {
          i += 2;
          continue;
        }
      }

      if (inQuotes) {
        if (byte === QUOTE) {
          // Doubled quote inside a quoted field → literal quote.
          if (chunk[i + 1] === QUOTE) {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += String.fromCharCode(byte);
        }
      } else {
        if (byte === QUOTE) {
          inQuotes = true;
        } else if (byte === COMMA) {
          finishField();
        } else if (byte === LF) {
          // Treat CRLF as a single record terminator by skipping LF when
          // the previous byte was CR.
          if (prevByte === CR) {
            prevByte = byte;
            continue;
          }
          const r = finishRow();
          if (r) yield r;
        } else if (byte === CR) {
          const r = finishRow();
          if (r) yield r;
        } else {
          field += String.fromCharCode(byte);
        }
      }

      prevByte = byte;
    }
  }

  // Flush trailing field / row if the file didn't end with a newline.
  if (field !== "" || row.length > 0) {
    const r = finishRow();
    if (r) yield r;
  }
}
