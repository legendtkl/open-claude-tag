const QR_ECC_LEVEL_L = 1;
const QR_FORMAT_MASK = 0x5412;
const QR_FORMAT_GENERATOR = 0x537;

type QrVersionInfo = {
  version: number;
  size: number;
  dataCodewords: number;
  eccCodewordsPerBlock: number;
  errorCorrectionBlocks: number;
  alignmentCenters: number[];
};

const QR_VERSIONS: QrVersionInfo[] = [
  {
    version: 1,
    size: 21,
    dataCodewords: 19,
    eccCodewordsPerBlock: 7,
    errorCorrectionBlocks: 1,
    alignmentCenters: [],
  },
  {
    version: 2,
    size: 25,
    dataCodewords: 34,
    eccCodewordsPerBlock: 10,
    errorCorrectionBlocks: 1,
    alignmentCenters: [6, 18],
  },
  {
    version: 3,
    size: 29,
    dataCodewords: 55,
    eccCodewordsPerBlock: 15,
    errorCorrectionBlocks: 1,
    alignmentCenters: [6, 22],
  },
  {
    version: 4,
    size: 33,
    dataCodewords: 80,
    eccCodewordsPerBlock: 20,
    errorCorrectionBlocks: 1,
    alignmentCenters: [6, 26],
  },
  {
    version: 5,
    size: 37,
    dataCodewords: 108,
    eccCodewordsPerBlock: 26,
    errorCorrectionBlocks: 1,
    alignmentCenters: [6, 30],
  },
  {
    version: 6,
    size: 41,
    dataCodewords: 136,
    eccCodewordsPerBlock: 18,
    errorCorrectionBlocks: 2,
    alignmentCenters: [6, 34],
  },
  {
    version: 7,
    size: 45,
    dataCodewords: 156,
    eccCodewordsPerBlock: 20,
    errorCorrectionBlocks: 2,
    alignmentCenters: [6, 22, 38],
  },
  {
    version: 8,
    size: 49,
    dataCodewords: 194,
    eccCodewordsPerBlock: 24,
    errorCorrectionBlocks: 2,
    alignmentCenters: [6, 24, 42],
  },
  {
    version: 9,
    size: 53,
    dataCodewords: 232,
    eccCodewordsPerBlock: 30,
    errorCorrectionBlocks: 2,
    alignmentCenters: [6, 26, 46],
  },
  {
    version: 10,
    size: 57,
    dataCodewords: 274,
    eccCodewordsPerBlock: 18,
    errorCorrectionBlocks: 4,
    alignmentCenters: [6, 28, 50],
  },
  {
    version: 11,
    size: 61,
    dataCodewords: 324,
    eccCodewordsPerBlock: 20,
    errorCorrectionBlocks: 4,
    alignmentCenters: [6, 30, 54],
  },
  {
    version: 12,
    size: 65,
    dataCodewords: 370,
    eccCodewordsPerBlock: 24,
    errorCorrectionBlocks: 4,
    alignmentCenters: [6, 32, 58],
  },
  {
    version: 13,
    size: 69,
    dataCodewords: 428,
    eccCodewordsPerBlock: 26,
    errorCorrectionBlocks: 4,
    alignmentCenters: [6, 34, 62],
  },
  {
    version: 14,
    size: 73,
    dataCodewords: 461,
    eccCodewordsPerBlock: 30,
    errorCorrectionBlocks: 4,
    alignmentCenters: [6, 26, 46, 66],
  },
  {
    version: 15,
    size: 77,
    dataCodewords: 523,
    eccCodewordsPerBlock: 22,
    errorCorrectionBlocks: 6,
    alignmentCenters: [6, 26, 48, 70],
  },
  {
    version: 16,
    size: 81,
    dataCodewords: 589,
    eccCodewordsPerBlock: 24,
    errorCorrectionBlocks: 6,
    alignmentCenters: [6, 26, 50, 74],
  },
  {
    version: 17,
    size: 85,
    dataCodewords: 647,
    eccCodewordsPerBlock: 28,
    errorCorrectionBlocks: 6,
    alignmentCenters: [6, 30, 54, 78],
  },
  {
    version: 18,
    size: 89,
    dataCodewords: 721,
    eccCodewordsPerBlock: 30,
    errorCorrectionBlocks: 6,
    alignmentCenters: [6, 30, 56, 82],
  },
  {
    version: 19,
    size: 93,
    dataCodewords: 795,
    eccCodewordsPerBlock: 28,
    errorCorrectionBlocks: 7,
    alignmentCenters: [6, 30, 58, 86],
  },
  {
    version: 20,
    size: 97,
    dataCodewords: 861,
    eccCodewordsPerBlock: 28,
    errorCorrectionBlocks: 8,
    alignmentCenters: [6, 34, 62, 90],
  },
];

