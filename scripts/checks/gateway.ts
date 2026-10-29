/** Real Docker topology check. Build --target gateway first; all targets are temporary local fixtures. */
import Docker from "dockerode";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ProjectGateway, bridgeForwarding } from "../../apps/dispatcher/src/gateway.js";
import type { DispatchConfig } from "../../packages/protocol/src/index.js";

const docker = new Docker({
  socketPath: process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock",
});
const prefix = `tessera-nettest-${Date.now()}`,
  project = "fixture";
const image = process.env.TESSERA_GATEWAY_TEST_IMAGE || "tessera-gateway:network-test";
Object.assign(process.env, {
  TESSERA_GATEWAY_IMAGE: image,
  TESSERA_CALLBACK_HOST: "127.0.0.1",
  TESSERA_CALLBACK_BIND: "127.0.0.1",
  TESSERA_CALLBACK_PORTS: "23870-23871",
  TESSERA_CALLBACK_BLOCK_SIZE: "2",
  TESSERA_WORKER_TOKEN: "network-fixture",
  TESSERA_WORKER_INGRESS: "",
  TESSERA_CAPTURE_UPSTREAM: "",
  TESSERA_CAPTURE_BYPASS: "",
});
const config = {
  volume_prefix: prefix,
  network: `${prefix}-uplink`,
  server: "http://target:9000",
  capture_enabled: true,
} as DispatchConfig;
const manager = new ProjectGateway(docker),
  containers: string[] = [];
