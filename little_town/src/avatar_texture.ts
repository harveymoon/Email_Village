// Phaser-side avatar texture pipeline. Takes an AvatarConfig
// (layer file paths), composites all the layer sheets into a single
// in-memory canvas, registers it as a Phaser texture with frames laid
// out on a tight 48×96 grid, and registers walk/idle/stand/sit
// animations on that texture.
//
// Memory budget is the single thing this file is designed around.
// Source LimeZu sheets are 2781×1968 (~22MB decoded each). With ~175
// distinct layer files used across N senders, naive loading easily
// eats >4GB of tab heap and Chrome kills the page.
//
// Two key compressions:
//   (1) On layer-image LOAD, immediately repack the source PNG into a
//       small 1152×384 canvas containing ONLY the frames we use:
//         row 0  ←  source row 0  (stand)
//         row 1  ←  source row 1  (idle)
//         row 2  ←  source row 2  (walk)
//         row 3  ←  source row 4  (sit)  ←  source row 3 (sleep) skipped
//       After the drawImage copy the original Image goes out of scope
//       and the browser can GC its decoded buffer.
//   (2) The composite is also 1152×384. Same source/dest geometry, so
//       the layer canvases drawImage straight onto the composite.
//
// Per-layer memory: 1152×384×4 = 1.77MB (was ~22MB).
// Per-avatar composite: 1.77MB (was ~22MB).
// With 175 layer files + 100 unique avatars: ~487MB total instead of
// ~4-6GB. Tab survives.
//
// Cached by config hash — identical avatars across multiple NPCs share
// one texture + one animation set.
//
// Usage:
//   const key = await composeAndRegisterAvatar(scene, cfg);
//   const sprite = scene.physics.add.sprite(x, y, key, AVATAR_FRAMES.idleDown);
//   sprite.anims.play(`${key}-walk-down`);

import * as Phaser from 'phaser';
import type { AvatarConfig } from './avatar';

const FRAME_W = 48;
const FRAME_H = 96;
// LimeZu source dimensions — used only for the load-time crop.
const SOURCE_SHEET_W = 2781;
// Source row index for each pose. R3 (sleep) is intentionally skipped.
const SOURCE_ROWS_USED = [0, 1, 2, 4] as const;
// Tight atlas: we only keep the COLUMNS each pose actually uses.
// Idle and walk use 0-23 (6 frames × 4 directions), sit uses 0-11
// (6 frames × 2 directions), stand uses 0-3. Max = 24.
const PACKED_COLS = 24;
const PACKED_ROWS = SOURCE_ROWS_USED.length;     // 4
const PACKED_W = PACKED_COLS * FRAME_W;          // 1152
const PACKED_H = PACKED_ROWS * FRAME_H;          // 384

// Number of columns in the packed atlas — used to convert (row, col)
// into the linear frame index Phaser uses.
export const SHEET_COLS = PACKED_COLS;

// Frame indices for the starting cell of each named pose, computed for
// the PACKED atlas (not the source sheet). Row mapping:
//   packed row 0 = stand
//   packed row 1 = idle
//   packed row 2 = walk
//   packed row 3 = sit
function frameOf(packedRow: number, col: number): number {
  return packedRow * PACKED_COLS + col;
}
export const AVATAR_FRAMES = {
  standRight: frameOf(0, 0),
  standUp:    frameOf(0, 1),
  standLeft:  frameOf(0, 2),
  standDown:  frameOf(0, 3),
  idleRight:  frameOf(1, 0),
  idleUp:     frameOf(1, 6),
  idleLeft:   frameOf(1, 12),
  idleDown:   frameOf(1, 18),
  walkRight:  frameOf(2, 0),
  walkUp:     frameOf(2, 6),
  walkLeft:   frameOf(2, 12),
  walkDown:   frameOf(2, 18),
  sitRight:   frameOf(3, 0),
  sitLeft:    frameOf(3, 6),
} as const;

// In-memory cache of registered textures, keyed by the stable hash of
// the avatar config. Concurrent calls for the same config share one
// in-flight load.
const inFlight = new Map<string, Promise<string>>();

