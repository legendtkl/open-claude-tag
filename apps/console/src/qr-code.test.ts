import { describe, expect, it } from 'vitest';
import { createQrCodeSvgDataUrl } from './qr-code';

const QR_FORMAT_MASK = 0x5412;
const QR_FORMAT_GENERATOR = 0x537;

type VersionTestInfo = {
  dataCodewords: number;
  eccCodewordsPerBlock: number;
  errorCorrectionBlocks: number;
};

const VERSION_INFO = new Map<number, VersionTestInfo>([
  [1, { dataCodewords: 19, eccCodewordsPerBlock: 7, errorCorrectionBlocks: 1 }],
  [2, { dataCodewords: 34, eccCodewordsPerBlock: 10, errorCorrectionBlocks: 1 }],
  [3, { dataCodewords: 55, eccCodewordsPerBlock: 15, errorCorrectionBlocks: 1 }],
  [4, { dataCodewords: 80, eccCodewordsPerBlock: 20, errorCorrectionBlocks: 1 }],
  [5, { dataCodewords: 108, eccCodewordsPerBlock: 26, errorCorrectionBlocks: 1 }],
  [6, { dataCodewords: 136, eccCodewordsPerBlock: 18, errorCorrectionBlocks: 2 }],
  [7, { dataCodewords: 156, eccCodewordsPerBlock: 20, errorCorrectionBlocks: 2 }],
  [8, { dataCodewords: 194, eccCodewordsPerBlock: 24, errorCorrectionBlocks: 2 }],
  [9, { dataCodewords: 232, eccCodewordsPerBlock: 30, errorCorrectionBlocks: 2 }],
  [10, { dataCodewords: 274, eccCodewordsPerBlock: 18, errorCorrectionBlocks: 4 }],
  [11, { dataCodewords: 324, eccCodewordsPerBlock: 20, errorCorrectionBlocks: 4 }],
  [12, { dataCodewords: 370, eccCodewordsPerBlock: 24, errorCorrectionBlocks: 4 }],
  [13, { dataCodewords: 428, eccCodewordsPerBlock: 26, errorCorrectionBlocks: 4 }],
  [14, { dataCodewords: 461, eccCodewordsPerBlock: 30, errorCorrectionBlocks: 4 }],
  [15, { dataCodewords: 523, eccCodewordsPerBlock: 22, errorCorrectionBlocks: 6 }],
  [16, { dataCodewords: 589, eccCodewordsPerBlock: 24, errorCorrectionBlocks: 6 }],
  [17, { dataCodewords: 647, eccCodewordsPerBlock: 28, errorCorrectionBlocks: 6 }],
  [18, { dataCodewords: 721, eccCodewordsPerBlock: 30, errorCorrectionBlocks: 6 }],
  [19, { dataCodewords: 795, eccCodewordsPerBlock: 28, errorCorrectionBlocks: 7 }],
  [20, { dataCodewords: 861, eccCodewordsPerBlock: 28, errorCorrectionBlocks: 8 }],
]);

const VERSION_ALIGNMENT_CENTERS = new Map([
  [1, []],
  [2, [6, 18]],
  [3, [6, 22]],
  [4, [6, 26]],
  [5, [6, 30]],
  [6, [6, 34]],
  [7, [6, 22, 38]],
  [8, [6, 24, 42]],
  [9, [6, 26, 46]],
  [10, [6, 28, 50]],
  [11, [6, 30, 54]],
  [12, [6, 32, 58]],
  [13, [6, 34, 62]],
  [14, [6, 26, 46, 66]],
  [15, [6, 26, 48, 70]],
  [16, [6, 26, 50, 74]],
  [17, [6, 30, 54, 78]],
  [18, [6, 30, 56, 82]],
  [19, [6, 30, 58, 86]],
  [20, [6, 34, 62, 90]],
]);

