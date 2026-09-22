import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

export const EVENT_PROCESSOR_ENTRY =
  "google3/third_party/py/google/antigravity/connections/local/event_processor.py";

export const PYCACHE_PREFIX =
  "google3/third_party/py/google/antigravity/connections/local/__pycache__/event_processor.";

export const ZIP_EOCD_MAGIC = 0x06054b50;
export const ZIP_CD_MAGIC = 0x02014b50;
export const ZIP_LOCAL_MAGIC = 0x04034b50;

export const ORIGINAL_ANCHOR = `      elif (
          tsu.state
          == localharness_pb2.TrajectoryStateUpdate.State.STATE_FULLY_IDLE
      ):`;

export const REPLACEMENT_CODE = `      elif tsu.state in (
          localharness_pb2.TrajectoryStateUpdate.State.STATE_FULLY_IDLE,
          localharness_pb2.TrajectoryStateUpdate.State.STATE_WAITING_FOR_TASKS,
      ):`;

export const PROMPT_ANCHOR = `elif (
            tsu.state
            == localharness_pb2.TrajectoryStateUpdate.State.STATE_FULLY_IDLE):`;

export const PROMPT_REPLACEMENT = `        elif tsu.state in (
            localharness_pb2.TrajectoryStateUpdate.State.STATE_FULLY_IDLE,
            localharness_pb2.TrajectoryStateUpdate.State.STATE_WAITING_FOR_TASKS,
        ):`;

export type PatchClassification = "patchable" | "already-fixed" | "unrecognized" | "entry-missing";

export interface ZipEntryInfo {
  name: string;
  method: number;
  crc32: number;
  compSize: number;
  uncompSize: number;
  localHeaderOffset: number;
  cdEntryOffset: number;
  nameLength: number;
  extraLength: number;
  commentLength: number;
}

export interface ZipArchiveInfo {
  eocdOffset: number;
  cdOffset: number;
  cdSize: number;
  cdStart: number;
  baseOffset: number;
  entries: Map<string, ZipEntryInfo>;
}

export interface PatchOptions {
  cacheBaseDir?: string;
  force?: boolean;
  skipSign?: boolean;
}

export interface PatchResult {
  path: string;
  patched: boolean;
  classification: PatchClassification;
  cached: boolean;
}

function isValidEocd(buf: Buffer, pos: number): boolean {
  if (pos + 22 > buf.length) return false;
  const cdSize = buf.readUInt32LE(pos + 12);
  const cdStart = pos - cdSize;
  if (cdStart < 0) return false;
  if (cdSize === 0) return true;
  if (cdStart + 4 > buf.length) return false;
  return buf.readUInt32LE(cdStart) === ZIP_CD_MAGIC;
}

export function findEocd(buf: Buffer): number {
  if (buf.length < 22) return -1;
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let pos = buf.length - 22;
  while (pos >= 0) {
    pos = buf.lastIndexOf(signature, pos);
    if (pos === -1) return -1;
    if (isValidEocd(buf, pos)) return pos;
    pos -= 1;
  }
  return -1;
}

