import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { DOMAIN_LABEL, domainStats } from "../../apps/web/src/graph-summary.js";

function fixture() {
  const store = new Store(":memory:");
  const id = store.create(
    createProjectSchema.parse({ title: "Domain stats", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const step = (description: string, test_domain?: string, focus?: string) =>
    store.manualStep(id, {
      from: ["origin"],
      description,
      creator: "human",
      claim: true,
      test_domain: test_domain as any,
      focus,
    });
  const fact = (stepId: string, description: string) =>
    store.fact(id, stepId, { worker: "human", description, evidence_ids: [] });

  const recon = step("Enumerate subdomains", "recon");
  const reconFact = fact(recon.id, "admin.example.test resolves");
  const access = step("Check IDOR on the admin panel", "access");
  fact(access.id, "other tenant record readable");
  store.mutate(id, "fixture.cross-domain", false, (g) => {
    // 用 recon 的事实作为 access 任务的输入：跨域依赖，统计里应单独计数。
    g.steps.find((item) => item.id === access.id)!.from = [reconFact.id];
  });
  const inject = step("Probe the search box", "inject", "注入：反射型");
  const injectFact = fact(inject.id, "payload returns verbatim");
  store.submitFinding(
    id,
    findingSchema.parse({ title: "Reflected XSS", description: "Search box reflects input", from: [injectFact.id] }),
  );
  const post = step("Escalate with SUID", "post", "提权：SUID");
  fact(post.id, "root shell obtained");
  const legacy = step("Old manual check");
  fact(legacy.id, "legacy check recorded");
  const discarded = step("Abandoned logic probe", "logic");
  fact(discarded.id, "abandoned observation");
  store.mutate(id, "fixture.discard", false, (g) => {
    const step = g.steps.find((item) => item.id === discarded.id)!;
    step.discarded = true;
    step.concluded_at = new Date().toISOString();
  });
  return { store, id };
}

test("项目日志统计各域任务数、核心域覆盖率与未分类比例", () => {
  const { store, id } = fixture();
  try {
    const stats = domainStats(store.get(id));
    assert.equal(stats.total, 5, "丢弃的任务不计入统计");
    assert.equal(stats.discarded, 1);
    assert.equal(stats.classified, 4);
    assert.equal(stats.unclassified, 1);
    assert.equal(stats.used, 4);
    assert.equal(stats.coreTotal, 9);
    assert.equal(stats.coverage, 4 / 9);
    assert.equal(stats.otherRatio, 1 / 5);
    assert.equal(stats.crossDomain, 1, "access 任务的输入来自 recon，算一条跨域依赖");

    const byKey = new Map(stats.domains.map((domain) => [domain.key, domain]));
    assert.equal(stats.domains.length, 10, "九个核心域加 other，空域也保留 0 条");
    assert.equal(byKey.get("recon")!.steps, 1);
    assert.equal(byKey.get("recon")!.facts, 1);
    assert.equal(byKey.get("recon")!.label, DOMAIN_LABEL.recon);
    assert.equal(byKey.get("recon")!.share, 1 / 5);
    assert.equal(byKey.get("inject")!.findings, 1, "发现跟随生产任务继承域");
    assert.equal(byKey.get("post")!.steps, 1);
    assert.equal(byKey.get("other")!.steps, 1);
    assert.match(byKey.get("other")!.label, /未分类/);
    assert.equal(byKey.get("logic")!.steps, 0, "被丢弃的任务不出现");
    assert.equal(
      stats.domains.reduce((total, domain) => total + domain.facts, 0),
      5,
      "丢弃任务的事实不参与统计，范围授权事实也不参与",
    );
  } finally {
    store.close();
  }
});

test("空项目没有任务时统计为 0，不产生 NaN", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Empty", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const stats = domainStats(store.get(id));
    assert.equal(stats.total, 0);
    assert.equal(stats.discarded, 0);
    assert.equal(stats.classified, 0);
    assert.equal(stats.unclassified, 0);
    assert.equal(stats.coverage, 0);
    assert.equal(stats.otherRatio, 0);
    assert.equal(stats.crossDomain, 0);
    assert.equal(stats.domains.length, 10);
    assert.equal(
      stats.domains.every((domain) => Number.isFinite(domain.share) && domain.share === 0),
      true,
    );
  } finally {
    store.close();
  }
});
