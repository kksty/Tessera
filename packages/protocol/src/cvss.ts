/**
 * CVSS v4.0 Base score, computed by the application from the reviewer's vector.
 *
 * The reviewer supplies a vector and a rationale; the application parses and scores
 * it. Scores are never taken from the model and never feed priority or scheduling.
 * The lookup table is the FIRST specification's macrovector table
 * (https://www.first.org/cvss/v4.0/specification-document, Table 24–30).
 */
export const CVSS_VERSION = "4.0" as const;
export const cvssMetrics = ["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"] as const;
export type CvssMetric = typeof cvssMetrics[number];
export type CvssBase = Record<CvssMetric, string>;

const baseValues: Record<CvssMetric, string[]> = {
  AV: ["N", "A", "L", "P"],
  AC: ["L", "H"],
  AT: ["N", "P"],
  PR: ["N", "L", "H"],
  UI: ["N", "P", "A"],
  VC: ["H", "L", "N"],
  VI: ["H", "L", "N"],
  VA: ["H", "L", "N"],
  SC: ["H", "L", "N"],
  SI: ["H", "L", "N"],
  SA: ["H", "L", "N"],
};

export class CvssError extends Error {}

/** Parse the 11 mandatory Base metrics. Threat/Environmental metrics are rejected, not guessed. */
export function parseCvssVector(vector: string): CvssBase {
  const prefix = "CVSS:4.0/";
  const source = vector.trim();
  if (!source.startsWith(prefix)) throw new CvssError("CVSS v4.0 vector must start with CVSS:4.0/");
  const parsed: Partial<CvssBase> = {};
  for (const part of source.slice(prefix.length).split("/")) {
    const [metric, value, extra] = part.split(":");
    if (!metric || !value || extra !== undefined) throw new CvssError(`Invalid CVSS metric segment: ${part}`);
    if (!(cvssMetrics as readonly string[]).includes(metric))
      throw new CvssError(`Unsupported CVSS v4.0 metric ${metric}；只接受 11 个 Base 指标`);
    if (parsed[metric as CvssMetric] !== undefined) throw new CvssError(`Duplicate CVSS metric ${metric}`);
    if (!baseValues[metric as CvssMetric].includes(value))
      throw new CvssError(`Invalid value ${value} for CVSS metric ${metric}`);
    parsed[metric as CvssMetric] = value;
  }
  for (const metric of cvssMetrics)
    if (parsed[metric] === undefined) throw new CvssError(`Missing CVSS Base metric ${metric}`);
  return parsed as CvssBase;
}

const severityIndex: Record<string, string[]> = {
  AV: ["N", "A", "L", "P"], AC: ["L", "H"], AT: ["N", "P"], PR: ["N", "L", "H"], UI: ["N", "P", "A"],
  VC: ["H", "L", "N"], VI: ["H", "L", "N"], VA: ["H", "L", "N"],
  SC: ["H", "L", "N"], SI: ["S", "H", "L", "N"], SA: ["S", "H", "L", "N"],
  CR: ["H", "M", "L"], IR: ["H", "M", "L"], AR: ["H", "M", "L"],
};

const highestSeverityVectors: Record<number, Record<string, string[]>> = {
  1: {
    0: ["AV:N/PR:N/UI:N"],
    1: ["AV:A/PR:N/UI:N", "AV:N/PR:L/UI:N", "AV:N/PR:N/UI:P"],
    2: ["AV:P/PR:N/UI:N", "AV:A/PR:L/UI:P"],
  },
  2: {
    0: ["AC:L/AT:N"],
    1: ["AC:H/AT:N", "AC:L/AT:P"],
  },
  3: {
    0: {
      0: ["VC:H/VI:H/VA:H/CR:H/IR:H/AR:H"],
      1: ["VC:H/VI:H/VA:L/CR:M/IR:M/AR:H", "VC:H/VI:H/VA:H/CR:M/IR:M/AR:M"],
    },
    1: {
      0: ["VC:L/VI:H/VA:H/CR:H/IR:H/AR:H", "VC:H/VI:L/VA:H/CR:H/IR:H/AR:H"],
      1: ["VC:L/VI:H/VA:L/CR:H/IR:M/AR:H", "VC:L/VI:H/VA:H/CR:H/IR:M/AR:M",
        "VC:H/VI:L/VA:H/CR:M/IR:H/AR:M", "VC:H/VI:L/VA:L/CR:M/IR:H/AR:H",
        "VC:L/VI:L/VA:H/CR:H/IR:H/AR:M"],
    },
    2: { 1: ["VC:L/VI:L/VA:L/CR:H/IR:H/AR:H"] },
  },
  4: {
    0: ["SC:H/SI:S/SA:S"],
    1: ["SC:H/SI:H/SA:H"],
    2: ["SC:L/SI:L/SA:L"],
  },
} as unknown as Record<number, Record<string, string[]>>;

