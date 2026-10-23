import { test } from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../../apps/dispatcher/src/loop.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";

test("one global slot rotates across ticks and skips unavailable projects", async () => {
  const claimed: string[] = [], releases: (() => void)[] = [];
  let projects = ["a", "b", "c"];
  const dispatcher = new Dispatcher({ request: async (path: string, body: any) => {
    if (path === "/projects") return projects.map(id => ({ id, status: "active" }));
    if (path.endsWith("/release")) return { ok: true };
    const id = path.split("/")[2];
    claimed.push(id);
    return { kind: "review", project_id: id, graph_id: "main", worker: body.worker, finding_id: "v001", finding_version: 1 };
  } } as any, {
    prepare: async id => id !== "b",
    run: async () => new Promise<void>(resolve => { releases.push(resolve); }),
  });
  const config = new RuntimeConfig("unused-fairness-config.json", {}).value;
  config.model = { ...config.model, id: "fixture", base_url: "http://fixture.invalid/v1" };
  config.max_workers = 1;
  try {
    for (let i = 0; i < 4; i++) {
      await dispatcher.tick(config);
      const tasks = [...dispatcher.running.values()];
      assert.equal(tasks.length, 1);
      releases.shift()!();
      await Promise.all(tasks.map(t => t.promise));
    }
    assert.deepEqual(claimed, ["a", "c", "a", "c"]);
    projects = ["a", "b"]; // The cursor's project disappeared.
    await dispatcher.tick(config);
    const tasks = [...dispatcher.running.values()];
    releases.shift()!(); await Promise.all(tasks.map(t => t.promise));
    assert.equal(claimed.at(-1), "a");
  } finally { releases.forEach(resolve => resolve()); await dispatcher.stop(); }
});