const fixtureMount: Docker.MountSettings = {
  Type: "bind",
  Source: resolve("scripts/checks/gateway-fixture.py"),
  Target: "/fixture.py",
  ReadOnly: true,
};
function cli(...args: string[]) {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function python(container: string, source: string) {
  return cli("exec", container, "python3", "-c", source);
}
let gatewayName = `${prefix}-gateway-${project}`;
try {
  await docker.createNetwork({ Name: config.network });
  const target = await docker.createContainer({
    name: `${prefix}-target`,
    Image: image,
    Cmd: ["python3", "/fixture.py", "target"],
    HostConfig: { NetworkMode: config.network, Mounts: [fixtureMount] },
    NetworkingConfig: { EndpointsConfig: { [config.network]: { Aliases: ["target"] } } },
  });
  containers.push(target.id);
  await target.start();
  for (let i = 0; i < 30; i++) {
    try {
      python(target.id, "import socket; socket.create_connection(('127.0.0.1',9000),1).close()");
      break;
    } catch {
      await sleep(200);
    }
  }
  const gateway = await manager.ensure(project, config);
  const certificate = cli("exec", target.id, "cat", "/tmp/cert.pem");
  python(
    gatewayName,
    `import base64; from pathlib import Path; Path('/usr/local/share/ca-certificates/fixture.crt').write_bytes(base64.b64decode('${Buffer.from(certificate).toString("base64")}'))`,
  );
  cli("exec", gatewayName, "update-ca-certificates");
  await docker.getContainer(gatewayName).restart();
  await manager.ensure(project, config);
  const worker = await docker.createContainer({
    name: `${prefix}-worker`,
    Image: image,
    Cmd: ["python3", "/fixture.py", "worker", "23870", "23871"],
    HostConfig: {
      NetworkMode: gateway.networkName,
      CapDrop: ["NET_ADMIN"],
      CapAdd: ["NET_RAW"],
      SecurityOpt: ["no-new-privileges:true"],
      Sysctls: { "net.ipv6.conf.all.disable_ipv6": "1" },
      Mounts: [fixtureMount, { Type: "volume", Source: gateway.ca, Target: "/etc/tessera-ca", ReadOnly: true }],
    },
    NetworkingConfig: { EndpointsConfig: { [gateway.networkName]: { IPAMConfig: { IPv4Address: gateway.worker } } } },
  });
  containers.push(worker.id);
  await worker.start();
  python(
    worker.id,
    `from pathlib import Path; Path('/etc/resolv.conf').write_text('nameserver ${gateway.gateway}'+chr(10))`,
  );
  const targetIP = (await target.inspect()).NetworkSettings.Networks[config.network].IPAddress;
  assert.throws(
    () => python(worker.id, `import socket; socket.create_connection(('${targetIP}',9001),1)`),
    "isolated worker must have no initial escape route",
  );
  await manager.route(worker, gateway.gateway, project);
  assert.throws(() => cli("exec", worker.id, "ip", "route", "del", "default"), "Worker cannot modify its routes");
  assert.throws(() => cli("exec", worker.id, "iptables", "-F"), "Worker cannot change firewall rules");
  const fetch = `import urllib.request,ssl; opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile='/etc/tessera-ca/project-ca.crt'))); print(opener.open(URL,timeout=5).read().decode())`;
  assert.equal(python(worker.id, fetch.replace("URL", "'http://target:9001/plain'")), "fixture-http-ok");
  assert.equal(python(worker.id, fetch.replace("URL", "'https://target:9443/tls'")), "fixture-http-ok");
  assert.equal(
    python(
      worker.id,
      "import socket; s=socket.create_connection(('target',9998),5); print(s.recv(100).decode().strip()); s.sendall(b'raw-ok'); print(s.recv(100).decode())",
    ),
    "SSH-fixture-banner\nraw-ok",
  );
  assert.equal(
    python(
      worker.id,
      "import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(3); s.sendto(b'udp-ok',('target',9999)); print(s.recv(100).decode())",
    ),
    "udp-ok",
  );
  // Simulate an external peer on the uplink: callback connection, followed by bidirectional application data.
  const gatewayIP = (await docker.getContainer(gatewayName).inspect()).NetworkSettings.Networks[config.network]
    .IPAddress;
  assert.equal(
    python(
      target.id,
      `import socket; s=socket.create_connection(('${gatewayIP}',23870),5); print(s.recv(100).decode().strip()); s.sendall(b'callback-tcp'); print(s.recv(100).decode())`,
    ),
    "SSH-fixture-banner\ncallback-tcp",
  );
  assert.equal(
    python(
      target.id,
      `import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(3); s.sendto(b'callback-udp',('${gatewayIP}',23871)); print(s.recv(100).decode())`,
    ),
    "callback-udp",
  );
  // Check the Docker host publication as well as the second DNAT hop.
  const { createConnection } = await import("node:net");
  await new Promise<void>((ok, fail) => {
    const socket = createConnection(23870, "127.0.0.1");
    let data = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("callback timeout")));
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("SSH-fixture-banner")) {
        socket.destroy();
        ok();
      }
    });
  });
  await sleep(1500);
  const records = JSON.parse(
    python(
      target.id,
      "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:9000/records').read().decode())",
    ),
  );
  assert.ok(records.some((r: any) => r.url === "http://target:9001/plain" && r.response));
  assert.ok(records.some((r: any) => r.url === "https://target:9443/tls" && r.response));
  assert.ok(records.every((r: any) => r.capture_kind === "http"));
  assert.ok(records.every((r: any) => !r.url.includes("23870") && !r.url.includes("23871")));
  await docker.getContainer(gatewayName).stop();
  assert.throws(
    () => python(worker.id, fetch.replace("URL", "'http://target:9001/blocked'")),
    "gateway stop must not fall back to direct access",
  );
  console.log(
    "PASS: isolated routing, immutable Worker rules, transparent HTTP/HTTPS on custom ports, raw TCP/UDP, bidirectional callback TCP/UDP, published host port, HTTP-only records, gateway fail-closed",
  );
} catch (error) {
  try {
    execFileSync("docker", ["logs", "--tail", "35", gatewayName], { stdio: "inherit" });
  } catch {}
  try {
    console.error(cli("exec", gatewayName, "iptables-save", "-c"));
  } catch {}
  try {
    console.error(cli("exec", `${prefix}-worker`, "ip", "route"));
  } catch {}
  try {
    console.error(python(`${prefix}-worker`, "print(open('/proc/net/tcp').read())"));
  } catch {}
  try {
    console.error(
      cli("run", "--rm", "--network", "host", "--cap-add", "NET_ADMIN", image, "iptables-save", "-c", "-t", "filter"),
    );
  } catch {}
  throw error;
} finally {
  for (const id of [...containers.reverse(), gatewayName])
    await docker
      .getContainer(id)
      .remove({ force: true, v: false })
      .catch(() => {});
  const network = await docker
    .getNetwork(`${prefix}-isolated-${project}`)
    .inspect()
    .catch(() => null);
  if (network)
    await bridgeForwarding(docker, image, project, network.Options!["com.docker.network.bridge.name"], false);
  for (const name of [`${prefix}-isolated-${project}`, config.network])
    await docker
      .getNetwork(name)
      .remove()
      .catch(() => {});
  for (const name of [`${prefix}-gateway-ca-${project}`, `${prefix}-gateway-data-${project}`])
    await docker
      .getVolume(name)
      .remove()
      .catch(() => {});
}