const depth: Record<number, Record<string, number>> = {
  1: { 0: 0, 1: 3, 2: 4 },
  2: { 0: 0, 1: 1 },
  3: { 0: 6, 1: 5 }, // indexed [eq3][eq6] below
  4: { 0: 5, 1: 4, 2: 3 },
  5: { 0: 1, 1: 1, 2: 1 },
} as unknown as Record<number, Record<string, number>>;
const depth36: Record<string, Record<string, number>> = {
  0: { 0: 6, 1: 5 },
  1: { 0: 7, 1: 7 },
  2: { 1: 9 },
};

const macrovectorScores: Record<string, number> = {
  "000000": 10, "000001": 9.9, "000010": 9.8, "000011": 9.5, "000020": 9.5, "000021": 9.2,
  "000100": 10, "000101": 9.6, "000110": 9.3, "000111": 8.7, "000120": 9.1, "000121": 8.1,
  "000200": 9.3, "000201": 9, "000210": 8.9, "000211": 8, "000220": 8.1, "000221": 6.8,
  "001000": 9.8, "001001": 9.5, "001010": 9.5, "001011": 9.2, "001020": 9, "001021": 8.4,
  "001100": 9.3, "001101": 9.2, "001110": 8.9, "001111": 8.1, "001120": 8.1, "001121": 6.5,
  "001200": 8.8, "001201": 8, "001210": 7.8, "001211": 7, "001220": 6.9, "001221": 4.8,
  "002001": 9.2, "002011": 8.2, "002021": 7.2, "002101": 7.9, "002111": 6.9, "002121": 5,
  "002201": 6.9, "002211": 5.5, "002221": 2.7,
  "010000": 9.9, "010001": 9.7, "010010": 9.5, "010011": 9.2, "010020": 9.2, "010021": 8.5,
  "010100": 9.5, "010101": 9.1, "010110": 9, "010111": 8.3, "010120": 8.4, "010121": 7.1,
  "010200": 9.2, "010201": 8.1, "010210": 8.2, "010211": 7.1, "010220": 7.2, "010221": 5.3,
  "011000": 9.5, "011001": 9.3, "011010": 9.2, "011011": 8.5, "011020": 8.5, "011021": 7.3,
  "011100": 9.2, "011101": 8.2, "011110": 8, "011111": 7.2, "011120": 7, "011121": 5.9,
  "011200": 8.4, "011201": 7, "011210": 7.1, "011211": 5.2, "011220": 5, "011221": 3,
  "012001": 8.6, "012011": 7.5, "012021": 5.2, "012101": 7.1, "012111": 5.2, "012121": 2.9,
  "012201": 6.3, "012211": 2.9, "012221": 1.7,
  "100000": 9.8, "100001": 9.5, "100010": 9.4, "100011": 8.7, "100020": 9.1, "100021": 8.1,
  "100100": 9.4, "100101": 8.9, "100110": 8.6, "100111": 7.4, "100120": 7.7, "100121": 6.4,
  "100200": 8.7, "100201": 7.5, "100210": 7.4, "100211": 6.3, "100220": 6.3, "100221": 4.9,
  "101000": 9.4, "101001": 8.9, "101010": 8.8, "101011": 7.7, "101020": 7.6, "101021": 6.7,
  "101100": 8.6, "101101": 7.6, "101110": 7.4, "101111": 5.8, "101120": 5.9, "101121": 5,
  "101200": 7.2, "101201": 5.7, "101210": 5.7, "101211": 5.2, "101220": 5.2, "101221": 2.5,
  "102001": 8.3, "102011": 7, "102021": 5.4, "102101": 6.5, "102111": 5.8, "102121": 2.6,
  "102201": 5.3, "102211": 2.1, "102221": 1.3,
  "110000": 9.5, "110001": 9, "110010": 8.8, "110011": 7.6, "110020": 7.6, "110021": 7,
  "110100": 9, "110101": 7.7, "110110": 7.5, "110111": 6.2, "110120": 6.1, "110121": 5.3,
  "110200": 7.7, "110201": 6.6, "110210": 6.8, "110211": 5.9, "110220": 5.2, "110221": 3,
  "111000": 8.9, "111001": 7.8, "111010": 7.6, "111011": 6.7, "111020": 6.2, "111021": 5.8,
  "111100": 7.4, "111101": 5.9, "111110": 5.7, "111111": 5.7, "111120": 4.7, "111121": 2.3,
  "111200": 6.1, "111201": 5.2, "111210": 5.7, "111211": 2.9, "111220": 2.4, "111221": 1.6,
  "112001": 7.1, "112011": 5.9, "112021": 3, "112101": 5.8, "112111": 2.6, "112121": 1.5,
  "112201": 2.3, "112211": 1.3, "112221": 0.6,
  "200000": 9.3, "200001": 8.7, "200010": 8.6, "200011": 7.2, "200020": 7.5, "200021": 5.8,
  "200100": 8.6, "200101": 7.4, "200110": 7.4, "200111": 6.1, "200120": 5.6, "200121": 3.4,
  "200200": 7, "200201": 5.4, "200210": 5.2, "200211": 4, "200220": 4, "200221": 2.2,
  "201000": 8.5, "201001": 7.5, "201010": 7.4, "201011": 5.5, "201020": 6.2, "201021": 5.1,
  "201100": 7.2, "201101": 5.7, "201110": 5.5, "201111": 4.1, "201120": 4.6, "201121": 1.9,
  "201200": 5.3, "201201": 3.6, "201210": 3.4, "201211": 1.9, "201220": 1.9, "201221": 0.8,
  "202001": 6.4, "202011": 5.1, "202021": 2, "202101": 4.7, "202111": 2.1, "202121": 1.1,
  "202201": 2.4, "202211": 0.9, "202221": 0.4,
  "210000": 8.8, "210001": 7.5, "210010": 7.3, "210011": 5.3, "210020": 6, "210021": 5,
  "210100": 7.3, "210101": 5.5, "210110": 5.9, "210111": 4, "210120": 4.1, "210121": 2,
  "210200": 5.4, "210201": 4.3, "210210": 4.5, "210211": 2.2, "210220": 2, "210221": 1.1,
  "211000": 7.5, "211001": 5.5, "211010": 5.8, "211011": 4.5, "211020": 4, "211021": 2.1,
  "211100": 6.1, "211101": 5.1, "211110": 4.8, "211111": 1.8, "211120": 2, "211121": 0.9,
  "211200": 4.6, "211201": 1.8, "211210": 1.7, "211211": 0.7, "211220": 0.8, "211221": 0.2,
  "212001": 5.3, "212011": 2.4, "212021": 1.4, "212101": 2.4, "212111": 1.2, "212121": 0.5,
  "212201": 1, "212211": 0.3, "212221": 0.1,
};

