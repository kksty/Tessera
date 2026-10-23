import { test } from "node:test";
import assert from "node:assert/strict";
import { queryReferences, readReference } from "../../packages/runner/src/references.js";

test("reference guidance has stable ids and hashes, complete offset reads and no evidence semantics", () => {
  const index = queryReferences();
  assert.equal(index.evidence, false); assert.equal(index.items.length, 2);
  assert.equal(queryReferences("工具输出").items[0].id, "tool-artifacts");
  for (const record of index.items) {
    let offset = 0, content = "";
    for (;;) {
      const page = readReference(record.id, offset, 41, record.reference_hash);
      assert.equal(page.evidence, false); content += page.content;
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
    assert.equal(content.length, record.total_chars);
    assert.match(content, /原始|Evidence/);
  }
  assert.throws(() => readReference("../../secret"), /not found/);
  assert.throws(() => readReference(index.items[0].id, 0, 4000, "changed"), /changed/);
  assert.throws(() => readReference(index.items[0].id, -1), /Invalid/);
});
