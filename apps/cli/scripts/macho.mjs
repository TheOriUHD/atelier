// Gives the official Node.js binary an identity of its own on macOS, as Apple's TN3179 ("Understanding local network
// privacy") asks of a command-line tool, and the way Claude Code's `claude` binary is built:
//   - its own LC_UUID. Local network privacy uses the main executable's UUID, and every copy of a Node.js release
//     shares one: TN3179 says a shared UUID makes it "behave weirdly", and the person's answer for Atelier would mix
//     with any official Node of the same version on the computer.
//   - an Info.plist in a `__TEXT,__info_plist` section, as `-sectcreate __TEXT __info_plist` makes it, which codesign
//     binds into the signature: CFBundleIdentifier `dev.atelier.cli` and NSLocalNetworkUsageDescription (TN3179:
//     "add it to an Info.plist that's embedded in your executable").
// macOS keeps the answer for the signing identifier: a newer version, at another path with another UUID, was let
// through without asking again (checked on macOS 27.2). Its question names the file, "atelier".
// The section goes in the free space between the load commands and the first section, where the linker puts it; the
// binary has to be signed again afterwards (the old signature no longer matches).
import { createHash } from 'node:crypto';

const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
const HEADER = 32;
const SEGMENT = 72;
const SECTION = 80;
/** Section types without file contents (their offset is 0). */
const ZEROFILL = new Set([0x1, 0xc, 0x12]);

const name16 = (buf, at) => buf.toString('latin1', at, at + 16).replace(/\0+$/, '');
const allZero = (buf, from, to) => buf.subarray(from, to).every((b) => b === 0);

/** The load commands of a thin 64-bit little-endian Mach-O. */
export function loadCommands(buf) {
  if (buf.length < HEADER || buf.readUInt32LE(0) !== MH_MAGIC_64) throw new Error('Not a thin 64-bit Mach-O binary.');
  const ncmds = buf.readUInt32LE(16);
  const sizeofcmds = buf.readUInt32LE(20);
  const list = [];
  let at = HEADER;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(at);
    const size = buf.readUInt32LE(at + 4);
    if (size < 8 || at + size > HEADER + sizeofcmds) throw new Error('The load commands are damaged.');
    const entry = { cmd, at, size };
    if (cmd === LC_SEGMENT_64) {
      entry.segname = name16(buf, at + 8);
      entry.vmaddr = buf.readBigUInt64LE(at + 24);
      entry.fileoff = buf.readBigUInt64LE(at + 40);
      entry.sections = [];
      const n = buf.readUInt32LE(at + 64);
      for (let s = 0; s < n; s++) {
        const p = at + SEGMENT + s * SECTION;
        entry.sections.push({ sectname: name16(buf, p), segname: name16(buf, p + 16), offset: buf.readUInt32LE(p + 48), size: buf.readBigUInt64LE(p + 40), type: buf.readUInt32LE(p + 64) & 0xff });
      }
    }
    list.push(entry);
    at += size;
  }
  return { ncmds, sizeofcmds, list };
}

