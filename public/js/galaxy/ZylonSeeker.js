/**
 * ZylonSeeker.js — Zylon Seeker: a solo traveling icosahedron.
 *
 * The Seeker is the Zylon's explorer form. It travels alone through the galaxy
 * using pachinko movement, looking for resource sectors to inhabit.
 *
 * Lifecycle:
 *   SEARCHING — moving through the galaxy
 *   (evolve)  — enters a resource sector → galaxy creates a Spawner, Seeker is removed
 *   (dead)    — killed by the player before it could settle
 *
 * Movement:
 *   - Born in parent Spawner's sector. First warp after seekerBirthWarpDelaySec (5s).
 *   - Subsequent warps every seekerMoveIntervalSec (45s).
 *   - Will never re-enter its birth sector (homeQ / homeR).
 *   - Pachinko bounce at map edges; optional cargo-ship following.
 *
 * In-sector:
 *   Solo icosahedron visible to the player. One hit kills it.
 *   Warps out on its own schedule regardless of player presence.
 */
class ZylonSeeker {
  /**
   * @param {object} opts
   * @param {number}       opts.q       — birth galaxy hex col
   * @param {number}       opts.r       — birth galaxy hex row
   * @param {number}       opts.facing  — initial facing index 0–5
   * @param {ZylonSpawner} opts.spawner — parent spawner
   * @param {GalaxyMap}    opts.galaxy  — reference for hex lookups
   */
  constructor({ q, r, facing, spawner, galaxy, generation = 1 }) {
    this.q       = q;
    this.r       = r;
    this.facing  = facing;
    this.spawner = spawner;
    this.galaxy  = galaxy;
    this.clanId  = spawner.clanId;

    // Birth sector — never re-enter
    this.homeQ = q;
    this.homeR = r;

    this.state = 'SEARCHING';
    this.alive = true;
    this.generation = generation;  // inherited from parent spawner — controls decay chain

    // First warp fires after birthDelay seconds; subsequent every moveInterval
    const cfg         = GameConfig.zylon;
    this._moveInterval = cfg.seekerMoveIntervalSec;
    const birthDelay   = cfg.seekerBirthWarpDelaySec ?? 5;
    this._moveTimer    = this._moveInterval - birthDelay;

    // Cargo-ship tracking
    this._cargoSnapshot   = [];
    this._trackTimer      = 0;
    this._followableShips = [];
    this._followDest      = null;

    // In-sector state (set/cleared by SectorView)
    this.sectorPos = null;
    this.inCombat  = false;

    // Power Scan homing
    this._homingTarget = null;
    this._homingTimer  = 0;
  }

  get key() { return `${this.q},${this.r}`; }

  // ─────────────────────────────────────────────
  // GALAXY-MAP TICK
  // ─────────────────────────────────────────────

  tick(dt, galaxy) {
    if (!this.alive) return;

    // Power Scan homing overrides normal movement
    if (this._homingTarget) {
      this._homingTimer += dt;
      if (this._homingTimer >= (GameConfig.powerScan?.homingMoveIntervalSec ?? 10)) {
        this._homingTimer = 0;
        this._homingStep(galaxy);
      }
      return;
    }

    // Cargo tracking (real-time only)
    if (!galaxy.fastForwarding) {
      if (this._cargoSnapshot.length > 0 && this._trackTimer < 5) {
        this._trackTimer += dt;
        if (this._trackTimer >= 5) {
          this._followableShips = this._cargoSnapshot.filter(s =>
            !s.destroyed &&
            s.currentHex?.q === this.q &&
            s.currentHex?.r === this.r
          );
          this._cargoSnapshot = [];
        }
      }
      if (!this._followDest && this._followableShips.length > 0) {
        const departed = this._followableShips.find(s =>
          s.destroyed || s.currentHex?.q !== this.q || s.currentHex?.r !== this.r
        );
        if (departed && !departed.destroyed) {
          this._followDest = { q: departed.currentHex.q, r: departed.currentHex.r };
        } else if (departed?.destroyed) {
          this._followableShips = this._followableShips.filter(s => s !== departed);
        }
      }
    }

    // Move timer
    this._moveTimer += dt;
    if (this._moveTimer < this._moveInterval) return;
    this._moveTimer = 0;

    if (this._followDest) {
      this._moveTo(this._followDest.q, this._followDest.r, galaxy);
      this._clearTracking();
      this._evaluateSector(galaxy);
      return;
    }

    if (this._followableShips.length > 0) {
      const anyHere = this._followableShips.some(s =>
        !s.destroyed && s.currentHex?.q === this.q && s.currentHex?.r === this.r
      );
      if (anyHere) { this._moveTimer = 0; return; }
      this._clearTracking();
    }

    this._searchMove(galaxy);
  }

