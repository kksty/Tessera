import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { projectEntry } from "../../packages/core/src/projection.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";

test("上报的新主机同时落成资产与一条事实，决策者能在入口里看到", () => {
  const store = new Store(":memory:");
  try {
    const graph = store.create(
      createProjectSchema.parse({ title: "发现", origin: "https://seed.example.test", goal: "评估" }),
    );
    const id = graph.project.id;
    const [asset] = store.discover(id, [{ hostname: "Dev.Seed.example.test.", source: "dns", evidence_ids: [] }]);
    const after = store.get(id);
    assert.equal(asset.approval, "approved", "模型判定范围，登记即可用");
    const fact = after.facts.find((f) => f.asset_id === asset.id);
    assert.ok(fact, "发现必须留下一条事实");
    assert.equal(fact.status, "observed");
    assert.match(String(fact.conclusion), /dev\.seed\.example\.test/);
    assert.match(fact.description, /dns/);

    const entry = projectEntry(after, "goal") as Record<string, unknown>;
    const lines = entry.facts as string[];
    assert.ok(
      lines.some((line) => line.includes("dev.seed.example.test")),
      "登记资产要出现在决策入口的事实列表里",
    );
    assert.ok(
      lines.some((line) => line.startsWith("origin")),
      "种子事实仍在",
    );
  } finally {
    store.close();
  }
});

test("重复上报同一主机不会重复建事实", () => {
  const store = new Store(":memory:");
  try {
    const graph = store.create(
      createProjectSchema.parse({ title: "发现", origin: "https://seed.example.test", goal: "评估" }),
    );
    const id = graph.project.id;
    store.discover(id, [{ hostname: "dup.example.test", source: "dns", evidence_ids: [] }]);
    store.discover(id, [{ hostname: "DUP.example.test", source: "dns", evidence_ids: [] }]);
    const after = store.get(id);
    assert.equal(after.assets.filter((a) => a.hostname === "dup.example.test").length, 1);
    assert.equal(after.facts.filter((f) => f.description.includes("dup.example.test")).length, 1);
  } finally {
    store.close();
  }
});

test("模型提交的主机都登记为可用资产，不再逐资产批准", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "范围", origin: "https://example.test", goal: "评估目标" }),
    ).project.id;
    const evidence = store.addEvidence(id, {
      title: "Login page",
      content: "External QR API and CA links",
      encoding: "utf8",
      mime_type: "text/html",
    });
    const hosts = [
      "API.Example.TEST.",
      "child.api.example.test",
      "api.app.ebidsun.com",
      "online.cwca.com.cn",
      "example.test.attacker.test",
      "notexample.test",
      "example.other.test",
      "192.0.2.10",
    ];
    const result = store.discover(
      id,
      hosts.map((hostname) => ({ hostname, source: "页面与 DNS 线索", evidence_ids: [evidence.id] })),
    );
    assert.deepEqual(
      result.map((a) => a.hostname),
      [
        "api.example.test",
        "child.api.example.test",
        "api.app.ebidsun.com",
        "online.cwca.com.cn",
        "example.test.attacker.test",
        "notexample.test",
        "example.other.test",
        "192.0.2.10",
      ],
    );
    assert.ok(
      result.every((a) => a.approval === "approved"),
      "模型判定范围，登记即可用",
    );
    assert.equal(store.get(id).assets.length, 9);
    const external = store.get(id).facts.filter((f) => f.asset_id === result[2].id);
    assert.equal(external.length, 1, "登记资产要留一条可见事实");
    assert.match(external[0].description, /登记资产/);
    // 重复提交同一主机不会重复建资产或事实
    store.discover(id, [{ hostname: "API.APP.EBIDSUN.COM.", source: "再次见到", evidence_ids: [evidence.id] }]);
    assert.equal(store.get(id).assets.length, 9);
    assert.equal(store.get(id).facts.filter((f) => f.asset_id === result[2].id).length, 1);
    // 不再有逐资产批准门槛，登记后可直接建单测试
    store.manualStep(id, { from: ["origin"], description: "登记后可直接测试", creator: "QA", asset_id: result[2].id });
  } finally {
    store.close();
  }
});
