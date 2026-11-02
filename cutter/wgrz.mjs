// The .wgrz container: one gzip stream holding every step of one field.
// Layout, little endian: "WGRZ", version byte 1, uint16 count, then records
// of { uint16 stepHours, uint32 byteLength, bytes }. The bytes are the wgr1
// files copied unchanged from the laptop-format pack folder.

import { gzipSync, gunzipSync } from 'node:zlib'

export const WGRZ_MAGIC = 'WGRZ'
export const WGRZ_VERSION = 1
export const WGRZ_HEADER_BYTES = 7

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError('field bytes must be a Buffer or Uint8Array')
}

/**
 * Pack one field's step files into a .wgrz buffer.
 * @param {{ stepHours: number, bytes: Uint8Array | Buffer }[]} files
 * @returns {Buffer}
 */
export function packField(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('packField needs at least one step file')
  }
  if (files.length > 0xffff) {
    throw new Error(`too many steps for the uint16 count: ${files.length}`)
  }
  let previous = null
  let total = WGRZ_HEADER_BYTES
  for (const file of files) {
    const step = file?.stepHours
    if (!Number.isInteger(step) || step < 0 || step > 0xffff) {
      throw new Error(`step hour is not a uint16: ${step}`)
    }
    if (previous !== null && step <= previous) {
      throw new Error(`steps must be strictly ascending: ${previous} then ${step}`)
    }
    const bytes = asBytes(file.bytes)
    if (bytes.length > 0xffffffff) {
      throw new Error(`step ${step} is too large for the uint32 length`)
    }
    previous = step
    total += 6 + bytes.length
  }

  const out = Buffer.allocUnsafe(total)
  out.write(WGRZ_MAGIC, 0, 'ascii')
  out.writeUInt8(WGRZ_VERSION, 4)
  out.writeUInt16LE(files.length, 5)
  let offset = WGRZ_HEADER_BYTES
  for (const file of files) {
    const bytes = asBytes(file.bytes)
    out.writeUInt16LE(file.stepHours, offset)
    out.writeUInt32LE(bytes.length, offset + 2)
    offset += 6
    bytes.copy(out, offset)
    offset += bytes.length
  }

  return gzipSync(out, { level: 9 })
}

/**
 * Unpack a .wgrz buffer back into its step files.
 * @param {Uint8Array | Buffer} input
 * @returns {{ stepHours: number, bytes: Buffer }[]}
 */
export function unpackField(input) {
  const raw = gunzipSync(asBytes(input))
  if (raw.length < WGRZ_HEADER_BYTES) {
    throw new Error('truncated .wgrz container: shorter than the header')
  }
  if (raw.toString('ascii', 0, 4) !== WGRZ_MAGIC) {
    throw new Error(`wrong .wgrz magic: ${raw.toString('ascii', 0, 4)}`)
  }
  const version = raw.readUInt8(4)
  if (version !== WGRZ_VERSION) {
    throw new Error(`wrong .wgrz version: ${version}`)
  }
  const count = raw.readUInt16LE(5)
  const files = []
  let offset = WGRZ_HEADER_BYTES
  for (let i = 0; i < count; i++) {
    if (offset + 6 > raw.length) {
      throw new Error(`truncated .wgrz record ${i}: step header missing`)
    }
    const stepHours = raw.readUInt16LE(offset)
    const byteLength = raw.readUInt32LE(offset + 2)
    offset += 6
    if (offset + byteLength > raw.length) {
      throw new Error(`truncated .wgrz record ${i}: payload missing`)
    }
    files.push({ stepHours, bytes: raw.subarray(offset, offset + byteLength) })
    offset += byteLength
  }
  if (offset !== raw.length) {
    throw new Error(`count mismatch: ${count} records read, ${raw.length - offset} extra bytes`)
  }
  return files
}
