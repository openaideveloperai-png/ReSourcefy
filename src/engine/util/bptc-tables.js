// Generated from AssetStudio Texture2DDecoderNative/bcn.cpp (MIT, derived from bimg by Branimir Karadzic).
export const BPTC_P2 = new Uint16Array([0xcccc,0x8888,0xeeee,0xecc8,0xc880,0xfeec,0xfec8,0xec80,0xc800,0xffec,0xfe80,0xe800,0xffe8,0xff00,0xfff0,0xf000,0xf710,0x8e,0x7100,0x8ce,0x8c,0x7310,0x3100,0x8cce,0x88c,0x3110,0x6666,0x366c,0x17e8,0xff0,0x718e,0x399c,0xaaaa,0xf0f0,0x5a5a,0x33cc,0x3c3c,0x55aa,0x9696,0xa55a,0x73ce,0x13c8,0x324c,0x3bdc,0x6996,0xc33c,0x9966,0x660,0x272,0x4e4,0x4e40,0x2720,0xc936,0x936c,0x39c6,0x639c,0x9336,0x9cc6,0x817e,0xe718,0xccf0,0xfcc,0x7744,0xee22]);
export const BPTC_A2 = new Uint8Array([15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,2,8,2,2,8,8,15,2,8,2,2,8,8,2,2,15,15,6,8,2,8,15,15,2,8,2,2,2,15,15,6,6,2,6,8,15,15,2,2,15,15,15,15,15,2,2,15]);
export const BPTC_FACTORS = [new Uint8Array([0,21,43,64,0,0,0,0,0,0,0,0,0,0,0,0]),new Uint8Array([0,9,18,27,37,46,55,64,0,0,0,0,0,0,0,0]),new Uint8Array([0,4,9,13,17,21,26,30,34,38,43,47,51,55,60,64])];
export const BPTC_P3 = new Uint32Array([0xaa685050,0x6a5a5040,0x5a5a4200,0x5450a0a8,0xa5a50000,0xa0a05050,0x5555a0a0,0x5a5a5050,0xaa550000,0xaa555500,0xaaaa5500,0x90909090,0x94949494,0xa4a4a4a4,0xa9a59450,0x2a0a4250,0xa5945040,0xa425054,0xa5a5a500,0x55a0a0a0,0xa8a85454,0x6a6a4040,0xa4a45000,0x1a1a0500,0x50a4a4,0xaaa59090,0x14696914,0x69691400,0xa08585a0,0xaa821414,0x50a4a450,0x6a5a0200,0xa9a58000,0x5090a0a8,0xa8a09050,0x24242424,0xaa5500,0x24924924,0x24499224,0x50a50a50,0x500aa550,0xaaaa4444,0x66660000,0xa5a0a5a0,0x50a050a0,0x69286928,0x44aaaa44,0x66666600,0xaa444444,0x54a854a8,0x95809580,0x96969600,0xa85454a8,0x80959580,0xaa141414,0x96960000,0xaaaa1414,0xa05050a0,0xa0a5a5a0,0x96000000,0x40804080,0xa9a8a9a8,0xaaaaaa44,0x2a4a5254]);
export const BPTC_A3 = [new Uint8Array([3,3,15,15,8,3,15,15,8,8,6,6,6,5,3,3,3,3,8,15,3,3,6,10,5,8,8,6,8,5,15,15,8,15,3,5,6,10,8,15,15,3,15,5,15,15,15,15,3,15,5,5,5,8,5,10,5,10,8,13,15,12,3,3]), new Uint8Array([15,8,8,3,15,15,3,8,15,15,15,15,15,15,15,8,15,8,15,3,15,8,15,8,3,15,6,10,15,15,10,8,15,3,15,10,10,8,9,10,6,15,8,15,3,6,6,8,15,3,15,15,15,15,15,15,15,15,15,15,3,15,15,8])];
export const BC6_MODES = [[1,5,10,[5,5,5]],[1,5,7,[6,6,6]],[1,5,11,[5,4,4]],[0,0,10,[10,10,10]],[0,0,0,[0,0,0]],[0,0,0,[0,0,0]],[1,5,11,[4,5,4]],[1,0,11,[9,9,9]],[0,0,0,[0,0,0]],[0,0,0,[0,0,0]],[1,5,11,[4,4,5]],[1,0,12,[8,8,8]],[0,0,0,[0,0,0]],[0,0,0,[0,0,0]],[1,5,9,[5,5,5]],[1,0,16,[4,4,4]],[0,0,0,[0,0,0]],[0,0,0,[0,0,0]],[1,5,8,[6,5,5]],[0,0,0,[0,0,0]],[0,0,0,[0,0,0]],[0,0,0,[0,0,0]],[1,5,8,[5,6,5]],[0,0,0,[0,0,0]],[0,0,0,[0,0,0]],[0,0,0,[0,0,0]],[1,5,8,[5,5,6]],[0,0,0,[0,0,0]],[0,0,0,[0,0,0]],[0,0,0,[0,0,0]],[0,5,6,[6,6,6]],[0,0,0,[0,0,0]]];
// Endpoint bit layout per BC6H mode (reads into epR/epG/epB arrays).
export function bc6ReadEndpoints(bit, mode, epR, epG, epB) {
if (mode & 2)
  {
    // 5-bit mode
    mode |= bit.read(3) << 2;

    if (0 == BC6_MODES[mode][2]) return -1;

    switch (mode)
    {
    case 2:
      epR[0] |= bit.read(10) << 0;
      epG[0] |= bit.read(10) << 0;
      epB[0] |= bit.read(10) << 0;
      epR[1] |= bit.read(5) << 0;
      epR[0] |= bit.read(1) << 10;
      epG[2] |= bit.read(4) << 0;
      epG[1] |= bit.read(4) << 0;
      epG[0] |= bit.read(1) << 10;
      epB[3] |= bit.read(1) << 0;
      epG[3] |= bit.read(4) << 0;
      epB[1] |= bit.read(4) << 0;
      epB[0] |= bit.read(1) << 10;
      epB[3] |= bit.read(1) << 1;
      epB[2] |= bit.read(4) << 0;
      epR[2] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 2;
      epR[3] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 3;
      break;

    case 3:
      epR[0] |= bit.read(10) << 0;
      epG[0] |= bit.read(10) << 0;
      epB[0] |= bit.read(10) << 0;
      epR[1] |= bit.read(10) << 0;
      epG[1] |= bit.read(10) << 0;
      epB[1] |= bit.read(10) << 0;
      break;

    case 6:
      epR[0] |= bit.read(10) << 0;
      epG[0] |= bit.read(10) << 0;
      epB[0] |= bit.read(10) << 0;
      epR[1] |= bit.read(4) << 0;
      epR[0] |= bit.read(1) << 10;
      epG[3] |= bit.read(1) << 4;
      epG[2] |= bit.read(4) << 0;
      epG[1] |= bit.read(5) << 0;
      epG[0] |= bit.read(1) << 10;
      epG[3] |= bit.read(4) << 0;
      epB[1] |= bit.read(4) << 0;
      epB[0] |= bit.read(1) << 10;
      epB[3] |= bit.read(1) << 1;
      epB[2] |= bit.read(4) << 0;
      epR[2] |= bit.read(4) << 0;
      epB[3] |= bit.read(1) << 0;
      epB[3] |= bit.read(1) << 2;
      epR[3] |= bit.read(4) << 0;
      epG[2] |= bit.read(1) << 4;
      epB[3] |= bit.read(1) << 3;
      break;

    case 7:
      epR[0] |= bit.read(10) << 0;
      epG[0] |= bit.read(10) << 0;
      epB[0] |= bit.read(10) << 0;
      epR[1] |= bit.read(9) << 0;
      epR[0] |= bit.read(1) << 10;
      epG[1] |= bit.read(9) << 0;
      epG[0] |= bit.read(1) << 10;
      epB[1] |= bit.read(9) << 0;
      epB[0] |= bit.read(1) << 10;
      break;

    case 10:
      epR[0] |= bit.read(10) << 0;
      epG[0] |= bit.read(10) << 0;
      epB[0] |= bit.read(10) << 0;
      epR[1] |= bit.read(4) << 0;
      epR[0] |= bit.read(1) << 10;
      epB[2] |= bit.read(1) << 4;
      epG[2] |= bit.read(4) << 0;
      epG[1] |= bit.read(4) << 0;
      epG[0] |= bit.read(1) << 10;
      epB[3] |= bit.read(1) << 0;
      epG[3] |= bit.read(4) << 0;
      epB[1] |= bit.read(5) << 0;
      epB[0] |= bit.read(1) << 10;
      epB[2] |= bit.read(4) << 0;
      epR[2] |= bit.read(4) << 0;
      epB[3] |= bit.read(1) << 1;
      epB[3] |= bit.read(1) << 2;
      epR[3] |= bit.read(4) << 0;
      epB[3] |= bit.read(1) << 4;
      epB[3] |= bit.read(1) << 3;
      break;

    case 11:
      epR[0] |= bit.read(10) << 0;
      epG[0] |= bit.read(10) << 0;
      epB[0] |= bit.read(10) << 0;
      epR[1] |= bit.read(8) << 0;
      epR[0] |= bit.read(1) << 11;
      epR[0] |= bit.read(1) << 10;
      epG[1] |= bit.read(8) << 0;
      epG[0] |= bit.read(1) << 11;
      epG[0] |= bit.read(1) << 10;
      epB[1] |= bit.read(8) << 0;
      epB[0] |= bit.read(1) << 11;
      epB[0] |= bit.read(1) << 10;
      break;

    case 14:
      epR[0] |= bit.read(9) << 0;
      epB[2] |= bit.read(1) << 4;
      epG[0] |= bit.read(9) << 0;
      epG[2] |= bit.read(1) << 4;
      epB[0] |= bit.read(9) << 0;
      epB[3] |= bit.read(1) << 4;
      epR[1] |= bit.read(5) << 0;
      epG[3] |= bit.read(1) << 4;
      epG[2] |= bit.read(4) << 0;
      epG[1] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 0;
      epG[3] |= bit.read(4) << 0;
      epB[1] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 1;
      epB[2] |= bit.read(4) << 0;
      epR[2] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 2;
      epR[3] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 3;
      break;

    case 15:
      epR[0] |= bit.read(10) << 0;
      epG[0] |= bit.read(10) << 0;
      epB[0] |= bit.read(10) << 0;
      epR[1] |= bit.read(4) << 0;
      epR[0] |= bit.read(1) << 15;
      epR[0] |= bit.read(1) << 14;
      epR[0] |= bit.read(1) << 13;
      epR[0] |= bit.read(1) << 12;
      epR[0] |= bit.read(1) << 11;
      epR[0] |= bit.read(1) << 10;
      epG[1] |= bit.read(4) << 0;
      epG[0] |= bit.read(1) << 15;
      epG[0] |= bit.read(1) << 14;
      epG[0] |= bit.read(1) << 13;
      epG[0] |= bit.read(1) << 12;
      epG[0] |= bit.read(1) << 11;
      epG[0] |= bit.read(1) << 10;
      epB[1] |= bit.read(4) << 0;
      epB[0] |= bit.read(1) << 15;
      epB[0] |= bit.read(1) << 14;
      epB[0] |= bit.read(1) << 13;
      epB[0] |= bit.read(1) << 12;
      epB[0] |= bit.read(1) << 11;
      epB[0] |= bit.read(1) << 10;
      break;

    case 18:
      epR[0] |= bit.read(8) << 0;
      epG[3] |= bit.read(1) << 4;
      epB[2] |= bit.read(1) << 4;
      epG[0] |= bit.read(8) << 0;
      epB[3] |= bit.read(1) << 2;
      epG[2] |= bit.read(1) << 4;
      epB[0] |= bit.read(8) << 0;
      epB[3] |= bit.read(1) << 3;
      epB[3] |= bit.read(1) << 4;
      epR[1] |= bit.read(6) << 0;
      epG[2] |= bit.read(4) << 0;
      epG[1] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 0;
      epG[3] |= bit.read(4) << 0;
      epB[1] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 1;
      epB[2] |= bit.read(4) << 0;
      epR[2] |= bit.read(6) << 0;
      epR[3] |= bit.read(6) << 0;
      break;

    case 22:
      epR[0] |= bit.read(8) << 0;
      epB[3] |= bit.read(1) << 0;
      epB[2] |= bit.read(1) << 4;
      epG[0] |= bit.read(8) << 0;
      epG[2] |= bit.read(1) << 5;
      epG[2] |= bit.read(1) << 4;
      epB[0] |= bit.read(8) << 0;
      epG[3] |= bit.read(1) << 5;
      epB[3] |= bit.read(1) << 4;
      epR[1] |= bit.read(5) << 0;
      epG[3] |= bit.read(1) << 4;
      epG[2] |= bit.read(4) << 0;
      epG[1] |= bit.read(6) << 0;
      epG[3] |= bit.read(4) << 0;
      epB[1] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 1;
      epB[2] |= bit.read(4) << 0;
      epR[2] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 2;
      epR[3] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 3;
      break;

    case 26:
      epR[0] |= bit.read(8) << 0;
      epB[3] |= bit.read(1) << 1;
      epB[2] |= bit.read(1) << 4;
      epG[0] |= bit.read(8) << 0;
      epB[2] |= bit.read(1) << 5;
      epG[2] |= bit.read(1) << 4;
      epB[0] |= bit.read(8) << 0;
      epB[3] |= bit.read(1) << 5;
      epB[3] |= bit.read(1) << 4;
      epR[1] |= bit.read(5) << 0;
      epG[3] |= bit.read(1) << 4;
      epG[2] |= bit.read(4) << 0;
      epG[1] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 0;
      epG[3] |= bit.read(4) << 0;
      epB[1] |= bit.read(6) << 0;
      epB[2] |= bit.read(4) << 0;
      epR[2] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 2;
      epR[3] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 3;
      break;

    case 30:
      epR[0] |= bit.read(6) << 0;
      epG[3] |= bit.read(1) << 4;
      epB[3] |= bit.read(1) << 0;
      epB[3] |= bit.read(1) << 1;
      epB[2] |= bit.read(1) << 4;
      epG[0] |= bit.read(6) << 0;
      epG[2] |= bit.read(1) << 5;
      epB[2] |= bit.read(1) << 5;
      epB[3] |= bit.read(1) << 2;
      epG[2] |= bit.read(1) << 4;
      epB[0] |= bit.read(6) << 0;
      epG[3] |= bit.read(1) << 5;
      epB[3] |= bit.read(1) << 3;
      epB[3] |= bit.read(1) << 5;
      epB[3] |= bit.read(1) << 4;
      epR[1] |= bit.read(6) << 0;
      epG[2] |= bit.read(4) << 0;
      epG[1] |= bit.read(6) << 0;
      epG[3] |= bit.read(4) << 0;
      epB[1] |= bit.read(6) << 0;
      epB[2] |= bit.read(4) << 0;
      epR[2] |= bit.read(6) << 0;
      epR[3] |= bit.read(6) << 0;
      break;

    default:
      break;
    }
  }
  else
  {
    switch (mode)
    {
    case 0:
      epG[2] |= bit.read(1) << 4;
      epB[2] |= bit.read(1) << 4;
      epB[3] |= bit.read(1) << 4;
      epR[0] |= bit.read(10) << 0;
      epG[0] |= bit.read(10) << 0;
      epB[0] |= bit.read(10) << 0;
      epR[1] |= bit.read(5) << 0;
      epG[3] |= bit.read(1) << 4;
      epG[2] |= bit.read(4) << 0;
      epG[1] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 0;
      epG[3] |= bit.read(4) << 0;
      epB[1] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 1;
      epB[2] |= bit.read(4) << 0;
      epR[2] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 2;
      epR[3] |= bit.read(5) << 0;
      epB[3] |= bit.read(1) << 3;
      break;

    case 1:
      epG[2] |= bit.read(1) << 5;
      epG[3] |= bit.read(1) << 4;
      epG[3] |= bit.read(1) << 5;
      epR[0] |= bit.read(7) << 0;
      epB[3] |= bit.read(1) << 0;
      epB[3] |= bit.read(1) << 1;
      epB[2] |= bit.read(1) << 4;
      epG[0] |= bit.read(7) << 0;
      epB[2] |= bit.read(1) << 5;
      epB[3] |= bit.read(1) << 2;
      epG[2] |= bit.read(1) << 4;
      epB[0] |= bit.read(7) << 0;
      epB[3] |= bit.read(1) << 3;
      epB[3] |= bit.read(1) << 5;
      epB[3] |= bit.read(1) << 4;
      epR[1] |= bit.read(6) << 0;
      epG[2] |= bit.read(4) << 0;
      epG[1] |= bit.read(6) << 0;
      epG[3] |= bit.read(4) << 0;
      epB[1] |= bit.read(6) << 0;
      epB[2] |= bit.read(4) << 0;
      epR[2] |= bit.read(6) << 0;
      epR[3] |= bit.read(6) << 0;
      break;

    default:
      break;
    }
  }

  
  return mode;
}
