/**
 * ZylonWarrior.js — A Warrior pair produced by the Spawner.
 *
 * Warrior lifecycle:
 *   SPAWNING  — managed entirely by ZylonSpawner (production timer).
 *               The Warrior does not exist yet during this phase.
 *   READY     — Warrior exists; waiting for an active Beacon signal to warp to.
 *               Checks every 30 seconds for any active Beacon in the galaxy.
 *               When one is found → warp is instant → ASSAULTING.
 *   ASSAULTING — Warrior has arrived in the Beacon's sector; fighting.
 *                Managed by SectorView once the player is present.
 *
 * Notes:
 *   - Warp is INSTANT. There is no in-transit state.
 *   - Warriors survive Beacon death. They stay READY and wait for the next Beacon.
 */

class ZylonWarrior {
  /**
   * @param {object} opts
   * @param {number}       opts.q        — initial galaxy hex col (spawner's location)
   * @param {number}       opts.r        — initial galaxy hex row (spawner's location)
   * @param {ZylonBeacon}  opts.beacon   — the beacon that triggered production (may go inactive)
   * @param {ZylonSpawner} opts.spawner  — parent spawner
   */
  constructor({ q, r, beacon, spawner }) {
    this.q       = q;
    this.r       = r;
    this.beacon  = beacon;
    this.spawner = spawner;
    this.clanId  = spawner.clanId;  // inherit clan from parent spawner

    // Warrior begins existence as READY — waiting for a beacon signal
    this.state   = 'READY';
    this.alive   = true;

    // How many hits to kill (Warriors are shielded)
    this.maxHp   = GameConfig.zylon.warriorHp;
    this.hp      = this.maxHp;

    // Check timer — start near-ready so first check fires quickly
    this._waitTimer = 29;

    // Approach tracking — distance from sector entry point to orbit.
    // Set to 900 on arrival; decrements at 50u/s until orbit (200u) is reached.
    this._distToStarbase = null;

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

    // When ASSAULTING: fly in to orbit, then deal galaxy-level damage.
    // If player IS here, SectorView handles combat — skip galaxy tick.
    if (this.state === 'ASSAULTING') {
      const playerHere =
        galaxy.playerPos?.q === this.q && galaxy.playerPos?.r === this.r;
      if (!playerHere) {
        // Approach phase: close distance at 50u/s until orbit reached
        if (this._distToStarbase > 200) {
          this._distToStarbase = Math.max(200, this._distToStarbase - 50 * dt);
          return;
        }
        // Orbit phase: fire every warriorFireIntervalSec
        this._combatTimer = (this._combatTimer ?? 0) + dt;
        if (this._combatTimer >= GameConfig.zylon.warriorFireIntervalSec) {
          this._combatTimer = 0;
          const dmg = GameConfig.zylon.zylonTorpedoDamage;
          const sb  = galaxy.starbases.find(s =>
            s.q === this.q && s.r === this.r && s.state === 'active'
          );
          // Each cargo ship in the sector has a 1/6 chance of intercepting the shot
          // (they represent ~1/6 of the warrior's orbit arc — closest target wins).
          const cargoShips = galaxy.shipsInSector(this.q, this.r);
          let intercepted = false;
          for (const ship of cargoShips) {
            if (Math.random() < 1 / 6) {
              ship.takeDamage(dmg);
              intercepted = true;
              break;
            }
          }
          if (!intercepted && sb) sb.takeCombatHit(dmg);
        }
      }
      return;
    }

    if (this.state === 'COMBAT') return; // managed by SectorView

    // READY: check every 30 seconds for any active beacon to warp to
    this._waitTimer += dt;
    if (this._waitTimer >= 30) {
      this._waitTimer = 0;
      // Prefer own beacon; fall back to any active beacon if ours was destroyed
      const beacon = (this.beacon?.active ? this.beacon : null)
        ?? galaxy.zylonBeacons.find(b => b.active);
      if (beacon) {
        // Warp is instant — move to beacon's sector and notify galaxy
        this.beacon            = beacon;
        this.q                 = beacon.q;
        this.r                 = beacon.r;
        this.state             = 'ASSAULTING';
        this._distToStarbase   = 900;
        this._combatTimer      = 0;
        galaxy._onWarriorArrived(this);
      }
    }
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

  /**
   * Called by ZylonShip.destroy() via the onComponentDestroyed pathway.
   * Warriors are single-component units so this simply destroys them.
   */
  onComponentDestroyed(isBeacon = false) {
    this.destroy();
  }
}
