/**
 * What a report says about the computer the desktop app runs on (ARCHITECTURE §26), and the window's picture at the
 * moment the person pressed the report shortcut. Main collects; the window shows it to the person before anything
 * is sent, and only sends it when they press Send.
 */
import type { NativeImage } from 'electron';
import type { ReportGpu, ReportSystem } from '@atelier/protocol';

/** PCI vendor ids Chromium reports, by the name people know. */
const VENDORS: Record<number, string> = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x1022: 'AMD', 0x8086: 'Intel', 0x106b: 'Apple', 0x5143: 'Qualcomm', 0x13b5: 'Arm', 0x1414: 'Microsoft' };

interface ChromiumGpu {
  vendorId?: number;
  deviceId?: number;
  active?: boolean;
  deviceString?: string;
  vendorString?: string;
  driverVersion?: string;
}

/** Chromium's GPU list (`app.getGPUInfo`): every adapter, which one draws Atelier, and its driver. */
export function chromiumGpus(info: unknown): ReportGpu[] {
  const devices = (info as { gpuDevice?: ChromiumGpu[] } | null)?.gpuDevice ?? [];
  return devices
    .filter((d) => d.vendorId || d.deviceString)
    .slice(0, 8)
    .map((d) => {
      const vendor = d.vendorString || (d.vendorId ? VENDORS[d.vendorId] : undefined);
      const name = d.deviceString || `${vendor ?? 'GPU'} 0x${(d.deviceId ?? 0).toString(16).padStart(4, '0')}`;
      return { name: `${name}${d.active ? ' (draws Atelier)' : ''}`.slice(0, 200), ...(vendor ? { vendor: vendor.slice(0, 80) } : {}), ...(d.driverVersion ? { driver: d.driverVersion.slice(0, 80) } : {}), source: 'electron' };
    });
}

interface DisplayLike {
  id: number;
  size: { width: number; height: number };
  scaleFactor: number;
  displayFrequency?: number;
}

/** The computer, its graphics as the system and as Chromium see them, and its monitors. */
export function clientSystem(base: ReportSystem, gpuInfo: unknown, displays: readonly DisplayLike[], primaryId: number): ReportSystem {
  const chromium = chromiumGpus(gpuInfo);
  // The system's own list names cards and their memory best; Chromium's adds which one draws the window.
  const gpus = [...(base.hardware.gpus ?? []), ...chromium.filter((c) => !(base.hardware.gpus ?? []).some((g) => c.name.toLowerCase().includes(g.name.toLowerCase().split(' (')[0]!)))];
  return {
    ...base,
    hardware: {
      ...base.hardware,
      ...(gpus.length ? { gpus: gpus.slice(0, 16) } : {}),
      displays: displays.slice(0, 16).map((d) => ({ width: d.size.width, height: d.size.height, scale: d.scaleFactor, ...(d.displayFrequency ? { refreshHz: Math.round(d.displayFrequency) } : {}), ...(d.id === primaryId ? { primary: true } : {}) })),
    },
  };
}

/** The longest side a captured window is scaled down to; the window compresses it further. */
const CAPTURE_SIDE = 2560;

/** The window's picture as PNG, no larger than `CAPTURE_SIDE` on its longest side. */
export function capturedPicture(image: NativeImage): { mime: 'image/png'; dataBase64: string; width: number; height: number } | null {
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const scale = Math.min(1, CAPTURE_SIDE / Math.max(width, height));
  const sized = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : image;
  const size = sized.getSize();
  return { mime: 'image/png', dataBase64: sized.toPNG().toString('base64'), width: size.width, height: size.height };
}
