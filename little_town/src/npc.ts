// NPC: a sprite that mostly stands around. Two modes:
//
//   Wander mode (default): idles for a few seconds, then takes a short
//     walk (1-3 tiles) to a nearby spot within the building's bounds,
//     then idles again. Designed to look like a person hanging out, not
//     a person on a brisk circuit.
//
//   Travel mode: `setTarget(door, onArrive)` aims at a specific door
//     and stops on arrival, firing the callback. Used by the sort
//     flow to walk an email-NPC from one building to another (and
//     despawn on arrival).
//
// NPCs also carry optional `data` (e.g. `{ threadId, subject, from }`)
// so clicks in the world can look up the email behind a sprite.
//
// Animations are registered globally per character key in main.ts.

import * as Phaser from 'phaser';
import { CostGrid } from './pathfind';

export interface Door { x: number; y: number; tx: number; ty: number; }
export interface Rect { x: number; y: number; w: number; h: number; }

const TILE = 48;
const SPEED = 80;       // pixels/sec
const ARRIVE_PX = 4;    // distance at which we consider a waypoint reached

// LimeZu Modern Interiors 48×96 character layout (see avatar_texture.ts).
// AVATAR_FRAMES.idleDown lands on the first frame of the down-facing
// idle animation — used as the default sprite frame at spawn.
export { AVATAR_FRAMES } from './avatar_texture';
import { AVATAR_FRAMES } from './avatar_texture';

export interface NPCOptions {
  data?: Record<string, unknown>;
  homeDoor?: Door | null;
  // World-pixel rect of the building this NPC belongs to. When set,
  // wander goals stay within the rect + a small padding (the walkable
  // ring around the building's solid interior). Preferred over
  // homeRadius when both are provided.
  homeBounds?: Rect | null;
  homeRadius?: number;        // tile radius around homeDoor (used if no bounds)
  // Idle cadence — how long the NPC stands still between micro-walks.
  // Default: random 20–60s. Quarter the rate of the original 5–15s so
  // waiting NPCs pace ~once per minute instead of constantly.
  idleMinMs?: number;
  idleMaxMs?: number;
  // Max manhattan tile distance for any single wander step. Keeps
  // movement to a few steps at a time, not full sprints.
  maxWanderTiles?: number;
}

export class NPC {
  scene: Phaser.Scene;
  sprite: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
  grid: CostGrid;
  doors: Door[];
  charKey: string;
  data: Record<string, unknown> | undefined;
  homeDoor: Door | null;
  homeBounds: Rect | null;
  homeRadius: number;
  idleMinMs: number;
  idleMaxMs: number;
  maxWanderTiles: number;
  // Travel-mode target. Wander mode leaves this null.
  targetDoor: Door | null = null;
  onArrive: (() => void) | null = null;
  // Human-readable label for the CURRENT destination ("UGG 2026 nyc",
  // "home", etc.). Surfaced in the NPC popup so users can see where the
  // NPC is heading without inspecting internals. Cleared on arrival.
  currentDestinationLabel: string | null = null;
  // Queue of pending walk destinations. Used by the multi-thread move
  // flow: when a person-NPC carries 3 emails and you move each to a
  // different building, the NPC visits each destination in sequence.
  walkQueue: Array<{ door: Door; onArrive?: () => void; label?: string }> = [];
  path: { x: number; y: number }[] = [];
  pathIdx = 0;
  pickFails = 0;
  // performance.now() timestamp until which we should stand still.
  private idleUntilMs = 0;
  // Stall detection (only relevant while actively walking a path).
  private lastX = 0;
  private lastY = 0;
  private stallMs = 0;
  private static STALL_THRESHOLD_MS = 1500;
  private static STALL_MIN_PROGRESS_PX = 4;

  // Sidestep state — when an NPC bumps another while walking, it shifts
  // a few pixels to its RIGHT (perpendicular to its current heading) for
  // a brief window before resuming. Two NPCs walking toward each other
  // both stepping right naturally pass each other on the right, like
  // pedestrians on a path. Pure idlers don't sidestep — the moving one
  // is the one expected to give way.
  private sidestepUntilMs = 0;
  private sidestepVx = 0;
  private sidestepVy = 0;
  private lastBumpMs = 0;
  private static SIDESTEP_DURATION_MS = 280;
  private static BUMP_DEBOUNCE_MS = 120;
  // Per-target pixel offset for the FINAL waypoint. Two NPCs walking
  // to the same door tile would otherwise aim at the same pixel and
  // bump endlessly against each other at the destination; jittering
  // by ±12 px gives them distinct spots inside the tile to settle at.
  private targetOffsetX = 0;
  private targetOffsetY = 0;
  private static TARGET_JITTER_PX = 12;
  private regenerateTargetJitter(): void {
    this.targetOffsetX = (Math.random() - 0.5) * 2 * NPC.TARGET_JITTER_PX;
    this.targetOffsetY = (Math.random() - 0.5) * 2 * NPC.TARGET_JITTER_PX;
  }