export function createQrCodeSvgDataUrl(value: string): string {
  const modules = createQrCodeModules(value);
  const quiet = 4;
  const size = modules.length + quiet * 2;
  const path = modules
    .flatMap((row, y) =>
      row
        .map((dark, x) => (dark ? `M${x + quiet},${y + quiet}h1v1h-1z` : ''))
        .filter(Boolean),
    )
    .join('');
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`,
    `<path fill="#fff" d="M0 0h${size}v${size}H0z"/>`,
    `<path fill="#111718" d="${path}"/>`,
    '</svg>',
  ].join('');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createQrCodeModules(value: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(value)];
  const version = chooseVersion(bytes.length);
  const dataCodewords = createDataCodewords(bytes, version);
  const allCodewords = createFinalCodewords(dataCodewords, version);
  const dataBits = allCodewords.flatMap((codeword) => numberBits(codeword, 8));
  const base = createBaseMatrix(version);
  let bestMatrix: boolean[][] | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = cloneModules(base.modules);
    placeDataBits(candidate, base.reserved, dataBits, mask);
    placeFormatBits(candidate, mask);
    const penalty = calculatePenalty(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMatrix = candidate;
    }
  }

  return bestMatrix ?? base.modules;
}

function chooseVersion(byteLength: number): QrVersionInfo {
  for (const version of QR_VERSIONS) {
    const lengthBits = version.version < 10 ? 8 : 16;
    if (4 + lengthBits + byteLength * 8 <= version.dataCodewords * 8) {
      return version;
    }
  }
  throw new Error('QR input is too long for the built-in encoder.');
}

function createDataCodewords(bytes: number[], version: QrVersionInfo): number[] {
  const lengthBits = version.version < 10 ? 8 : 16;
  const bits = [...numberBits(0b0100, 4), ...numberBits(bytes.length, lengthBits)];
  for (const byte of bytes) bits.push(...numberBits(byte, 8));
  const capacityBits = version.dataCodewords * 8;
  bits.push(...Array(Math.min(4, capacityBits - bits.length)).fill(0));
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    codewords.push(bitsToNumber(bits.slice(index, index + 8)));
  }
  for (let pad = 0xec; codewords.length < version.dataCodewords; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

function createFinalCodewords(dataCodewords: number[], version: QrVersionInfo): number[] {
  const rawCodewords =
    version.dataCodewords + version.eccCodewordsPerBlock * version.errorCorrectionBlocks;
  const blockCount = version.errorCorrectionBlocks;
  const shortBlockCount = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const shortDataLength = shortBlockLength - version.eccCodewordsPerBlock;
  const blocks: number[][] = [];
  let dataOffset = 0;

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const dataLength = shortDataLength + (blockIndex < shortBlockCount ? 0 : 1);
    const dataBlock = dataCodewords.slice(dataOffset, dataOffset + dataLength);
    dataOffset += dataLength;
    const errorCorrectionBlock = createErrorCorrectionCodewords(
      dataBlock,
      version.eccCodewordsPerBlock,
    );
    if (blockIndex < shortBlockCount) dataBlock.push(0);
    blocks.push([...dataBlock, ...errorCorrectionBlock]);
  }

  if (dataOffset !== dataCodewords.length) {
    throw new Error('QR encoder block layout is invalid.');
  }

  const result: number[] = [];
  for (let index = 0; index < blocks[0].length; index += 1) {
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      if (index === shortDataLength && blockIndex < shortBlockCount) continue;
      const codeword = blocks[blockIndex][index];
      if (codeword !== undefined) result.push(codeword);
    }
  }

  if (result.length !== rawCodewords) {
    throw new Error('QR encoder produced an invalid codeword count.');
  }
  return result;
}

function createBaseMatrix(version: QrVersionInfo): {
  modules: boolean[][];
  reserved: boolean[][];
} {
  const modules = Array.from({ length: version.size }, () => Array(version.size).fill(false));
  const reserved = Array.from({ length: version.size }, () => Array(version.size).fill(false));
  const set = (x: number, y: number, dark: boolean, reserve = true) => {
    if (x < 0 || y < 0 || x >= version.size || y >= version.size) return;
    modules[y][x] = dark;
    if (reserve) reserved[y][x] = true;
  };

  placeFinderPattern(set, 0, 0);
  placeFinderPattern(set, version.size - 7, 0);
  placeFinderPattern(set, 0, version.size - 7);
  placeAlignmentPatterns(set, version);

  for (let index = 8; index < version.size - 8; index += 1) {
    const dark = index % 2 === 0;
    set(index, 6, dark);
    set(6, index, dark);
  }

  set(8, version.size - 8, true);
  reserveFormatAreas(reserved, version.size);
  placeVersionBits(set, version);
  return { modules, reserved };
}

function placeFinderPattern(
  set: (x: number, y: number, dark: boolean, reserve?: boolean) => void,
  left: number,
  top: number,
): void {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const dark =
        x >= 0 &&
        x <= 6 &&
        y >= 0 &&
        y <= 6 &&
        (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
      set(left + x, top + y, dark);
    }
  }
}

function placeAlignmentPatterns(
  set: (x: number, y: number, dark: boolean, reserve?: boolean) => void,
  version: QrVersionInfo,
): void {
  for (const cx of version.alignmentCenters) {
    for (const cy of version.alignmentCenters) {
      const overlapsFinder =
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === version.size - 7) ||
        (cx === version.size - 7 && cy === 6);
      if (overlapsFinder) continue;
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) {
          const distance = Math.max(Math.abs(x), Math.abs(y));
          set(cx + x, cy + y, distance !== 1);
        }
      }
    }
  }
}

function reserveFormatAreas(reserved: boolean[][], size: number): void {
  for (let i = 0; i <= 5; i += 1) reserved[i][8] = true;
  reserved[7][8] = true;
  reserved[8][8] = true;
  reserved[8][7] = true;
  for (let i = 0; i <= 5; i += 1) reserved[8][i] = true;
  for (let i = 0; i <= 7; i += 1) reserved[8][size - 1 - i] = true;
  for (let i = 0; i <= 6; i += 1) reserved[size - 1 - i][8] = true;
}

function placeVersionBits(
  set: (x: number, y: number, dark: boolean, reserve?: boolean) => void,
  version: QrVersionInfo,
): void {
  if (version.version < 7) return;
  const bits = calculateVersionBits(version.version);
  for (let index = 0; index < 18; index += 1) {
    const dark = ((bits >>> index) & 1) === 1;
    const a = version.size - 11 + (index % 3);
    const b = Math.floor(index / 3);
    set(a, b, dark);
    set(b, a, dark);
  }
}

function calculateVersionBits(version: number): number {
  let remainder = version << 12;
  for (let bit = 17; bit >= 12; bit -= 1) {
    if (((remainder >>> bit) & 1) !== 0) {
      remainder ^= 0x1f25 << (bit - 12);
    }
  }
  return (version << 12) | remainder;
}

function placeDataBits(
  modules: boolean[][],
  reserved: boolean[][],
  bits: number[],
  mask: number,
): void {
  const size = modules.length;
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = upward ? size - 1 - vertical : vertical;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (reserved[y][x]) continue;
        const bit = bits[bitIndex] === 1;
        bitIndex += 1;
        modules[y][x] = bit !== maskApplies(mask, x, y);
      }
    }
    upward = !upward;
  }
}

function placeFormatBits(modules: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = calculateFormatBits(mask);
  const bit = (index: number) => ((bits >>> index) & 1) === 1;

  for (let index = 0; index <= 5; index += 1) modules[index][8] = bit(index);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let index = 9; index <= 14; index += 1) modules[8][14 - index] = bit(index);

  for (let index = 0; index <= 7; index += 1) modules[8][size - 1 - index] = bit(index);
  for (let index = 8; index <= 14; index += 1) modules[size - 15 + index][8] = bit(index);
}

function calculateFormatBits(mask: number): number {
  const value = (QR_ECC_LEVEL_L << 3) | mask;
  let remainder = value << 10;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if (((remainder >>> bit) & 1) !== 0) {
      remainder ^= QR_FORMAT_GENERATOR << (bit - 10);
    }
  }
  return ((value << 10) | remainder) ^ QR_FORMAT_MASK;
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function createErrorCorrectionCodewords(data: number[], degree: number): number[] {
  const generator = createGeneratorPolynomial(degree);
  const remainder = Array(degree).fill(0);
  for (const codeword of data) {
    const factor = codeword ^ remainder.shift()!;
    remainder.push(0);
    for (let index = 0; index < degree; index += 1) {
      remainder[index] ^= gfMultiply(generator[index + 1], factor);
    }
  }
  return remainder;
}

function createGeneratorPolynomial(degree: number): number[] {
  let coefficients = [1];
  for (let index = 0; index < degree; index += 1) {
    coefficients = multiplyPolynomials(coefficients, [1, gfPower(index)]);
  }
  return coefficients;
}

function multiplyPolynomials(left: number[], right: number[]): number[] {
  const result = Array(left.length + right.length - 1).fill(0);
  for (let i = 0; i < left.length; i += 1) {
    for (let j = 0; j < right.length; j += 1) {
      result[i + j] ^= gfMultiply(left[i], right[j]);
    }
  }
  return result;
}

const GF_EXP = (() => {
  const values = Array(512).fill(0);
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    values[index] = value;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) values[index] = values[index - 255];
  return values;
})();

const GF_LOG = (() => {
  const values = Array(256).fill(0);
  for (let index = 0; index < 255; index += 1) values[GF_EXP[index]] = index;
  return values;
})();

function gfMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

function gfPower(exponent: number): number {
  return GF_EXP[exponent];
}

function calculatePenalty(modules: boolean[][]): number {
  return (
    penaltyRuns(modules) +
    penaltyRuns(transpose(modules)) +
    penaltyBoxes(modules) +
    penaltyFinderLike(modules) +
    penaltyFinderLike(transpose(modules)) +
    penaltyBalance(modules)
  );
}

function penaltyRuns(modules: boolean[][]): number {
  let penalty = 0;
  for (const row of modules) {
    let runColor = row[0];
    let runLength = 1;
    for (let index = 1; index < row.length; index += 1) {
      if (row[index] === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) penalty += runLength - 2;
        runColor = row[index];
        runLength = 1;
      }
    }
    if (runLength >= 5) penalty += runLength - 2;
  }
  return penalty;
}

function penaltyBoxes(modules: boolean[][]): number {
  let penalty = 0;
  for (let y = 0; y < modules.length - 1; y += 1) {
    for (let x = 0; x < modules.length - 1; x += 1) {
      const color = modules[y][x];
      if (
        modules[y][x + 1] === color &&
        modules[y + 1][x] === color &&
        modules[y + 1][x + 1] === color
      ) {
        penalty += 3;
      }
    }
  }
  return penalty;
}

function penaltyFinderLike(modules: boolean[][]): number {
  let penalty = 0;
  const pattern = [true, false, true, true, true, false, true];
  for (const row of modules) {
    for (let index = 0; index <= row.length - 7; index += 1) {
      if (!pattern.every((color, offset) => row[index + offset] === color)) continue;
      const leftClear = index >= 4 && row.slice(index - 4, index).every((color) => !color);
      const rightClear =
        index + 11 <= row.length && row.slice(index + 7, index + 11).every((color) => !color);
      if (leftClear || rightClear) penalty += 40;
    }
  }
  return penalty;
}

function penaltyBalance(modules: boolean[][]): number {
  const total = modules.length * modules.length;
  const dark = modules.flat().filter(Boolean).length;
  return Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
}

function numberBits(value: number, length: number): number[] {
  return Array.from({ length }, (_, index) => (value >>> (length - 1 - index)) & 1);
}

function bitsToNumber(bits: number[]): number {
  return bits.reduce((value, bit) => (value << 1) | bit, 0);
}

function cloneModules(modules: boolean[][]): boolean[][] {
  return modules.map((row) => [...row]);
}

function transpose(modules: boolean[][]): boolean[][] {
  return modules[0].map((_, column) => modules.map((row) => row[column]));
}
