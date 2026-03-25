/**
 * ZylonBeacon.js — A placed object deployed by a Seeker pair when they enter a qualifying sector.
 *
 * The Beacon serves two roles:
 *  1. Galaxy-map role: signals the Spawner what to produce next (starbase → Warriors, resource → Spawner)
 *  2. Sector-view role: physical object at a fixed position ~750 units from the starbase,
 *     guarded by the Seeker pair that deployed it.
 *
 * Warriors can only warp to a Beacon — it is their galactic navigation system.
 */

class ZylonBeacon {
  /**
   * @param {object} opts
   * @param {number}  opts.q          — galaxy hex column
   * @param {number}  opts.r          — galaxy hex row
   * @param {string}  opts.type       — 'starbase' | 'resource'
   * @param {ZylonSpawner} opts.spawner  — the Spawner that owns this beacon's Seekers
   * @param {object}  opts.sectorPos  — { x, y } pixel position in sector view (~750 units from starbase)
   */
  constructor({ q, r, type, spawner, sectorPos = null }) {
    this.q        = q;
    this.r        = r;
    this.type     = type;      // 'starbase' | 'resource'
    this.spawner  = spawner;

    // Sector-view position (set when sector is first rendered with this beacon present)
    this.sectorPos = sectorPos;

    // State
    this.active     = true;
    this.signalSent = false;   // true after Spawner has been notified (avoid double-dispatch)

    // Animation
    this._pulseTimer = 0;
    this._pulsePhase = Math.random() * Math.PI * 2; // stagger pulses if multiple beacons
  }

  get key() { return `${this.q},${this.r}`; }

  /** Called each frame for animation state. dt in seconds. */
  tick(dt) {
    this._pulseTimer += dt;
  }

  /**
   * Current pulse intensity 0–1, for rendering the pulsing glow.
   * Oscillates on a ~2-second cycle.
   */
  get pulseIntensity() {
    return 0.5 + 0.5 * Math.sin(this._pulseTimer * Math.PI + this._pulsePhase);
  }

  /** Destroy this beacon — called when player weapons connect. */
  destroy() {
    this.active = false;
  }

  /**
   * Compute the default sector-view position for a beacon relative to a starbase.
   * Places the beacon ~750 units from the starbase, slightly offset so multiple
   * beacons in the same sector don't perfectly overlap.
   *
   * @param {number} sbX   — starbase sector-view x
   * @param {number} sbY   — starbase sector-view y
   * @param {number} index — beacon index (0, 1, 2...) for angular offset
   * @returns {{ x, y }}
   */
  static defaultSectorPos(sbX, sbY, index = 0) {
    const DIST  = 750;
    const angle = (index * Math.PI * 2 / 6) - Math.PI / 2; // evenly spread if multiple
    return {
      x: sbX + Math.cos(angle) * DIST,
      y: sbY + Math.sin(angle) * DIST,
    };
  }
}