  constructor(scene: Phaser.Scene, grid: CostGrid, doors: Door[], spawn: { x: number; y: number }, charKey: string, opts: NPCOptions = {}) {
    this.scene = scene;
    this.grid = grid;
    this.doors = doors;
    this.charKey = charKey;
    this.data = opts.data;
    this.homeDoor = opts.homeDoor ?? null;
    this.homeBounds = opts.homeBounds ?? null;
    this.homeRadius = opts.homeRadius ?? 4;
    this.idleMinMs = opts.idleMinMs ?? 20000;
    this.idleMaxMs = opts.idleMaxMs ?? 60000;
    this.maxWanderTiles = opts.maxWanderTiles ?? 3;
    // 48×96 LimeZu sprite — scale 1 puts feet aligned with a single
    // tile. Body collision box hugs the FEET (small rectangle near the
    // bottom of the sprite) so the NPC's head can overlap building
    // walls above without colliding, while their feet block them at
    // walls below. setSize/setOffset are in TEXTURE pixels, not display.
    this.sprite = scene.physics.add.sprite(spawn.x, spawn.y, charKey, AVATAR_FRAMES.idleDown)
      .setScale(1)
      .setSize(14, 12).setOffset(17, 50)
      // Depth 20 puts the NPC ABOVE the Buildings tile layer (15) so
      // heads aren't clipped when they stand at a building's door.
      .setDepth(20);
    // Push back a bit on collisions instead of sliding through.
    this.sprite.body.setBounce(0, 0);
    this.sprite.body.setDamping(true);
    this.sprite.body.setDrag(0.92, 0.92);
    (this.sprite as any).npc = this;
    this.lastX = this.sprite.x;
    this.lastY = this.sprite.y;
    // Start in idle so freshly-spawned NPCs don't immediately walk.
    this.idleUntilMs = performance.now() + this.randomIdleMs();
    // If the spawn position drifted (random scatter) more than a tile
    // away from the door, send the NPC to the door first so wander
    // happens from "the front of the building" outward.
    if (this.homeDoor) {
      const sx = (this.sprite.x / TILE) | 0, sy = (this.sprite.y / TILE) | 0;
      const md = Math.abs(sx - this.homeDoor.tx) + Math.abs(sy - this.homeDoor.ty);
      if (md > 0) {
        // Short delay so spawn isn't an immediate sprint — gives the
        // scene a beat to settle and the user sees them arrive.
        setTimeout(() => {
          if (this.sprite.active) this.queueWalk(this.homeDoor!);
        }, 200 + Math.random() * 600);
      }
    }
  }

  // Set an explicit walk-to target. NPC stops on arrival, no auto-repick.
  // Clears any pending walk queue — use queueWalk() for sequential trips.
  setTarget(door: Door, onArrive?: () => void, label?: string): void {
    this.walkQueue = [];
    this.targetDoor = door;
    this.onArrive = onArrive || null;
    this.currentDestinationLabel = label ?? null;
    this.path = []; this.pathIdx = 0; this.stallMs = 0;
    this.idleUntilMs = 0;
    this.regenerateTargetJitter();
    this.computePathToTarget();
  }

  // Push a destination onto the walk queue. If the NPC is currently
  // idle/wandering, immediately starts walking; otherwise the queued
  // walk happens after the current target (and any earlier queue items)
  // complete. Each walk's onArrive fires before the next one starts.
  // `label` is shown in the NPC popup as "Going to: <label>".
  queueWalk(door: Door, onArrive?: () => void, label?: string): void {
    this.walkQueue.push({ door, onArrive, label });
    if (!this.targetDoor && !this.path.length) {
      this.advanceQueue();
    }
  }

