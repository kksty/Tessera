import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Evidence } from "../../protocol/src/index.js";

/** Upload original bytes in bounded requests; large originals are represented by an explicit, complete manifest. */
export async function saveEvidenceFile(file: string, metadata: { title: string; mime_type: string; step_id?: string }, save: (body: Record<string, unknown>) => Promise<Evidence>): Promise<Evidence> {
  const handle = await open(file, "r");
  const chunkSize = 8 * 1024 * 1024;
  try {
    const before = await handle.stat();
    const buffer = Buffer.alloc(Math.min(chunkSize, Math.max(1, before.size)));
    const parts: { id: string; offset: number; size: number; sha256: string }[] = [];
    const hash = createHash("sha256");
    let offset = 0;
    do {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead && offset < before.size) throw new Error("Evidence file changed while reading; original was not archived completely");
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      const part = await save({ ...metadata, title: before.size > chunkSize ? `${metadata.title} · part ${parts.length + 1}` : metadata.title,
        source_path: file, encoding: "base64", content: bytes.toString("base64"),
        mime_type: before.size > chunkSize ? "application/octet-stream" : metadata.mime_type });
      parts.push({ id: part.id, offset, size: bytesRead, sha256: part.sha256 });
      offset += bytesRead;
      if (before.size <= chunkSize) return part;
    } while (offset < before.size);
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Evidence file changed while reading; please save a stable copy");
    return await save({ ...metadata, source_path: file, mime_type: "application/vnd.tessera.evidence-manifest+json", encoding: "utf8",
      part_ids: parts.map(p => p.id), content: JSON.stringify({ format: "tessera-chunked-evidence-v1", source_path: file,
        original_mime_type: metadata.mime_type, size: offset, sha256: hash.digest("hex"),
        reconstruction: "Concatenate the original bytes of each part in offset order; verify total size and SHA-256.", parts }) });
  } finally { await handle.close(); }
}
