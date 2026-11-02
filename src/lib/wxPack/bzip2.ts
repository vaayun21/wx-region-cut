// pure JS streaming bzip2 decompressor
export function bunzip2(input: Uint8Array): Uint8Array {
  if (!(input instanceof Uint8Array)) throw new Error("Input must be a Uint8Array");
  let inPos = 0;
  const inLen = input.length;
  let bitBuffer = 0;
  let bitCount = 0;

  function readBits(n: number): number {
    while (bitCount < n) {
      if (inPos >= inLen) throw new Error("truncated data: cut stream");
      bitBuffer = (bitBuffer << 8) | input[inPos++];
      bitCount += 8;
    }
    bitCount -= n;
    return (bitBuffer >>> bitCount) & ((1 << n) - 1);
  }

  function readBit(): number {
    if (bitCount === 0) {
      if (inPos >= inLen) throw new Error("truncated data: cut stream");
      bitBuffer = (bitBuffer << 8) | input[inPos++];
      bitCount += 8;
    }
    bitCount--;
    return (bitBuffer >>> bitCount) & 1;
  }

  const crcTable = new Int32Array(256);
  for(let i = 0; i < 256; i++) {
    let c = i << 24;
    for(let j = 8; j > 0; j--) {
      if (c & 0x80000000) c = (c << 1) ^ 0x04C11DB7;
      else c = (c << 1);
    }
    crcTable[i] = c;
  }

  const rNums = new Int32Array([619, 720, 127, 481, 931, 816, 813, 233, 566, 247, 986, 723, 205, 415, 709, 164, 921, 677, 207, 410, 250, 214, 224, 480, 526, 689, 427, 199, 50, 159, 92, 477, 908, 305, 597, 241, 196, 668, 485, 747, 445, 175, 153, 981, 755, 608, 622, 128, 595, 638, 202, 532, 237, 563, 222, 290, 778, 671, 770, 741, 799, 120, 184, 977, 461, 810, 686, 269, 758, 201, 442, 503, 307, 347, 946, 739, 368, 617, 335, 137, 362, 54, 452, 940, 281, 332, 330, 786, 121, 552, 310, 749, 187, 856, 422, 178, 437, 867, 861, 484, 965, 433, 960, 482, 313, 275, 959, 311, 447, 252, 344, 497, 891, 792, 177, 523, 762, 500, 795, 340, 268, 707, 939, 466, 170, 457, 183, 360, 920, 292, 113, 53, 401, 750, 502, 983, 853, 413, 115, 663, 942, 381, 625, 443, 827, 725, 553, 623, 650, 426, 149, 574, 520, 125, 975, 479, 321, 894, 218, 513, 999, 907, 851, 659, 210, 804, 396, 521, 456, 829, 100, 694, 606, 917, 653, 660, 642, 188, 306, 531, 803, 575, 235, 129, 878, 679, 403, 678, 505, 508, 329, 715, 641, 107, 630, 297, 836, 176, 590, 83, 647, 66, 158, 636, 730, 936, 680, 263, 206, 420, 271, 716, 501, 331, 131, 283, 895, 389, 742, 603, 141, 407, 773, 529, 881, 953, 363, 467, 444, 133, 971, 462, 336, 818, 970, 769, 584, 985, 350, 728, 797, 866, 966, 489, 572, 796, 992, 854, 495, 696, 649, 783, 303, 412, 198, 142, 874, 451, 116, 681, 618, 225, 111, 475, 692, 706, 496, 860, 525, 255, 819, 756, 932, 289, 417, 230, 599, 134, 464, 439, 450, 203, 560, 582, 397, 710, 682, 839, 399, 834, 727, 421, 627, 607, 631, 802, 610, 826, 952, 929, 245, 963, 431, 863, 591, 558, 449, 440, 234, 155, 314, 528, 868, 62, 135, 665, 872, 903, 626, 320, 604, 309, 391, 81, 58, 492, 359, 156, 219, 569, 455, 948, 61, 633, 226, 174, 602, 181, 441, 672, 354, 168, 388, 779, 93, 298, 923, 213, 258, 893, 285, 814, 185, 319, 65, 246, 527, 724, 764, 693, 685, 785, 254, 400, 315, 646, 364, 411, 537, 644, 79, 296, 547, 85, 257, 102, 637, 859, 661, 751, 654, 577, 812, 594, 943, 765, 41, 794, 735, 259, 951, 108, 938, 592, 357, 514, 192, 191, 44, 713, 559, 23, 512, 941, 470, 711, 605, 483, 308, 434, 84, 915, 873, 580, 52, 109, 345, 369, 276, 57, 805, 928, 925, 978, 719, 448, 346, 614, 699, 144, 74, 139, 436, 194, 772, 101, 888, 515, 240, 221, 774, 414, 172, 924, 824, 616, 26, 278, 564, 45, 991, 850, 487, 899, 871, 955, 377, 687, 807, 789, 458, 419, 930, 260, 498, 568, 387, 518, 550, 937, 517, 300, 898, 995, 12, 114, 323, 621, 428, 86, 145, 169, 251, 624, 835, 242, 609, 103, 855, 967, 752, 670, 491, 988, 587, 546, 60, 669, 897, 843, 982, 361, 571, 460, 593, 266, 91, 89, 56, 150, 355, 782, 596, 424, 215, 601, 140, 634, 71, 173, 324, 236, 935, 318, 64, 208, 14, 703, 104, 800]);

  let outBuf = new Uint8Array(1024 * 1024);
  let outPos = 0;
  const MAX_OUTPUT = 512 * 1024 * 1024;
  // Set once a full stream end marker is seen. A buffer that ends first
  // is truncated data, never an empty result.
  let streamEnded = false;

  function pushByte(b: number) {
    if (outPos >= outBuf.length) {
      const newLen = outBuf.length * 2;
      if (newLen > MAX_OUTPUT) throw new Error("Output exceeds 512MB limit");
      const newBuf = new Uint8Array(newLen);
      newBuf.set(outBuf);
      outBuf = newBuf;
    }
    outBuf[outPos++] = b;
  }

  const MAX_HUFCODE_BITS = 20;
  const MAX_SYMBOLS = 258;
  const GROUP_SIZE = 50;

  const symToByte = new Uint8Array(256);
  const mtfSymbol = new Int32Array(256);
  const selectors = new Uint8Array(32768);
  const lengthArr = new Uint8Array(MAX_SYMBOLS);

  const permute = new Int32Array(6 * MAX_SYMBOLS);
  const limit = new Int32Array(6 * (MAX_HUFCODE_BITS + 1));
  const base = new Int32Array(6 * (MAX_HUFCODE_BITS + 1));
  const minLen = new Int32Array(6);
  const maxLen = new Int32Array(6);

  const byteCount = new Int32Array(256);

  while (inPos < inLen) {
    if (inPos + 4 >= inLen) break;

    const magic1 = readBits(16);
    if (magic1 !== 0x425A) {
      if (inPos === 2) throw new Error("Not a bzip2 archive (no header magic)");
      break;
    }
    const magic2 = readBits(8);
    if (magic2 !== 0x68) throw new Error("Not a bzip2 archive (no version magic)");

    let blockSize100k = readBits(8) - 48;
    if (blockSize100k < 1 || blockSize100k > 9) throw new Error("Invalid block size");

    const bufsize = 100000 * blockSize100k;
    let tt = new Int32Array(bufsize + 100);

    let streamCRC = 0xFFFFFFFF;

    while (true) {
      const h1 = readBits(24);
      const h2 = readBits(24);

      if (h1 === 0x177245 && h2 === 0x385090) {
        const expectedStreamCRC = (readBits(16) << 16) | readBits(16);
        const finalCRC = (streamCRC ^ 0xFFFFFFFF) >>> 0;
        if (finalCRC !== (expectedStreamCRC >>> 0)) {
          throw new Error("Checksum mismatch: stream checksum");
        }
        bitCount = 0;
        bitBuffer = 0;
        streamEnded = true;
        break;
      }

      if (h1 !== 0x314159 || h2 !== 0x265359) {
        throw new Error("Invalid block magic");
      }

      const blockCRC = (readBits(16) << 16) | readBits(16);
      const randomized = readBit();

      const origPtr = readBits(24);
      if (origPtr > bufsize) throw new Error("Initial position larger than buffer size");

      let symTotal = 0;
      const map16 = readBits(16);
      for (let i = 0; i < 16; i++) {
        if ((map16 & (1 << (15 - i))) !== 0) {
          const map8 = readBits(16);
          for (let j = 0; j < 16; j++) {
            if ((map8 & (1 << (15 - j))) !== 0) {
              symToByte[symTotal++] = (16 * i) + j;
            }
          }
        }
      }
      if (symTotal === 0) throw new Error("No symbols in block");

      const groupCount = readBits(3);
      if (groupCount < 2 || groupCount > 6) throw new Error("Invalid group count");
      const nSelectors = readBits(15);
      if (nSelectors === 0) throw new Error("No selectors");

      for (let i = 0; i < groupCount; i++) mtfSymbol[i] = i;

      for (let i = 0; i < nSelectors; i++) {
        let j = 0;
        while (readBit()) {
          j++;
          if (j >= groupCount) throw new Error("Invalid selector data");
        }
        const uc = mtfSymbol[j];
        for (let k = j; k > 0; k--) mtfSymbol[k] = mtfSymbol[k - 1];
        mtfSymbol[0] = uc;
        selectors[i] = uc;
      }

      const symCount = symTotal + 2;

      for (let j = 0; j < groupCount; j++) {
        let t = readBits(5);
        for (let i = 0; i < symCount; i++) {
          while (true) {
            if (t < 1 || t > MAX_HUFCODE_BITS) throw new Error("Invalid huffman length");
            if (!readBit()) break;
            if (readBit()) t--; else t++;
          }
          lengthArr[i] = t;
        }

        let minL = lengthArr[0];
        let maxL = lengthArr[0];
        for (let i = 1; i < symCount; i++) {
          if (lengthArr[i] > maxL) maxL = lengthArr[i];
          if (lengthArr[i] < minL) minL = lengthArr[i];
        }

        minLen[j] = minL;
        maxLen[j] = maxL;

        const gLimit = j * (MAX_HUFCODE_BITS + 1);
        const gBase = j * (MAX_HUFCODE_BITS + 1);
        const gPerm = j * MAX_SYMBOLS;

        let pp = 0;
        for (let i = minL; i <= maxL; i++) {
          for (let t = 0; t < symCount; t++) {
            if (lengthArr[t] === i) permute[gPerm + (pp++)] = t;
          }
        }

        for (let i = 0; i < MAX_HUFCODE_BITS + 1; i++) {
           limit[gLimit + i] = 0;
           base[gBase + i] = 0;
        }

        const temp = new Int32Array(MAX_HUFCODE_BITS + 1);
        for (let i = 0; i < symCount; i++) temp[lengthArr[i]]++;

        pp = 0;
        let t2 = 0;
        for (let i = minL; i < maxL; i++) {
          pp += temp[i];
          limit[gLimit + i] = pp - 1;
          pp <<= 1;
          t2 += temp[i];
          base[gBase + i + 1] = pp - t2;
        }
        limit[gLimit + maxL] = pp + temp[maxL] - 1;
        base[gBase + minL] = 0;
      }

      for (let i = 0; i < 256; i++) {
        mtfSymbol[i] = i;
        byteCount[i] = 0;
      }

      let count = 0;
      let sCount = 0;
      let selectorIdx = 0;

      let currentGroup = 0;
      let gLimit = 0;
      let gBase = 0;
      let gPerm = 0;
      let cMinLen = 0;
      let cMaxLen = 0;

      while (true) {
        if (sCount === 0) {
          sCount = GROUP_SIZE;
          if (selectorIdx >= nSelectors) throw new Error("Selector overflow");
          currentGroup = selectors[selectorIdx++];
          gLimit = currentGroup * (MAX_HUFCODE_BITS + 1);
          gBase = currentGroup * (MAX_HUFCODE_BITS + 1);
          gPerm = currentGroup * MAX_SYMBOLS;
          cMinLen = minLen[currentGroup];
          cMaxLen = maxLen[currentGroup];
        }
        sCount--;

        let i = cMinLen;
        let j = readBits(i);
        while (j > limit[gLimit + i]) {
          i++;
          if (i > cMaxLen) throw new Error("Huffman decode error");
          j = (j << 1) | readBit();
        }

        j -= base[gBase + i];
        if (j < 0 || j >= MAX_SYMBOLS) throw new Error("Huffman decode error (bounds)");

        const nextSym = permute[gPerm + j];

        if (nextSym === 0 || nextSym === 1) { // RUNA or RUNB
          let runLength = 0;
          let weight = 1;

          let sym = nextSym;
          while (true) {
            if (sym === 0) runLength += weight;
            else if (sym === 1) runLength += 2 * weight;

            weight <<= 1;

            if (sCount === 0) {
              sCount = GROUP_SIZE;
              if (selectorIdx >= nSelectors) throw new Error("Selector overflow");
              currentGroup = selectors[selectorIdx++];
              gLimit = currentGroup * (MAX_HUFCODE_BITS + 1);
              gBase = currentGroup * (MAX_HUFCODE_BITS + 1);
              gPerm = currentGroup * MAX_SYMBOLS;
              cMinLen = minLen[currentGroup];
              cMaxLen = maxLen[currentGroup];
            }
            sCount--;

            let i = cMinLen;
            let j = readBits(i);
            while (j > limit[gLimit + i]) {
              i++;
              if (i > cMaxLen) throw new Error("Huffman decode error");
              j = (j << 1) | readBit();
            }
            j -= base[gBase + i];
            sym = permute[gPerm + j];

            if (sym !== 0 && sym !== 1) {
              break;
            }
          }

          if (count + runLength > bufsize) throw new Error("Buffer overflow in run");
          const uc = symToByte[mtfSymbol[0]];
          byteCount[uc] += runLength;
          while (runLength--) tt[count++] = uc;

          if (sym > symTotal) break;

          if (count >= bufsize) throw new Error("Buffer overflow");
          const mtfIdx = sym - 1;
          const ucb = mtfSymbol[mtfIdx];
          for (let k = mtfIdx; k > 0; k--) mtfSymbol[k] = mtfSymbol[k - 1];
          mtfSymbol[0] = ucb;

          const decByte = symToByte[ucb];
          byteCount[decByte]++;
          tt[count++] = decByte;

        } else {
          if (nextSym > symTotal) break; // End of block

          if (count >= bufsize) throw new Error("Buffer overflow");
          const mtfIdx = nextSym - 1;
          const uc = mtfSymbol[mtfIdx];
          for (let k = mtfIdx; k > 0; k--) mtfSymbol[k] = mtfSymbol[k - 1];
          mtfSymbol[0] = uc;

          const decByte = symToByte[uc];
          byteCount[decByte]++;
          tt[count++] = decByte;
        }
      }

      if (origPtr < 0 || origPtr >= count) throw new Error("Invalid origPtr");

      const cumCount = new Int32Array(257);
      for (let i = 0; i < 256; i++) {
        cumCount[i + 1] = cumCount[i] + byteCount[i];
      }

      for (let i = 0; i < count; i++) {
        const uc = tt[i] & 0xFF;
        tt[cumCount[uc]] |= (i << 8);
        cumCount[uc]++;
      }

      let pos = tt[origPtr];
      let current = pos & 0xFF;
      pos >>= 8;

      let cCRC = 0xFFFFFFFF;
      let previous = current;
      let run = -1;
      let randN = 0;
      let randIdx = 0;
      let outbyte = -1;

      let copies = 0;

      let pendingCount = count;
      while (pendingCount > 0) {
        pendingCount--;

        previous = current;
        pos = tt[pos];
        current = pos & 0xFF;
        pos >>= 8;

        if (randomized) {
          if (randN === 0) {
            randN = rNums[randIdx] - 1;
            randIdx = (randIdx + 1) % 512;
          } else {
            randN--;
          }
          if (randN === 0) current ^= 1;
        }

        if (run === 3) {
           copies = current;
           outbyte = previous;
           current = -1;
        } else {
           copies = 1;
           outbyte = current;
        }

        while (copies > 0) {
           copies--;
           cCRC = (cCRC << 8) ^ crcTable[((cCRC >>> 24) ^ outbyte) & 0xFF];
           pushByte(outbyte);
        }
        if (current !== previous) run = 0;
        else run++;
      }

      cCRC = (cCRC ^ 0xFFFFFFFF) >>> 0;
      if (cCRC !== (blockCRC >>> 0)) {
         throw new Error("Checksum mismatch: block checksum");
      }

      // Bzip2 calculates stream CRC by XORing all block CRCs with left rotation by 1
      streamCRC = ((streamCRC << 1) | (streamCRC >>> 31)) ^ cCRC;
    }
  }

  if (!streamEnded) throw new Error("truncated data: no stream end");
  return outBuf.slice(0, outPos);
}