/** Environmental/threat metrics are Not Defined, so they default to H (requirements) and A (E). */
const real = (base: CvssBase, metric: string): string =>
  (metric === "CR" || metric === "IR" || metric === "AR") ? "H"
  : metric === "E" ? "A"
  : base[metric as CvssMetric];

function macrovector(base: CvssBase): string {
  const av = base.AV, ac = base.AC, at = base.AT, pr = base.PR, ui = base.UI;
  const vc = base.VC, vi = base.VI, va = base.VA, sc = base.SC, si = base.SI, sa = base.SA;
  let eq1 = "0";
  if (av === "N" && pr === "N" && ui === "N") eq1 = "0";
  else if ((av === "N" || pr === "N" || ui === "N") && !(av === "N" && pr === "N" && ui === "N") && av !== "P") eq1 = "1";
  else eq1 = "2";
  const eq2 = (ac === "L" && at === "N") ? "0" : "1";
  let eq3 = "0";
  if (vc === "H" && vi === "H") eq3 = "0";
  else if (vc === "H" || vi === "H" || va === "H") eq3 = "1";
  else eq3 = "2";
  let eq4 = "0";
  if (si === "S" || sa === "S") eq4 = "0";
  else if (sc === "H" || si === "H" || sa === "H") eq4 = "1";
  else eq4 = "2";
  const eq5 = "0"; // E:X → A
  const eq6 = (vc === "H" || vi === "H" || va === "H") ? "0" : "1";
  return eq1 + eq2 + eq3 + eq4 + eq5 + eq6;
}

