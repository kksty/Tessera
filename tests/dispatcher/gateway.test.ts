import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateCallback,
  CallbackSlotRegistry,
  callbackRange,
  callbackSlotCount,
  gatewayIdleMilliseconds,
  gatewaySubnetPool,
  ingressConfig,
  networkAddresses,
  nextFreeSubnet,
  subnetsOverlap,
} from "../../apps/dispatcher/src/gateway.js";
import { callbackEnvironment } from "../../packages/runner/src/task-resources.js";
import { toolEnvironment } from "../../packages/runner/src/tool-environment.js";

test("callback blocks do not overlap, honor existing reservations and report exhaustion", () => {
  const policy = { host: "vps.example", first: 20000, last: 20299, size: 100, bind: "0.0.0.0" };
  const one = allocateCallback(policy, [])!;
  assert.deepEqual(one, { host: "vps.example", first: 20000, last: 20099 });
  const two = allocateCallback(policy, [one])!;
  assert.equal(two.first, 20100);
  const three = allocateCallback(policy, [one, two])!;
  assert.equal(three.first, 20200);
  assert.throws(() => allocateCallback(policy, [one, two, three]), /exhausted/);
  assert.equal(allocateCallback({ ...policy, host: "" }, [one, two, three]), null);
  assert.equal(allocateCallback(policy, [{ host: "", first: 20050, last: 20120 }])!.first, 20200);
});

test("explicit callbacks reject shared host ports and invalid protocols but allow separate TCP/UDP", () => {
  assert.throws(
    () =>
      ingressConfig(
        JSON.stringify({
          a: [{ host_port: 20000, worker_port: 4444, bind: "0.0.0.0" }],
          b: [{ host_port: 20000, worker_port: 5555 }],
        }),
      ),
    /Duplicate/,
  );
  assert.throws(() => ingressConfig('{"a":[{"host_port":0,"worker_port":1}]}'));
  assert.throws(() => ingressConfig('{"a":[{"host_port":20000,"worker_port":1,"protocol":"sctp"}]}'));
  const config = ingressConfig(
    '{"a":[{"host_port":20000,"worker_port":4444},{"host_port":20000,"worker_port":4444,"protocol":"udp"}]}',
  );
  assert.equal(config.a[0].bind, "127.0.0.1");
  assert.equal(config.a.length, 2);
});

test("model receives the public callback contract without gateway controls or credentials", () => {
  const env = {
    TESSERA_CALLBACK_HOST: "vps.example",
    TESSERA_CALLBACK_PORT_START: "20000",
    TESSERA_CALLBACK_PORT_END: "20099",
    TESSERA_GATEWAY_IP: "172.20.0.2",
    TESSERA_PROJECT_TOKEN: "secret",
  };
  const tools = toolEnvironment(env);
  assert.equal(tools.TESSERA_CALLBACK_HOST, "vps.example");
  assert.equal(tools.TESSERA_GATEWAY_IP, undefined);
  assert.equal(tools.TESSERA_PROJECT_TOKEN, undefined);
  assert.match(callbackEnvironment(env), /vps.example/);
  assert.match(callbackEnvironment(env), /20000–20099/);
  assert.match(callbackEnvironment(env), /0.0.0.0/);
  assert.doesNotMatch(callbackEnvironment(env), /172.20|secret/);
  assert.equal(callbackEnvironment({ ...env, TESSERA_CALLBACK_HOST: "bad\ninstruction" }), "");
  assert.equal(callbackEnvironment({}), "");
});

test("project endpoints stay distinct from Docker IPAM's reserved address", () => {
  assert.deepEqual(networkAddresses("172.20.0.0/16"), { gateway: "172.20.0.2", worker: "172.20.0.3" });
  assert.throws(() => networkAddresses("172.20.0.0/30"));
  assert.throws(() => networkAddresses("fd00::/64"));
});

test("project subnets are explicit /29 slices that avoid existing reservations", () => {
  assert.equal(nextFreeSubnet("10.250.0.0/16", 29, []), "10.250.0.0/29");
  assert.equal(nextFreeSubnet("10.250.0.0/16", 29, ["10.250.0.0/29"]), "10.250.0.8/29");
  assert.equal(
    nextFreeSubnet("10.250.0.0/16", 29, ["10.250.0.8/29", "10.249.0.0/16", "10.251.0.0/16"]),
    "10.250.0.0/29",
  );
  assert.equal(nextFreeSubnet("10.250.0.0/16", 29, ["172.19.0.0/16"]), "10.250.0.0/29");
  assert.throws(() => nextFreeSubnet("10.250.0.0/29", 29, ["10.250.0.0/29"]), /No free/);
  assert.equal(subnetsOverlap("10.250.0.0/16", "10.250.7.0/29"), true);
  assert.equal(subnetsOverlap("10.250.0.0/16", "10.251.0.0/16"), false);
  const previous = process.env.TESSERA_GATEWAY_SUBNET_POOL;
  try {
    process.env.TESSERA_GATEWAY_SUBNET_POOL = "100.64.0.0/10";
    assert.equal(gatewaySubnetPool(), "100.64.0.0/10");
  } finally {
    if (previous === undefined) delete process.env.TESSERA_GATEWAY_SUBNET_POOL;
    else process.env.TESSERA_GATEWAY_SUBNET_POOL = previous;
  }
});

test("concurrent Runs get disjoint callback subranges of the project block", () => {
  const block = { host: "vps.example", first: 20000, last: 20099 };
  assert.equal(callbackSlotCount(block, 4), 4);
  const ranges = [0, 1, 2, 3].map((slot) => callbackRange(block, 4, slot)!);
  assert.deepEqual(ranges[0], { first: 20000, last: 20024 });
  assert.deepEqual(ranges[3], { first: 20075, last: 20099 });
  for (let i = 0; i < ranges.length; i++)
    for (let j = i + 1; j < ranges.length; j++) assert.ok(ranges[i].last < ranges[j].first);
  assert.equal(callbackRange(block, 4, 4), null);
  assert.equal(callbackSlotCount(block, 1), 1);
  assert.deepEqual(callbackRange(block, 1, 0), { first: 20000, last: 20099 });
  const narrow = { host: "", first: 20000, last: 20001 };
  assert.equal(callbackSlotCount(narrow, 4), 2);
  assert.deepEqual(callbackRange(narrow, 2, 1), { first: 20001, last: 20001 });
  assert.equal(callbackRange(narrow, 4, 0), null);
  assert.equal(callbackSlotCount(null, 4), 0);
});

test("callback slot registry hands out unique slots, recycles them and isolates projects", () => {
  const registry = new CallbackSlotRegistry();
  assert.equal(registry.acquire("a", 2), 0);
  assert.equal(registry.acquire("a", 2), 1);
  assert.equal(registry.acquire("a", 2), null);
  assert.equal(registry.acquire("b", 2), 0, "projects have independent slots");
  registry.release("a", 0);
  assert.equal(registry.acquire("a", 2), 0, "released slot is reused");
  assert.equal(registry.acquire("a", 0), null);
  registry.release("a", 99);
  assert.equal(registry.acquire("a", 2), null, "unknown releases are a no-op");
});

test("idle gateway delay accepts seconds but rejects negatives", () => {
  assert.equal(gatewayIdleMilliseconds(undefined), 600_000);
  assert.equal(gatewayIdleMilliseconds("0"), 0);
  assert.equal(gatewayIdleMilliseconds("90"), 90_000);
  assert.throws(() => gatewayIdleMilliseconds("-1"), /non-negative/);
  assert.throws(() => gatewayIdleMilliseconds("soon"), /non-negative/);
});
