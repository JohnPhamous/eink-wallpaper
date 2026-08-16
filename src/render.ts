import path from 'node:path';
import sharp from 'sharp';
import { atomicWrite, ensureDirectory } from './fs.js';

const WIDTH = 800;
const HEIGHT = 480;

const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [255, 255, 255],
  [0, 255, 0],
  [0, 0, 255],
  [255, 0, 0],
  [255, 255, 0],
];

function nearestColor(red: number, green: number, blue: number): readonly [number, number, number] {
  let best = PALETTE[0];
  let bestDistance = Infinity;
  for (const color of PALETTE) {
    const dr = red - color[0];
    const dg = green - color[1];
    const db = blue - color[2];
    // Match the factory browser converter's nearest-RGB palette behavior.
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      best = color;
      bestDistance = distance;
    }
  }
  return best;
}

function diffuse(
  pixels: Float32Array,
  x: number,
  y: number,
  width: number,
  height: number,
  error: readonly [number, number, number],
  weight: number,
): void {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const offset = (y * width + x) * 3;
  pixels[offset] += error[0] * weight;
  pixels[offset + 1] += error[1] * weight;
  pixels[offset + 2] += error[2] * weight;
}

export function ditherSixColor(input: Buffer, width = WIDTH, height = HEIGHT): Buffer {
  const pixels = Float32Array.from(input);
  const output = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const reverse = y % 2 === 1;
    for (let step = 0; step < width; step += 1) {
      const x = reverse ? width - 1 - step : step;
      const offset = (y * width + x) * 3;
      const old: [number, number, number] = [
        Math.max(0, Math.min(255, pixels[offset])),
        Math.max(0, Math.min(255, pixels[offset + 1])),
        Math.max(0, Math.min(255, pixels[offset + 2])),
      ];
      const chosen = nearestColor(old[0], old[1], old[2]);
      output[offset] = chosen[0];
      output[offset + 1] = chosen[1];
      output[offset + 2] = chosen[2];
      const error: [number, number, number] = [
        old[0] - chosen[0],
        old[1] - chosen[1],
        old[2] - chosen[2],
      ];
      const direction = reverse ? -1 : 1;
      diffuse(pixels, x + direction, y, width, height, error, 7 / 16);
      diffuse(pixels, x - direction, y + 1, width, height, error, 3 / 16);
      diffuse(pixels, x, y + 1, width, height, error, 5 / 16);
      diffuse(pixels, x + direction, y + 1, width, height, error, 1 / 16);
    }
  }
  return output;
}

export function encodeBmp24(rgb: Buffer, width = WIDTH, height = HEIGHT): Buffer {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const output = Buffer.alloc(54 + pixelBytes);
  output.write('BM', 0, 'ascii');
  output.writeUInt32LE(output.length, 2);
  output.writeUInt32LE(54, 10);
  output.writeUInt32LE(40, 14);
  output.writeInt32LE(width, 18);
  output.writeInt32LE(height, 22);
  output.writeUInt16LE(1, 26);
  output.writeUInt16LE(24, 28);
  output.writeUInt32LE(0, 30);
  output.writeUInt32LE(pixelBytes, 34);
  output.writeInt32LE(2835, 38);
  output.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y += 1) {
    const sourceY = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const source = (sourceY * width + x) * 3;
      const target = 54 + y * rowStride + x * 3;
      output[target] = rgb[source + 2];
      output[target + 1] = rgb[source + 1];
      output[target + 2] = rgb[source];
    }
  }
  return output;
}

export interface RenderedArtwork {
  originalFile: string;
  previewFile: string;
  bmpFile: string;
  original: Buffer;
  preview: Buffer;
  bmp: Buffer;
}

export async function renderArtwork(source: Buffer, directory: string): Promise<RenderedArtwork> {
  await ensureDirectory(directory);
  const original = await sharp(source).rotate().png({ compressionLevel: 9 }).toBuffer();
  const raw = await sharp(original)
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' })
    .modulate({ saturation: 1.12 })
    .sharpen({ sigma: 0.55 })
    .removeAlpha()
    .raw()
    .toBuffer();
  const dithered = ditherSixColor(raw);
  const preview = await sharp(dithered, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .png({ compressionLevel: 9, palette: true, colours: 6 })
    .toBuffer();
  const bmp = encodeBmp24(dithered);
  const originalFile = 'original.png';
  const previewFile = 'display-preview.png';
  const bmpFile = 'display.bmp';
  await Promise.all([
    atomicWrite(path.join(directory, originalFile), original),
    atomicWrite(path.join(directory, previewFile), preview),
    atomicWrite(path.join(directory, bmpFile), bmp),
  ]);
  return { originalFile, previewFile, bmpFile, original, preview, bmp };
}
