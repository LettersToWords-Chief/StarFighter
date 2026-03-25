/**
 * ZylonWarrior.js — A Warrior pair dispatched by a Spawner to an active Beacon.
 *
 * Warriors warp directly to a Beacon sector (instant galaxy transit).
 * Once present, they fire warpedos at the starbase.
 * When the player fires at them, they break off and fight the player.
 * When the player warps out, they resume the starbase assault.
 *
 * States:
 *   WARPING    — in transit; will arrive after warpDelay seconds
 *   ASSAULTING — firing warpedos at starbase
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

    // Warpedo fire timer
    this._fireTimer    = 0;
    this._fireInterval = GameConfig.zylon.warpedoFireIntervalSec;

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
        this.state = 'ASSAULTING';
        // Notify the galaxy map that a warrior has arrived in this sector
        galaxy._onWarriorArrived(this);
      }
      return;
    }

    if (this.state === 'ASSAULTING' && !this.inCombat) {
      this._fireTimer += dt;
      if (this._fireTimer >= this._fireInterval) {
        this._fireTimer = 0;
        this._fireWarpedo(galaxy);
      }
    }
    // In COMBAT state, SectorView handles timing and damage
  }

  // ─────────────────────────────────────────────
  // WARPEDO FIRE
  // ─────────────────────────────────────────────

  _fireWarpedo(galaxy) {
    const starbase = galaxy.starbases.find(
      sb => sb.q === this.q && sb.r === this.r
    );
    if (!starbase) return;
    starbase.warpedoHit(
      GameConfig.zylon.warpedoShieldDamage,
      GameConfig.zylon.warpedoEnergyDamage
    );
    // Galaxy map fires an event so SectorView (if player is present) can animate the impact
    galaxy._onWarpedoFired(this, starbase);
  }

  // ─────────────────────────────────────────────
  // COMBAT EVENTS (called by SectorView)
  // ─────────────────────────────────────────────

  /** Player fired at this Warrior — break off starbase attack, engage player. */
  onPlayerFired() {
    this.inCombat = true;
    this.state    = 'COMBAT';
  }

  /** Player left the sector — resume starbase assault. */
  onPlayerLeft() {
    if (!this.alive) return;
    this.inCombat = false;
    this.state    = 'ASSAULTING';
    this._fireTimer = 0; // small grace period before first shot
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