function severityDistance(metric: string, value: string, maximum: string): number {
  const index = severityIndex[metric];
  return index.indexOf(value) - index.indexOf(maximum);
}

function valueOf(partial: string, metric: string): string {
  for (const part of partial.split("/")) {
    const [key, value] = part.split(":");
    if (key === metric) return value;
  }
  return "";
}

const roundup = (score: number) => +(score * 10).toFixed() / 10;

/**
 * CVSS v4.0 Base score. Vectors with no impact at all score 0.0.
 * @throws CvssError for an invalid vector.
 */
export function cvssScore(vector: string): number {
  const base = parseCvssVector(vector);
  if (["VC", "VI", "VA", "SC", "SI", "SA"].every(metric => base[metric as CvssMetric] === "N")) return 0;
  const mv = macrovector(base);
  const [eq1, eq2, eq3, eq4, eq5, eq6] = mv.split("").map(Number);
  const eqsv = macrovectorScores[mv];
  if (eqsv === undefined) throw new CvssError(`No CVSS macrovector score for ${mv}`);
  let lower = 0;
  let eq1nlm = NaN, eq2nlm = NaN, eq3eq6nlm = NaN, eq4nlm = NaN, eq5nlm = NaN;
  if (eq1 < 2) { eq1nlm = macrovectorScores[`${eq1 + 1}${eq2}${eq3}${eq4}${eq5}${eq6}`]; lower++; }
  if (eq2 < 1) { eq2nlm = macrovectorScores[`${eq1}${eq2 + 1}${eq3}${eq4}${eq5}${eq6}`]; lower++; }
  if (eq4 < 2) { eq4nlm = macrovectorScores[`${eq1}${eq2}${eq3}${eq4 + 1}${eq5}${eq6}`]; lower++; }
  if (eq5 < 2) { eq5nlm = macrovectorScores[`${eq1}${eq2}${eq3}${eq4}${eq5 + 1}${eq6}`]; lower++; }
  if (eq3 === 1 && eq6 === 1) { eq3eq6nlm = macrovectorScores[`${eq1}${eq2}${eq3 + 1}${eq4}${eq5}${eq6}`]; lower++; }
  else if (eq3 === 0 && eq6 === 1) { eq3eq6nlm = macrovectorScores[`${eq1}${eq2}${eq3 + 1}${eq4}${eq5}${eq6}`]; lower++; }
  else if (eq3 === 1 && eq6 === 0) { eq3eq6nlm = macrovectorScores[`${eq1}${eq2}${eq3}${eq4}${eq5}${eq6 + 1}`]; lower++; }
  else if (eq3 === 0 && eq6 === 0) {
    eq3eq6nlm = Math.max(
      macrovectorScores[`${eq1}${eq2}${eq3 + 1}${eq4}${eq5}${eq6}`],
      macrovectorScores[`${eq1}${eq2}${eq3}${eq4}${eq5}${eq6 + 1}`]);
    lower++;
  }
  const msd = (nlm: number) => Number.isNaN(nlm) ? 0 : Math.abs(nlm - eqsv);
  let eq1msd = msd(eq1nlm), eq2msd = msd(eq2nlm), eq3eq6msd = msd(eq3eq6nlm),
    eq4msd = msd(eq4nlm), eq5msd = msd(eq5nlm);
  let eq1svdst = 0, eq2svdst = 0, eq3eq6svdst = 0, eq4svdst = 0;
  const eq3Table = (highestSeverityVectors[3] as unknown as Record<string, Record<string, string[]>>)[String(eq3)];
  const eq3Vectors = eq3Table?.[String(eq6)] ?? [];
  for (const eq1mx of highestSeverityVectors[1][String(eq1)]) {
    for (const eq2mx of highestSeverityVectors[2][String(eq2)]) {
      for (const eq3eq6mx of eq3Vectors) {
        for (const eq4mx of highestSeverityVectors[4][String(eq4)]) {
          const partial = [eq1mx, eq2mx, eq3eq6mx, eq4mx].join("/");
          const distance = (metric: string) => severityDistance(metric, real(base, metric), valueOf(partial, metric));
          const distances = ["AV", "PR", "UI", "AC", "AT", "VC", "VI", "VA", "SC", "SI", "SA", "CR", "IR", "AR"].map(distance);
          if (distances.some(value => value < 0)) continue;
          eq1svdst = distance("AV") + distance("PR") + distance("UI");
          eq2svdst = distance("AC") + distance("AT");
          eq3eq6svdst = distance("VC") + distance("VI") + distance("VA") + distance("CR") + distance("IR") + distance("AR");
          eq4svdst = distance("SC") + distance("SI") + distance("SA");
          break;
        }
      }
    }
  }
  const eq1prop = eq1svdst / (depth[1][String(eq1)] + 1);
  const eq2prop = eq2svdst / (depth[2][String(eq2)] + 1);
  const eq3eq6prop = eq3eq6svdst / ((depth36[String(eq3)]?.[String(eq6)] ?? 0) + 1);
  const eq4prop = eq4svdst / (depth[4][String(eq4)] + 1);
  const eq5prop = 0 / (depth[5][String(eq5)] + 1);
  eq1msd *= eq1prop; eq2msd *= eq2prop; eq3eq6msd *= eq3eq6prop; eq4msd *= eq4prop; eq5msd *= eq5prop;
  const mean = lower === 0 ? 0 : (eq1msd + eq2msd + eq3eq6msd + eq4msd + eq5msd) / lower;
  return roundup(eqsv - mean);
}

