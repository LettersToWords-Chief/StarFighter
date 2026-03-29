/**
 * ZylonSeeker.js — A Seeker pair on the galaxy map.
 *
 * Seekers travel one hex per tick in a "pachinko" pattern:
 *  - They have a FACING (0–5, corresponding to the 6 edge directions of a
 *    pointy-top hex: 12, 2, 4, 6, 8, 10 o'clock).
 *  - Each move they randomly step to one of the two neighbor hexes that
 *    flank that edge (the hex at 11/1, 1/3, 3/5, 5/7, 7/9, or 9/11).
 *  - At the map edge one or both candidates are off-map.  The Seeker then
 *    picks a random turn direction (CW or CCW) and rotates 1–2 steps,
 *    continuing 1 step at a time until both candidates are on the map.
 *
 * States:
 *   SEARCHING  — moving through the galaxy; pachinko or cargo-following
 *   GUARDING   — beacon deployed; defending it in-sector
 *   FALLBACK   — beacon was destroyed; now attacking starbase / ships freely
 *
 * Cargo-ship tracking (real-time only, not during fast-forward seeding):
 *   When a seeker enters a sector that has no starbase or resource node but
 *   does have cargo ships, it snapshots those ships at the moment of arrival.
 *   After 5 real-time seconds, any of those ships still in the sector become
 *   "followable."  When a followable ship departs, the seeker records its
 *   destination and jumps there when its own 45 s move interval fires.
 *   If all followable ships are still present when the interval fires (damaged
 *   ship taking longer than normal), the seeker holds and keeps waiting.
 */

class ZylonSeeker {
  /**
   * @param {object} opts
   * @param {number}       opts.q          — starting galaxy hex col
   * @param {number}       opts.r          — starting galaxy hex row
   * @param {number}       opts.facing     — initial facing index 0–5
   * @param {ZylonSpawner} opts.spawner    — parent spawner
   * @param {GalaxyMap}    opts.galaxy     — reference for hex lookups
   */
  constructor({ q, r, facing, spawner, galaxy }) {
    this.q       = q;
    this.r       = r;
    this.facing  = facing;   // integer 0–5
    this.spawner = spawner;
    this.galaxy  = galaxy;

    this.state   = 'SEARCHING';
    this.beacon  = null;         // ZylonBeacon once deployed
    this.alive   = true;

    // Galaxy-move timer
    this._moveTimer    = 0;
    this._moveInterval = GameConfig.zylon.seekerMoveIntervalSec;

    // Cargo-ship tracking state (real-time only)
    this._cargoSnapshot   = [];  // ships present at the moment of sector entry
    this._trackTimer      = 0;   // seconds since entry (counts up to 5)
    this._followableShips = [];  // subset still in sector at T=5s
    this._followDest      = null; // {q,r} recorded when a followable ship departs

    // In-sector combat (managed by SectorView when player is present)
    this.hp        = 1;        // one hit and they die
    this.sectorPos = null;     // { x, y } — set by SectorView on entry
    this.inCombat  = false;
  }

  get key() { return `${this.q},${this.r}`; }

  // ─────────────────────────────────────────────
  // GALAXY-MAP TICK (called by GalaxyMap._updateZylons)
  // ─────────────────────────────────────────────

