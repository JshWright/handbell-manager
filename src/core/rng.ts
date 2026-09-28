/** Mulberry32 — a fast, seedable 32-bit PRNG. Produces identical sequences
 *  across runs for the same seed (unlike Math.random), which gives deterministic
 *  assignment results. */

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1) >>> 0;
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    z = ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    return z;
  }

  /** Random integer in [0, n) */
  randint(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Choose from +1 or -1 randomly */
  choice(arr: number[]): number {
    return arr[this.randint(arr.length)];
  }

  /** Fisher-Yates in-place shuffle */
  shuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.randint(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}
