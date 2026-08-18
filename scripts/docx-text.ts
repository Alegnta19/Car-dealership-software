/**
 * FBL-020-R5 §3.4 — READ THE ACTUAL DOCUMENT.
 *
 * The R4 documentation test compared the delivery report against a fact set held in
 * `docs/FBL-020-R*-REQUIREMENT-MAP.json`. Both files are written by the implementation, so
 * the check could only ever prove that two of our own documents agree — and they can be
 * wrong together, which is precisely what happened: the recorded citation was ambiguous
 * between two blueprints whose §14.3 are different orders — Version 1.0 reads FBL-000
 * there, Version 2.0 reads FBL-020-R2 — and no test could see it.
 *
 * A check with an external anchor needs the document itself. This module opens a `.docx`
 * — a ZIP holding `word/document.xml` — and returns its paragraphs, using only `node:zlib`
 * so nothing is added to the dependency tree for a documentation gate.
 *
 * WHAT IT DOES NOT DO, stated because the gate's worth depends on its reach: it reads
 * paragraph text from the main document part only. Headers, footers, footnotes, text
 * boxes, and text inside embedded objects are not read, and no formatting is interpreted.
 * A heading is recognised only by its paragraph style id, so a document that styles
 * headings some other way yields paragraphs with an empty `style`. That is enough for the
 * facts §3.1 pins — a title, a version line and the §14 headings — and it is not a
 * general-purpose converter.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { inflateRawSync } from 'zlib';

/** One paragraph of a Word document: its style id (may be empty) and its text. */
export interface DocxParagraph {
  style: string;
  text: string;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;

/** The end-of-central-directory record, searched from the end as the format requires. */
function findEndOfCentralDirectory(zip: Buffer): number {
  for (let at = zip.length - 22; at >= 0; at -= 1) {
    if (zip.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return at;
  }
  throw new Error('not a ZIP archive: no end-of-central-directory record');
}

/** Extract one named entry from a ZIP archive. */
function readZipEntry(zip: Buffer, wanted: string): Buffer {
  const eocd = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(at) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error(`corrupt ZIP: bad central directory header at ${at}`);
    }
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const compressedSize = zip.readUInt32LE(at + 20);
    const localHeaderAt = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');

    if (name === wanted) {
      if (zip.readUInt32LE(localHeaderAt) !== LOCAL_HEADER_SIGNATURE) {
        throw new Error(`corrupt ZIP: bad local header for ${name}`);
      }
      const method = zip.readUInt16LE(localHeaderAt + 8);
      const localNameLength = zip.readUInt16LE(localHeaderAt + 26);
      const localExtraLength = zip.readUInt16LE(localHeaderAt + 28);
      const dataAt = localHeaderAt + 30 + localNameLength + localExtraLength;
      const data = zip.subarray(dataAt, dataAt + compressedSize);
      if (method === STORED) return Buffer.from(data);
      if (method === DEFLATED) return inflateRawSync(data);
      throw new Error(`unsupported ZIP compression method ${method} for ${name}`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${wanted}`);
}

function decodeXmlText(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

/** Every paragraph of the main document part, in document order. */
export function docxParagraphs(path: string): DocxParagraph[] {
  const xml = readZipEntry(readFileSync(path), 'word/document.xml').toString('utf8');
  const paragraphs: DocxParagraph[] = [];
  // Split on the paragraph element rather than matching it, so a paragraph containing
  // nested content (a hyperlink run, a bookmark) is not skipped by a greedy pattern.
  const chunks = xml.split(/<w:p[ >]/).slice(1);
  for (const chunk of chunks) {
    const runs = [...chunk.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1] ?? '');
    const style = /<w:pStyle w:val="([^"]+)"/.exec(chunk)?.[1] ?? '';
    paragraphs.push({ style, text: decodeXmlText(runs.join('')) });
  }
  return paragraphs;
}

/** Paragraph text only, trimmed, with empties dropped. */
export function docxLines(path: string): string[] {
  return docxParagraphs(path)
    .map((p) => p.text.trim())
    .filter((text) => text !== '');
}

/**
 * Paragraphs whose style id names a heading level, as `{ level, text }`.
 * A document that does not use Word's built-in heading styles yields nothing here, which
 * is why callers that must not silently pass assert on the count they expect.
 */
export function docxHeadings(path: string): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  for (const p of docxParagraphs(path)) {
    const level = /^Heading([1-9])$/.exec(p.style)?.[1];
    const text = p.text.trim();
    if (level !== undefined && text !== '') headings.push({ level: Number(level), text });
  }
  return headings;
}

/** sha256 of the file's bytes exactly as they sit on disk. */
export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Byte length of the file on disk. */
export function fileBytes(path: string): number {
  return readFileSync(path).length;
}

function main(): void {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('Usage: docx-text.ts <file.docx> [--headings]');
    process.exit(2);
  }
  process.stdout.write(`${path}\n  sha256 ${fileSha256(path)}\n  bytes  ${fileBytes(path)}\n\n`);
  const lines = process.argv.includes('--headings')
    ? docxHeadings(path).map((h) => `${'#'.repeat(h.level)} ${h.text}`)
    : docxLines(path);
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (require.main === module) main();
