/** Längenstufen (KNP 1.11.0): pro Artikel wird zufällig eine der angehakten Stufen gezogen */

export const LENGTH_TIERS = {
  short: { min: 300, max: 500 },
  medium: { min: 500, max: 800 },
  long: { min: 800, max: 1200 },
} as const;

export type LengthTier = keyof typeof LENGTH_TIERS;
export const LENGTH_TIER_NAMES = Object.keys(LENGTH_TIERS) as LengthTier[];

export function pickLength(tiers: readonly LengthTier[], random: () => number = Math.random): { tier: LengthTier; min: number; max: number } {
  const list = tiers.length ? tiers : (["medium"] as const);
  const tier = list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;
  return { tier, ...LENGTH_TIERS[tier] };
}

/** Token-Limit der Antwort: min(12000, Höchstwortzahl * 4 + 2000) */
export function classifyMaxTokens(maxWords: number): number {
  return Math.min(12_000, maxWords * 4 + 2000);
}
