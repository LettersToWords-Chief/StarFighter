/**
 * CommerceLane.js — Represents a supply route between two starbases.
 */

class CommerceLane {
  /**
   * @param {Starbase} from
   * @param {Starbase} to
   */
  constructor(from, to) {
    this.from = from;
    this.to   = to;
    this.active = true;      // false when interdicted
    this.supplyLevel = 1.0;  // 0–1; degrades when interdicted
  }

  get id() {
    // Order-independent key so A→B and B→A are the same lane
    const keys = [this.from.key, this.to.key].sort();
    return keys.join('::');
  }

  /** Tick interdiction — supply degrades over time without player action. */
  interdicTick(deltaSeconds) {
    this.supplyLevel = Math.max(0, this.supplyLevel - 0.02 * deltaSeconds);
    if (this.supplyLevel === 0) this.active = false;
  }

  /** Restore supply when lane is cleared. */
  restore() {
    this.active = true;
    this.supplyLevel = Math.min(1.0, this.supplyLevel + 0.1);
  }

  /** Draw this lane on the galaxy map canvas. */
  draw(ctx, hexSize, origin) {
    const fromPx = HexMath.axialToPixel(this.from.q, this.from.r, hexSize);
    const toPx   = HexMath.axialToPixel(this.to.q,   this.to.r,   hexSize);

    const fx = origin.x + fromPx.x;
    const fy = origin.y + fromPx.y;
    const tx = origin.x + toPx.x;
    const ty = origin.y + toPx.y;

    const alpha = 0.3 + this.supplyLevel * 0.5;
    const color = this.active ? `rgba(0,180,255,${alpha})` : `rgba(255,100,50,${alpha * 0.5})`;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = this.active ? 2 : 1;
    ctx.setLineDash(this.active ? [6, 4] : [3, 6]);

    // Animate the dash offset for active lanes
    if (this.active) {
      ctx.lineDashOffset = -(Date.now() / 80) % 20;
    }

    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.restore();
  }
}
