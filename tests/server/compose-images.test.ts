import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

test("compose pulls prebuilt images and keeps source builds opt-in", () => {
  const compose = parse(readFileSync("compose.yaml", "utf8"));
  for (const service of ["tessera-server", "tessera-dispatcher", "worker-image"])
    assert.equal(compose.services[service].build, undefined, `${service} must not build by default`);
  assert.match(compose.services["tessera-server"].image, /ghcr\.io/);
  assert.match(compose.services["tessera-server"].image, /TESSERA_IMAGE_TAG:-latest/);
  assert.match(compose.services["worker-image"].image, /tessera-runtime/);
  assert.match(compose.services["worker-image"].image, /TESSERA_IMAGE_TAG:-latest/);
  assert.match(readFileSync(".env.example", "utf8"), /^TESSERA_IMAGE_TAG=latest$/m);
  assert.equal(
    compose.services["tessera-server"].environment.TESSERA_WORKER_IMAGE,
    compose.services["worker-image"].image,
    "server must dispatch the same worker image that compose pulls",
  );

  const images = parse(readFileSync(".github/workflows/images.yml", "utf8"));
  assert.deepEqual(images.on.push.branches, ["main"]);
  assert.ok(images.on.push.paths.includes("apps/**"));
  assert.ok(images.on.push.paths.includes("docker/**"));

  const build = parse(readFileSync("compose.build.yaml", "utf8"));
  assert.ok(build.services["tessera-server"].build);
  assert.ok(build.services["tessera-dispatcher"].build);
  assert.equal(build.services["worker-image"].build.target, "${TESSERA_WORKER_TARGET:-runtime}");
});
