import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceOperation } from "../../apps/dispatcher/src/workspace.js";
import { readWorkspaceSecret, workspaceSignature } from "../../packages/protocol/src/workspace-auth.js";

test("workspace capability is project-scoped and stable across processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tessera-workspace-cap-"));
  try {
    const secret = readWorkspaceSecret(dir);
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.equal(readWorkspaceSecret(dir), secret, "the shared secret survives a restart");
    assert.equal(workspaceSignature(secret, "proj_a"), workspaceSignature(secret, "proj_a"));
    assert.notEqual(
      workspaceSignature(secret, "proj_a"),
      workspaceSignature(secret, "proj_b"),
      "a signature for one project cannot authorize another",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace operations preserve bytes and reject root deletion, traversal and symlink escapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tessera-files-")),
    root = join(dir, "project");
  try {
    await mkdir(root);
    await mkdir(join(root, "source"));
    await writeFile(join(root, "source", "original.js"), "const proof = '原始文件';");
    const original = Buffer.from([0, 255, 17, 23, 66]);
    await writeFile(join(root, "binary"), original);
    const listing = await workspaceOperation(root, { operation: "list", path: "." });
    assert.equal(listing.files[0].name, "source");
    assert.deepEqual(listing.stats, {
      files: 2,
      directories: 1,
      size: Buffer.byteLength("const proof = '原始文件';") + original.length,
      truncated: false,
    });
    const nested = await workspaceOperation(root, { operation: "list", path: "source" });
    assert.deepEqual(nested.stats, {
      files: 1,
      directories: 0,
      size: Buffer.byteLength("const proof = '原始文件';"),
      truncated: false,
    });
    // The summary budget stops the walk instead of scanning a huge subtree.
    const budgeted = await workspaceOperation(root, { operation: "list", path: ".", stats_limit: 1 });
    assert.equal(budgeted.stats.truncated, true);
    assert.equal(budgeted.stats.files + budgeted.stats.directories, 1);
    const data = await workspaceOperation(root, { operation: "read", path: "binary", limit: 2 });
    assert.ok(data.truncated);
    assert.deepEqual(Buffer.from(data.content, "base64"), original.subarray(0, 2));
    const complete = await workspaceOperation(root, { operation: "read", path: "binary" });
    assert.deepEqual(Buffer.from(complete.content, "base64"), original);
    await assert.rejects(workspaceOperation(root, { operation: "delete", path: "." }), /root/);
    await assert.rejects(workspaceOperation(root, { operation: "read", path: "../outside" }), /inside/);
    await writeFile(join(dir, "outside"), "outside proof");
    await symlink(dir, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(workspaceOperation(root, { operation: "read", path: "escape/outside" }), /escapes/);
    await assert.rejects(workspaceOperation(root, { operation: "delete", path: "escape/outside" }), /escapes/);
    await workspaceOperation(root, { operation: "delete", path: "source" });
    assert.equal(await readFile(join(dir, "outside"), "utf8"), "outside proof");
    assert.deepEqual(await readFile(join(root, "binary")), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
