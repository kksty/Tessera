import type { Usage } from "./index.js";

/** Missing legacy fields and interrupted requests remain explicitly unknown. */
export function summarizeUsage(records: Usage[]) {
  const fields = ["input", "input_uncached", "cache_read", "cache_write", "output", "cost"] as const;
  return Object.fromEntries(fields.map(field => {
    const values = records.map(r => r[field]);
    return [field, { known: values.reduce<number>((sum, n) => sum + (n ?? 0), 0), unknown: values.filter(n => n == null).length }];
  })) as Record<typeof fields[number], { known: number; unknown: number }>;
}
