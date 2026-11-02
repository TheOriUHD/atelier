/**
 * A multipart body as bytes. The plain-HTTP fetch that reaches local servers (providers/plain-http.ts) and the device
 * link only send strings and byte arrays, so `FormData` would arrive empty.
 */
export type MultipartField = { name: string; value: string } | { name: string; filename: string; mime: string; bytes: Uint8Array };

export function multipart(fields: readonly MultipartField[]): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = `----atelier${crypto.randomUUID().replaceAll('-', '')}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const quoted = (s: string) => s.replace(/["\r\n]/g, '_');
  for (const field of fields) {
    const head = 'value' in field
      ? `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(field.name)}"\r\n\r\n${field.value}\r\n`
      : `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(field.name)}"; filename="${quoted(field.filename)}"\r\nContent-Type: ${field.mime}\r\n\r\n`;
    parts.push(encoder.encode(head));
    if ('bytes' in field) parts.push(field.bytes, encoder.encode('\r\n'));
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
