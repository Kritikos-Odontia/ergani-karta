// SPDX-License-Identifier: EUPL-1.2
import { crc32 } from 'node:zlib';

/** A small, portable ZIP writer: stored entries, UTF-8 names, no shell or platform dependency. */
export function zipFiles(files: ReadonlyMap<string, Buffer>): Buffer {
  if (files.size > 65535) throw new Error('Πάρα πολλά αρχεία· διαλέξτε μικρότερη περίοδο.');
  const local: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.startsWith('/') || name.split('/').includes('..')) throw new Error('Unsafe ZIP path.');
    const encoded = Buffer.from(name);
    if (encoded.length > 65535 || bytes.length > 0xffffffff || offset + bytes.length + encoded.length + 30 > 0xffffffff) throw new Error('Το ZIP είναι πολύ μεγάλο· διαλέξτε μικρότερη περίοδο.');
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); // UTF-8
    header.writeUInt16LE(0x21, 12); // 1980-01-01, a valid DOS date
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(encoded.length, 26);
    local.push(header, encoded, bytes);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, encoded);
    offset += header.length + encoded.length + bytes.length;
  }
  const size = directory.reduce((n, b) => n + b.length, 0);
  if (offset + size + 22 > 0xffffffff) throw new Error('Το ZIP είναι πολύ μεγάλο· διαλέξτε μικρότερη περίοδο.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...directory, end]);
}