/** The binary's LC_UUID, as 8-4-4-4-12 hex in capitals (what `dwarfdump --uuid` prints). */
export function machoUuid(buf) {
  const uuid = loadCommands(buf).list.find((c) => c.cmd === LC_UUID);
  if (!uuid) return null;
  const hex = buf.toString('hex', uuid.at + 8, uuid.at + 24).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The embedded Info.plist, or null. */
export function embeddedInfoPlist(buf) {
  for (const c of loadCommands(buf).list) {
    const s = c.sections?.find((x) => x.segname === '__TEXT' && x.sectname === '__info_plist');
    if (s) return buf.toString('utf8', s.offset, s.offset + Number(s.size));
  }
  return null;
}

/** A UUID that is the same for the same inputs (a rebuild of a version gets the same one) and unique to them. */
export function uuidFor(...parts) {
  const b = createHash('sha256').update(parts.join('\n')).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The Info.plist the terminal app carries. */
export function cliInfoPlist(version) {
  const short = /^\d+\.\d+\.\d+/.exec(version)?.[0] ?? '0.0.0';
  const entries = [
    ['CFBundleIdentifier', 'dev.atelier.cli'],
    ['CFBundleName', 'Atelier CLI'],
    ['CFBundleDisplayName', 'Atelier CLI'],
    ['CFBundleExecutable', 'atelier'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', short],
    ['CFBundleVersion', short],
    ['NSLocalNetworkUsageDescription', 'Atelier CLI connects to your Atelier server and finds Atelier servers on your network.'],
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.map(([k, v]) => `\t<key>${k}</key>\n\t<string>${escape(v)}</string>`).join('\n')}
\t<key>LSUIElement</key>
\t<true/>
</dict>
</plist>
`;
}

/**
 * A copy of `buf` with `plist` in a new `__TEXT,__info_plist` section and `uuid` (16 bytes) as its LC_UUID.
 * Throws when the binary already has an Info.plist or there is no room for one.
 */
export function brandMachO(buf, { plist, uuid }) {
  if (uuid.length !== 16) throw new Error('A UUID is 16 bytes.');
  const { sizeofcmds, list } = loadCommands(buf);
  const text = list.find((c) => c.cmd === LC_SEGMENT_64 && c.segname === '__TEXT');
  if (!text) throw new Error('The binary has no __TEXT segment.');
  if (text.sections.some((s) => s.sectname === '__info_plist')) throw new Error('The binary already has an Info.plist.');
  const uuidCmd = list.find((c) => c.cmd === LC_UUID);
  if (!uuidCmd) throw new Error('The binary has no LC_UUID.');

  // The free space: after the load commands (plus the new section header), before the first section's contents.
  const firstData = Math.min(...list.flatMap((c) => c.sections ?? []).filter((s) => s.offset > 0 && !ZEROFILL.has(s.type)).map((s) => s.offset));
  const data = Buffer.from(plist, 'utf8');
  const commandsEnd = HEADER + sizeofcmds + SECTION;
  const start = Math.floor((firstData - data.length) / 16) * 16;
  if (start < commandsEnd) throw new Error(`No room for the Info.plist: ${firstData - commandsEnd} bytes free, ${data.length} needed.`);
  if (!allZero(buf, HEADER + sizeofcmds, commandsEnd) || !allZero(buf, start, start + data.length)) throw new Error('The space after the load commands isn’t empty.');
  if (text.fileoff !== 0n) throw new Error('__TEXT doesn’t start the file.');

  const out = Buffer.from(buf);
  // The load commands again, the __TEXT segment with the new section first (it lies before __text, as ld places it).
  const commands = Buffer.alloc(sizeofcmds + SECTION);
  let at = 0;
  for (const c of list) {
    if (c !== text) {
      buf.copy(commands, at, c.at, c.at + c.size);
      at += c.size;
      continue;
    }
    buf.copy(commands, at, c.at, c.at + SEGMENT);
    commands.writeUInt32LE(c.size + SECTION, at + 4);
    commands.writeUInt32LE(c.sections.length + 1, at + 64);
    const s = at + SEGMENT;
    commands.write('__info_plist', s, 'latin1');
    commands.write('__TEXT', s + 16, 'latin1');
    commands.writeBigUInt64LE(text.vmaddr + BigInt(start), s + 32);
    commands.writeBigUInt64LE(BigInt(data.length), s + 40);
    commands.writeUInt32LE(start, s + 48);
    // align 2^0, no relocations, S_REGULAR: what -sectcreate makes.
    buf.copy(commands, s + SECTION, c.at + SEGMENT, c.at + c.size);
    at += c.size + SECTION;
  }
  commands.copy(out, HEADER);
  out.writeUInt32LE(sizeofcmds + SECTION, 20);
  data.copy(out, start);
  // LC_UUID moved with the commands after __TEXT (or not, when it comes first).
  const uuidAt = uuidCmd.at + (uuidCmd.at > text.at ? SECTION : 0);
  uuid.copy(out, uuidAt + 8);
  return out;
}
