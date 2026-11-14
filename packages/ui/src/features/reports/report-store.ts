/**
 * The report dialog's state (ARCHITECTURE §26): open or not, which kind, and a draft for each kind that outlives the
 * dialog, so closing it by accident loses nothing. Pictures stay until the report is sent or they are taken out.
 */
import { create } from 'zustand';
import type { ReportKind } from '@atelier/protocol';
import type { Shot } from './report-images.ts';

export interface ReportDraft {
  title: string;
  description: string;
  contact: string;
}

const EMPTY: ReportDraft = { title: '', description: '', contact: '' };

interface ReportState {
  open: boolean;
  /** How many times it was opened: each opening mounts a fresh dialog. */
  opens: number;
  kind: ReportKind;
  /** Opened from where the person is (F1, the bug button, Help › Report an Issue…): the conversation open now goes with it. */
  fromHere: boolean;
  drafts: Record<ReportKind, ReportDraft>;
  shots: Shot[];
  open_(kind: ReportKind, shot?: Shot | null, fromHere?: boolean): void;
  close(): void;
  setKind(kind: ReportKind): void;
  setDraft(kind: ReportKind, patch: Partial<ReportDraft>): void;
  addShots(shots: Shot[]): void;
  removeShot(id: string): void;
  /** After sending: that kind's draft and every picture go. */
  sent(kind: ReportKind): void;
}

export const MAX_SHOTS = 4;

const release = (shots: Shot[]) => {
  for (const s of shots) URL.revokeObjectURL(s.url);
};

export const useReports = create<ReportState>((set) => ({
  open: false,
  opens: 0,
  kind: 'issue',
  fromHere: false,
  drafts: { issue: EMPTY, feature: EMPTY },
  shots: [],
  open_: (kind, shot, fromHere = false) =>
    set((s) => {
      const shots = shot ? [...s.shots, shot] : s.shots;
      if (shots.length > MAX_SHOTS) release(shots.slice(0, shots.length - MAX_SHOTS));
      return { open: true, opens: s.open ? s.opens : s.opens + 1, kind, fromHere: s.open ? s.fromHere : fromHere, shots: shots.slice(-MAX_SHOTS) };
    }),
  close: () => set({ open: false }),
  setKind: (kind) => set({ kind }),
  setDraft: (kind, patch) => set((s) => ({ drafts: { ...s.drafts, [kind]: { ...s.drafts[kind], ...patch } } })),
  addShots: (added) =>
    set((s) => {
      const room = MAX_SHOTS - s.shots.length;
      release(added.slice(Math.max(0, room)));
      return { shots: [...s.shots, ...added.slice(0, Math.max(0, room))] };
    }),
  removeShot: (id) =>
    set((s) => {
      release(s.shots.filter((x) => x.id === id));
      return { shots: s.shots.filter((x) => x.id !== id) };
    }),
  sent: (kind) =>
    set((s) => {
      release(s.shots);
      return { drafts: { ...s.drafts, [kind]: EMPTY }, shots: [] };
    }),
}));
