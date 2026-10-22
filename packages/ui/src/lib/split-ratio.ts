/**
 * How a split view divides its width among its cells: each one's share (they add up to 1), kept per window or browser
 * for each number of cells. A divider moves two neighbours against each other; neither goes under `MIN_SPLIT_CELL_PX`.
 */
const KEY = 'atelier.splitShares';

/** Neither neighbour gets less room than this: the transcript and its composer stay usable. */
export const MIN_SPLIT_CELL_PX = 360;

export const evenShares = (n: number): number[] => Array.from({ length: Math.max(1, n) }, () => 1 / Math.max(1, n));

/** `shares` if they are `n` positive numbers adding up to 1, else even ones. */
export function normalizeShares(shares: readonly number[] | undefined, n: number): number[] {
  if (!shares || shares.length !== n || shares.some((s) => !Number.isFinite(s) || s <= 0)) return evenShares(n);
  const total = shares.reduce((a, b) => a + b, 0);
  return Math.abs(total - 1) < 0.01 ? shares.map((s) => s / total) : evenShares(n);
}

/**
 * The limits of a divider's value, the left cell's share of its pair (the two cells' shares together), for a split
 * `width` px wide: both cells keep `MIN_SPLIT_CELL_PX` (even where they can't).
 */
export function dividerLimits(width: number, pair: number): { min: number; max: number } {
  // Not measured yet: the kept shares are shown as they are rather than jumping once the width is known.
  if (width <= 0) return { min: 0.05, max: 0.95 };
  const min = Math.min(0.5, MIN_SPLIT_CELL_PX / Math.max(width * pair, 1));
  return { min, max: 1 - min };
}

/** `shares` with divider `index` moved: the left cell takes `value` of the pair, the right the rest. */
export function moveDivider(shares: readonly number[], index: number, value: number): number[] {
  const pair = (shares[index] ?? 0) + (shares[index + 1] ?? 0);
  return shares.map((s, i) => (i === index ? value * pair : i === index + 1 ? (1 - value) * pair : s));
}

export function recalledShares(n: number, storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): number[] {
  try {
    const all = JSON.parse(storage?.getItem(KEY) ?? '{}') as Record<string, number[]>;
    return normalizeShares(all[String(n)], n);
  } catch {
    return evenShares(n);
  }
}

export function rememberShares(shares: readonly number[], storage: (Pick<Storage, 'getItem' | 'setItem'>) | undefined = safeStorage()): void {
  try {
    const all = JSON.parse(storage?.getItem(KEY) ?? '{}') as Record<string, number[]>;
    all[String(shares.length)] = shares.map((s) => Math.round(s * 1000) / 1000);
    storage?.setItem(KEY, JSON.stringify(all));
  } catch {
    // Not kept: the next split starts even.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