  // Pop the next queued walk and start it. Called automatically on
  // arrival via the onArrive chain set up in setTarget below.
  private advanceQueue(): void {
    if (this.walkQueue.length === 0) return;
    const next = this.walkQueue.shift()!;
    this.targetDoor = next.door;
    this.currentDestinationLabel = next.label ?? null;
    this.onArrive = () => {
      if (next.onArrive) next.onArrive();
      this.advanceQueue();
    };
    this.path = []; this.pathIdx = 0; this.stallMs = 0;
    this.idleUntilMs = 0;
    this.regenerateTargetJitter();
    this.computePathToTarget();
  }

  private randomIdleMs(): number {
    return this.idleMinMs + Math.random() * (this.idleMaxMs - this.idleMinMs);
  }

  private computePathToTarget(): void {
    if (!this.targetDoor) return;
    let sx = (this.sprite.x / TILE) | 0, sy = (this.sprite.y / TILE) | 0;
    // The NPC's current cell can be BLOCKED — they spawn with a small
    // random pixel offset around the door which sometimes lands inside
    // the adjacent solid building tile. CostGrid.findPath rejects any
    // path where start is blocked. Snap to the homeDoor (always
    // walkable since it came from the doors layer) or to a walkable
    // 8-neighbour, so the NPC actually starts moving.
    if (this.grid.cells[sy * this.grid.cols + sx]) {
      const snap = this.findWalkableSnap(sx, sy);
      if (snap) { sx = snap.x; sy = snap.y; }
    }
    if (sx === this.targetDoor.tx && sy === this.targetDoor.ty) {
      this.fireArrived();
      return;
    }
    const path = this.grid.findPath(sx, sy, this.targetDoor.tx, this.targetDoor.ty);
    if (path && path.length > 1) {
      this.path = path; this.pathIdx = 1;
    } else {
      console.warn('[npc] travel target unreachable', {
        from: { sx, sy },
        to: { tx: this.targetDoor.tx, ty: this.targetDoor.ty },
        data: this.data,
      });
      // Fire arrive so the caller's onArrive can clean up the sprite
      // (otherwise it would freeze forever waiting to walk).
      this.fireArrived();
    }
  }

