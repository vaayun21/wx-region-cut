/**
 * Pure-TypeScript decoder and encoder for CCSDS 121.0-B-3 lossless data compression
 * (libaec / GRIB2 data representation template 5.42).
 *
 * Implements the adaptive entropy coder and preprocessor state machine:
 * - Code option IDs (Rice split, zero block with ROS, second extension, uncompressed)
 * - Reference sample handling at RSI boundaries when preprocessing is enabled
 * - 64-block segment boundary ROS handling
 * - Unit-delay predictor inversion (unsigned and signed theta mapping)
 */

export const AEC_DATA_SIGNED = 1
export const AEC_DATA_3BYTE = 2
export const AEC_DATA_MSB = 4
export const AEC_DATA_PREPROCESS = 8
export const AEC_RESTRICTED = 16
export const AEC_PAD_RSI = 32
export const AEC_NOT_ENFORCE = 64

export interface AecOptions {
  /** Resolution in bits per sample (1 to 32). */
  bitsPerSample: number
  /** Block size in samples (typically 16 or 32, even, up to 256). */
  blockSize: number
  /** Reference sample interval in blocks (up to 4096). */
  rsi: number
  /** Data description flags (AEC_DATA_*). */
  flags: number
}

export interface AecDecodeResult {
  /** Decoded integer samples (Uint32Array for unsigned, Int32Array for signed). */
  samples: Uint32Array | Int32Array
  /** Total payload bytes consumed. */
  bytesConsumed: number
  /** Unconsumed bits in the last byte (0 to 7). */
  bitOffset: number
}

// Precomputed Second Extension lookup table (CCSDS 121.0-B-3 table 5-1 / libaec se_table)
const SE_TABLE = new Int32Array(182)
{
  let k = 0
  for (let i = 0; i < 13; i++) {
    const ms = k
    for (let j = 0; j <= i; j++) {
      SE_TABLE[2 * k] = i
      SE_TABLE[2 * k + 1] = ms
      k++
    }
  }
}

/**
 * Low-level BitReader reading MSB first.
 */
export class BitReader {
  readonly bytes: Uint8Array
  bytePos: number = 0
  bitOffset: number = 0
  /** Set once a read runs past the end: the buffer ended mid-code. */
  pastEnd: boolean = false

  constructor(bytes: Uint8Array, startByte: number = 0) {
    this.bytes = bytes
    this.bytePos = startByte
  }

  /** Read n bits (0 <= n <= 32). Returns unsigned 32-bit integer. */
  getBits(n: number): number {
    if (n === 0) return 0
    let res = 0
    while (n > 0) {
      if (this.bytePos >= this.bytes.length) {
        this.pastEnd = true
        return res >>> 0
      }
      const avail = 8 - this.bitOffset
      if (avail <= n) {
        res = (res << avail) | (this.bytes[this.bytePos] & ((1 << avail) - 1))
        this.bytePos++
        this.bitOffset = 0
        n -= avail
      } else {
        res = (res << n) | ((this.bytes[this.bytePos] >> (avail - n)) & ((1 << n) - 1))
        this.bitOffset += n
        n = 0
      }
    }
    return res >>> 0
  }

  /**
   * Interpret a Fundamental Sequence (unary code):
   * Counts zero bits until a terminating 1 bit is encountered, consuming the 1.
   * A code cut off by the buffer end counts what is there and marks pastEnd.
   */
  getFS(): number {
    let fs = 0
    while (this.bytePos < this.bytes.length) {
      const b = this.bytes[this.bytePos]
      const rem = (b << this.bitOffset) & 0xff
      if (rem === 0) {
        fs += 8 - this.bitOffset
        this.bitOffset = 0
        this.bytePos++
        while (this.bytePos < this.bytes.length && this.bytes[this.bytePos] === 0) {
          fs += 8
          this.bytePos++
        }
        continue
      }
      const clz = Math.clz32(rem) - 24
      fs += clz
      this.bitOffset += clz + 1
      if (this.bitOffset === 8) {
        this.bitOffset = 0
        this.bytePos++
      }
      return fs
    }
    this.pastEnd = true
    return fs
  }

  /** Drop remaining bits in current byte if not byte-aligned. */
  alignToByte(): void {
    if (this.bitOffset > 0) {
      this.bitOffset = 0
      this.bytePos++
    }
  }

