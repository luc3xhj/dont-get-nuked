/**
 * Wilson score lower bound for a success rate: with few observations it stays low, so "2 out of 2"
 * doesn't read as a 100% hit rate. z = 1.645 is a one-sided 95% bound.
 */
export function wilsonLower(successes: number, n: number, z = 1.645): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n));
}
