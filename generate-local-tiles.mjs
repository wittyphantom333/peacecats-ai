#!/usr/bin/env node
/*
 * Generates synthetic placeholder map tiles for local self-hosted use.
 *
 * The real WARDOGS map imagery is distributed only via the project's
 * private CDN and is not part of this repository. This script writes
 * clearly-synthetic PNG tile pyramids under maps/tiles/ (git-ignored)
 * so every interface works locally against placeholder basemaps.
 *
 * Usage: node generate-local-tiles.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const TILE = 256;
/* Placeholder depth is intentionally small; the dev server detects the
 * deepest zoom_N directory and serves it as tiles.maxZoom. */
const MAX_ZOOM = 4;
const MAP_IDS = ['bakurani', 'ozeti', 'zestafona'];

const STYLES = {
    grayscale: {
        suffix: '',
        inside: [233, 233, 227],
        outside: [209, 209, 205],
        border: [163, 163, 158],
        accent: [255, 170, 60]
    },
    color: {
        suffix: '-color',
        inside: [219, 207, 178],
        outside: [192, 182, 160],
        border: [151, 141, 119],
        accent: [226, 88, 58]
    }
};

/* ---- minimal PNG encoder (RGB, no dependencies) ---- */
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[n] = c;
}

function crc32(buffer) {
    let c = ~0;
    for (let i = 0; i < buffer.length; i++) {
        c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    }
    return (~c) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

function encodePNG(width, height, rgb) {
    const stride = width * 3 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3)
            .copy(raw, y * stride + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 2;  // color type: truecolor RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(raw, { level: 6 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

/* ---- placeholder tile painting ---- */
function paintTile(map, style, zoom, x, y) {
    const tb = map.tileBounds || map.bounds;
    const b = map.bounds;
    const n = 2 ** zoom;
    const wx0 = tb.minX + (tb.maxX - tb.minX) * (x / n);
    const wx1 = tb.minX + (tb.maxX - tb.minX) * ((x + 1) / n);
    const wy0 = tb.minY + (tb.maxY - tb.minY) * (y / n);
    const wy1 = tb.minY + (tb.maxY - tb.minY) * ((y + 1) / n);
    const wppX = (wx1 - wx0) / TILE;
    const wppY = (wy1 - wy0) / TILE;

    const rgb = new Uint8Array(TILE * TILE * 3);

    for (let py = 0; py < TILE; py++) {
        const wy = wy0 + wppY * (py + 0.5);
        for (let px = 0; px < TILE; px++) {
            const wx = wx0 + wppX * (px + 0.5);
            let color =
                wx >= b.minX && wx <= b.maxX && wy >= b.minY && wy <= b.maxY
                    ? style.inside
                    : style.outside;

            // Highlight the playable-coordinate boundary.
            const edgeX =
                Math.abs(wx - b.minX) < wppX * 2 ||
                Math.abs(wx - b.maxX) < wppX * 2;
            const edgeY =
                Math.abs(wy - b.minY) < wppY * 2 ||
                Math.abs(wy - b.maxY) < wppY * 2;
            if (edgeX || edgeY) {
                color = style.accent;
            }

            // Tile grid border.
            if (px === 0 || py === 0 || px === TILE - 1 || py === TILE - 1) {
                color = style.border;
            }

            const i = (py * TILE + px) * 3;
            rgb[i] = color[0];
            rgb[i + 1] = color[1];
            rgb[i + 2] = color[2];
        }
    }

    return encodePNG(TILE, TILE, rgb);
}

/* ---- main ---- */
let written = 0;

for (const id of MAP_IDS) {
    const map = JSON.parse(await readFile(join(root, 'maps', `${id}.json`), 'utf8'));
    const maxZoom = MAX_ZOOM;

    for (const style of Object.values(STYLES)) {
        const base = join(root, 'maps', 'tiles', `${id}${style.suffix}`);

        for (let zoom = 0; zoom <= maxZoom; zoom++) {
            const n = 2 ** zoom;
            await mkdir(join(base, `zoom_${zoom}`), { recursive: true });

            for (let x = 0; x < n; x++) {
                for (let y = 0; y < n; y++) {
                    await writeFile(
                        join(base, `zoom_${zoom}`, `${x}_${y}.png`),
                        paintTile(map, style, zoom, x, y)
                    );
                    written++;
                }
            }
        }
    }
}

console.log(`Generated ${written} placeholder tiles under maps/tiles/`);