  /** Total bits read from beginning. */
  get totalBitsRead(): number {
    return this.bytePos * 8 + this.bitOffset
  }
}

/**
 * Low-level BitWriter writing MSB first.
 */
export class BitWriter {
  private buffer: Uint8Array
  private bytePos: number = 0
  private bitOffset: number = 0 // bits used in current byte (0..7)

  constructor(initialCapacity: number = 1024) {
    this.buffer = new Uint8Array(initialCapacity)
  }

  private ensure(additionalBytes: number): void {
    if (this.bytePos + additionalBytes >= this.buffer.length) {
      const next = new Uint8Array(Math.max(this.buffer.length * 2, this.bytePos + additionalBytes + 1024))
      next.set(this.buffer)
      this.buffer = next
    }
  }

  putBits(val: number, n: number): void {
    if (n === 0) return
    this.ensure(Math.ceil(n / 8) + 2)
    while (n > 0) {
      const avail = 8 - this.bitOffset
      if (n >= avail) {
        const shift = n - avail
        const chunk = shift >= 32 ? 0 : (val >>> shift) & ((1 << avail) - 1)
        this.buffer[this.bytePos] |= chunk
        this.bytePos++
        this.bitOffset = 0
        n -= avail
      } else {
        const chunk = (val & ((1 << n) - 1)) << (avail - n)
        this.buffer[this.bytePos] |= chunk
        this.bitOffset += n
        n = 0
      }
    }
  }

  /** Fundamental sequence: fs zeros followed by a 1. */
  putFS(fs: number): void {
    this.ensure(Math.ceil((fs + 1) / 8) + 2)
    while (fs > 0) {
      const avail = 8 - this.bitOffset
      if (fs < avail) {
        // can put all zeros and the terminating 1 in current byte
        this.bitOffset += fs
        fs = 0
        break
      } else {
        fs -= avail
        this.bytePos++
        this.bitOffset = 0
      }
    }
    // Now put terminating 1
    this.putBits(1, 1)
  }

  alignToByte(): void {
    if (this.bitOffset > 0) {
      this.bytePos++
      this.bitOffset = 0
    }
  }

  finish(): Uint8Array {
    let len = this.bytePos
    if (this.bitOffset > 0) {
      len++
    }
    return this.buffer.slice(0, len)
  }
}

/**
 * Decodes CCSDS AEC lossless compressed payload (libaec format).
 * Returns array of unsigned or signed integer samples X.
 */