  tick(dt, galaxy) {
    if (!this.alive) return;
    if (this.state === 'GUARDING' || this.state === 'FALLBACK') return;
    if (this.inCombat) return;

    // Interval is always the real game value — the caller scales dt during fast-forward
    this._moveInterval = GameConfig.zylon.seekerMoveIntervalSec;

    // ── Cargo tracking (real-time only) ───────────────────────────────────────
    if (!galaxy.fastForwarding) {

      // Phase 1: count up to 5s — then lock in followable set
      if (this._cargoSnapshot.length > 0 && this._trackTimer < 5) {
        this._trackTimer += dt;
        if (this._trackTimer >= 5) {
          // Keep only ships still in this sector at the 5-second mark
          this._followableShips = this._cargoSnapshot.filter(s =>
            !s.destroyed &&
            s.currentHex?.q === this.q &&
            s.currentHex?.r === this.r
          );
          this._cargoSnapshot = []; // done with snapshot
        }
      }

      // Phase 2: watch for a followable ship to depart (runs independently of Phase 1)
      if (!this._followDest && this._followableShips.length > 0) {
        const departed = this._followableShips.find(s =>
          s.destroyed ||
          s.currentHex?.q !== this.q ||
          s.currentHex?.r !== this.r
        );
        if (departed && !departed.destroyed) {
          // Record the hex the ship just jumped to
          this._followDest = {
            q: departed.currentHex.q,
            r: departed.currentHex.r,
          };
        } else if (departed && departed.destroyed) {
          // Ship was destroyed — remove from followable list
          this._followableShips = this._followableShips.filter(s => s !== departed);
        }
      }
    }

    // ── Move-interval check ───────────────────────────────────────────────────
    this._moveTimer += dt;
    if (this._moveTimer < this._moveInterval) return;

    // If a followable ship has already departed → jump to its destination
    if (this._followDest) {
      this._moveTo(this._followDest.q, this._followDest.r);
      this._clearTracking();
      this._moveTimer = 0;
      this._evaluateSector(galaxy);
      return;
    }

    // If followable ships exist but none have left yet → hold (damaged-ship case)
    if (this._followableShips.length > 0) {
      const anyStillHere = this._followableShips.some(s =>
        !s.destroyed &&
        s.currentHex?.q === this.q &&
        s.currentHex?.r === this.r
      );
      if (anyStillHere) {
        // Reset timer and wait another cycle
        this._moveTimer = 0;
        return;
      }
      // All followable ships gone but none caught departing → fall through to pachinko
      this._clearTracking();
    }

    // Normal pachinko move
    this._moveTimer = 0;
    this._searchMove(galaxy);
  }

  // ─────────────────────────────────────────────
  // MOVEMENT
  // ─────────────────────────────────────────────

  _searchMove(galaxy) {
    // Pachinko step — resources found only by landing on them
    this._pachinkoStep(galaxy);
    this._evaluateSector(galaxy);
  }

  /**
   * Pachinko movement:
   *  1. Compute the two candidate neighbor hexes that flank the current facing edge.
   *  2. If both are on the map → pick one at random and move there.
   *  3. If one or both are off the map → turn (CW or CCW, random) 1–2 steps,
   *     then keep turning 1 step at a time until both candidates are valid.
   *  4. Move to random candidate from the resolved facing.
   */
  _pachinkoStep(galaxy) {
    let [c0, c1] = this._candidatesForFacing(this.facing);

    const on0 = galaxy.hexes.has(HexMath.key(c0.q, c0.r));
    const on1 = galaxy.hexes.has(HexMath.key(c1.q, c1.r));

    if (!on0 || !on1) {
      // Turn to find a valid facing
      const turnDir = Math.random() < 0.5 ? 1 : -1;   // +1 = CW, -1 = CCW
      const initialTurn = Math.random() < 0.5 ? 1 : 2; // initial 1 or 2 steps

      this.facing = (this.facing + turnDir * initialTurn + 6) % 6;

      // Keep turning 1 step at a time until both candidates are on the map
      for (let safety = 0; safety < 6; safety++) {
        [c0, c1] = this._candidatesForFacing(this.facing);
        const valid0 = galaxy.hexes.has(HexMath.key(c0.q, c0.r));
        const valid1 = galaxy.hexes.has(HexMath.key(c1.q, c1.r));
        if (valid0 && valid1) break;
        this.facing = (this.facing + turnDir + 6) % 6;
      }

      // Re-resolve candidates after turning
      [c0, c1] = this._candidatesForFacing(this.facing);
    }

    // Move to one of the two flanking hexes at random
    const next = Math.random() < 0.5 ? c0 : c1;
    this._moveTo(next.q, next.r);
  }

