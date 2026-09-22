import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it, afterEach } from "vitest";
import {
  EVENT_PROCESSOR_ENTRY,
  ORIGINAL_ANCHOR,
  PROMPT_ANCHOR,
  PYCACHE_PREFIX,
  REPLACEMENT_CODE,
  classifyBinary,
  classifyBuffer,
  ensurePatchedBinary,
  gcCache,
  getCacheKey,
  parseZipArchive,
  patchBinary,
  patchBuffer,
} from "./agy-patch.js";

const DUMMY_MACHO_PREFIX = Buffer.from([
  0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01, 0x03, 0x00, 0x00, 0x80, 0x02, 0x00, 0x00, 0x00,
  0x10, 0x00, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const SIBLING_PYC_ENTRY = `${PYCACHE_PREFIX}cpython-314.pyc`;

const DECORATIVE_COMMENTS = [
  "  # ---------------------------------------------------------------------------",
  "  # Dynamic policy evaluation",
  "  # ---------------------------------------------------------------------------",
].join("\n");

function createEventProcessorContent(anchor = ORIGINAL_ANCHOR): string {
  return [
    "# Copyright 2026 Google LLC",
    "# Antigravity event processor",
    "class EventProcessor:",
    "  async def _process(self, tsu):",
    "    if False:",
    "      pass",
    anchor,
    '        if tsu.HasField("error"): await self.step_queue.put(None)',
    "",
    DECORATIVE_COMMENTS,
    "",
    "  async def _finish(self):",
    "    return True",
  ].join("\n");
}

interface SyntheticZipEntry {
  name: string;
  data: string | Buffer;
  method?: number;
}

interface BuildZipOptions {
  prefix?: Buffer;
  trailer?: Buffer;
}

function buildSyntheticZip(entries: SyntheticZipEntry[], options: BuildZipOptions = {}): Buffer {
  const prefix = options.prefix ?? DUMMY_MACHO_PREFIX;
  const trailer = options.trailer ?? Buffer.alloc(0);

  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let currentOffset = 0;

  const cdEntries: Array<{
    nameBuf: Buffer;
    dataLen: number;
    crc: number;
    method: number;
    localOffset: number;
  }> = [];

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const crc = zlib.crc32(dataBuf);
    const method = entry.method ?? 0;

    const locHdr = Buffer.alloc(30);
    locHdr.writeUInt32LE(0x04034b50, 0);
    locHdr.writeUInt16LE(20, 4);
    locHdr.writeUInt16LE(0, 6);
    locHdr.writeUInt16LE(method, 8);
    locHdr.writeUInt16LE(0, 10);
    locHdr.writeUInt16LE(0, 12);
    locHdr.writeUInt32LE(crc, 14);
    locHdr.writeUInt32LE(dataBuf.length, 18);
    locHdr.writeUInt32LE(dataBuf.length, 22);
    locHdr.writeUInt16LE(nameBuf.length, 26);
    locHdr.writeUInt16LE(0, 28);

    const localOffset = currentOffset;
    localChunks.push(locHdr, nameBuf, dataBuf);
    currentOffset += 30 + nameBuf.length + dataBuf.length;

    cdEntries.push({
      nameBuf,
      dataLen: dataBuf.length,
      crc,
      method,
      localOffset,
    });
  }

  const cdStart = currentOffset;
  let cdSize = 0;
  for (const cde of cdEntries) {
    const cdHdr = Buffer.alloc(46);
    cdHdr.writeUInt32LE(0x02014b50, 0);
    cdHdr.writeUInt16LE(0x031e, 4);
    cdHdr.writeUInt16LE(20, 6);
    cdHdr.writeUInt16LE(0, 8);
    cdHdr.writeUInt16LE(cde.method, 10);
    cdHdr.writeUInt16LE(0, 12);
    cdHdr.writeUInt16LE(0, 14);
    cdHdr.writeUInt32LE(cde.crc, 16);
    cdHdr.writeUInt32LE(cde.dataLen, 20);
    cdHdr.writeUInt32LE(cde.dataLen, 24);
    cdHdr.writeUInt16LE(cde.nameBuf.length, 28);
    cdHdr.writeUInt16LE(0, 30);
    cdHdr.writeUInt16LE(0, 32);
    cdHdr.writeUInt16LE(0, 34);
    cdHdr.writeUInt16LE(0, 36);
    cdHdr.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cdHdr.writeUInt32LE(cde.localOffset, 42);

    cdChunks.push(cdHdr, cde.nameBuf);
    cdSize += 46 + cde.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([prefix, ...localChunks, ...cdChunks, eocd, trailer]);
}

describe("agy-patch binary engine", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix = "agy-patch-test"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    delete process.env.PASEO_AGY_NO_PATCH;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  describe("classification", () => {
    it("classifies valid unpatched fixture as patchable", () => {
      const buf = buildSyntheticZip([
        { name: EVENT_PROCESSOR_ENTRY, data: createEventProcessorContent() },
        { name: SIBLING_PYC_ENTRY, data: Buffer.from("dummy-pyc-bytecode") },
      ]);
      expect(classifyBuffer(buf)).toBe("patchable");
    });

    it("classifies fixed fixture as already-fixed", () => {
      const fixedContent = createEventProcessorContent(REPLACEMENT_CODE);
      const buf = buildSyntheticZip([{ name: EVENT_PROCESSOR_ENTRY, data: fixedContent }]);
      expect(classifyBuffer(buf)).toBe("already-fixed");
    });

    it("classifies missing event_processor.py as entry-missing", () => {
      const buf = buildSyntheticZip([{ name: "some/other/file.py", data: "print(123)" }]);
      expect(classifyBuffer(buf)).toBe("entry-missing");
    });

    it("classifies file without anchor or replacement as unrecognized", () => {
      const buf = buildSyntheticZip([{ name: EVENT_PROCESSOR_ENTRY, data: "def hello(): pass" }]);
      expect(classifyBuffer(buf)).toBe("unrecognized");
    });

    it("classifies non-stored (compressed) entry as unrecognized", () => {
      const buf = buildSyntheticZip([
        {
          name: EVENT_PROCESSOR_ENTRY,
          data: createEventProcessorContent(),
          method: 8,
        },
      ]);
      expect(classifyBuffer(buf)).toBe("unrecognized");
    });

    it("classifies entry without decorative comments as unrecognized", () => {
      const noComments = ["class EventProcessor:", ORIGINAL_ANCHOR, "  pass"].join("\n");
      const buf = buildSyntheticZip([{ name: EVENT_PROCESSOR_ENTRY, data: noComments }]);
      expect(classifyBuffer(buf)).toBe("unrecognized");
    });

    it("classifies non-zip buffer as unrecognized", () => {
      const buf = Buffer.from("not a zip archive");
      expect(classifyBuffer(buf)).toBe("unrecognized");
    });
  });

  describe("patchBuffer", () => {
    it("patches in-place, preserving identical length, updating CRC, and renaming .pyc", () => {
      const originalContent = createEventProcessorContent();
      const pycData = Buffer.from("precompiled-cpython-bytecode");

      const buf = buildSyntheticZip(
        [
          { name: EVENT_PROCESSOR_ENTRY, data: originalContent },
          { name: SIBLING_PYC_ENTRY, data: pycData },
        ],
        {
          prefix: Buffer.alloc(128, 0xef),
          trailer: Buffer.alloc(64, 0x99),
        },
      );

      const originalLength = buf.length;
      const initialClassification = classifyBuffer(buf);
      expect(initialClassification).toBe("patchable");

      const result = patchBuffer(buf);
      expect(result.patched).toBe(true);
      expect(result.classification).toBe("already-fixed");

      // 1. Identical file length
      expect(buf.length).toBe(originalLength);

      // 2. Re-classification returns already-fixed
      expect(classifyBuffer(buf)).toBe("already-fixed");

      // 3. Parse zip and verify headers
      const zip = parseZipArchive(buf);
      expect(zip).not.toBeNull();

      // event_processor.py checks
      const pyEntry = zip!.entries.get(EVENT_PROCESSOR_ENTRY);
      expect(pyEntry).toBeDefined();

      const absLocalHdr = zip!.baseOffset + pyEntry!.localHeaderOffset;
      const localCrc = buf.readUInt32LE(absLocalHdr + 14);
      const cdCrc = pyEntry!.crc32;
      expect(localCrc).toBe(cdCrc);

      // Extract modified entry data and verify CRC matches zlib.crc32
      const dataOffset = absLocalHdr + 30 + pyEntry!.nameLength + pyEntry!.extraLength;
      const modifiedData = buf.subarray(dataOffset, dataOffset + pyEntry!.uncompSize);
      const computedCrc = zlib.crc32(modifiedData);
      expect(cdCrc).toBe(computedCrc);

      const modifiedText = modifiedData.toString("utf8");
      expect(modifiedText).toContain("STATE_WAITING_FOR_TASKS");
      expect(modifiedText).not.toContain(ORIGINAL_ANCHOR);

      // 4. Sibling .pyc is renamed to .bak in both CD and Local Header
      const expectedBakName = SIBLING_PYC_ENTRY.replace(/\.pyc$/, ".bak");
      const bakEntry = zip!.entries.get(expectedBakName);
      expect(bakEntry).toBeDefined();

      const bakLocalHdr = zip!.baseOffset + bakEntry!.localHeaderOffset;
      const bakLocalName = buf
        .subarray(bakLocalHdr + 30, bakLocalHdr + 30 + bakEntry!.nameLength)
        .toString("utf8");
      expect(bakLocalName).toBe(expectedBakName);

      // Original .pyc entry should no longer be in zip map
      expect(zip!.entries.get(SIBLING_PYC_ENTRY)).toBeUndefined();
    });

    it("is idempotent and avoids re-patching an already-fixed buffer", () => {
      const buf = buildSyntheticZip([
        { name: EVENT_PROCESSOR_ENTRY, data: createEventProcessorContent() },
        { name: SIBLING_PYC_ENTRY, data: Buffer.from("dummy") },
      ]);

      const first = patchBuffer(buf);
      expect(first.patched).toBe(true);

      const second = patchBuffer(buf);
      expect(second.patched).toBe(false);
      expect(second.classification).toBe("already-fixed");
    });

    it("supports prompt anchor formatting with decorative comments", () => {
      const promptContent = ["class EventProcessor:", PROMPT_ANCHOR, DECORATIVE_COMMENTS].join(
        "\n",
      );

      const buf = buildSyntheticZip([{ name: EVENT_PROCESSOR_ENTRY, data: promptContent }]);

      expect(classifyBuffer(buf)).toBe("patchable");
      const res = patchBuffer(buf);
      expect(res.patched).toBe(true);
      expect(classifyBuffer(buf)).toBe("already-fixed");
    });
  });

  describe("patchBinary and caching", () => {
    it("respects PASEO_AGY_NO_PATCH=1 escape hatch", () => {
      process.env.PASEO_AGY_NO_PATCH = "1";
      const dir = makeTempDir();
      const binPath = path.join(dir, "agy_acp_server.par");
      const buf = buildSyntheticZip([
        { name: EVENT_PROCESSOR_ENTRY, data: createEventProcessorContent() },
      ]);
      fs.writeFileSync(binPath, buf);

      const res = patchBinary(binPath, { skipSign: true });
      expect(res.patched).toBe(false);
      expect(res.path).toBe(binPath);
    });

    it("creates a clone in cache dir, patches clone, and leaves source intact", () => {
      const dir = makeTempDir();
      const cacheBase = path.join(dir, "cache");
      const binPath = path.join(dir, "agy_acp_server.par");

      const originalBuf = buildSyntheticZip([
        { name: EVENT_PROCESSOR_ENTRY, data: createEventProcessorContent() },
        { name: SIBLING_PYC_ENTRY, data: Buffer.from("bytecode") },
      ]);
      fs.writeFileSync(binPath, originalBuf);

      const res = patchBinary(binPath, {
        cacheBaseDir: cacheBase,
        skipSign: true,
      });

      expect(res.patched).toBe(true);
      expect(res.cached).toBe(false);
      expect(res.classification).toBe("already-fixed");
      expect(res.path).not.toBe(binPath);
      expect(fs.existsSync(res.path)).toBe(true);

      // Verify original binary is unmodified
      const srcBuf = fs.readFileSync(binPath);
      expect(classifyBuffer(srcBuf)).toBe("patchable");

      // Verify cached clone is patched
      const cloneBuf = fs.readFileSync(res.path);
      expect(classifyBuffer(cloneBuf)).toBe("already-fixed");
    });

    it("hits cache on second call and avoids re-patching", () => {
      const dir = makeTempDir();
      const cacheBase = path.join(dir, "cache");
      const binPath = path.join(dir, "agy_acp_server.par");

      const originalBuf = buildSyntheticZip([
        { name: EVENT_PROCESSOR_ENTRY, data: createEventProcessorContent() },
        { name: SIBLING_PYC_ENTRY, data: Buffer.from("bytecode") },
      ]);
      fs.writeFileSync(binPath, originalBuf);

      const first = patchBinary(binPath, {
        cacheBaseDir: cacheBase,
        skipSign: true,
      });
      expect(first.patched).toBe(true);
      expect(first.cached).toBe(false);

      const second = patchBinary(binPath, {
        cacheBaseDir: cacheBase,
        skipSign: true,
      });
      expect(second.patched).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.path).toBe(first.path);

      // ensurePatchedBinary returns the cached path
      const ensured = ensurePatchedBinary(binPath, {
        cacheBaseDir: cacheBase,
        skipSign: true,
      });
      expect(ensured).toBe(first.path);
    });

    it("returns original path without patching for unrecognized binaries", () => {
      const dir = makeTempDir();
      const binPath = path.join(dir, "agy_acp_server.par");
      fs.writeFileSync(binPath, Buffer.from("random unpatchable data"));

      const res = patchBinary(binPath, { skipSign: true });
      expect(res.patched).toBe(false);
      expect(res.classification).toBe("unrecognized");
      expect(res.path).toBe(binPath);
    });

    it("garbage collects old cache directories while retaining the active key", () => {
      const dir = makeTempDir();
      const cacheBase = path.join(dir, "cache");
      const activeKey = "active-key-123";
      const oldKey1 = "old-key-456";
      const oldKey2 = "old-key-789";

      fs.mkdirSync(path.join(cacheBase, activeKey), { recursive: true });
      fs.mkdirSync(path.join(cacheBase, oldKey1), { recursive: true });
      fs.mkdirSync(path.join(cacheBase, oldKey2), { recursive: true });

      gcCache(cacheBase, activeKey);

      expect(fs.existsSync(path.join(cacheBase, activeKey))).toBe(true);
      expect(fs.existsSync(path.join(cacheBase, oldKey1))).toBe(false);
      expect(fs.existsSync(path.join(cacheBase, oldKey2))).toBe(false);
    });

    it("generates deterministic cache keys", () => {
      const dir = makeTempDir();
      const testFile = path.join(dir, "binary");
      fs.writeFileSync(testFile, "test");
      const stat = fs.statSync(testFile);

      const key1 = getCacheKey(testFile, stat);
      const key2 = getCacheKey(testFile, stat);
      expect(key1).toBe(key2);
      expect(typeof key1).toBe("string");
      expect(key1.length).toBe(32);
    });

    it("correctly classifies binary from filesystem via classifyBinary", () => {
      const dir = makeTempDir();
      const binPath = path.join(dir, "agy_acp_server.par");
      const buf = buildSyntheticZip([
        { name: EVENT_PROCESSOR_ENTRY, data: createEventProcessorContent() },
      ]);
      fs.writeFileSync(binPath, buf);

      expect(classifyBinary(binPath)).toBe("patchable");
    });
  });
});
