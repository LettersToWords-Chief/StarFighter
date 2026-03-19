/**
 * Starbase.js — Represents a single starbase on the galaxy map.
 */

class Starbase {
  /**
   * @param {object} opts
   * @param {number} opts.q         — hex axial q
   * @param {number} opts.r         — hex axial r
   * @param {string} opts.name      — display name
   * @param {boolean} opts.isCapital — true for the Home Base
   * @param {number} opts.sensorRange — rings of visibility (0 = own hex only)
   */
  constructor({ q, r, name, isCapital = false, sensorRange = 0, produces = null }) {
    this.q = q;
    this.r = r;
    this.name = name;
    this.isCapital = isCapital;
    this.sensorRange = sensorRange;
    this.produces = produces;  // resource this base extracts/manufactures

    // Status
    this.state = 'active'; // 'active' | 'dormant' | 'occupied'
    this.shields = 100;    // 0–100
    this.resources = 100;  // 0–100; drains during siege

    // Upgrade levels
    this.sensorLevel = sensorRange;   // upgrade increases this
    this.repairLevel = 1;
    this.stockpileLevel = 1;

    // Distress
    this.underAttack = false;
    this.distressActive = false;
  }

  get key() {
    return HexMath.key(this.q, this.r);
  }

  /** Returns all sectors this starbase currently reveals. */
  visibleSectors() {
    return HexMath.hexesInRange(this.q, this.r, this.sensorLevel);
  }

  /** Drain shields during siege. Returns true if still alive. */
  siegeTick(deltaSeconds) {
    if (this.state !== 'active') return false;
    const drainRate = 5 * deltaSeconds; // 5% per second under siege
    this.resources = Math.max(0, this.resources - drainRate * 0.3);
    this.shields   = Math.max(0, this.shields   - drainRate);
    if (this.shields <= 0) {
      this.state = 'dormant';
      this.underAttack = false;
      this.distressActive = false;
      return false;
    }
    this.distressActive = this.shields < 40;
    return true;
  }

  /** Attempt repair while docked (per second). */
  repairTick(deltaSeconds) {
    const rate = 10 * this.repairLevel * deltaSeconds;
    this.shields   = Math.min(100, this.shields   + rate);
    this.resources = Math.min(100, this.resources + rate * 0.5);
  }
}
