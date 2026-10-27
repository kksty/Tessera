import type { Graph } from "../../protocol/src/models.js";
import { TEST_DOMAINS, TEST_DOMAIN_LABELS } from "../../protocol/src/domains.js";
import { activeGraph } from "../../protocol/src/node-lifecycle.js";

/** 固定的展示顺序：九个核心域在前，未分类最后。 */
export const DOMAIN_ORDER: string[] = [...TEST_DOMAINS];
/** 未分类的 Step、没有生产者的孤立事实都落在 other。 */
export const DEFAULT_DOMAIN = "other";
/** 核心域：除 other 之外的九个域。覆盖率按「用到几个核心域 / 9」计算。 */
export const CORE_DOMAINS = DOMAIN_ORDER.filter((domain) => domain !== DEFAULT_DOMAIN);

export interface DomainStat {
  key: string;
  label: string;
  steps: number;
  facts: number;
  findings: number;
  /** 该域任务数 / 全部任务数。 */
  share: number;
}

export interface DomainStats {
  /** 当前未删除、未丢弃的任务数。 */
  total: number;
  /** 未删除但已丢弃的任务数；不计入 total，只在日志里说明差额。 */
  discarded: number;
  classified: number;
  unclassified: number;
  /** 用到的核心域数量。 */
  used: number;
  coreTotal: number;
  /** 核心域覆盖率 = used / coreTotal。 */
  coverage: number;
  /** 未分类任务占比。 */
  otherRatio: number;
  /** 输入事实来自其他域的任务数：跨域依赖，不是错误，但值得在日志里看见。 */
  crossDomain: number;
  /** 按 DOMAIN_ORDER 排列，含 0 条的域，便于看出覆盖缺口。 */
  domains: DomainStat[];
}

/**
 * 测试域统计：任务按自己的 test_domain 计数，Fact / Finding 跟随生产任务。
 * 只统计当前活动图（未删除）且未丢弃的任务；没有 test_domain 的任务算「其他 / 未分类」。
 * 这是规划覆盖的度量，不是执行完成度。黑板时间线和诊断日志导出共用这一份实现。
 */
export function domainStats(graph: Graph): DomainStats {
  const active = activeGraph(graph);
  const steps = active.steps.filter((step) => !step.discarded);
  const discarded = active.steps.length - steps.length;
  const domainOfStep = new Map(steps.map((step) => [step.id, step.test_domain ?? DEFAULT_DOMAIN]));
  const factById = new Map(active.facts.map((fact) => [fact.id, fact]));
  const counts = new Map<string, { steps: number; facts: number; findings: number }>(
    DOMAIN_ORDER.map((key) => [key, { steps: 0, facts: 0, findings: 0 }]),
  );
  const bump = (domain: string, kind: "steps" | "facts" | "findings") => {
    const bucket = counts.get(domain);
    if (bucket) bucket[kind] += 1;
  };

  for (const step of steps) bump(step.test_domain ?? DEFAULT_DOMAIN, "steps");
  for (const fact of active.facts) {
    // 起点、范围授权事实没有生产任务，不参与域统计。
    const domain = fact.step_id ? domainOfStep.get(fact.step_id) : undefined;
    if (domain) bump(domain, "facts");
  }
  for (const finding of active.findings) {
    if (finding.merged_into || finding.withdrawn_at) continue;
    const producer =
      finding.step_id ??
      finding.revision_step_id ??
      finding.from.map((id) => factById.get(id)?.step_id).find((id) => !!id);
    const domain = producer ? domainOfStep.get(producer) : undefined;
    if (domain) bump(domain, "findings");
  }

  const total = steps.length;
  const unclassified = counts.get(DEFAULT_DOMAIN)?.steps ?? 0;
  const used = CORE_DOMAINS.filter((key) => (counts.get(key)?.steps ?? 0) > 0).length;
  const producerOfFact = new Map<string, string>();
  for (const fact of active.facts) if (fact.step_id) producerOfFact.set(fact.id, fact.step_id);
  const crossDomain = steps.filter((step) => {
    const own = step.test_domain ?? DEFAULT_DOMAIN;
    return step.from.some((id) => {
      const producer = producerOfFact.get(id);
      const source = producer ? domainOfStep.get(producer) : undefined;
      return !!source && source !== own;
    });
  }).length;
  return {
    total,
    discarded,
    classified: total - unclassified,
    unclassified,
    used,
    coreTotal: CORE_DOMAINS.length,
    coverage: CORE_DOMAINS.length ? used / CORE_DOMAINS.length : 0,
    otherRatio: total ? unclassified / total : 0,
    crossDomain,
    domains: DOMAIN_ORDER.map((key) => {
      const count = counts.get(key) ?? { steps: 0, facts: 0, findings: 0 };
      return {
        key,
        label: TEST_DOMAIN_LABELS[key as keyof typeof TEST_DOMAIN_LABELS] ?? key,
        ...count,
        share: total ? count.steps / total : 0,
      };
    }),
  };
}