function parseCdEntries(buf: Buffer, cdStart: number, cdSize: number): Map<string, ZipEntryInfo> {
  const entries = new Map<string, ZipEntryInfo>();
  let pos = cdStart;
  const cdEnd = cdStart + cdSize;

  while (pos + 46 <= cdEnd) {
    if (buf.readUInt32LE(pos) !== ZIP_CD_MAGIC) break;
    const method = buf.readUInt16LE(pos + 10);
    const crc32 = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const nameStart = pos + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > cdEnd) break;
    const name = buf.toString("utf8", nameStart, nameEnd);

    entries.set(name, {
      name,
      method,
      crc32,
      compSize,
      uncompSize,
      localHeaderOffset,
      cdEntryOffset: pos,
      nameLength,
      extraLength,
      commentLength,
    });

    pos += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export function parseZipArchive(buf: Buffer): ZipArchiveInfo | null {
  const eocdOffset = findEocd(buf);
  if (eocdOffset < 0) return null;

  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdStart = eocdOffset - cdSize;
  const baseOffset = cdStart - cdOffset;
  const entries = parseCdEntries(buf, cdStart, cdSize);

  return {
    eocdOffset,
    cdOffset,
    cdSize,
    cdStart,
    baseOffset,
    entries,
  };
}

export function getEntryData(buf: Buffer, zip: ZipArchiveInfo, entry: ZipEntryInfo): Buffer | null {
  const absLocalHdr = zip.baseOffset + entry.localHeaderOffset;
  if (absLocalHdr < 0 || absLocalHdr + 30 > buf.length) return null;
  if (buf.readUInt32LE(absLocalHdr) !== ZIP_LOCAL_MAGIC) return null;

  const localNameLen = buf.readUInt16LE(absLocalHdr + 26);
  const localExtraLen = buf.readUInt16LE(absLocalHdr + 28);
  const dataOffset = absLocalHdr + 30 + localNameLen + localExtraLen;
  const dataEnd = dataOffset + entry.uncompSize;

  if (dataEnd > buf.length) return null;
  return buf.subarray(dataOffset, dataEnd);
}

export function findAnchorAndReplacement(
  text: string,
): { anchor: string; replacement: string } | null {
  if (text.includes(ORIGINAL_ANCHOR)) {
    return { anchor: ORIGINAL_ANCHOR, replacement: REPLACEMENT_CODE };
  }
  if (text.includes(PROMPT_ANCHOR)) {
    return { anchor: PROMPT_ANCHOR, replacement: PROMPT_REPLACEMENT };
  }
  return null;
}

export function shortenDecorativeComments(text: string, delta: number): string | null {
  if (delta <= 0) return text;
  const matches = [...text.matchAll(/([ \t]*# -{20,})/g)];
  if (matches.length === 0) return null;

  if (matches.length >= 2) {
    const d1 = Math.ceil(delta / 2);
    const d2 = Math.floor(delta / 2);
    const m1 = matches[0];
    const m2 = matches[1];
    if (m1[0].length <= d1 + 5 || m2[0].length <= d2 + 5) return null;
    const s1 = m1[0].slice(0, m1[0].length - d1);
    const s2 = m2[0].slice(0, m2[0].length - d2);
    return (
      text.slice(0, m1.index) +
      s1 +
      text.slice(m1.index + m1[0].length, m2.index) +
      s2 +
      text.slice(m2.index + m2[0].length)
    );
  }

  const m = matches[0];
  if (m[0].length <= delta + 5) return null;
  const s = m[0].slice(0, m[0].length - delta);
  return text.slice(0, m.index) + s + text.slice(m.index + m[0].length);
}

export function patchEventProcessorContent(content: string): string | null {
  const pair = findAnchorAndReplacement(content);
  if (!pair) return null;
  const delta =
    Buffer.byteLength(pair.replacement, "utf8") - Buffer.byteLength(pair.anchor, "utf8");
  const shortened = shortenDecorativeComments(content, delta);
  if (!shortened) return null;
  const patched = shortened.replace(pair.anchor, pair.replacement);
  if (Buffer.byteLength(patched, "utf8") !== Buffer.byteLength(content, "utf8")) {
    return null;
  }
  return patched;
}

export function classifyBuffer(buf: Buffer): PatchClassification {
  const zip = parseZipArchive(buf);
  if (!zip) return "unrecognized";

  const entry = zip.entries.get(EVENT_PROCESSOR_ENTRY);
  if (!entry) return "entry-missing";
  if (entry.method !== 0) return "unrecognized";

  const data = getEntryData(buf, zip, entry);
  if (!data) return "unrecognized";

  const text = data.toString("utf8");
  if (text.includes("STATE_WAITING_FOR_TASKS")) {
    return "already-fixed";
  }

  const pair = findAnchorAndReplacement(text);
  if (!pair) return "unrecognized";

  const delta =
    Buffer.byteLength(pair.replacement, "utf8") - Buffer.byteLength(pair.anchor, "utf8");
  const shortened = shortenDecorativeComments(text, delta);
  if (!shortened) return "unrecognized";

  return "patchable";
}

export function classifyBinary(filePath: string): PatchClassification {
  try {
    const buf = fs.readFileSync(filePath);
    return classifyBuffer(buf);
  } catch {
    return "unrecognized";
  }
}

function renameSiblingPyc(buf: Buffer, zip: ZipArchiveInfo): void {
  for (const entry of zip.entries.values()) {
    if (!entry.name.startsWith(PYCACHE_PREFIX) || !entry.name.endsWith(".pyc")) {
      continue;
    }

    const cdExtPos = entry.cdEntryOffset + 46 + entry.nameLength - 4;
    if (buf.subarray(cdExtPos, cdExtPos + 4).toString("utf8") === ".pyc") {
      buf.write(".bak", cdExtPos, "utf8");
    }

    const localHdrPos = zip.baseOffset + entry.localHeaderOffset;
    const localNameLen = buf.readUInt16LE(localHdrPos + 26);
    const localExtPos = localHdrPos + 30 + localNameLen - 4;
    if (buf.subarray(localExtPos, localExtPos + 4).toString("utf8") === ".pyc") {
      buf.write(".bak", localExtPos, "utf8");
    }
  }
}

export function patchBuffer(buf: Buffer): {
  patched: boolean;
  classification: PatchClassification;
} {
  const classification = classifyBuffer(buf);
  if (classification !== "patchable") {
    return { patched: false, classification };
  }

  const zip = parseZipArchive(buf)!;
  const entry = zip.entries.get(EVENT_PROCESSOR_ENTRY)!;
  const data = getEntryData(buf, zip, entry)!;
  const text = data.toString("utf8");

  const patchedText = patchEventProcessorContent(text);
  if (!patchedText) {
    return { patched: false, classification: "unrecognized" };
  }

  const localHdrPos = zip.baseOffset + entry.localHeaderOffset;
  const localNameLen = buf.readUInt16LE(localHdrPos + 26);
  const localExtraLen = buf.readUInt16LE(localHdrPos + 28);
  const dataOffset = localHdrPos + 30 + localNameLen + localExtraLen;

  buf.write(patchedText, dataOffset, "utf8");

  const newCrc = zlib.crc32(buf.subarray(dataOffset, dataOffset + entry.uncompSize));
  buf.writeUInt32LE(newCrc, localHdrPos + 14);
  buf.writeUInt32LE(newCrc, entry.cdEntryOffset + 16);

  renameSiblingPyc(buf, zip);

  return { patched: true, classification: "already-fixed" };
}

export function getCacheKey(realpath: string, stat?: { size: number; mtimeMs: number }): string {
  const s = stat ?? fs.statSync(realpath);
  return crypto
    .createHash("sha256")
    .update(`${realpath}:${s.size}:${s.mtimeMs}`)
    .digest("hex")
    .slice(0, 32);
}

export function getCacheBaseDir(customDir?: string): string {
  if (customDir) return customDir;
  const pluginData =
    process.env.PASEO_PLUGIN_DATA_DIR ?? path.join(os.homedir(), ".paseo", "plugin-data");
  return path.join(pluginData, "antigravity", "bin");
}

function cloneFile(src: string, dst: string): void {
  try {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

function reSignBinary(dst: string): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync(
      "codesign",
      ["--force", "-s", "-", "--preserve-metadata=entitlements,flags", dst],
      { stdio: "ignore" },
    );
  } catch {
    // Gracefully ignore codesign errors
  }
}

export function gcCache(baseDir: string, currentKey?: string): void {
  if (!fs.existsSync(baseDir)) return;
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (currentKey && entry.name === currentKey) continue;
      fs.rmSync(path.join(baseDir, entry.name), {
        recursive: true,
        force: true,
      });
    }
  } catch {
    // Non-fatal if GC fails
  }
}

interface CacheTarget {
  realPath: string;
  key: string;
  cacheBase: string;
  cacheDir: string;
  dstPath: string;
}

function resolveCacheTarget(srcPath: string, customBase?: string): CacheTarget {
  const realPath = fs.realpathSync(srcPath);
  const stat = fs.statSync(realPath);
  const key = getCacheKey(realPath, stat);
  const cacheBase = getCacheBaseDir(customBase);
  const cacheDir = path.join(cacheBase, key);
  const dstPath = path.join(cacheDir, path.basename(realPath));
  return { realPath, key, cacheBase, cacheDir, dstPath };
}

function cloneAndPatch(
  realPath: string,
  dstPath: string,
  cacheDir: string,
  skipSign?: boolean,
): boolean {
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
  const tempDst = `${dstPath}.tmp.${Date.now()}`;
  cloneFile(realPath, tempDst);
  fs.chmodSync(tempDst, 0o755);

  const buf = fs.readFileSync(tempDst);
  const patchRes = patchBuffer(buf);
  if (!patchRes.patched) {
    fs.rmSync(tempDst, { force: true });
    return false;
  }

  fs.writeFileSync(tempDst, buf);
  if (!skipSign) {
    reSignBinary(tempDst);
  }
  fs.renameSync(tempDst, dstPath);
  return true;
}

export function patchBinary(srcPath: string, options?: PatchOptions): PatchResult {
  if (process.env.PASEO_AGY_NO_PATCH === "1") {
    return { path: srcPath, patched: false, classification: "unrecognized", cached: false };
  }

  const { realPath, key, cacheBase, cacheDir, dstPath } = resolveCacheTarget(
    srcPath,
    options?.cacheBaseDir,
  );

  if (!options?.force && fs.existsSync(dstPath)) {
    gcCache(cacheBase, key);
    return { path: dstPath, patched: false, classification: "already-fixed", cached: true };
  }

  const classification = classifyBinary(realPath);
  if (classification !== "patchable") {
    return { path: srcPath, patched: false, classification, cached: false };
  }

  const ok = cloneAndPatch(realPath, dstPath, cacheDir, options?.skipSign);
  if (!ok) {
    return { path: srcPath, patched: false, classification: "unrecognized", cached: false };
  }

  gcCache(cacheBase, key);
  return { path: dstPath, patched: true, classification: "already-fixed", cached: false };
}

export function ensurePatchedBinary(srcPath: string, options?: PatchOptions): string {
  const res = patchBinary(srcPath, options);
  return res.path;
}
