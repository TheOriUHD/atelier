import { describe, expect, it } from 'vitest';
import { extractText } from './text-extract.ts';

/** Minimal single-page PDF containing "Hello PDF". */
function tinyPdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 12 Tf 20 50 Td (Hello PDF) Tj ET';
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

describe('extractText', () => {
  it('decodes text files and truncates', async () => {
    const r = await extractText(new TextEncoder().encode('abcdef'), 'text/plain', 3);
    expect(r).toEqual({ text: 'abc', truncated: true });
  });
  it('extracts text from PDFs', async () => {
    const r = await extractText(tinyPdf(), 'application/pdf');
    expect(r.text).toContain('Hello PDF');
  });
  it('refuses binary formats', async () => {
    await expect(extractText(new Uint8Array([1, 2]), 'image/png')).rejects.toThrow();
  });
});
