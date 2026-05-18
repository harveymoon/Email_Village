// Phaser-side avatar texture pipeline. Takes an AvatarConfig
// (layer file paths), composites all the layer sheets into a single
// in-memory canvas, registers it as a Phaser texture with frames
// laid out on a 48×96 grid, and registers walk/idle/stand/sit
// animations on that texture.
//
// Cached by config hash — identical avatars across multiple NPCs
// share one texture + one animation set. Async because layer PNGs
// are loaded via Image() (Phaser's loader can't easily handle the
// dynamic per-NPC composition).
//
// Usage:
//   const key = await composeAndRegisterAvatar(scene, cfg);
//   const sprite = scene.physics.add.sprite(x, y, key, IDLE_DOWN_FRAME);
//   sprite.anims.play(`${key}-walk-down`);

import * as Phaser from 'phaser';
import type { AvatarConfig } from './avatar';

const FRAME_W = 48;
const FRAME_H = 96;
const SHEET_W = 2781;
const SHEET_H = 1968;
// Number of full columns in the sheet. Used to convert (col, row) to
// the linear frame index Phaser uses when we add frames row-major.
export const SHEET_COLS = Math.floor(SHEET_W / FRAME_W);   // 57

// Frame indices for the starting cell of each named pose. These match
// the layout the character builder confirmed:
//   R0 = stand (1 frame per dir; column order right, up, left, down)
//   R1 = idle (6 frames per dir; column order right, up, left, down)
//   R2 = walk (6 frames per dir; column order right, up, left, down)
//   R4 = sit  (6 frames; only right + left)
function frameOf(row: number, col: number): number {
  return row * SHEET_COLS + col;
}
export const AVATAR_FRAMES = {
  standDown:  frameOf(0, 3),
  standUp:    frameOf(0, 1),
  standLeft:  frameOf(0, 2),
  standRight: frameOf(0, 0),
  idleDown:   frameOf(1, 18),
  idleUp:     frameOf(1, 6),
  idleLeft:   frameOf(1, 12),
  idleRight:  frameOf(1, 0),
  walkDown:   frameOf(2, 18),
  walkUp:     frameOf(2, 6),
  walkLeft:   frameOf(2, 12),
  walkRight:  frameOf(2, 0),
} as const;

// In-memory cache of registered textures, keyed by the stable hash of
// the avatar config. Concurrent calls for the same config share one
// in-flight load.
const inFlight = new Map<string, Promise<string>>();

function avatarHash(cfg: AvatarConfig): string {
  const parts = [cfg.body, cfg.eyes || '', cfg.outfit || '', cfg.hairstyle || '', cfg.accessory || ''];
  // Simple FNV-1a hash of the joined parts — keeps texture keys short.
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Shared cache across calls so we don't reload the same body sheet 50
// times when 50 NPCs share a body variant. Promises so concurrent
// requests for the same image don't double-fetch.
const layerImageCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadLayerImage(src: string): Promise<HTMLImageElement | null> {
  if (layerImageCache.has(src)) return layerImageCache.get(src)!;
  const p = new Promise<HTMLImageElement | null>(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { console.warn(`[avatar-texture] failed to load layer: ${src}`); resolve(null); };
    img.src = src;
  });
  layerImageCache.set(src, p);
  return p;
}

export async function composeAndRegisterAvatar(scene: Phaser.Scene, cfg: AvatarConfig): Promise<string> {
  const hash = avatarHash(cfg);
  const textureKey = `avatar_${hash}`;
  // Already loaded + registered? Reuse.
  if (scene.textures.exists(textureKey)) return textureKey;
  // Already loading? Wait on the in-flight promise.
  if (inFlight.has(textureKey)) return inFlight.get(textureKey)!;
  const promise = (async () => {
    // Load every layer in parallel. Body is required; others optional.
    const layerSrcs: Array<string | null> = [
      cfg.body, cfg.eyes || null, cfg.outfit || null, cfg.hairstyle || null, cfg.accessory || null,
    ];
    const imgs = await Promise.all(layerSrcs.map(src => src ? loadLayerImage(src) : Promise.resolve(null)));
    // Body is required — without it the NPC is just floating hair +
    // clothes (invisible skin). Bail out with a loud warning so the
    // bad config can be regenerated rather than composing a skeleton.
    if (!imgs[0]) {
      inFlight.delete(textureKey);
      throw new Error(`[avatar-texture] body sheet failed to load (${cfg.body}); refusing to composite invisible-skin avatar`);
    }
    // Composite onto a single canvas matching the LimeZu sheet dims.
    const canvas = document.createElement('canvas');
    canvas.width = SHEET_W;
    canvas.height = SHEET_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.imageSmoothingEnabled = false;
    for (const img of imgs) {
      if (img) ctx.drawImage(img, 0, 0);
    }
    // Race: another call may have registered the texture between our
    // exists() check above and now. addCanvas would throw.
    if (scene.textures.exists(textureKey)) return textureKey;
    const tex = scene.textures.addCanvas(textureKey, canvas);
    if (!tex) {
      console.error(`[avatar-texture] addCanvas returned null for ${textureKey}`);
      return textureKey;
    }
    // Manually slice the canvas into 48×96 frames laid out row-major.
    // We cap at row 20 (the last partial row at y=1920-1968 is too
    // short for a 96-tall frame anyway).
    const rows = Math.floor(SHEET_H / FRAME_H);     // 20
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < SHEET_COLS; c++) {
        tex.add(r * SHEET_COLS + c, 0, c * FRAME_W, r * FRAME_H, FRAME_W, FRAME_H);
      }
    }
    registerAvatarAnimations(scene, textureKey);
    return textureKey;
  })();
  inFlight.set(textureKey, promise);
  return promise;
}

// Register the standard movement animations against `key`. Idempotent
// per (key, animName) so calling twice is harmless.
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
  // Stand — 1 frame, just sets the right pose.
  mk('stand-right', 0, 0,  1, 1, 0);
  mk('stand-up',    0, 1,  1, 1, 0);
  mk('stand-left',  0, 2,  1, 1, 0);
  mk('stand-down',  0, 3,  1, 1, 0);
  // Idle — gentle bob, 6 frames per direction.
  mk('idle-right',  1, 0,  6, 6);
  mk('idle-up',     1, 6,  6, 6);
  mk('idle-left',   1, 12, 6, 6);
  mk('idle-down',   1, 18, 6, 6);
  // Walk — 6 frames per direction at a faster rate.
  mk('walk-right',  2, 0,  6, 10);
  mk('walk-up',     2, 6,  6, 10);
  mk('walk-left',   2, 12, 6, 10);
  mk('walk-down',   2, 18, 6, 10);
  // Sit — right + left only (R4 has no up/down).
  mk('sit-right',   4, 0,  6, 4);
  mk('sit-left',    4, 6,  6, 4);
}
