import { deflateRawSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** A bounded ZIP32 writer for generated archives; no input ZIP extraction or filesystem paths. */
export function zip(files: { name: string; bytes: Buffer }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  if (files.length > 65535) throw new Error("ZIP entry count exceeds ZIP32");
  for (const file of files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.name) || file.name.startsWith("/") || file.name.split("/").includes(".."))
      throw new Error("Unsafe archive entry name");
    const name = Buffer.from(file.name), content = deflateRawSync(file.bytes), crc = crc32(file.bytes);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8); head.writeUInt16LE(33, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(content.length, 18); head.writeUInt32LE(file.bytes.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, content);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(content.length, 20); entry.writeUInt32LE(file.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += head.length + name.length + content.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
