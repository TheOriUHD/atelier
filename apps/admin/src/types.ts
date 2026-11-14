/** What deploy/admin/src/api.js answers. The report and chat themselves are the protocol's types. */
import type { ReportChat, ReportEnvelope } from '@atelier/protocol';

export type { ReportChat, ReportEnvelope };
export type Kind = 'issue' | 'feature';

export interface Row {
  id: string;
  kind: Kind;
  title: string;
  status: string;
  labels: string[];
  version: string;
  surface: string;
  mode: string;
  os: string | null;
  osName: string | null;
  arch: string | null;
  hasDiagnostics: boolean;
  hasChat: boolean;
  screenshots: number;
  hasContact: boolean;
  bytes: number;
  scrubbed: number;
  receivedAt: number;
  updatedAt: number;
  seenAt: number | null;
}

export interface FullRow extends Row {
  description: string;
  contact: string | null;
  note: string;
}

export interface Facet {
  value: string;
  count: number;
}

export interface ListResponse {
  rows: Row[];
  next: string | null;
  total: number;
  statuses: string[];
  closed: string[];
  facets: { versions: Facet[]; os: Facet[]; statuses: Record<string, number>; unseen: number };
}

export interface DetailResponse {
  row: FullRow;
  report: ReportEnvelope | null;
  files: { name: string; size: number }[];
  statuses: string[];
}

export interface Limits {
  day: string;
  today: number;
  todayByKind: Partial<Record<Kind, number>>;
  perDay: number;
  bits: number;
  bitsSteps: { below: number | null; bits: number }[];
  storedBytes: number;
  storageBytes: number;
  perAddressPerDay: number;
  addressesToday: number;
  busiestAddressToday: number;
  rate: { reports: { limit: number; period: number }; challenges: { limit: number; period: number } };
  retentionDays: number;
}

export interface DayCount {
  day: string;
  platform: string;
  count: number;
}

export interface Overview {
  days: number;
  from: string;
  today: string;
  downloads: {
    today: number;
    d7: number;
    prev7: number;
    d30: number;
    daily: DayCount[];
    kinds: Record<string, { d7: number; d30: number }>;
  };
  versions: { version: string; downloads: number; updates: number; d7: number; firstDay: string }[];
  latest: { version: string; since: string; downloads: number; updates: number; share7: number | null } | null;
  checks: { daily: DayCount[]; today: number };
  reports: Record<Kind, { new: number; unseen: number; total: number }> & {
    daily: { day: string; kind: Kind; count: number }[];
  };
  collector: Limits;
}

export interface Downloads {
  days: number;
  from: string;
  today: string;
  daily: (DayCount & { kind: string })[];
  versions: { version: string; kind: string; count: number }[];
  countries: { country: string; count: number }[];
  files: { file: string; kind: string; count: number }[];
  checks: { day: string; channel: string; platform: string; version: string; count: number }[];
  github: {
    day: string | null;
    total: number;
    daily: { day: string; total: number; delta: number | null }[];
    tags: { tag: string; downloads: number; assets: number; delta: number }[];
  };
}
