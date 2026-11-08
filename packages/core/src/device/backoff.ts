/** No wait on a healthy connection; then 250 ms doubling to 10 s while the server stays unreachable. */
export const backoff = (failures: number) => (failures === 0 ? 0 : Math.min(10_000, 250 * 2 ** (failures - 1)));