function avatarHash(cfg: AvatarConfig): string {
  const parts = [cfg.body, cfg.eyes || '', cfg.outfit || '', cfg.hairstyle || '', cfg.accessory || ''];
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Shared cache across calls so we don't reload + repack the same sheet
// 50 times when 50 NPCs share a body variant. Returns a 1152×384
// canvas already packed with the used rows. The original full-size
// Image is dropped immediately after the copy so its decoded pixel
// buffer can be GC'd (the biggest single memory win).
const layerImageCache = new Map<string, Promise<HTMLCanvasElement | null>>();
function loadLayerImage(src: string): Promise<HTMLCanvasElement | null> {
  if (layerImageCache.has(src)) return layerImageCache.get(src)!;
  const p = new Promise<HTMLCanvasElement | null>(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const packed = document.createElement('canvas');
        packed.width = PACKED_W;
        packed.height = PACKED_H;
        const cx = packed.getContext('2d');
        if (!cx) { resolve(null); return; }
        cx.imageSmoothingEnabled = false;
        // Copy each used source row into its packed slot. We crop to
        // the used columns (0 .. PACKED_W) at the same time, throwing
        // away the empty/unused right side of the source sheet.
        for (let i = 0; i < SOURCE_ROWS_USED.length; i++) {
          const srcRow = SOURCE_ROWS_USED[i];
          cx.drawImage(
            img,
            0, srcRow * FRAME_H, PACKED_W, FRAME_H,        // src x,y,w,h
            0, i * FRAME_H, PACKED_W, FRAME_H,             // dst x,y,w,h
          );
        }
        // `img` goes out of scope here — its decoded pixel buffer is
        // eligible for GC, which is the entire point.
        resolve(packed);
      } catch (err) {
        console.warn(`[avatar-texture] failed to repack ${src}:`, err);
        resolve(null);
      }
    };
    img.onerror = () => { console.warn(`[avatar-texture] failed to load layer: ${src}`); resolve(null); };
    img.src = src;
  });
  layerImageCache.set(src, p);
  return p;
}

export async function composeAndRegisterAvatar(scene: Phaser.Scene, cfg: AvatarConfig): Promise<string> {
  const hash = avatarHash(cfg);
  const textureKey = `avatar_${hash}`;
  if (scene.textures.exists(textureKey)) return textureKey;
  if (inFlight.has(textureKey)) return inFlight.get(textureKey)!;
  const promise = (async () => {
    const layerSrcs: Array<string | null> = [
      cfg.body, cfg.eyes || null, cfg.outfit || null, cfg.hairstyle || null, cfg.accessory || null,
    ];
    const layers = await Promise.all(layerSrcs.map(src => src ? loadLayerImage(src) : Promise.resolve(null)));
    // Body is required — without it the NPC would be just floating
    // hair + clothes. Bail loudly so the bad config gets regenerated
    // rather than rendering a skeleton.
    if (!layers[0]) {
      inFlight.delete(textureKey);
      throw new Error(`[avatar-texture] body sheet failed to load (${cfg.body}); refusing to composite invisible-skin avatar`);
    }
    // Composite onto a 1152×384 canvas — same dims as the packed
    // layer canvases so drawImage is a straight 1:1 copy.
    const composite = document.createElement('canvas');
    composite.width = PACKED_W;
    composite.height = PACKED_H;
    const ctx = composite.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.imageSmoothingEnabled = false;
    for (const layer of layers) {
      if (layer) ctx.drawImage(layer, 0, 0);
    }
    if (scene.textures.exists(textureKey)) return textureKey;
    const tex = scene.textures.addCanvas(textureKey, composite);
    if (!tex) {
      console.error(`[avatar-texture] addCanvas returned null for ${textureKey}`);
      return textureKey;
    }
    // Register every frame in the packed atlas.
    for (let r = 0; r < PACKED_ROWS; r++) {
      for (let c = 0; c < PACKED_COLS; c++) {
        tex.add(r * PACKED_COLS + c, 0, c * FRAME_W, r * FRAME_H, FRAME_W, FRAME_H);
      }
    }
    registerAvatarAnimations(scene, textureKey);
    return textureKey;
  })();
  inFlight.set(textureKey, promise);
  return promise;
}

// Register the standard movement animations against `key`. Idempotent
// per (key, animName). Uses the packed-atlas row mapping:
//   row 0 = stand · row 1 = idle · row 2 = walk · row 3 = sit
export function registerAvatarAnimations(scene: Phaser.Scene, key: string): void {
  const mk = (animName: string, row: number, dirCol: number, frames: number, fps: number, repeat = -1) => {
    const animKey = `${key}-${animName}`;
    if (scene.anims.exists(animKey)) return;
    const start = frameOf(row, dirCol);
    const end = start + frames - 1;
    scene.anims.create({
      key: animKey,
      frames: scene.anims.generateFrameNumbers(key, { start, end }),
      frameRate: fps,
      repeat,
    });
  };
  // Stand — single-frame pose, row 0.
  mk('stand-right', 0, 0,  1, 1, 0);
  mk('stand-up',    0, 1,  1, 1, 0);
  mk('stand-left',  0, 2,  1, 1, 0);
  mk('stand-down',  0, 3,  1, 1, 0);
  // Idle — gentle bob, 6 frames per direction, row 1.
  mk('idle-right',  1, 0,  6, 6);
  mk('idle-up',     1, 6,  6, 6);
  mk('idle-left',   1, 12, 6, 6);
  mk('idle-down',   1, 18, 6, 6);
  // Walk — 6 frames per direction at a faster rate, row 2.
  mk('walk-right',  2, 0,  6, 10);
  mk('walk-up',     2, 6,  6, 10);
  mk('walk-left',   2, 12, 6, 10);
  mk('walk-down',   2, 18, 6, 10);
  // Sit — right + left only, row 3 (was source row 4).
  mk('sit-right',   3, 0,  6, 4);
  mk('sit-left',    3, 6,  6, 4);
}
