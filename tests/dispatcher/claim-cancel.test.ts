import { test } from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../../apps/dispatcher/src/loop.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";

test("a timed-out claim is cancelled so the server cannot keep an orphan lease", async () => {
  const claims: { path: string; body: any }[] = [];
  const cancels: { path: string; body: any; timeout?: number }[] = [];
  const dispatcher = new Dispatcher(
    {
      timeouts: { cancel_ms: 5000, claim_ms: 90000, release_ms: 30000 },
      // The real client's control() uses the long claim budget; this double times out.
      control: async (path: string, body: any) => {
        claims.push({ path, body });
        throw new Error("API 0: timeout after 90000ms");
      },
      request: async (path: string, body: any, _method?: string, timeout?: number) => {
        if (path === "/projects") return [{ id: "p1", status: "active" }];
        cancels.push({ path, body, timeout });
        return { cancelled: false };
      },
    } as any,
    { prepare: async () => true, run: async () => {} },
  );
  const config = new RuntimeConfig("unused-claim-cancel.json", {}).value;
  config.model = { ...config.model, id: "fixture", base_url: "http://fixture.invalid/v1" };
  config.max_workers = 1;
  config.max_project_workers = 1;
  await dispatcher.tick(config);
  assert.equal(claims.length, 1);
  const claim = claims[0];
  assert.match(claim.path, /\/projects\/p1\/jobs\/claim$/);
  assert.ok(claim.body.claim_id, "the claim carries a client-generated id");
  assert.equal(cancels.length, 1, "the abandoned claim is cancelled once");
  assert.equal(cancels[0].path, `/projects/p1/jobs/claim/${encodeURIComponent(claim.body.claim_id)}/cancel`);
  assert.equal(cancels[0].body.worker, claim.body.worker);
  assert.equal(cancels[0].timeout, 5000, "cancel must not block the scheduler slot");
  assert.equal(dispatcher.running.size, 0);
  await dispatcher.stop();
});
