/**
 * ZylonBeacon.js — The warp-guidance device carried by every Seeker group.
 *
 * The Beacon is a permanent member of the Seeker group (TIE + BIRD + BEACON).
 * It travels with the group and exists in every sector the player encounters them.
 *
 * Roles:
 *  1. Galaxy-map: signals the Spawner once ACTIVATED at a qualifying sector.
 *     Inactive while traveling — only appears on the galaxy map when active.
 *  2. Sector-view: physical ship orbiting at ~750 units from sector center,
 *     guarded by the TIE and BIRD. Killing it stops all warrior reinforcements.
 *
 * State:
 *  active = false  — traveling with the seeker group (not yet at a destination)
 *  active = true   — activated at a starbase or resource sector; summoning units
 */

class ZylonBeacon {
  /**
   * @param {object} opts
   * @param {number}       opts.q        — galaxy hex column
   * @param {number}       opts.r        — galaxy hex row
   * @param {string}       opts.type     — 'searching' | 'starbase' | 'resource'
   * @param {ZylonSpawner} opts.spawner  — the Spawner that owns this beacon's Seekers
   */
  constructor({ q, r, type = 'searching', spawner }) {
    this.q        = q;
    this.r        = r;
    this.type     = type;
    this.spawner  = spawner;
    this.clanId   = spawner.clanId;  // inherit clan from parent spawner

    // Inactive while traveling — activates when seeker reaches a qualifying sector
    this.active   = false;

    // HP — base value; increases with each absorbed seeker group
    this.hp       = GameConfig.zylon?.beaconBaseHP ?? 100;
    this.maxHp    = this.hp;
    this.mergeCount = 0;  // number of seeker groups absorbed into this beacon

    // Galaxy reference — set when activated so tick() can count warriors
    this._galaxy       = null;
    this._resupplyTimer = 0;

    // Animation
    this._pulseTimer = 0;
    this._pulsePhase = Math.random() * Math.PI * 2;
  }

  get key() { return `${this.q},${this.r}`; }

  /** Called each frame for animation state and resupply logic. dt in seconds. */
  tick(dt) {
    this._pulseTimer += dt;

    if (!this.active || !this._galaxy) return;

    // ── Resupply check (real gameplay only — not during fast-forward) ──────────
    const cfg       = GameConfig.zylon;
    const checkSec  = cfg.warriorResupplyCheckSec  ?? 30;
    const target    = cfg.warriorResupplyTarget     ?? 4;
    if (!this._galaxy.fastForwarding) {
      this._resupplyTimer += dt;
    }
    if (this._resupplyTimer >= checkSec) {
      this._resupplyTimer = 0;
      // Count alive same-clan warriors in this sector (fighting or assigned and waiting)
      const present = this._galaxy.zylonWarriors.filter(w =>
        w.alive && w.clanId === this.clanId && (
          // In this sector and actively fighting
          ((w.state === 'ASSAULTING' || w.state === 'COMBAT') &&
           w.q === this.q && w.r === this.r) ||
          // READY and already assigned to this beacon (will warp on next 30s check)
          (w.state === 'READY' && w.beacon === this)
        )
      ).length;

      if (present < target) {
        // Dispatch exactly 1 pair per check — warriors accumulate gradually,
        // not all at once. Hitting the target cap takes multiple resupply cycles.
        this.spawner.onResupplyRequested(this, 1, this._galaxy);
      }
    }
  }

  /**
   * Current pulse intensity 0–1, for rendering the pulsing glow.
   * Oscillates on a ~2-second cycle.
   */
  get pulseIntensity() {
    return 0.5 + 0.5 * Math.sin(this._pulseTimer * Math.PI + this._pulsePhase);
  }

  /**
   * Activate this beacon at a qualifying sector.
   * Called by ZylonSeeker._evaluateSector() when the group reaches a target sector.
   * Adds itself to galaxy.zylonBeacons (becomes visible on the galaxy map)
   * and notifies the Spawner so it begins producing warriors or sub-spawners.
   *
   * @param {string}    type    — 'starbase' | 'resource'
   * @param {GalaxyMap} galaxy  — live galaxy reference
   */
  activate(type, galaxy) {
    if (this.active) return; // already activated
    // Hard cap: only 1 active (transmitting) beacon per sector — extras must merge
    const alreadyHere = (galaxy.zylonBeacons ?? []).filter(
      b => b.active && b.q === this.q && b.r === this.r
    ).length;
    if (alreadyHere >= 1) return; // sector already has a transmitting beacon
    this.type    = type;
    this.active  = true;
    this._galaxy = galaxy;   // store for resupply checks in tick()
    // Add to galaxy beacon list so the galaxy map renders it and warriors can find it
    galaxy.zylonBeacons.push(this);
    // Notify spawner so it queues warriors / sub-spawner production
    this.spawner.onBeaconDeployed(this, galaxy);
  }

  /**
   * Absorb an incoming seeker group into this transmitting beacon.
   * The merged seeker's TIE and Bird will fight on as escort.
   * @param {ZylonSeeker} seeker
   */
  absorb(seeker) {
    const added   = seeker.beacon?.hp ?? (GameConfig.zylon?.beaconBaseHP ?? 100);
    this.hp      += added;
    this.maxHp   += added;
    this.mergeCount++;
    // The merged seeker is consumed — it ceases to exist as a galaxy-level unit.
    // Its TIE and Bird will be re-assigned to the primary seeker in SectorView.
    seeker.alive = false;
  }

  /** Destroy this beacon — called when the beacon ZylonShip is killed. */
  destroy() {
    this.active = false;
    // Note: galaxy._updateZylons will filter it from zylonBeacons on next pass
  }

  /**
   * Compute the default sector-view position for a beacon relative to a starbase.
   * Places the beacon ~750 units from the sector center, slightly offset so multiple
   * beacons in the same sector don't perfectly overlap.
   *
   * @param {number} sbX   — starbase sector-view x
   * @param {number} sbY   — starbase sector-view y
   * @param {number} index — beacon index (0, 1, 2...) for angular offset
   * @returns {{ x, y }}
   */
  static defaultSectorPos(sbX, sbY, index = 0) {
    const DIST  = 750;
    const angle = (index * Math.PI * 2 / 6) - Math.PI / 2;
    return {
      x: sbX + Math.cos(angle) * DIST,
      y: sbY + Math.sin(angle) * DIST,
    };
  }
}
