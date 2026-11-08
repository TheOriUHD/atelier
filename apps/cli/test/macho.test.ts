import { describe, expect, it } from 'vitest';
import { brandMachO, cliInfoPlist, embeddedInfoPlist, loadCommands, machoUuid, uuidFor } from '../scripts/macho.mjs';

// A small Mach-O laid out like Node's: header, __PAGEZERO, __TEXT (fileoff 0) with __text at 0x1000, LC_UUID, __LINKEDIT.
function fakeBinary(): Buffer {
  const buf = Buffer.alloc(0x3000);
  const seg = (at: number, name: string, vmaddr: bigint, fileoff: bigint, filesize: bigint, sections: Array<{ name: string; offset: number; size: number }>) => {
    buf.writeUInt32LE(0x19, at);
    buf.writeUInt32LE(72 + 80 * sections.length, at + 4);
    buf.write(name, at + 8, 'latin1');
    buf.writeBigUInt64LE(vmaddr, at + 24);
    buf.writeBigUInt64LE(filesize, at + 32);
    buf.writeBigUInt64LE(fileoff, at + 40);
    buf.writeBigUInt64LE(filesize, at + 48);
    buf.writeUInt32LE(sections.length, at + 64);
    sections.forEach((s, i) => {
      const p = at + 72 + i * 80;
      buf.write(s.name, p, 'latin1');
      buf.write(name, p + 16, 'latin1');
      buf.writeBigUInt64LE(vmaddr + BigInt(s.offset), p + 32);
      buf.writeBigUInt64LE(BigInt(s.size), p + 40);
      buf.writeUInt32LE(s.offset, p + 48);
    });
    return 72 + 80 * sections.length;
  };
  let at = 32;
  at += seg(at, '__PAGEZERO', 0n, 0n, 0n, []);
  const textAt = at;
  at += seg(at, '__TEXT', 0x100000000n, 0n, 0x2000n, [
    { name: '__text', offset: 0x1000, size: 0x800 },
    { name: '__cstring', offset: 0x1800, size: 0x100 },
  ]);
  buf.writeUInt32LE(0x1b, at);
  buf.writeUInt32LE(24, at + 4);
  Buffer.from('0270D61394183AE9A1B1634739E39157', 'hex').copy(buf, at + 8);
  at += 24;
  at += seg(at, '__LINKEDIT', 0x100002000n, 0x2000n, 0x1000n, []);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(4, 16);
  buf.writeUInt32LE(at - 32, 20);
  buf.fill(0xcc, 0x1000, 0x1900);
  expect(textAt).toBe(32 + 72);
  return buf;
}

describe('branding the macOS Node binary', () => {
  it('adds the Info.plist before __text and gives it its own UUID', () => {
    const before = fakeBinary();
    const plist = cliInfoPlist('0.6.0');
    const after = brandMachO(before, { plist, uuid: uuidFor('dev.atelier.cli', '0.6.0', 'darwin-arm64') });
    expect(after.length).toBe(before.length);
    expect(embeddedInfoPlist(after)).toBe(plist);
    expect(machoUuid(before)).toBe('0270D613-9418-3AE9-A1B1-634739E39157');
    expect(machoUuid(after)).not.toBe(machoUuid(before));

    const { ncmds, sizeofcmds, list } = loadCommands(after);
    expect(ncmds).toBe(4);
    expect(sizeofcmds).toBe(loadCommands(before).sizeofcmds + 80);
    const text = list.find((c) => c.segname === '__TEXT')!;
    expect(text.sections.map((s) => s.sectname)).toEqual(['__info_plist', '__text', '__cstring']);
    const info = text.sections[0];
    expect(info.offset + Number(info.size)).toBeLessThanOrEqual(0x1000);
    expect(info.offset).toBeGreaterThanOrEqual(32 + sizeofcmds);
    // The code and the other commands are untouched.
    expect(after.subarray(0x1000, 0x3000).equals(before.subarray(0x1000, 0x3000))).toBe(true);
    expect(list.map((c) => c.segname ?? c.cmd)).toEqual(['__PAGEZERO', '__TEXT', 0x1b, '__LINKEDIT']);
  });

  it('carries the bundle id, name and the reason macOS shows', () => {
    const plist = cliInfoPlist('0.6.0-beta.2');
    expect(plist).toContain('<key>CFBundleIdentifier</key>\n\t<string>dev.atelier.cli</string>');
    expect(plist).toContain('<key>CFBundleName</key>\n\t<string>Atelier CLI</string>');
    expect(plist).toContain('<key>CFBundleShortVersionString</key>\n\t<string>0.6.0</string>');
    expect(plist).toContain('NSLocalNetworkUsageDescription');
  });

  it('gives each version and platform its own UUID, the same on a rebuild', () => {
    expect(uuidFor('a', '0.6.0', 'darwin-arm64').equals(uuidFor('a', '0.6.0', 'darwin-arm64'))).toBe(true);
    expect(uuidFor('a', '0.6.0', 'darwin-arm64').equals(uuidFor('a', '0.6.0', 'darwin-x64'))).toBe(false);
    expect(uuidFor('a', '0.6.0', 'darwin-arm64').equals(uuidFor('a', '0.6.1', 'darwin-arm64'))).toBe(false);
  });

  it('refuses a binary that has one already, or no room for it', () => {
    const once = brandMachO(fakeBinary(), { plist: cliInfoPlist('0.6.0'), uuid: uuidFor('x') });
    expect(() => brandMachO(once, { plist: cliInfoPlist('0.6.0'), uuid: uuidFor('x') })).toThrow(/already has an Info.plist/);
    expect(() => brandMachO(fakeBinary(), { plist: 'x'.repeat(0x1000), uuid: uuidFor('x') })).toThrow(/No room/);
    expect(() => brandMachO(Buffer.from('not a binary'), { plist: '', uuid: uuidFor('x') })).toThrow(/Mach-O/);
  });
});
