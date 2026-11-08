/**
 * A QR code drawn with half blocks, two modules to a cell, with its quiet zone. Scanners want dark modules on light, so
 * on a dark terminal the light modules (and the margin) are the ones drawn in the text colour; on a light one, the dark.
 */
import qrcode from 'qrcode-generator';

export function qrLines(text: string, shade: 'dark' | 'light' = 'dark'): string[] {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 2;
  const isDark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const drawn = (r: number, c: number) => (shade === 'dark' ? !isDark(r, c) : isDark(r, c));
  const lines: string[] = [];
  for (let r = -margin; r < n + margin; r += 2) {
    let line = '';
    for (let c = -margin; c < n + margin; c++) {
      const top = drawn(r, c);
      const bottom = r + 1 < n + margin && drawn(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines;
}
