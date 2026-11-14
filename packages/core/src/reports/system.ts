/**
 * The computer Atelier's backend runs on, for an issue report (ARCHITECTURE §26): the system, the processor, memory,
 * graphics cards and the disk of the data folder. Never its name, serial number, account or addresses.
 *
 * Every probe is bounded in time and best effort: a report is sent when the person asks, often because something is
 * broken, so nothing here may hang or throw. Graphics cards take a second or two to read, so they are kept a while.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import type { ReportGpu, ReportSystem } from '@atelier/protocol';

const PROBE_MS = 6000;
const GPU_TTL_MS = 5 * 60_000;

/** A program's output, or null when it isn't there, fails or takes too long. No shell: the arguments are fixed. */
export function run(file: string, args: string[], timeout = PROBE_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout));
    } catch {
      resolve(null);
    }
  });
}

const settle = async <T>(work: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await work;
  } catch {
    return fallback;
  }
};

const clean = (s: string | undefined | null, max = 200): string | undefined => {
  const v = s?.replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, max) : undefined;
};

/** "macOS 26.1", "Windows 11 Pro (build 26100)", "Ubuntu 24.04.3 LTS". */
async function osName(): Promise<string | undefined> {
  if (process.platform === 'darwin') {
    const version = clean(await run('sw_vers', ['-productVersion'], 2000));
    return version ? `macOS ${version}` : 'macOS';
  }
  if (process.platform === 'win32') {
    const build = Number(os.release().split('.')[2] ?? 0);
    // Windows 11 still calls itself "Windows 10" in the registry; the build number tells them apart.
    const name = (os.version() || 'Windows').replace(/^Windows 10/, build >= 22000 ? 'Windows 11' : 'Windows 10');
    return `${name}${build ? ` (build ${build})` : ''}`;
  }
  if (process.platform === 'linux') {
    const release = await settle(readFile('/etc/os-release', 'utf8'), '');
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release)?.[1];
    return clean(pretty) ?? 'Linux';
  }
  return clean(os.version()) ?? process.platform;
}

/** "Mac16,1"; a PC's maker and model. Never a serial number. */
async function machineModel(): Promise<string | undefined> {
  if (process.platform === 'darwin') return clean(await run('sysctl', ['-n', 'hw.model'], 2000), 80);
  if (process.platform === 'linux') {
    const vendor = clean(await settle(readFile('/sys/devices/virtual/dmi/id/sys_vendor', 'utf8'), ''), 40);
    const product = clean(await settle(readFile('/sys/devices/virtual/dmi/id/product_name', 'utf8'), ''), 60);
    const name = [vendor, product].filter(Boolean).join(' ');
    return name && !/to be filled|default string|system product name/i.test(name) ? name : undefined;
  }
  return undefined;
}

const MB = 1024 * 1024;

/** NVIDIA cards, on any system that has the driver: name, memory in use and in all, driver version. */
export function parseNvidiaSmi(out: string): ReportGpu[] {
  return out
    .split('\n')
    .map((line) => line.split(',').map((f) => f.trim()))
    .filter((f) => f.length >= 4 && f[0])
    .map(([name, total, free, driver]) => ({
      name: name!.slice(0, 200),
      vendor: 'NVIDIA',
      ...(Number.isFinite(Number(total)) ? { vramBytes: Number(total) * MB } : {}),
      ...(Number.isFinite(Number(free)) ? { vramFreeBytes: Number(free) * MB } : {}),
      ...(driver ? { driver: driver.slice(0, 80) } : {}),
      source: 'nvidia-smi',
    }));
}

/** `system_profiler SPDisplaysDataType -json`: the Mac's graphics, with the core count on Apple silicon. */
export function parseSystemProfiler(out: string): ReportGpu[] {
  try {
    const data = JSON.parse(out) as { SPDisplaysDataType?: Record<string, string>[] };
    return (data.SPDisplaysDataType ?? []).map((g) => {
      const vram = /([\d.]+)\s*(GB|MB)/i.exec(g.spdisplays_vram ?? g.spdisplays_vram_shared ?? '');
      const cores = g.sppci_cores ? ` (${g.sppci_cores} cores)` : '';
      return {
        name: `${g.sppci_model ?? g._name ?? 'Graphics'}${cores}`.slice(0, 200),
        ...(g.spdisplays_vendor || g.sppci_vendor ? { vendor: String(g.spdisplays_vendor ?? g.sppci_vendor).replace(/^sppci_vendor_/, '').slice(0, 80) } : {}),
        ...(vram ? { vramBytes: Number(vram[1]) * (vram[2]!.toUpperCase() === 'GB' ? 1024 : 1) * MB } : {}),
        source: 'system_profiler',
      };
    });
  } catch {
    return [];
  }
}

