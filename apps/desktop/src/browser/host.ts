// The native messaging host for Atelier for Chrome (docs/ARCHITECTURE.md §22): a browser starts it with the extension's
// connection on stdin and stdout (each message a 4-byte little-endian length, then JSON) and it passes the messages on to
// the desktop app's main process over a Unix socket that only this user can open, as lines of JSON.
//
// It runs as Atelier's own executable in Node mode, through the script the app writes next to the socket
// (bridge.ts `hostScript`), which names the socket and the token file. The first line it sends is the token.

import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

/** Splits a stream of length-prefixed messages; what doesn't fit yet waits for the next chunk. */
export function readFrames(buffer: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let rest = buffer;
  while (rest.length >= 4) {
    const length = rest.readUInt32LE(0);
    // Chrome limits a message to the host at 4 GB in theory and 1 MB in practice to the extension; anything this big is
    // not ours.
    if (length > 64 * 1024 * 1024) throw new Error('message too large');
    if (rest.length < 4 + length) break;
    messages.push(rest.subarray(4, 4 + length).toString('utf8'));
    rest = rest.subarray(4 + length);
  }
  return { messages, rest };
}

export function frame(json: string): Buffer {
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function main(): void {
  const socketPath = process.env.ATELIER_BROWSER_SOCKET!;
  const tokenFile = process.env.ATELIER_BROWSER_TOKEN;
  if (!tokenFile) process.exit(2);
  const token = readFileSync(tokenFile, 'utf8').trim();
  const socket = connect(socketPath);
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(`${JSON.stringify({ auth: token })}\n`));
  // From the app: one JSON message a line, to the extension.
  let lines = '';
  socket.on('data', (chunk: string) => {
    lines += chunk;
    let end: number;
    while ((end = lines.indexOf('\n')) >= 0) {
      const line = lines.slice(0, end);
      lines = lines.slice(end + 1);
      if (line) process.stdout.write(frame(line));
    }
  });
  socket.on('close', () => process.exit(0));
  socket.on('error', () => process.exit(1));
  // From the extension: frames, to the app as lines.
  let pending: Buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      const { messages, rest } = readFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const message of messages) socket.write(`${JSON.stringify(JSON.parse(message))}\n`);
    } catch {
      process.exit(1);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// Started by a browser through the host script, which names the socket; imported (tests), it does nothing.
if (process.env.ATELIER_BROWSER_SOCKET) main();