describe('createQrCodeSvgDataUrl', () => {
  it('generates an approval QR that decodes back to the source URL', () => {
    const approvalUrl =
      'https://open.feishu.cn/app/cli_reviewer/auth?op_from=openapi&token_type=tenant';

    const dataUrl = createQrCodeSvgDataUrl(approvalUrl);

    expect(decodeQrSvgDataUrl(dataUrl)).toBe(approvalUrl);
  });

  it('generates a scoped approval QR that decodes back to the source URL', () => {
    const approvalUrl =
      'https://open.feishu.cn/app/cli_xxxxxxxxxxxxxxxx/auth?q=im%3Amessage.p2p_msg%3Areadonly%2Cim%3Amessage.reactions%3Awrite_only%2Cim%3Achat.members%3Aread&op_from=openapi&token_type=tenant';

    const dataUrl = createQrCodeSvgDataUrl(approvalUrl);

    expect(decodeQrSvgDataUrl(dataUrl)).toBe(approvalUrl);
  });

  it('generates a QR for every current OpenClaudeTag required scope', () => {
    const approvalUrl =
      'https://open.feishu.cn/app/cli_xxxxxxxxxxxxxxxx/auth?q=im%3Amessage.p2p_msg%3Areadonly%2Cim%3Amessage.group_at_msg%3Areadonly%2Cim%3Amessage%3Asend_as_bot%2Cim%3Amessage%3Aupdate%2Cim%3Amessage.reactions%3Awrite_only%2Cim%3Amessage%3Areadonly%2Cim%3Aresource%2Cdocs%3Aevent%3Asubscribe%2Cdocs%3Adocument.comment%3Aread%2Cdocs%3Adocument.comment%3Acreate%2Cim%3Achat%3Aread%2Cim%3Achat.members%3Aread%2Ctask%3Atasklist%3Aread%2Ctask%3Atasklist%3Awriteonly%2Ctask%3Acustom_field%3Aread%2Ctask%3Acustom_field%3Awriteonly%2Ctask%3Asection%3Aread%2Ctask%3Asection%3Awriteonly%2Ctask%3Atask%3Awrite&op_from=openapi&token_type=tenant';

    const dataUrl = createQrCodeSvgDataUrl(approvalUrl);

    expect(decodeQrSvgDataUrl(dataUrl)).toBe(approvalUrl);
  });

  it('rejects values outside the built-in encoder capacity', () => {
    expect(() => createQrCodeSvgDataUrl('x'.repeat(1000))).toThrow(
      'QR input is too long for the built-in encoder.',
    );
  });
});

function decodeQrSvgDataUrl(dataUrl: string): string {
  const modules = modulesFromSvgDataUrl(dataUrl);
  const size = modules.length;
  const version = (size - 17) / 4;
  const versionInfo = VERSION_INFO.get(version);
  if (!versionInfo) throw new Error(`Unsupported QR version ${version}`);
  const reserved = createReservedModules(version, size);
  const mask = readMask(modules);
  const rawCodewords = readCodewords(modules, reserved, mask, versionInfo);
  const dataCodewords = deinterleaveDataCodewords(rawCodewords, versionInfo);
  const bits = dataCodewords.flatMap((codeword) => numberBits(codeword, 8));
  const mode = bitsToNumber(bits.slice(0, 4));
  if (mode !== 0b0100) throw new Error(`Unsupported QR mode ${mode}`);
  const lengthBits = version < 10 ? 8 : 16;
  const byteLength = bitsToNumber(bits.slice(4, 4 + lengthBits));
  const bytes: number[] = [];
  for (let index = 4 + lengthBits; index < 4 + lengthBits + byteLength * 8; index += 8) {
    bytes.push(bitsToNumber(bits.slice(index, index + 8)));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function modulesFromSvgDataUrl(dataUrl: string): boolean[][] {
  const encoded = dataUrl.match(/^data:image\/svg\+xml;charset=utf-8,(.*)$/)?.[1];
  if (!encoded) throw new Error('Unexpected QR data URL format');
  const svg = decodeURIComponent(encoded);
  const size = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)?.[1]);
  if (!Number.isInteger(size)) throw new Error('Missing QR viewBox');
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const path = svg.match(/<path fill="#111718" d="([^"]*)"/)?.[1] ?? '';
  for (const match of path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    modules[y][x] = true;
  }
  const quiet = 4;
  return modules
    .slice(quiet, size - quiet)
    .map((row) => row.slice(quiet, size - quiet));
}