export function decodeAec(
  bytes: Uint8Array,
  options: AecOptions,
  nSamples: number,
): Uint32Array | Int32Array {
  const { bitsPerSample, blockSize, rsi, flags } = options

  if (bitsPerSample === 0 || bitsPerSample > 32) {
    throw new Error(`invalid bitsPerSample: ${bitsPerSample}`)
  }
  if (blockSize === 0 || (blockSize & 1) !== 0 || blockSize > 256) {
    throw new Error(`invalid blockSize: ${blockSize}`)
  }
  if (rsi === 0 || rsi > 4096) {
    throw new Error(`invalid rsi: ${rsi}`)
  }
  // An empty buffer holds no samples: zeros would invent data.
  if (nSamples > 0 && bytes.length === 0) {
    throw new Error('truncated data: empty buffer')
  }

  const reader = new BitReader(bytes)

  // Determine ID code length
  let idLen: number
  if (bitsPerSample > 16) {
    idLen = 5
  } else if (bitsPerSample > 8) {
    idLen = 4
  } else {
    if (flags & AEC_RESTRICTED) {
      if (bitsPerSample <= 2) idLen = 1
      else if (bitsPerSample <= 4) idLen = 2
      else throw new Error(`AEC_RESTRICTED invalid for bitsPerSample ${bitsPerSample}`)
    } else {
      idLen = 3
    }
  }
  const modi = 1 << idLen

  const pp = (flags & AEC_DATA_PREPROCESS) !== 0
  const isSigned = (flags & AEC_DATA_SIGNED) !== 0

  const xmax = bitsPerSample === 32 ? 0xffffffff : (((1 << bitsPerSample) - 1) >>> 0)
  const med = bitsPerSample === 32 ? 0x80000000 : ((1 << (bitsPerSample - 1)) >>> 0)
  const s_xmax = bitsPerSample === 32 ? 0x7fffffff : ((1 << (bitsPerSample - 1)) - 1)

  const rsiSize = rsi * blockSize
  const rsiBuf = new Uint32Array(rsiSize)
  const out = new (isSigned ? Int32Array : Uint32Array)(nSamples)
  let outCount = 0

  let rsiIndex = 0
  let ref = pp ? 1 : 0
  let encodedBlockSize = pp ? (blockSize - 1) : blockSize

  const flushRsi = (count: number): void => {
    if (count === 0) return
    if (!pp) {
      for (let i = 0; i < count; i++) {
        if (outCount < nSamples) out[outCount++] = rsiBuf[i]
      }
      return
    }

    // Unit-delay predictor inversion
    let data = rsiBuf[0]
    if (isSigned) {
      const m = 1 << (bitsPerSample - 1)
      data = (data ^ m) - m
    }
    if (outCount < nSamples) out[outCount++] = data

    if (!isSigned) {
      for (let i = 1; i < count; i++) {
        const d = rsiBuf[i]
        const half_d = (d >>> 1) + (d & 1)
        const mask = (data & med) ? xmax : 0
        if (half_d <= (mask ^ data)) {
          data += (d >>> 1) ^ (~((d & 1) - 1))
        } else {
          data = mask ^ d
        }
        data = data >>> 0
        if (outCount < nSamples) out[outCount++] = data
      }
    } else {
      for (let i = 1; i < count; i++) {
        const d = rsiBuf[i]
        const half_d = (d >>> 1) + (d & 1)
        if (data < 0) {
          if (half_d <= s_xmax + data + 1) {
            data += (d >>> 1) ^ (~((d & 1) - 1))
          } else {
            data = d - s_xmax - 1
          }
        } else {
          if (half_d <= s_xmax - data) {
            data += (d >>> 1) ^ (~((d & 1) - 1))
          } else {
            data = s_xmax - d
          }
        }
        if (outCount < nSamples) out[outCount++] = data
      }
    }
  }

  while (outCount < nSamples && reader.bytePos < bytes.length) {
    if (rsiIndex === rsiSize) {
      flushRsi(rsiIndex)
      rsiIndex = 0
      ref = pp ? 1 : 0
      encodedBlockSize = pp ? (blockSize - 1) : blockSize
      if (flags & AEC_PAD_RSI) {
        reader.alignToByte()
      }
      // Output complete: trailing bits are padding, never read them.
      if (outCount >= nSamples) break
    }

    const id = reader.getBits(idLen)

    if (id === 0) {
      // Low entropy option: 1 bit sub-id
      const subId = reader.getBits(1)
      if (ref) {
        rsiBuf[rsiIndex++] = reader.getBits(bitsPerSample)
      }
      if (subId === 1) {
        // Second extension
        let i = ref
        while (i < blockSize) {
          const m = reader.getFS()
          if (m > 90) throw new Error(`second extension index m > 90: ${m}`)
          const d1 = m - SE_TABLE[2 * m + 1]
          if ((i & 1) === 0) {
            rsiBuf[rsiIndex++] = SE_TABLE[2 * m] - d1
            i++
          }
          rsiBuf[rsiIndex++] = d1
          i++
        }
      } else {
        // Zero block
        const fs = reader.getFS()
        let zeroBlocks = fs + 1
        if (zeroBlocks === 5) {
          // ROS (Run of Zeros)
          const b = Math.floor(rsiIndex / blockSize)
          zeroBlocks = Math.min(rsi - b, 64 - (b % 64))
        } else if (zeroBlocks > 5) {
          zeroBlocks--
        }
        const zeroSamples = zeroBlocks * blockSize - ref
        rsiBuf.fill(0, rsiIndex, rsiIndex + zeroSamples)
        rsiIndex += zeroSamples
      }
    } else if (id === modi - 1) {
      // Uncompressed option
      for (let i = 0; i < blockSize; i++) {
        rsiBuf[rsiIndex++] = reader.getBits(bitsPerSample)
      }
    } else {
      // Split (Rice) option
      const k = id - 1
      if (ref) {
        rsiBuf[rsiIndex++] = reader.getBits(bitsPerSample)
      }
      const startIdx = rsiIndex
      for (let i = 0; i < encodedBlockSize; i++) {
        rsiBuf[startIdx + i] = reader.getFS() << k
      }
      if (k > 0) {
        for (let i = 0; i < encodedBlockSize; i++) {
          rsiBuf[startIdx + i] += reader.getBits(k)
        }
      }
      rsiIndex += encodedBlockSize
    }

    ref = 0
    encodedBlockSize = blockSize

    // Enough samples buffered: trailing bits are padding, never read them.
    if (outCount + rsiIndex >= nSamples) break
  }

  // Final flush for remaining samples in last RSI
  flushRsi(rsiIndex)

  // A short buffer must say so, never pad with zeros. pastEnd means the
  // buffer ran dry mid-code: even a full-looking output is suspect.
  if (outCount < nSamples || reader.pastEnd) {
    throw new Error(`truncated data: need ${nSamples} samples, have ${outCount}`)
  }

  return out
}

