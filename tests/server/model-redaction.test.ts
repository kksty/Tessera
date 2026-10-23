import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { modelResponseRedaction } from "../../apps/server/src/model-redaction.js";

test("provider success/error streams redact upstream credentials across chunks while preserving UTF-8 and SSE", async () => {
  const secret = "fixture-long-lived-key";
  const source = Buffer.from(`event: error\ndata: {"error":{"message":"失败 Bearer ${secret}"}}\n\n`);
  const chunks = Array.from(source, (byte) => Buffer.from([byte]));
  const result: Buffer[] = [];
  for await (const chunk of Readable.from(chunks).pipe(modelResponseRedaction([secret]))) result.push(chunk);
  assert.equal(
    Buffer.concat(result).toString(),
    'event: error\ndata: {"error":{"message":"失败 Bearer [redacted]"}}\n\n',
  );
});

test("short literal credentials do not rewrite JSON field names", async () => {
  const result: Buffer[] = [];
  for await (const chunk of Readable.from(['{"id":"id","message":"id"}']).pipe(modelResponseRedaction(["id"])))
    result.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(result).toString()), { id: "[redacted]", message: "[redacted]" });
});
