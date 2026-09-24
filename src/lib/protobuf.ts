/**
 * Zero-dependency Protobuf wire-format encoders and decoders.
 */

export function encodeVarint(val: number): Buffer {
  const bytes: number[] = [];
  let v = val;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

export function encodeLengthDelimited(fieldNumber: number, data: Buffer): Buffer {
  const tag = (fieldNumber << 3) | 2;
  return Buffer.concat([encodeVarint(tag), encodeVarint(data.length), data]);
}

export function decodeVarint(buffer: Uint8Array, start: number): [number, number] {
  let res = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length) {
    const b = buffer[offset++];
    if (b === undefined) break;
    res |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return [res, offset];
}

export function getField(
  buffer: Uint8Array | null | undefined,
  targetField: number,
): Uint8Array | null {
  if (!buffer) return null;
  let offset = 0;

  while (offset < buffer.length) {
    const [tag, nextOffset] = decodeVarint(buffer, offset);
    offset = nextOffset;
    const wireType = tag & 0x7;
    const fieldNum = tag >> 3;
    if (wireType === 2) {
      const [len, afterLen] = decodeVarint(buffer, offset);
      const slice = buffer.subarray(afterLen, afterLen + len);
      offset = afterLen + len;
      if (fieldNum === targetField) return slice;
    } else if (wireType === 0) {
      [, offset] = decodeVarint(buffer, offset);
    } else if (wireType === 1) offset += 8;
    else if (wireType === 5) offset += 4;
    else break;
  }
  return null;
}

export function getVarintField(
  buffer: Uint8Array | null | undefined,
  targetField: number,
): number | null {
  if (!buffer) return null;
  let offset = 0;
  while (offset < buffer.length) {
    const [tag, nextOffset] = decodeVarint(buffer, offset);
    offset = nextOffset;
    const wireType = tag & 0x7;
    const fieldNum = tag >> 3;
    if (wireType === 0) {
      const [val, afterVal] = decodeVarint(buffer, offset);
      offset = afterVal;
      if (fieldNum === targetField) return val;
    } else if (wireType === 2) {
      const [len, afterLen] = decodeVarint(buffer, offset);
      offset = afterLen + len;
    } else if (wireType === 1) offset += 8;
    else if (wireType === 5) offset += 4;
    else break;
  }
  return null;
}