/**
 * CCSDS AEC encoder for testing and roundtrip verification.
 */
export function encodeAec(
  samples: ArrayLike<number>,
  options: AecOptions,
): Uint8Array {
  const { bitsPerSample, blockSize, rsi, flags } = options
  const writer = new BitWriter()

  let idLen: number
  if (bitsPerSample > 16) idLen = 5
  else if (bitsPerSample > 8) idLen = 4
  else {
    if (flags & AEC_RESTRICTED) {
      if (bitsPerSample <= 2) idLen = 1
      else if (bitsPerSample <= 4) idLen = 2
      else throw new Error('AEC_RESTRICTED invalid')
    } else idLen = 3
  }
  const modi = 1 << idLen

  const pp = (flags & AEC_DATA_PREPROCESS) !== 0
  const isSigned = (flags & AEC_DATA_SIGNED) !== 0

  const xmax = bitsPerSample === 32 ? 0xffffffff : (((1 << bitsPerSample) - 1) >>> 0)
  const xmin = isSigned ? (-(1 << (bitsPerSample - 1))) : 0

  const n = samples.length
  let samplePos = 0

  while (samplePos < n) {
    const rsiSampleCount = Math.min(rsi * blockSize, n - samplePos)
    // Create preprocessed array for this RSI
    const d = new Uint32Array(rsiSampleCount)
    const refSample = samples[samplePos] >>> 0

    if (pp) {
      d[0] = 0 // placeholder
      if (!isSigned) {
        for (let i = 0; i < rsiSampleCount - 1; i++) {
          const curr = samples[samplePos + i + 1] >>> 0
          const prev = samples[samplePos + i] >>> 0
          if (curr >= prev) {
            const diff = curr - prev
            d[i + 1] = diff <= prev ? 2 * diff : curr
          } else {
            const diff = prev - curr
            d[i + 1] = diff <= xmax - prev ? 2 * diff - 1 : xmax - curr
          }
        }
      } else {
        for (let i = 0; i < rsiSampleCount - 1; i++) {
          const curr = samples[samplePos + i + 1]
          const prev = samples[samplePos + i]
          if (curr < prev) {
            const diff = prev - curr
            d[i + 1] = diff <= xmax - prev ? 2 * diff - 1 : xmax - curr
          } else {
            const diff = curr - prev
            d[i + 1] = diff <= prev - xmin ? 2 * diff : curr - xmin
          }
        }
      }
    } else {
      for (let i = 0; i < rsiSampleCount; i++) {
        d[i] = samples[samplePos + i] >>> 0
      }
    }

    let rsiOffset = 0
    let blockIndexInRsi = 0
    let zeroBlocksAcc = 0
    let zeroRef = 0
    let zeroRefSample = 0

    const flushZeroBlocks = (): void => {
      if (zeroBlocksAcc === 0) return
      writer.putBits(0, idLen + 1) // id=0, sub_id=0
      if (zeroRef) {
        writer.putBits(zeroRefSample, bitsPerSample)
      }
      if (zeroBlocksAcc === 5) {
        writer.putFS(4)
      } else if (zeroBlocksAcc > 5) {
        writer.putFS(zeroBlocksAcc)
      } else {
        writer.putFS(zeroBlocksAcc - 1)
      }
      zeroBlocksAcc = 0
      zeroRef = 0
    }

    while (rsiOffset < rsiSampleCount) {
      const isFirstBlock = (blockIndexInRsi === 0)
      const curRef = (pp && isFirstBlock) ? 1 : 0
      const curRefSample = refSample
      const currentBlockLen = Math.min(blockSize, rsiSampleCount - rsiOffset)
      const blockSamples = new Uint32Array(blockSize)
      for (let i = 0; i < currentBlockLen; i++) {
        blockSamples[i] = d[rsiOffset + i]
      }
      // If block is incomplete (at end of data), pad with 0
      if (currentBlockLen < blockSize) {
        blockSamples.fill(0, currentBlockLen)
      }

      // Check if current block is all zero
      let isAllZero = true
      for (let i = curRef; i < blockSize; i++) {
        if (blockSamples[i] !== 0) {
          isAllZero = false
          break
        }
      }

      if (isAllZero) {
        zeroBlocksAcc++
        if (zeroBlocksAcc === 1) {
          zeroRef = curRef
          zeroRefSample = curRefSample
        }
        const nextBlockNum = blockIndexInRsi + 1
        const atSegmentEnd = (nextBlockNum % 64 === 0) || (rsiOffset + blockSize >= rsiSampleCount)
        if (atSegmentEnd) {
          if (zeroBlocksAcc > 4) zeroBlocksAcc = 5 // ROS
          flushZeroBlocks()
        }
        rsiOffset += blockSize
        blockIndexInRsi++
        continue
      }

      // Non-zero block: first flush any accumulated zero blocks
      if (zeroBlocksAcc > 0) {
        flushZeroBlocks()
      }

      // Evaluate best encoding option
      // Option 1: Uncompressed
      const uncompLen = blockSize * bitsPerSample

      // Option 2: Split options (k = 0 .. modi - 3)
      let bestK = 0
      let bestSplitLen = Infinity
      const encBlockSize = blockSize - curRef
      const kmax = idLen > 1 ? modi - 3 : 0

      for (let k = 0; k <= kmax; k++) {
        let fsSum = 0
        for (let i = curRef; i < blockSize; i++) {
          fsSum += blockSamples[i] >> k
        }
        const len = idLen + (curRef ? bitsPerSample : 0) + fsSum + encBlockSize * (k + 1)
        if (len < bestSplitLen) {
          bestSplitLen = len
          bestK = k
        }
      }

      // Option 3: Second Extension
      let seLen = Infinity
      if (blockSize % 2 === 0) {
        let seFsSum = 0
        let seValid = true
        for (let i = 0; i < blockSize; i += 2) {
          const s0 = (i === 0 && curRef) ? 0 : blockSamples[i]
          const s1 = blockSamples[i + 1]
          const sum = s0 + s1
          const m = (sum * (sum + 1)) / 2 + s1
          if (m > 90) { seValid = false; break }
          seFsSum += m + 1
        }
        if (seValid) {
          seLen = (idLen + 1) + (curRef ? bitsPerSample : 0) + seFsSum
        }
      }

      // Choose minimum
      if (bestSplitLen < uncompLen && bestSplitLen <= seLen) {
        // Emit Split
        writer.putBits(bestK + 1, idLen)
        if (curRef) writer.putBits(curRefSample, bitsPerSample)
        for (let i = curRef; i < blockSize; i++) {
          writer.putFS(blockSamples[i] >> bestK)
        }
        if (bestK > 0) {
          for (let i = curRef; i < blockSize; i++) {
            writer.putBits(blockSamples[i] & ((1 << bestK) - 1), bestK)
          }
        }
      } else if (seLen < uncompLen) {
        // Emit Second Extension
        writer.putBits(1, idLen + 1) // id=0, sub_id=1
        if (curRef) writer.putBits(curRefSample, bitsPerSample)
        for (let i = 0; i < blockSize; i += 2) {
          const s0 = (i === 0 && curRef) ? 0 : blockSamples[i]
          const s1 = blockSamples[i + 1]
          const sum = s0 + s1
          const m = (sum * (sum + 1)) / 2 + s1
          writer.putFS(m)
        }
      } else {
        // Emit Uncompressed
        writer.putBits(modi - 1, idLen)
        if (curRef) {
          blockSamples[0] = curRefSample
        }
        for (let i = 0; i < blockSize; i++) {
          writer.putBits(blockSamples[i], bitsPerSample)
        }
      }

      rsiOffset += blockSize
      blockIndexInRsi++
    }

    if (zeroBlocksAcc > 0) {
      flushZeroBlocks()
    }

    if (flags & AEC_PAD_RSI) {
      writer.alignToByte()
    }

    samplePos += rsiSampleCount
  }

  writer.alignToByte()
  return writer.finish()
}