function createReservedModules(version: number, size: number): boolean[][] {
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));
  const reserve = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    reserved[y][x] = true;
  };

  reserveFinder(0, 0, reserve);
  reserveFinder(size - 7, 0, reserve);
  reserveFinder(0, size - 7, reserve);
  for (const cx of VERSION_ALIGNMENT_CENTERS.get(version) ?? []) {
    for (const cy of VERSION_ALIGNMENT_CENTERS.get(version) ?? []) {
      const overlapsFinder =
        (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
      if (overlapsFinder) continue;
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) reserve(cx + x, cy + y);
      }
    }
  }
  for (let index = 8; index < size - 8; index += 1) {
    reserve(index, 6);
    reserve(6, index);
  }
  reserve(8, size - 8);
  reserveFormatAreas(reserved, size);
  reserveVersionAreas(reserved, version, size);
  return reserved;
}

function reserveFinder(left: number, top: number, reserve: (x: number, y: number) => void): void {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) reserve(left + x, top + y);
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

function reserveVersionAreas(reserved: boolean[][], version: number, size: number): void {
  if (version < 7) return;
  for (let index = 0; index < 18; index += 1) {
    const a = size - 11 + (index % 3);
    const b = Math.floor(index / 3);
    reserved[b][a] = true;
    reserved[a][b] = true;
  }
}

function readMask(modules: boolean[][]): number {
  let bits = 0;
  for (let index = 0; index <= 5; index += 1) bits |= Number(modules[index][8]) << index;
  bits |= Number(modules[7][8]) << 6;
  bits |= Number(modules[8][8]) << 7;
  bits |= Number(modules[8][7]) << 8;
  for (let index = 9; index <= 14; index += 1) {
    bits |= Number(modules[8][14 - index]) << index;
  }
  for (let mask = 0; mask < 8; mask += 1) {
    if (calculateFormatBits(mask) === bits) return mask;
  }
  throw new Error('Unable to decode QR mask');
}

function readDataBits(modules: boolean[][], reserved: boolean[][], mask: number): number[] {
  const size = modules.length;
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = upward ? size - 1 - vertical : vertical;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (reserved[y][x]) continue;
        bits.push(Number(modules[y][x] !== maskApplies(mask, x, y)));
      }
    }
    upward = !upward;
  }
  return bits;
}

function readCodewords(
  modules: boolean[][],
  reserved: boolean[][],
  mask: number,
  versionInfo: VersionTestInfo,
): number[] {
  const rawCodewords =
    versionInfo.dataCodewords +
    versionInfo.eccCodewordsPerBlock * versionInfo.errorCorrectionBlocks;
  const bits = readDataBits(modules, reserved, mask).slice(0, rawCodewords * 8);
  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    codewords.push(bitsToNumber(bits.slice(index, index + 8)));
  }
  return codewords;
}

function deinterleaveDataCodewords(
  rawCodewords: number[],
  versionInfo: VersionTestInfo,
): number[] {
  const blockCount = versionInfo.errorCorrectionBlocks;
  const rawCodewordCount =
    versionInfo.dataCodewords +
    versionInfo.eccCodewordsPerBlock * versionInfo.errorCorrectionBlocks;
  const shortBlockCount = blockCount - (rawCodewordCount % blockCount);
  const shortBlockLength = Math.floor(rawCodewordCount / blockCount);
  const shortDataLength = shortBlockLength - versionInfo.eccCodewordsPerBlock;
  const dataBlocks = Array.from({ length: blockCount }, (_, blockIndex) =>
    Array(shortDataLength + (blockIndex < shortBlockCount ? 0 : 1)).fill(0),
  );
  let offset = 0;

  for (let index = 0; index <= shortDataLength; index += 1) {
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      if (index === shortDataLength && blockIndex < shortBlockCount) continue;
      if (index >= dataBlocks[blockIndex].length) continue;
      dataBlocks[blockIndex][index] = rawCodewords[offset];
      offset += 1;
    }
  }

  return dataBlocks.flat();
}

function calculateFormatBits(mask: number): number {
  const value = (1 << 3) | mask;
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

function numberBits(value: number, length: number): number[] {
  return Array.from({ length }, (_, index) => (value >>> (length - 1 - index)) & 1);
}

function bitsToNumber(bits: number[]): number {
  return bits.reduce((value, bit) => (value << 1) | bit, 0);
}
