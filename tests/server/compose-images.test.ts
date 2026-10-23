import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

test("compose builds both images locally and keeps external images opt-in", () => {
  const source = readFileSync("compose.yaml", "utf8");
  const compose = parse(source);
  for (const service of ["tessera-server", "tessera-dispatcher", "worker-image"])
    assert.ok(compose.services[service].build, `${service} must build from source`);
  assert.equal(
    compose.services["tessera-server"].image,
    "${TESSERA_APP_IMAGE:-tessera-server:${TESSERA_IMAGE_TAG:-latest}}",
  );
  assert.equal(
    compose.services["worker-image"].image,
    "${TESSERA_WORKER_IMAGE:-tessera-runtime:${TESSERA_IMAGE_TAG:-latest}}",
  );
  assert.doesNotMatch(source, /ghcr\.io/, "no registry image may be pulled by default");
  assert.equal(compose.services["tessera-server"].build.dockerfile, "Dockerfile");
  assert.equal(compose.services["worker-image"].build.dockerfile, "docker/worker.Dockerfile");
  assert.equal(compose.services["worker-image"].build.target, "${TESSERA_WORKER_TARGET:-runtime}");
  assert.match(readFileSync(".env.example", "utf8"), /^TESSERA_IMAGE_TAG=latest$/m);
  assert.doesNotMatch(readFileSync(".env.example", "utf8"), /^TESSERA_IMAGE_REPO=/m);
  assert.equal(
    compose.services["tessera-server"].environment.TESSERA_WORKER_IMAGE,
    compose.services["worker-image"].image,
    "server must dispatch the same worker image compose builds",
  );

  // Published packages and the opt-in build overlay were removed with the image workflow.
  assert.equal(existsSync(".github/workflows/images.yml"), false);
  assert.equal(existsSync("compose.build.yaml"), false);
});