  /**
   * Return the two neighbor hex coords that flank the given facing edge.
   *
   * For a pointy-top hex with HexMath.DIRECTIONS indexed as:
   *   0 = E  (3 o'clock)    1 = NE (1 o'clock)    2 = NW (11 o'clock)
   *   3 = W  (9 o'clock)    4 = SW (7 o'clock)    5 = SE (5 o'clock)
   *
   * The six edge facings (clock edges) map to flanking neighbor pair indices:
   *   facing 0 (12 o'clock edge) → DIRS[2] (11) and DIRS[1] (1)
   *   facing 1 ( 2 o'clock edge) → DIRS[1] ( 1) and DIRS[0] (3)
   *   facing 2 ( 4 o'clock edge) → DIRS[0] ( 3) and DIRS[5] (5)
   *   facing 3 ( 6 o'clock edge) → DIRS[5] ( 5) and DIRS[4] (7)
   *   facing 4 ( 8 o'clock edge) → DIRS[4] ( 7) and DIRS[3] (9)
   *   facing 5 (10 o'clock edge) → DIRS[3] ( 9) and DIRS[2] (11)
   *
   * Formula: left = DIRS[(2-f+6)%6], right = DIRS[(1-f+6)%6]
   */
  _candidatesForFacing(f) {
    const d = HexMath.DIRECTIONS;
    const left  = d[(2 - f + 6) % 6];
    const right = d[(1 - f + 6) % 6];
    return [
      { q: this.q + left.q,  r: this.r + left.r  },
      { q: this.q + right.q, r: this.r + right.r },
    ];
  }

  _moveTo(q, r) {
    this.q = q;
    this.r = r;
    this.sectorPos = null; // reset in-sector position on sector change
  }

  // ─────────────────────────────────────────────
  // SECTOR EVALUATION (called on each hex entry)
  // ─────────────────────────────────────────────

  /**
   * Evaluate the current sector.
   * Priority: starbase → resource node → cargo ships (real-time tracking) → empty
   */
  _evaluateSector(galaxy) {
    // Always clear any stale tracking state when moving to a new sector
    this._clearTracking();

    // Only deploy at outer, active starbases — never at the capital or already-fallen bases
    const starbase = galaxy.starbases.find(sb =>
      sb.q === this.q && sb.r === this.r && !sb.isCapital && sb.state === 'active'
    );

    if (starbase) {
      this._deployBeacon(galaxy, 'starbase');
      return;
    }

    const hex = galaxy.hexes.get(HexMath.key(this.q, this.r));
    const hasSpawner = galaxy.zylonSpawners.some(sp => sp.alive && sp.q === this.q && sp.r === this.r);
    if (hex?.isResource && !hasSpawner) {
      this._deployBeacon(galaxy, 'resource');
      return;
    }

    // Cargo-ship tracking — real-time only; snapshot ships present right now
    if (!galaxy.fastForwarding) {
      const shipsHere = (galaxy.supplyShips ?? []).filter(s =>
        !s.destroyed &&
        s.currentHex?.q === this.q &&
        s.currentHex?.r === this.r
      );
      if (shipsHere.length > 0) {
        this._cargoSnapshot   = shipsHere;
        this._trackTimer      = 0;
        this._followableShips = [];
        this._followDest      = null;
      }
    }

    // Empty (or fast-forward) — keep searching via pachinko
  }

  _deployBeacon(galaxy, type) {
    if (!this.beacon) {
      const beaconIndex = galaxy.zylonBeacons.filter(
        b => b.q === this.q && b.r === this.r && b.active
      ).length;

      this.beacon = new ZylonBeacon({
        q: this.q,
        r: this.r,
        type,
        spawner: this.spawner,
        sectorPos: null,
      });
      this.beacon._beaconIndex = beaconIndex;
      galaxy.zylonBeacons.push(this.beacon);
      this.spawner.onBeaconDeployed(this.beacon, galaxy);
    }
    this.state = 'GUARDING';
  }

  // ─────────────────────────────────────────────
  // CARGO TRACKING HELPERS
  // ─────────────────────────────────────────────

  /** Reset all cargo-tracking state (called on every sector move). */
  _clearTracking() {
    this._cargoSnapshot   = [];
    this._trackTimer      = 0;
    this._followableShips = [];
    this._followDest      = null;
  }

  // ─────────────────────────────────────────────
  // COMBAT EVENTS (called by SectorView)
  // ─────────────────────────────────────────────

  onBeaconDestroyed() {
    this.beacon = null;
    this.state  = 'FALLBACK';
  }

  hit() {
    this.hp--;
    if (this.hp <= 0) this.destroy();
  }

  destroy() {
    this.alive    = false;
    this.inCombat = false;
    this.spawner.onSeekerDestroyed(this);
  }
}