/** `Win32_VideoController` as JSON (one object or a list). AdapterRAM stops at 4 GB, so a larger card says "at least". */
export function parseWindowsVideo(out: string): ReportGpu[] {
  try {
    const data = JSON.parse(out) as Record<string, unknown> | Record<string, unknown>[];
    return (Array.isArray(data) ? data : [data])
      .filter((g) => typeof g.Name === 'string')
      .map((g) => ({
        name: String(g.Name).slice(0, 200),
        ...(typeof g.AdapterCompatibility === 'string' ? { vendor: g.AdapterCompatibility.slice(0, 80) } : {}),
        ...(typeof g.DriverVersion === 'string' ? { driver: g.DriverVersion.slice(0, 80) } : {}),
        ...(typeof g.AdapterRAM === 'number' && g.AdapterRAM > 0 ? { vramBytes: g.AdapterRAM } : {}),
        source: 'wmi',
      }));
  } catch {
    return [];
  }
}

/** `lspci -mm`: the display controllers' names, when nothing better is installed. */
export function parseLspci(out: string): ReportGpu[] {
  return out
    .split('\n')
    .filter((l) => /"(VGA compatible controller|3D controller|Display controller)"/.test(l))
    .map((l) => {
      const fields = [...l.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
      return { name: `${fields[1] ?? ''} ${fields[2] ?? ''}`.trim().slice(0, 200) || 'Graphics', ...(fields[1] ? { vendor: fields[1].slice(0, 80) } : {}), source: 'lspci' };
    });
}

let gpuCache: { at: number; gpus: ReportGpu[] } | null = null;

async function gpus(): Promise<ReportGpu[]> {
  if (gpuCache && Date.now() - gpuCache.at < GPU_TTL_MS) return gpuCache.gpus;
  const nvidia = parseNvidiaSmi((await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits'])) ?? '');
  let found: ReportGpu[] = nvidia;
  if (process.platform === 'darwin') found = [...parseSystemProfiler((await run('system_profiler', ['SPDisplaysDataType', '-json'])) ?? ''), ...nvidia];
  else if (process.platform === 'win32' && !nvidia.length) {
    found = parseWindowsVideo(
      (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,DriverVersion,AdapterRAM | ConvertTo-Json -Compress'])) ?? '',
    );
  } else if (process.platform === 'linux' && !nvidia.length) found = parseLspci((await run('lspci', ['-mm'], 3000)) ?? '');
  gpuCache = { at: Date.now(), gpus: found.slice(0, 16) };
  return gpuCache.gpus;
}

/** Docker, Podman or a Kubernetes pod: how a server usually runs. */
async function inContainer(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return true;
  const cgroup = await settle(readFile('/proc/1/cgroup', 'utf8'), '');
  return /docker|kubepods|containerd|libpod/.test(cgroup);
}

/** The backend's computer. `dataDir` is the folder whose disk is reported. */
export async function backendSystem(dataDir: string): Promise<ReportSystem> {
  const cpus = os.cpus();
  const [name, model, cards, disk, container] = await Promise.all([
    settle(osName(), undefined),
    settle(machineModel(), undefined),
    settle(gpus(), []),
    settle(statfs(dataDir), null),
    settle(inContainer(), false),
  ]);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  return {
    os: { platform: process.platform, ...(name ? { name } : {}), release: os.release().slice(0, 80), arch: process.arch, ...(locale ? { locale } : {}) },
    hardware: {
      ...(model ? { model } : {}),
      ...(cpus[0] ? { cpu: { model: clean(cpus[0].model) ?? 'unknown', cores: os.availableParallelism?.() ?? cpus.length, ...(cpus[0].speed ? { speedMHz: cpus[0].speed } : {}) } } : {}),
      memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
      ...(cards.length ? { gpus: cards } : {}),
      ...(disk ? { disk: { totalBytes: disk.blocks * disk.bsize, freeBytes: disk.bavail * disk.bsize } } : {}),
    },
    runtime: { node: process.versions.node, ...(process.versions.electron ? { electron: process.versions.electron } : {}), ...(process.versions.chrome ? { chrome: process.versions.chrome } : {}) },
    ...(container ? { container } : {}),
    uptimeSeconds: Math.round(process.uptime()),
  };
}
