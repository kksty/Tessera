import { closeSync, openSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { deflateRaw, inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { DomainError } from "./errors.js";

const deflate = promisify(deflateRaw);
const inflate = promisify(inflateRaw);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export const crc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** Entry names are data, never destination paths: no absolute paths, no traversal, ASCII only. */
export const safeArchiveName = (name: string) =>
  /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(name) &&
  !name.startsWith("/") &&
  !name.split("/").includes("..") &&
  !name.includes("//") &&
  name.length <= 255;

export interface ZipEntry {
  name: string;
  bytes: Buffer;
}

const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
/** ZIP32 stores offsets and sizes in 32-bit fields; bundles are not ZIP64. */
const ZIP32_LIMIT = 0xfffffffe;

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer) {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, null);
    if (result.bytesWritten <= 0) throw new Error("Archive write stalled");
    written += result.bytesWritten;
  }
}

/**
 * ZIP32 writer for a known entry stream. Each entry is compressed in memory, so
 * memory stays bounded by the largest single file rather than the whole bundle.
 * Synchronous directory bookkeeping is fine; the caller decides where the file lives.
 */
export async function writeZip(
  file: string,
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
): Promise<{ entries: number; bytes: number }> {
  const handle = await open(file, "w", 0o600);
  const central: Buffer[] = [];
  let offset = 0,
    count = 0;
  try {
    for await (const entry of entries as AsyncIterable<ZipEntry>) {
      if (!safeArchiveName(entry.name)) throw new DomainError(422, `Unsafe archive entry name: ${entry.name}`);
      const name = Buffer.from(entry.name, "utf8"),
        compressed = await deflate(entry.bytes),
        crc = crc32(entry.bytes);
      if (count >= 65535) throw new DomainError(413, "Project bundle has too many entries for ZIP32");
      if (entry.bytes.length > ZIP32_LIMIT || compressed.length > ZIP32_LIMIT)
        throw new DomainError(413, `Project bundle entry is too large for ZIP32: ${entry.name}`);
      if (offset + 30 + name.length + compressed.length > ZIP32_LIMIT)
        throw new DomainError(
          413,
          "Project bundle exceeds the 4 GiB ZIP32 limit; export evidence in parts or use a full-volume backup",
        );
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(0x800, 6);
      head.writeUInt16LE(8, 8);
      head.writeUInt16LE(33, 12);
      head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(compressed.length, 18);
      head.writeUInt32LE(entry.bytes.length, 22);
      head.writeUInt16LE(name.length, 26);
      await writeAll(handle, head);
      await writeAll(handle, name);
      await writeAll(handle, compressed);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x800, 8);
      record.writeUInt16LE(8, 10);
      record.writeUInt16LE(33, 14);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(compressed.length, 20);
      record.writeUInt32LE(entry.bytes.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(offset, 42);
      central.push(record, name);
      offset += 30 + name.length + compressed.length;
      count++;
    }
    const index = Buffer.concat(central),
      end = Buffer.alloc(22);
    if (offset + index.length + end.length > ZIP32_LIMIT)
      throw new DomainError(413, "Project bundle exceeds the 4 GiB ZIP32 limit; use a full-volume backup");
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(index.length, 12);
    end.writeUInt32LE(offset, 16);
    await writeAll(handle, Buffer.concat([index, end]));
    return { entries: count, bytes: offset + index.length + end.length };
  } finally {
    await handle.close();
  }
}

function readExact(fd: number, buffer: Buffer, position: number) {
  let read = 0;
  while (read < buffer.length) {
    const n = readSync(fd, buffer, read, buffer.length - read, position + read);
    if (n <= 0) throw new DomainError(422, "Project bundle is truncated");
    read += n;
  }
}

/**
 * Sequential reader for archives written by `writeZip`. It never extracts to a
 * caller-supplied path: each verified entry is handed to the callback as bytes.
 * Compression method 0 and 8 only; data descriptors are rejected.
 */
export async function readZip(
  file: string,
  handler: (name: string, bytes: Buffer) => void | Promise<void>,
  options: { maxTotalBytes?: number } = {},
) {
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024 * 1024;
  const size = statSync(file).size;
  if (size <= 0 || size > MAX_ARCHIVE_BYTES) throw new DomainError(413, "Project bundle size is out of range");
  const fd = openSync(file, "r");
  try {
    let offset = 0,
      entries = 0,
      total = 0;
    while (offset + 4 <= size) {
      const signature = Buffer.alloc(4);
      readExact(fd, signature, offset);
      const kind = signature.readUInt32LE(0);
      // Central directory or end of central directory: the entry stream is complete.
      if (kind === 0x02014b50 || kind === 0x06054b50) return;
      if (kind !== 0x04034b50) throw new DomainError(422, "Project bundle is not a valid ZIP archive");
      const header = Buffer.alloc(26);
      readExact(fd, header, offset + 4);
      const flags = header.readUInt16LE(2),
        method = header.readUInt16LE(4),
        crc = header.readUInt32LE(10),
        compressedSize = header.readUInt32LE(14),
        uncompressedSize = header.readUInt32LE(18),
        nameLength = header.readUInt16LE(22),
        extraLength = header.readUInt16LE(24);
      if (flags & 0x08) throw new DomainError(422, "Project bundle uses unsupported ZIP data descriptors");
      if (![0, 8].includes(method)) throw new DomainError(422, "Project bundle uses an unsupported ZIP method");
      if (uncompressedSize > MAX_ENTRY_BYTES || compressedSize > MAX_ENTRY_BYTES)
        throw new DomainError(413, "Project bundle entry is too large");
      if (offset + 30 + nameLength + extraLength + compressedSize > size)
        throw new DomainError(422, "Project bundle entry exceeds the archive");
      const name = Buffer.alloc(nameLength);
      readExact(fd, name, offset + 30);
      const nameText = name.toString("utf8");
      if (!safeArchiveName(nameText)) throw new DomainError(422, `Unsafe archive entry name: ${nameText}`);
      const compressed = Buffer.alloc(compressedSize);
      if (compressedSize) readExact(fd, compressed, offset + 30 + nameLength + extraLength);
      const bytes = method === 8 ? await inflate(compressed) : compressed;
      if (bytes.length !== uncompressedSize)
        throw new DomainError(422, `Project bundle entry size mismatch: ${nameText}`);
      if (crc32(bytes) !== crc) throw new DomainError(422, `Project bundle entry checksum failed: ${nameText}`);
      total += bytes.length;
      if (total > maxTotalBytes) throw new DomainError(413, "Project bundle expands beyond the uncompressed limit");
      await handler(nameText, bytes);
      offset += 30 + nameLength + extraLength + compressedSize;
      entries++;
      if (entries > 100000) throw new DomainError(413, "Project bundle has too many entries");
    }
    throw new DomainError(422, "Project bundle has no central directory");
  } finally {
    closeSync(fd);
  }
}
