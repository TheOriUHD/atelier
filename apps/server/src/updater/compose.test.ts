import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Service {
  image: string;
  environment?: Record<string, string>;
  volumes?: string[];
  depends_on?: string[];
  mem_limit?: string;
  cpus?: number;
  pids_limit?: number;
  privileged?: boolean;
  security_opt?: string[];
  cap_drop?: string[];
  cap_add?: string[];
}
const compose = parse(readFileSync(join(import.meta.dirname, '../../../../deploy/compose.yaml'), 'utf8')) as {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};
const { atelier, sandbox, updater } = compose.services;

describe('deploy/compose.yaml', () => {
  it('is valid YAML with the server, sandbox and updater services', () => {
    expect(Object.keys(compose.services)).toEqual(expect.arrayContaining(['atelier', 'sandbox', 'updater', 'caddy']));
    for (const service of Object.values(compose.services)) for (const v of service.volumes ?? []) {
      const source = v.split(':')[0]!;
      if (!source.startsWith('.') && !source.startsWith('/')) expect(compose.volumes).toHaveProperty(source);
    }
  });

  it('gives the Docker socket to the updater alone', () => {
    const socket = (s: Service | undefined) => (s?.volumes ?? []).some((v) => v.includes('docker.sock'));
    expect(socket(updater)).toBe(true);
    expect(Object.entries(compose.services).filter(([, s]) => socket(s)).map(([name]) => name)).toEqual(['updater']);
  });

  it('shares the secret: the server writes it, the updater only reads it', () => {
    expect(atelier!.volumes).toContain('updater-secret:/updater');
    expect(updater!.volumes).toContain('updater-secret:/updater:ro');
    expect(updater!.volumes).toContain('.:/project:ro');
    expect(updater!.depends_on).toEqual(['atelier']);
    expect(atelier!.environment?.ATELIER_UPDATER_URL).toBe('http://updater:7341');
    expect(JSON.stringify(compose)).not.toMatch(/UPDATER_SECRET\s*[:=]\s*\w{16}/);
  });

  it('runs registry images, which the updater can pull', () => {
    expect(atelier!.image).toBe('ghcr.io/theoriuhd/atelier:latest');
    expect(sandbox!.image).toBe('ghcr.io/theoriuhd/atelier-sandbox:latest');
    expect(updater!.image).toBe('ghcr.io/theoriuhd/atelier-updater:latest');
  });

  it('keeps the sandbox limited: its size limits, no secrets, and only the few powers its root needs to log accounts in as their own users', () => {
    expect([sandbox!.mem_limit, sandbox!.cpus, sandbox!.pids_limit]).toEqual(['2g', 2, 512]);
    // None of the server's volumes, and the keys the server publishes are read-only.
    expect(sandbox!.volumes).toEqual(['sandbox-home:/home/sandbox', 'sandbox-keys:/keys:ro']);
    expect(sandbox!.privileged).toBeUndefined();
    expect(sandbox!.security_opt).toContain('no-new-privileges:true');
    expect(sandbox!.cap_drop).toEqual(['ALL']);
    // All of them are in Docker's default set (DAC_READ_SEARCH, which is not, would let root open host files by handle).
    expect(sandbox!.cap_add!.toSorted()).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID', 'SYS_CHROOT']);
    // The server publishes into the volume the sandbox reads, and the account pool is configured on both sides or on neither.
    expect(atelier!.volumes).toContain('sandbox-keys:/sandbox-keys');
    expect(atelier!.environment?.ATELIER_SANDBOX_KEYS).toBe('/sandbox-keys/authorized_keys');
    expect(sandbox!.environment?.ATELIER_SANDBOX_SLOTS).toBe(atelier!.environment?.ATELIER_SANDBOX_SLOTS);
  });
});
