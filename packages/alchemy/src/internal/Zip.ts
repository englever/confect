import { createReadStream, createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ZipError extends Schema.TaggedError<ZipError>()("ZipError", {
  reason: Schema.Literals(["format", "entry", "io"]),
}) {}

interface Entry {
  readonly method: number;
  readonly compressedSize: number;
  readonly headerOffset: number;
}

const formatError = () => new ZipError({ reason: "format" });

const findEntry = async (
  archive: string,
  name: string,
): Promise<Entry | ZipError> => {
  const file = await open(archive, "r");
  try {
    const { size } = await file.stat();
    const tailSize = Math.min(size, 0xffff + 22);
    const tail = Buffer.alloc(tailSize);
    await file.read(tail, 0, tailSize, size - tailSize);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || end + 22 > tailSize) return formatError();
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (directoryOffset + directorySize > size) return formatError();
    const directory = Buffer.alloc(directorySize);
    await file.read(directory, 0, directorySize, directoryOffset);
    let offset = 0;
    while (offset + 46 <= directorySize) {
      if (directory.readUInt32LE(offset) !== 0x02014b50) return formatError();
      const nameLength = directory.readUInt16LE(offset + 28);
      const entryName = directory.toString(
        "utf8",
        offset + 46,
        offset + 46 + nameLength,
      );
      if (entryName === name) {
        const compressedSize = directory.readUInt32LE(offset + 20);
        const headerOffset = directory.readUInt32LE(offset + 42);
        if (compressedSize === 0xffffffff || headerOffset === 0xffffffff)
          return formatError();
        return {
          method: directory.readUInt16LE(offset + 10),
          compressedSize,
          headerOffset,
        };
      }
      offset +=
        46 +
        nameLength +
        directory.readUInt16LE(offset + 30) +
        directory.readUInt16LE(offset + 32);
    }
    return new ZipError({ reason: "entry" });
  } finally {
    await file.close();
  }
};

const dataOffset = async (archive: string, entry: Entry) => {
  const file = await open(archive, "r");
  try {
    const header = Buffer.alloc(30);
    await file.read(header, 0, 30, entry.headerOffset);
    if (header.readUInt32LE(0) !== 0x04034b50) return undefined;
    return (
      entry.headerOffset +
      30 +
      header.readUInt16LE(26) +
      header.readUInt16LE(28)
    );
  } finally {
    await file.close();
  }
};

/**
 * Extract one entry of a zip archive. Convex publishes the local backend as a
 * single-file zip; this reads its central directory and inflates that entry,
 * without Zip64 support, which a release far under 4 GiB never needs.
 */
export const extract = Effect.fn("Zip.extract")(function* (
  archive: string,
  name: string,
  destination: string,
) {
  const entry = yield* Effect.tryPromise({
    try: () => findEntry(archive, name),
    catch: formatError,
  });
  if (Schema.is(ZipError)(entry)) return yield* entry;
  if (entry.method !== 0 && entry.method !== 8) return yield* formatError();
  const start = yield* Effect.tryPromise({
    try: () => dataOffset(archive, entry),
    catch: formatError,
  });
  if (start === undefined) return yield* formatError();
  yield* Effect.tryPromise({
    try: () => {
      const source = createReadStream(archive, {
        start,
        end: start + entry.compressedSize - 1,
      });
      const target = createWriteStream(destination, { mode: 0o755 });
      return entry.method === 8
        ? pipeline(source, createInflateRaw(), target)
        : pipeline(source, target);
    },
    catch: () => new ZipError({ reason: "io" }),
  }).pipe(
    Effect.tapError(() =>
      Effect.promise(() => rm(destination, { force: true })),
    ),
  );
});
