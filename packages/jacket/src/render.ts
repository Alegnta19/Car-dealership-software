/**
 * OUTCOME 4 — THE RENDERER, WHICH IS A PURE FUNCTION OR IT IS NOTHING.
 *
 * "Render versioned document packages deterministically."
 *
 * A document is the template body with every `{{field_code}}` replaced by the
 * assembled field's value, wrapped in the smallest HTML that reads as a
 * document. NOTHING ELSE goes in: no timestamp, no request id, no "rendered by",
 * no random anything. Same template bytes, same fields, same output bytes —
 * which is what lets `document_blobs` be keyed by content and lets a test prove
 * determinism by rendering twice and comparing digests.
 *
 * A PLACEHOLDER NOBODY FILLED IS A RENDER FAILURE, NOT A BLANK. A contract with
 * an empty amount is worse than no contract, so an unresolved placeholder
 * refuses the render and names the field; the assembler records the failure
 * where the board can see it (Outcome 6's "render failure" queue) and renders
 * nothing.
 *
 * MONEY IS FORMATTED FROM CENTS, ONCE, HERE. The renderer receives a bigint and
 * writes `$45,500.00 USD`; it never receives a float and never writes one.
 * Every field value is HTML-escaped, so a customer named `<b>` is a customer
 * named `<b>` on paper.
 */
import { formatCents } from '@dealer/desking';

import type { TemplateApprovalStatus } from './configuration';

export type FieldValueKind = 'text' | 'money' | 'integer' | 'rate_ppm' | 'date';

/** One assembled field: a value with its kind and where it came from. */
export interface AssembledField {
  readonly fieldCode: string;
  readonly valueKind: FieldValueKind;
  readonly valueText: string | null;
  readonly valueCents: bigint | null;
  readonly valueInteger: bigint | null;
  readonly currency: string | null;
  readonly sourceKind: string;
  readonly sourceId: string | null;
  readonly sourceVersion: string;
}

const PLACEHOLDER = /\{\{\s*([a-z0-9_.]{2,60})\s*\}\}/g;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Cents as `$1,234.56 USD`: the one place a figure becomes words. */
export function moneyWords(cents: bigint, currency: string): string {
  const plain = formatCents(cents);
  const negative = plain.startsWith('-');
  const [whole, part] = plain.replace('-', '').split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${part ?? '00'} ${currency}`;
}

export function ppmWords(ppm: bigint): string {
  // parts per million → percent with four decimals, exactly, no float
  const negative = ppm < 0n;
  const magnitude = negative ? -ppm : ppm;
  const whole = magnitude / 10000n;
  const frac = (magnitude % 10000n).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}%`;
}

export function fieldWords(field: AssembledField): string {
  switch (field.valueKind) {
    case 'money':
      return moneyWords(field.valueCents ?? 0n, field.currency ?? 'USD');
    case 'rate_ppm':
      return ppmWords(field.valueInteger ?? 0n);
    case 'integer':
      return (field.valueInteger ?? 0n).toString();
    case 'text':
    case 'date':
    default:
      return field.valueText ?? '';
  }
}

export type RenderOutcome =
  | { outcome: 'rendered'; html: string; placeholders: readonly string[] }
  | { outcome: 'unresolved'; missing: readonly string[] };

export interface RenderInput {
  readonly title: string;
  readonly templateCode: string;
  readonly templateVersion: number;
  readonly bodyTemplate: string;
  readonly approvalStatus: TemplateApprovalStatus;
  readonly source: string;
  readonly jurisdiction: string;
  readonly fields: readonly AssembledField[];
  readonly packageVersionNo: number;
}

/** What a document says about its own template, in words a reader cannot miss. */
export function approvalSentence(status: TemplateApprovalStatus, source: string): string {
  switch (status) {
    case 'approved':
      return `Template approved for use in the stated jurisdiction. Source: ${source}.`;
    case 'withdrawn':
      return `TEMPLATE WITHDRAWN. This text was withdrawn from use and is rendered for the record only. Source: ${source}.`;
    case 'unapproved_sample':
    default:
      return `UNAPPROVED SAMPLE — NOT A JURISDICTIONALLY APPROVED FORM. This text has not been approved by an accountable person for use in the stated jurisdiction. Source: ${source}.`;
  }
}

export function renderDocument(input: RenderInput): RenderOutcome {
  const byCode = new Map(input.fields.map((f) => [f.fieldCode, f] as const));
  const used: string[] = [];
  const missing: string[] = [];
  const body = input.bodyTemplate.replace(PLACEHOLDER, (_m, code: string) => {
    const field = byCode.get(code);
    if (field === undefined) {
      if (!missing.includes(code)) missing.push(code);
      return '';
    }
    if (!used.includes(code)) used.push(code);
    return escapeHtml(fieldWords(field));
  });
  if (missing.length > 0) return { outcome: 'unresolved', missing: missing.sort() };

  // Paragraphs are blank-line separated in the template; each becomes a <p>.
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<title>${escapeHtml(input.title)}</title>\n</head>\n<body>\n` +
    `<h1>${escapeHtml(input.title)}</h1>\n` +
    `<p class="template">Template ${escapeHtml(input.templateCode)} version ${input.templateVersion}` +
    ` · Jurisdiction ${escapeHtml(input.jurisdiction)} · Package version ${input.packageVersionNo}</p>\n` +
    `<p class="approval">${escapeHtml(approvalSentence(input.approvalStatus, input.source))}</p>\n` +
    `${paragraphs}\n</body>\n</html>\n`;
  return { outcome: 'rendered', html, placeholders: used.sort() };
}

export const RENDERED_MIME = 'text/html; charset=utf-8';