  // ─────────────────────────────────────────────
  // MOVEMENT
  // ─────────────────────────────────────────────

  _searchMove(galaxy) {
    this._pachinkoStep(galaxy);
    this._evaluateSector(galaxy);
  }

  _pachinkoStep(galaxy) {
    let [c0, c1] = this._candidatesForFacing(this.facing);
    const on0 = galaxy.hexes.has(HexMath.key(c0.q, c0.r));
    const on1 = galaxy.hexes.has(HexMath.key(c1.q, c1.r));

    if (!on0 || !on1) {
      const turnDir     = Math.random() < 0.5 ? 1 : -1;
      const initialTurn = Math.random() < 0.5 ? 1 : 2;
      this.facing = (this.facing + turnDir * initialTurn + 6) % 6;
      for (let i = 0; i < 6; i++) {
        [c0, c1] = this._candidatesForFacing(this.facing);
        if (galaxy.hexes.has(HexMath.key(c0.q, c0.r)) &&
            galaxy.hexes.has(HexMath.key(c1.q, c1.r))) break;
        this.facing = (this.facing + turnDir + 6) % 6;
      }
      [c0, c1] = this._candidatesForFacing(this.facing);
    }

    // Pick a candidate — avoid birth sector
    let next = Math.random() < 0.5 ? c0 : c1;
    if (next.q === this.homeQ && next.r === this.homeR) {
      next = (next === c0) ? c1 : c0;
    }
    this._moveTo(next.q, next.r, galaxy);
  }

  _candidatesForFacing(f) {
    const d = HexMath.DIRECTIONS;
    return [
      { q: this.q + d[(2 - f + 6) % 6].q, r: this.r + d[(2 - f + 6) % 6].r },
      { q: this.q + d[(1 - f + 6) % 6].q, r: this.r + d[(1 - f + 6) % 6].r },
    ];
  }

  _moveTo(q, r, galaxy) {
    this.prevQ     = this.q;  // remember where we came from (for departure detection)
    this.prevR     = this.r;
    this.q         = q;
    this.r         = r;
    this.sectorPos = null;
    galaxy?._onSeekerArrived?.(this);
  }

  // ─────────────────────────────────────────────
  // SECTOR EVALUATION
  // ─────────────────────────────────────────────

  _evaluateSector(galaxy) {
    this._clearTracking();
    const hex      = galaxy.hexes.get(HexMath.key(this.q, this.r));
    const starbase = galaxy.starbases.find(sb => sb.q === this.q && sb.r === this.r);

    // Resource sector (starbases are always in resource sectors) — evolve instantly
    if (hex?.isResource || starbase) {
      galaxy._onSeekerEvolved(this);
      return;
    }

    // Cargo-ship snapshot for follow logic
    if (!galaxy.fastForwarding) {
      const shipsHere = (galaxy.supplyShips ?? []).filter(s =>
        !s.destroyed && s.currentHex?.q === this.q && s.currentHex?.r === this.r
      );
      if (shipsHere.length > 0) {
        this._cargoSnapshot   = shipsHere;
        this._trackTimer      = 0;
        this._followableShips = [];
        this._followDest      = null;
      }
    }
  }

  // ─────────────────────────────────────────────
  // CARGO TRACKING HELPERS
  // ─────────────────────────────────────────────

  _clearTracking() {
    this._cargoSnapshot   = [];
    this._trackTimer      = 0;
    this._followableShips = [];
    this._followDest      = null;
  }

  _homingStep(galaxy) {
    const target = this._homingTarget;
    if (this.q === target.q && this.r === target.r) {
      this._homingTarget = null;
      this._evaluateSector(galaxy);
      return;
    }
    let bestDist = Infinity, bestQ = this.q, bestR = this.r;
    for (const d of HexMath.DIRECTIONS) {
      const nq = this.q + d.q, nr = this.r + d.r;
      if (!galaxy.hexes.has(HexMath.key(nq, nr))) continue;
      const dist = HexMath.distance({ q: nq, r: nr }, target);
      if (dist < bestDist) { bestDist = dist; bestQ = nq; bestR = nr; }
    }
    this._moveTo(bestQ, bestR, galaxy);
    this._evaluateSector(galaxy);
  }

  // ─────────────────────────────────────────────
  // DEATH
  // ─────────────────────────────────────────────

  /** Called by SectorView when the seeker's icosahedron is destroyed. */
  onComponentDestroyed() {
    this.destroy();
  }

  destroy() {
    if (!this.alive) return;
    this.alive    = false;
    this.inCombat = false;
    this.spawner?.onSeekerDestroyed(this);
  }
}
