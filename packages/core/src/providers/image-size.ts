/** Pixel size of a PNG, JPEG, GIF or WebP from its header, without decoding it; null when it can't be read. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const u32be = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  const ascii = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

  // PNG: signature, then the IHDR chunk with width and height.
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 'PNG')) return { width: u32be(16), height: u32be(20) };
  // GIF: logical screen size.
  if (b.length >= 10 && ascii(0, 'GIF8')) return { width: u16le(6), height: u16le(8) };
  // WebP: lossy (VP8 ), lossless (VP8L) or extended (VP8X).
  if (b.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8 ')) return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (ascii(12, 'VP8L')) {
      return { width: 1 + (b[21]! | ((b[22]! & 0x3f) << 8)), height: 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10)) };
    }
    if (ascii(12, 'VP8X')) return { width: 1 + u24le(24), height: 1 + u24le(27) };
    return null;
  }
  // JPEG: the first start-of-frame marker holds the size.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: u16be(i + 5), width: u16be(i + 7) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}
