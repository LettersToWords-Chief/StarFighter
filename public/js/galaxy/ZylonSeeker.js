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
    this.clanId  = spawner.clanId;  // inherit clan from parent spawner

    this.state          = 'SEARCHING';
    this.alive          = true;
    // Beacon is permanent — born here, activated when seeker reaches a qualifying sector
    this.beacon         = new ZylonBeacon({ q, r, type: 'searching', spawner });
    this._liveComponents = 3; // TIE + BIRD + BEACON — seeker dies when all three are killed


    // Galaxy-move timer
    this._moveTimer    = 0;
    this._moveInterval = GameConfig.zylon.seekerMoveIntervalSec;

    // Cargo-ship tracking state (real-time only)
    this._cargoSnapshot   = [];  // ships present at the moment of sector entry
    this._trackTimer      = 0;   // seconds since entry (counts up to 5)
    this._followableShips = [];  // subset still in sector at T=5s
    this._followDest      = null; // {q,r} recorded when a followable ship departs

    // Tracking Mode state (Section 5B)
    // Activated when entering a starbase that already has 2 active beacons.
    // Waits 30s to become "ready", then warps as soon as any cargo ship departs.
    this._isTracking     = false;  // true while shadowing a cargo ship
    this._trackReady     = false;  // true after 30s initial hold
    this._trackInitTimer = 0;      // seconds elapsed in 30s hold
    this._trackShip      = null;   // the cargo ship currently being watched

    // In-sector combat (managed by SectorView when player is present)
    this.hp        = 1;        // one hit and they die
    this.sectorPos = null;     // { x, y } — set by SectorView on entry
    this.inCombat  = false;

    // Power Scan homing — set by GalaxyMap._revealScanRing when scan wave hits this seeker
    this._homingTarget = null;  // { q, r } of broadcasting starbase
    this._homingTimer  = 0;
  }

  get key() { return `${this.q},${this.r}`; }

  // ─────────────────────────────────────────────
  // GALAXY-MAP TICK (called by GalaxyMap._updateZylons)
  // ─────────────────────────────────────────────

  tick(dt, galaxy) {
    if (!this.alive) return;
    if (this.state === 'GUARDING') return;
    if (this.inCombat) return;

    // ── Power Scan Homing ──────────────────────────────────────────────────────
    // Activated by a Power Scan reveal. Overrides normal pachinko movement.
    // Persists after the scan ends. Clears automatically when seeker settles (GUARDING).
    if (this._homingTarget && this.state === 'SEARCHING') {
      this._homingTimer += dt;
      if (this._homingTimer >= GameConfig.powerScan.homingMoveIntervalSec) {
        this._homingTimer = 0;
        this._homingStep(galaxy);
      }
      return; // skip all other movement logic while homing
    }

    // ── Tracking Mode (Section 5B) ─────────────────────────────────────────

    // Entered a starbase with ≥2 active beacons: wait 30s, then instantly
    // warp after the next cargo ship that leaves the sector.
    if (this._isTracking && !galaxy.fastForwarding) {
      if (!this._trackReady) {
        // Phase 1: 30s hold — seeker is "charging up"
        this._trackInitTimer += dt;
        if (this._trackInitTimer >= 30) this._trackReady = true;
        return; // hold position
      }
      // Phase 2: latch onto a cargo ship in this sector
      if (!this._trackShip || this._trackShip.destroyed) {
        this._trackShip = (galaxy.supplyShips ?? []).find(s =>
          !s.destroyed &&
          s.currentHex?.q === this.q &&
          s.currentHex?.r === this.r
        ) ?? null;
      }
      // Watch for latched ship to depart, then warp immediately after it
      if (this._trackShip && !this._trackShip.destroyed) {
        const sx = this._trackShip.currentHex;
        if (sx && (sx.q !== this.q || sx.r !== this.r)) {
          const dest = { q: sx.q, r: sx.r };
          this._trackShip = null;
          this._moveTo(dest.q, dest.r);
          this._evaluateSector(galaxy);
        }
      }
      return; // always skip the normal pachinko timer while tracking
    }
    // Tracking but fast-forwarding: hold position (prevents cap breach via pachinko)
    if (this._isTracking) return;

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
    this.q       = q;
    this.r       = r;
    this.sectorPos = null; // reset in-sector position on sector change
    // Beacon travels with the group — keep its galaxy coords in sync
    if (this.beacon) { this.beacon.q = q; this.beacon.r = r; }
    // Notify galaxy so main.js can spawn 3D ships if player is in this sector
    if (this.galaxy?._onSeekerArrived) this.galaxy._onSeekerArrived(this);
  }

  // ─────────────────────────────────────────────
  // SECTOR EVALUATION (called on each hex entry)
  // ─────────────────────────────────────────────

  /**
   * Evaluate the current sector.
   * Priority: starbase → resource node → cargo ships (real-time tracking) → empty
   */
  _evaluateSector(galaxy) {
    // Always clear the old cargo-snapshot tracking state on sector entry
    this._clearTracking();

    const starbase = galaxy.starbases.find(sb =>
      sb.q === this.q && sb.r === this.r && sb.state === 'active'
    );
    const hex = galaxy.hexes.get(HexMath.key(this.q, this.r));
    const hasSpawner = galaxy.zylonSpawners.some(
      sp => sp.alive && sp.q === this.q && sp.r === this.r
    );

    // ── Already in Tracking Mode: re-check for a beacon opportunity ─────────
    if (this._isTracking) {
      if (starbase) {
        const beaconsHere = (galaxy.zylonBeacons ?? []).filter(
          b => b.active && b.q === this.q && b.r === this.r
        ).length;
        if (beaconsHere < 2) {
          // A slot opened up — place our beacon and guard
          this._isTracking = false;
          starbase.onSeekerEntered?.();
          this.beacon.activate('starbase', galaxy);
          this.state = 'GUARDING';
          return;
        }
        // Still full — continue tracking here, no 30s wait
        this._trackReady = true;
        this._trackShip  = null;
        return;
      }
      // Resource slot while tracking?
      if (hex?.isResource && !hasSpawner) {
        this._isTracking = false;
        this.beacon.activate('resource', galaxy);
        this.state = 'GUARDING';
        return;
      }
      // No opportunity — keep tracking, immediately ready, no wait
      this._trackReady = true;
      this._trackShip  = null;
      return;
    }

    // ── Normal evaluation (not yet in Tracking Mode) ─────────────────────────

    if (starbase) {
      starbase.onSeekerEntered?.();
      const beaconsHere = (galaxy.zylonBeacons ?? []).filter(
        b => b.active && b.q === this.q && b.r === this.r
      ).length;
      if (beaconsHere < 2) {
        // Priority A: deploy beacon and guard
        this.beacon.activate('starbase', galaxy);
        this.state = 'GUARDING';
        return;
      }
      // Priority B: both slots taken — enter Tracking Mode, 30s hold
      this._isTracking     = true;
      this._trackReady     = false;
      this._trackInitTimer = 0;
      this._trackShip      = null;
      return;
    }

    // Priority C: resource sector with no spawner — place beacon for sub-spawner
    if (hex?.isResource && !hasSpawner) {
      this.beacon.activate('resource', galaxy);
      this.state = 'GUARDING';
      return;
    }

    // Priority D: cargo ships present — snapshot for standard 45s pachinko follow
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

  /**
   * Move one hex toward the homing target (greedy — pick neighbour with minimum
   * distance to target). Called every homingMoveIntervalSec while homing.
   */
  _homingStep(galaxy) {
    const target = this._homingTarget;
    // Already at the target sector — let normal evaluation handle it
    if (this.q === target.q && this.r === target.r) {
      this._homingTarget = null;
      this._evaluateSector(galaxy);
      return;
    }
    // Greedy: pick the adjacent hex that minimises distance to target
    const dirs = HexMath.DIRECTIONS;
    let bestDist = Infinity, bestQ = this.q, bestR = this.r;
    for (const d of dirs) {
      const nq = this.q + d.q, nr = this.r + d.r;
      if (!galaxy.hexes.has(HexMath.key(nq, nr))) continue;
      const dist = HexMath.distance({ q: nq, r: nr }, target);
      if (dist < bestDist) { bestDist = dist; bestQ = nq; bestR = nr; }
    }
    this._moveTo(bestQ, bestR);
    // May settle here if this is a resource or starbase sector
    this._evaluateSector(galaxy);
  }

  // ─────────────────────────────────────────────
  // COMPONENT DEATH (called by ZylonShip.destroy)
  // ─────────────────────────────────────────────

  /**
   * Called by each of the three sector-view ships (TIE, BIRD, BEACON) when killed.
   * Tracking: when all three are gone the galaxy-level seeker dies.
   *
   * @param {boolean} isBeacon — true when the BEACON ship was the one killed
   */
  onComponentDestroyed(isBeacon = false) {
    if (isBeacon && this.beacon) {
      this.beacon.destroy(); // stops warrior summoning immediately
    }
    this._liveComponents = Math.max(0, this._liveComponents - 1);
    if (this._liveComponents <= 0) {
      this.destroy();
    }
  }

  /** Final death — only called once all three sector-view ships are gone. */
  destroy() {
    this.alive    = false;
    this.inCombat = false;
    if (this.beacon) this.beacon.destroy(); // ensure beacon is inactive
    this.spawner.onSeekerDestroyed(this);
  }
}