  private findWalkableSnap(sx: number, sy: number): { x: number; y: number } | null {
    if (this.homeDoor && !this.grid.cells[this.homeDoor.ty * this.grid.cols + this.homeDoor.tx]) {
      return { x: this.homeDoor.tx, y: this.homeDoor.ty };
    }
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;     // ring only
        const nx = sx + dx, ny = sy + dy;
        if (nx < 0 || ny < 0 || nx >= this.grid.cols || ny >= this.grid.rows) continue;
        if (!this.grid.cells[ny * this.grid.cols + nx]) return { x: nx, y: ny };
      }
    }
    return null;
  }

  // Called from the npc-npc collider in main.ts when this NPC bumps
  // another. Three cases:
  //   1. We're walking → step to OUR right (passing on the right,
  //      hallway etiquette). Same as before.
  //   2. We're idle AND the other NPC is traveling to a building →
  //      flee directly AWAY from them so the traveler can pass.
  //      Travelers have priority; idle wanderers yield. Idle countdown
  //      is also cleared so update() runs the flee velocity rather
  //      than standing still.
  //   3. We're idle and the other is also idle → do nothing; let the
  //      physics collider naturally separate them.
  notifyBump(other: NPC | undefined): void {
    const now = performance.now();
    if (now - this.lastBumpMs < NPC.BUMP_DEBOUNCE_MS) return;
    this.lastBumpMs = now;

    const weAreWalking = this.path.length > 0 && this.pathIdx < this.path.length;
    if (weAreWalking) {
      const wp = this.path[this.pathIdx];
      const dx = (wp.x * TILE + TILE / 2) - this.sprite.x;
      const dy = (wp.y * TILE + TILE / 2) - this.sprite.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.001) return;
      const ux = dx / d, uy = dy / d;
      // Right of motion in screen coords (y-down): rotate heading 90° CW.
      this.sidestepVx = -uy;
      this.sidestepVy = ux;
      this.sidestepUntilMs = now + NPC.SIDESTEP_DURATION_MS;
      return;
    }

    // Idle path. Flee if the other NPC is traveling somewhere; ignore
    // collisions with other idlers (let physics handle them).
    if (!other || !other.targetDoor) return;
    const dx = this.sprite.x - other.sprite.x;
    const dy = this.sprite.y - other.sprite.y;
    const d = Math.hypot(dx, dy);
    let fx: number, fy: number;
    if (d < 0.001) {
      // Same exact spot (rare) — pick a random escape direction.
      const a = Math.random() * Math.PI * 2;
      fx = Math.cos(a); fy = Math.sin(a);
    } else {
      // Unit vector AWAY from the traveler.
      fx = dx / d; fy = dy / d;
    }
    this.sidestepVx = fx;
    this.sidestepVy = fy;
    // Idlers flee longer than walkers sidestep so they actually clear
    // the path rather than shuffle one step.
    this.sidestepUntilMs = now + NPC.SIDESTEP_DURATION_MS * 3;
    // Cancel idle countdown so update() runs the flee velocity right
    // away instead of standing still until the next wander tick.
    this.idleUntilMs = 0;
  }

  private fireArrived(): void {
    const cb = this.onArrive;
    this.targetDoor = null;
    this.onArrive = null;
    this.currentDestinationLabel = null;
    this.path = []; this.pathIdx = 0;
    if (cb) cb();
  }

  // Read-only snapshot of where the NPC is going next, used by UI.
  // First entry is the active target; subsequent entries are queued.
  upcomingDestinations(): string[] {
    const out: string[] = [];
    if (this.currentDestinationLabel) out.push(this.currentDestinationLabel);
    for (const q of this.walkQueue) if (q.label) out.push(q.label);
    return out;
  }

  // Pick a nearby walkable tile around the HOME DOOR. We use the
  // door + a small tile radius instead of the building's full rect
  // because the rect's far side might be reachable via a long detour
  // (around back), and NPCs would end up clumping there. The door is
  // the "front" the user thinks of — loiter close to it. We ALSO cap
  // path-length by manhattan distance from the door (not from current
  // sprite position) so an NPC doesn't drift further with each step.
  private repickGoal(): void {
    if (this.targetDoor) return;
    const sx = (this.sprite.x / TILE) | 0, sy = (this.sprite.y / TILE) | 0;

    if (!this.homeDoor) {
      // No home — stand still rather than wander the whole map.
      this.pickFails++;
      return;
    }
    const r = this.homeRadius;
    const dx0 = Math.max(0, this.homeDoor.tx - r);
    const dy0 = Math.max(0, this.homeDoor.ty - r);
    const dx1 = Math.min(this.grid.cols - 1, this.homeDoor.tx + r);
    const dy1 = Math.min(this.grid.rows - 1, this.homeDoor.ty + r);

    for (let attempt = 0; attempt < 16; attempt++) {
      const tx = dx0 + Math.floor(Math.random() * (dx1 - dx0 + 1));
      const ty = dy0 + Math.floor(Math.random() * (dy1 - dy0 + 1));
      if (tx === sx && ty === sy) continue;
      if (this.grid.cells[ty * this.grid.cols + tx]) continue;     // blocked
      // Stay close to the DOOR (not the current sprite position) so
      // each wander step is anchored to home — prevents wandering
      // outward over multiple steps.
      const distFromDoor = Math.abs(tx - this.homeDoor.tx) + Math.abs(ty - this.homeDoor.ty);
      if (distFromDoor > r) continue;
      // Short-step constraint: avoid epic wander trips and discourage
      // routes that loop around the building.
      const md = Math.abs(tx - sx) + Math.abs(ty - sy);
      if (md > this.maxWanderTiles) continue;
      const path = this.grid.findPath(sx, sy, tx, ty);
      // Reject paths longer than ~2x the manhattan distance — those
      // are detours (e.g. around the back of the building). We want
      // mostly-straight short hops near the door.
      if (path && path.length > 1 && path.length <= md * 2 + 2) {
        this.path = path; this.pathIdx = 1; this.pickFails = 0;
        return;
      }
    }
    this.pickFails++;
  }

  update(): void {
    const now = performance.now();

    // No active path → either idling, finished-travel, or ready to pick.
    if (!this.path.length || this.pathIdx >= this.path.length) {
      // Flee state takes priority over standing still — a traveler is
      // pushing us aside (see notifyBump). Keep playing the walk anim
      // in the direction we're moving so it doesn't look like sliding.
      if (now < this.sidestepUntilMs) {
        this.sprite.setVelocity(this.sidestepVx * SPEED, this.sidestepVy * SPEED);
        const ux = this.sidestepVx, uy = this.sidestepVy;
        if (Math.abs(ux) > Math.abs(uy) * 0.7) {
          this.sprite.anims.play(`${this.charKey}-walk-${ux > 0 ? 'right' : 'left'}`, true);
        } else {
          this.sprite.anims.play(`${this.charKey}-walk-${uy > 0 ? 'down' : 'up'}`, true);
        }
        this.stallMs = 0;
        this.lastX = this.sprite.x; this.lastY = this.sprite.y;
        return;
      }
      this.sprite.setVelocity(0);
      this.sprite.anims.stop();
      this.stallMs = 0;
      if (this.targetDoor) {
        this.fireArrived();
        this.lastX = this.sprite.x; this.lastY = this.sprite.y;
        return;
      }
      // Wander mode: respect idle countdown. Just stand still until it
      // elapses — gives the world a slow, lived-in pace and means clicks
      // actually land on the NPC.
      if (now < this.idleUntilMs) {
        this.lastX = this.sprite.x; this.lastY = this.sprite.y;
        return;
      }
      // Idle elapsed — try to pick a new nearby goal. If no good spot
      // is available, set a short idle and try again later.
      this.repickGoal();
      if (!this.path.length) {
        this.idleUntilMs = now + 2000;
      }
      this.lastX = this.sprite.x; this.lastY = this.sprite.y;
      return;
    }

    const wp = this.path[this.pathIdx];
    // Apply per-NPC jitter ONLY on the final waypoint so two NPCs
    // walking to the same door don't end up at the exact same pixel
    // (which makes them shove each other forever). Intermediate
    // waypoints stay tile-center so the arcade collider can't reject
    // their path.
    const isFinal = this.pathIdx === this.path.length - 1;
    const tx = wp.x * TILE + TILE / 2 + (isFinal ? this.targetOffsetX : 0);
    const ty = wp.y * TILE + TILE / 2 + (isFinal ? this.targetOffsetY : 0);
    const dx = tx - this.sprite.x, dy = ty - this.sprite.y;
    const dist = Math.hypot(dx, dy);
    if (dist < ARRIVE_PX) {
      this.pathIdx++;
      this.stallMs = 0;
      // Reached final waypoint? Set idle and stop.
      if (this.pathIdx >= this.path.length && !this.targetDoor) {
        this.path = [];
        this.idleUntilMs = now + this.randomIdleMs();
        this.sprite.setVelocity(0);
        this.sprite.anims.stop();
      }
      this.lastX = this.sprite.x; this.lastY = this.sprite.y;
      return;
    }
    // Stall guard — body wedged on a wall corner won't tick pathIdx;
    // abandon and repick after ~1.5 s of low progress.
    const moved = Math.hypot(this.sprite.x - this.lastX, this.sprite.y - this.lastY);
    const dt = this.scene.game.loop.delta;
    if (moved < NPC.STALL_MIN_PROGRESS_PX * (dt / 1000)) {
      this.stallMs += dt;
      if (this.stallMs > NPC.STALL_THRESHOLD_MS) {
        this.stallMs = 0;
        this.path = []; this.pathIdx = 0;
        if (this.targetDoor) this.computePathToTarget();
        else this.idleUntilMs = now + 1000;     // brief pause before trying again
        this.lastX = this.sprite.x; this.lastY = this.sprite.y;
        return;
      }
    } else {
      this.stallMs = 0;
    }
    this.lastX = this.sprite.x; this.lastY = this.sprite.y;
    // Active sidestep overrides the waypoint heading. We keep the
    // walking animation facing the intended direction of travel — the
    // shimmy is short enough that flipping the sprite would look jittery.
    if (now < this.sidestepUntilMs) {
      this.sprite.setVelocity(this.sidestepVx * SPEED, this.sidestepVy * SPEED);
      // Don't tick stall while sidestepping — we expect minimal forward
      // progress for ~300ms and don't want a re-pathfind storm.
      this.stallMs = 0;
      return;
    }
    const ux = dx / dist, uy = dy / dist;
    this.sprite.setVelocity(ux * SPEED, uy * SPEED);
    // LimeZu 48×96 sheets carry distinct right + left walk animations
    // (no need to mirror), so play whichever matches the heading.
    this.sprite.setFlipX(false);
    if (Math.abs(ux) > Math.abs(uy) * 0.7) {
      this.sprite.anims.play(`${this.charKey}-walk-${ux > 0 ? 'right' : 'left'}`, true);
    } else {
      this.sprite.anims.play(`${this.charKey}-walk-${uy > 0 ? 'down' : 'up'}`, true);
    }
  }

  destroy(): void {
    if (this.sprite && this.sprite.active) this.sprite.destroy();
  }
}
