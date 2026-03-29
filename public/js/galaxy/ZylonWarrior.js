/**
 * ZylonWarrior.js — A Warrior pair dispatched by a Spawner to an active Beacon.
 *
 * Warriors warp directly to a Beacon sector (instant galaxy transit).
 * Once present, they hold position and engage any player ship that enters.
 * When the player warps out, they remain on station.
 *
 * States:
 *   WARPING    — in transit; will arrive after warpDelay seconds
 *   ASSAULTING — holding the beacon sector; fights player on contact
 *   COMBAT     — fighting the player (switched by SectorView)
 *   DEAD
 */

class ZylonWarrior {
  /**
   * @param {object} opts
   * @param {number}       opts.q           — target beacon galaxy hex col
   * @param {number}       opts.r           — target beacon galaxy hex row
   * @param {ZylonBeacon}  opts.beacon      — the beacon they are warping to
   * @param {ZylonSpawner} opts.spawner     — parent spawner
   */
  constructor({ q, r, beacon, spawner }) {
    this.q       = q;
    this.r       = r;
    this.beacon  = beacon;
    this.spawner = spawner;

    this.state   = 'WARPING';
    this.alive   = true;

    // How many hits to kill (Warriors are shielded)
    this.maxHp   = GameConfig.zylon.warriorHp;
    this.hp      = this.maxHp;

    // Warp arrival timer
    this._warpTimer    = 0;
    this._warpDuration = GameConfig.zylon.warriorWarpDelaySec; // visual delay

    // In-sector
    this.sectorPos = null;   // { x, y } — set by SectorView on arrival
    this.inCombat  = false;  // true when fighting the player
  }

  get key() { return `${this.q},${this.r}`; }

  // ─────────────────────────────────────────────
  // GALAXY-MAP TICK
  // ─────────────────────────────────────────────

  tick(dt, galaxy) {
    if (!this.alive) return;

    if (this.state === 'WARPING') {
      this._warpTimer += dt;
      if (this._warpTimer >= this._warpDuration) {
        // If the beacon was destroyed while we were in hyperspace, disband.
        if (!this.beacon?.active) {
          this.alive = false;
          return;
        }
        this.state = 'ASSAULTING';
        // Notify the galaxy map that a warrior has arrived in this sector
        galaxy._onWarriorArrived(this);
      }
    }
    // In ASSAULTING state, Warriors hold their position.
    // In COMBAT state, SectorView handles all timing and damage.
  }

  // ─────────────────────────────────────────────
  // COMBAT EVENTS (called by SectorView)
  // ─────────────────────────────────────────────

  /** Player fired at this Warrior — break off and engage player. */
  onPlayerFired() {
    this.inCombat = true;
    this.state    = 'COMBAT';
  }

  /** Player left the sector — return to holding the beacon sector. */
  onPlayerLeft() {
    if (!this.alive) return;
    this.inCombat = false;
    this.state    = 'ASSAULTING';
  }

  hit(damage = 1) {
    this.hp -= damage;
    if (this.hp <= 0) this.destroy();
  }

  destroy() {
    this.alive    = false;
    this.inCombat = false;
    this.spawner.onWarriorDestroyed(this);
  }
}