export type CvssSeverity = "none" | "low" | "medium" | "high" | "critical" | "informational";
export const severityFromScore = (score: number): CvssSeverity =>
  score === 0 ? "none" : score < 4 ? "low" : score < 7 ? "medium" : score < 9 ? "high" : "critical";

export interface ImpactEvidence {
  metric: "VC" | "VI" | "VA" | "SC" | "SI" | "SA";
  affected: string;
  boundary: string;
  consequence: string;
  evidence_ids: string[];
}
export interface CvssInput { vector: string; rationale: string; impact_evidence?: ImpactEvidence[] }
export interface CvssRecord extends CvssInput { version: "4.0"; score: number }

/** Validate coverage and evidence bindings, leaving causal evaluation to Review. */
export function validateImpactEvidence(record: CvssRecord, referenced: string[]): void {
  const base = parseCvssVector(record.vector);
  const claims = record.impact_evidence ?? [];
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.metric)) throw new CvssError(`Duplicate impact evidence for ${claim.metric}`);
    seen.add(claim.metric);
    if (base[claim.metric] === "N") throw new CvssError(`Impact evidence contradicts ${claim.metric}:N`);
    if (!claim.affected.trim() || !claim.boundary.trim() || !claim.consequence.trim() || !claim.evidence_ids.length)
      throw new CvssError(`Incomplete impact evidence for ${claim.metric}`);
    if (claim.evidence_ids.some(id => !referenced.includes(id)))
      throw new CvssError(`Impact evidence for ${claim.metric} must reference the finding/review evidence`);
  }
  for (const metric of ["VC", "VI", "VA", "SC", "SI", "SA"] as const)
    if (base[metric] !== "N" && !seen.has(metric))
      throw new CvssError(`Non-zero CVSS impact ${metric} requires impact_evidence: affected, boundary, consequence and evidence_ids; use needs_evidence for unproven impact`);
}

/** The single place a score is produced: parse, score, round and keep the rationale. */
export function scoreCvss(input: CvssInput): CvssRecord {
  const vector = input.vector.trim();
  return { version: CVSS_VERSION, vector, score: cvssScore(vector), rationale: input.rationale.trim(),
    ...(input.impact_evidence ? { impact_evidence: input.impact_evidence } : {}) };
}
