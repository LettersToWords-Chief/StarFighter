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

    // Warrior begins existence as READY — waiting for a beacon signal
    this.state   = 'READY';
    this.alive   = true;

    // How many hits to kill (Warriors are shielded)
    this.maxHp   = GameConfig.zylon.warriorHp;
    this.hp      = this.maxHp;

    // Check timer — start near-ready so first check fires quickly
    this._waitTimer = 29;

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

    // When ASSAULTING: deal galaxy-level damage if player is NOT in this sector.
    // If player IS here, SectorView handles combat — skip galaxy tick.
    if (this.state === 'ASSAULTING') {
      const playerHere =
        galaxy.playerPos?.q === this.q && galaxy.playerPos?.r === this.r;
      if (!playerHere) {
        this._combatTimer = (this._combatTimer ?? 0) + dt;
        if (this._combatTimer >= GameConfig.zylon.warriorFireIntervalSec) {
          this._combatTimer = 0;
          const sb = galaxy.starbases.find(s =>
            s.q === this.q && s.r === this.r && s.state === 'active'
          );
          if (sb) sb.takeCombatHit(GameConfig.zylon.zylonTorpedoDamage);
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
        const clk = window.SubspaceComm?.clockStr?.() ?? '?';
        window.SubspaceComm?.send('WRR WARP', clk,
          `[${this.q},${this.r}] \u2192 BEACON [${beacon.q},${beacon.r}]`);
        // Warp is instant \u2014 move to beacon's sector and notify galaxy
        this.beacon = beacon;
        this.q      = beacon.q;
        this.r      = beacon.r;
        this.state  = 'ASSAULTING';
        this._combatTimer = 0;
        window.SubspaceComm?.send('WRR ARRIVED', clk,
          `[${this.q},${this.r}] STATE: ASSAULTING`);
        galaxy._onWarriorArrived(this);
      } else {
        const clk = window.SubspaceComm?.clockStr?.() ?? '?';
        window.SubspaceComm?.send('WRR READY', clk,
          `[${this.q},${this.r}] NO BEACON FOUND`);
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
