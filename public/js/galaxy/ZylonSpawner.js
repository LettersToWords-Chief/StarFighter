/**
 * ZylonSpawner.js — Zylon production hub.
 *
 * The Spawner is a Seeker that has settled in a resource sector. It remains
 * stationary (at 750U from the sector center) for its entire life.
 *
 * Production formula: 5 * sqrt(childOrdinal) seconds per child.
 *   Child 1 = 5s, Child 2 ≈ 7.07s, Child 3 ≈ 8.66s, Child 4 = 10s, …
 *
 * Priority order:
 *   Phase 1 (first 6 children): fill 1 TIE + 1 Bird + 4 Warriors — in that order
 *   Phase 2 (seekersMade < 6): produce Seekers
 *     — BLOCKED while this sector's starbase has active shields
 *     — while blocked, warriors continue bombarding the starbase
 *   Phase 3 (seekersMade >= 6): maintain 2 TIE + 2 Birds + 5 Warriors
 *
 * If a fleet member is killed, the Spawner queues a replacement using the
 * standard sqrt-formula timer (production never stops).
 *
 * Off-screen simulation:
 *   The Spawner tracks fleet.warrior and fires off starbase bombardment hits
 *   every warriorFireIntervalSec while the player is not in the sector.
 *
 * Production pauses:
 *   When the Spawner is hit it flees for spawnerFleeTimeSec (10s), during which
 *   _produceTimer does not advance.
 */
class ZylonSpawner {
  /**
   * @param {object} opts
   * @param {number}    opts.q      — galaxy hex col
   * @param {number}    opts.r      — galaxy hex row
   * @param {GalaxyMap} opts.galaxy — reference
   */
  constructor({ q, r, galaxy }) {
    this.q      = q;
    this.r      = r;
    this.galaxy = galaxy;
    this.alive  = true;
    this.clanId = ZylonSpawner._nextClanId++;

    // ── Fleet inventory (live ships in sector) ──────────────────────────
    this.fleet = { tie: 0, bird: 0, warrior: 0 };

    // ── Seeker production counter ───────────────────────────────────────
    this.seekersMade = 0;
    this._maxSeekers = GameConfig.zylon.maxSeekersPerSpawner ?? 6;

    // ── Production ──────────────────────────────────────────────────────
    this.childCount     = 0;    // total children ever produced
    this._produceTimer  = 0;    // accumulates dt toward next child
    this._fleeTimer     = 0;    // > 0 while fleeing (production paused)

    // ── Off-screen bombardment ──────────────────────────────────────────
    this._bombardTimer = 0;

    // ── SectorView callbacks (set when player enters this sector) ────────
    this._onUnitBorn     = null;  // (type) → SectorView spawns a 3D ship
    this._onSpawnerKilled = null; // () → SectorView purges 3D ships

    // ── Seeker tracking (for onSeekerDestroyed callback) ─────────────────
    this._seekers = [];
  }

  get key() { return `${this.q},${this.r}`; }

  // ─────────────────────────────────────────────
  // PRODUCTION FORMULA
  // ─────────────────────────────────────────────

  /** Seconds to produce child number (childCount + 1). */
  get _nextProductionTime() {
    return 5 * Math.sqrt(this.childCount + 1);
  }

  // ─────────────────────────────────────────────
  // FLEET TARGETS
  // ─────────────────────────────────────────────

  get _targets() {
    if (this.seekersMade < this._maxSeekers) {
      return { tie: 1, bird: 1, warrior: 4 };
    }
    return { tie: 2, bird: 2, warrior: 5 };
  }

  // ─────────────────────────────────────────────
  // TICK
  // ─────────────────────────────────────────────

  tick(dt, galaxy) {
    if (!this.alive) return;

    // ── Flee timer (pauses production) ─────────────────────────────────
    if (this._fleeTimer > 0) {
      this._fleeTimer = Math.max(0, this._fleeTimer - dt);
      return;
    }

    // ── Off-screen starbase bombardment ────────────────────────────────
    const playerHere = galaxy.playerPos?.q === this.q && galaxy.playerPos?.r === this.r;
    if (!playerHere && this.fleet.warrior > 0) {
      const sb = galaxy.starbases.find(s => s.q === this.q && s.r === this.r && s.state === 'active');
      if (sb) {
        const interval = GameConfig.zylon.warriorFireIntervalSec ?? 8;
        this._bombardTimer += dt;
        if (this._bombardTimer >= interval) {
          this._bombardTimer = 0;
          sb.takeCombatHit(GameConfig.zylon.zylonTorpedoDamage ?? 10);
        }
      }
    }

    // ── Production timer ────────────────────────────────────────────────
    this._produceTimer += dt;
    if (this._produceTimer < this._nextProductionTime) return;
    this._produceTimer = 0;

    this._produce(galaxy);
  }

  // ─────────────────────────────────────────────
  // PRODUCTION LOGIC
  // ─────────────────────────────────────────────

  _produce(galaxy) {
    const targets = this._targets;

    // Priority 1: fill TIE
    if (this.fleet.tie < targets.tie) {
      this._birthFleetMember('tie', galaxy);
      return;
    }
    // Priority 2: fill Bird
    if (this.fleet.bird < targets.bird) {
      this._birthFleetMember('bird', galaxy);
      return;
    }
    // Priority 3: fill Warriors
    if (this.fleet.warrior < targets.warrior) {
      this._birthFleetMember('warrior', galaxy);
      return;
    }

    // Priority 4: produce Seekers (if under cap and not blocked by starbase)
    if (this.seekersMade < this._maxSeekers) {
      const sb = galaxy.starbases.find(s => s.q === this.q && s.r === this.r && s.state === 'active');
      if (sb) {
        // Blocked — warriors are already bombarding. Skip Seeker, produce nothing this cycle.
        return;
      }
      this._birthSeeker(galaxy);
    }
    // After maxSeekers, loop continues filling Phase 3 targets (handled above)
  }

  _birthFleetMember(type, galaxy) {
    this.fleet[type]++;
    this.childCount++;
    this._onUnitBorn?.(type);
    if (GameConfig.debug?.spawner) {
      console.log(`[Spawner ${this.clanId}] born ${type} (child ${this.childCount}, fleet=${JSON.stringify(this.fleet)})`);
    }
  }

  _birthSeeker(galaxy) {
    const dir    = this._pickSeekerDirection(galaxy);
    const seeker = new ZylonSeeker({ q: this.q, r: this.r, facing: dir, spawner: this, galaxy });
    this._seekers.push(seeker);
    galaxy.zylonSeekers.push(seeker);
    this.seekersMade++;
    this.childCount++;
    this._onUnitBorn?.('seeker');
    if (GameConfig.debug?.spawner) {
      console.log(`[Spawner ${this.clanId}] born seeker #${this.seekersMade} facing ${dir}`);
    }
  }

  _pickSeekerDirection(galaxy) {
    const usedFacings = new Set(this._seekers.filter(s => s.alive).map(s => s.facing));
    const free = [0, 1, 2, 3, 4, 5].filter(f => !usedFacings.has(f));
    if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
    return Math.floor(Math.random() * 6);
  }

  // ─────────────────────────────────────────────
  // FLEET LOSS (called by SectorView when a ship is killed)
  // ─────────────────────────────────────────────

  onFleetLoss(type) {
    if (!this.alive) return;
    if (this.fleet[type] !== undefined) {
      this.fleet[type] = Math.max(0, this.fleet[type] - 1);
    }
  }

  // ─────────────────────────────────────────────
  // SEEKER CALLBACKS
  // ─────────────────────────────────────────────

  onSeekerDestroyed(seeker) {
    this._seekers = this._seekers.filter(s => s !== seeker);
  }

  // ─────────────────────────────────────────────
  // FLEE (called when Spawner ship is hit)
  // ─────────────────────────────────────────────

  onHit() {
    this._fleeTimer = GameConfig.zylon.spawnerFleeTimeSec ?? 10;
  }

  // ─────────────────────────────────────────────
  // RED ALERT (called by GalaxyMap on first Spawner in a starbase sector)
  // ─────────────────────────────────────────────

  get isInStarbaseSector() {
    return !!(this.galaxy?.starbases?.find(sb => sb.q === this.q && sb.r === this.r));
  }

  // ─────────────────────────────────────────────
  // FAST-FORWARD SEEDING
  // ─────────────────────────────────────────────

  /**
   * Called by GalaxyMap._fastForwardZylons to run production at accelerated speed.
   * Ticks the spawner with a large dt until the first Seeker is ready.
   */
  fastForwardTick(dt, galaxy) {
    this._produceTimer += dt;
    while (this._produceTimer >= this._nextProductionTime) {
      this._produceTimer -= this._nextProductionTime;
      this._produce(galaxy);
    }
  }

  // ─────────────────────────────────────────────
  // DESTROY
  // ─────────────────────────────────────────────

  destroy() {
    if (!this.alive) return;
    this.alive       = false;
    this.fleet       = { tie: 0, bird: 0, warrior: 0 };
    // Kill all living Seekers that this Spawner produced
    for (const s of this._seekers) {
      if (s.alive) s.alive = false;
    }
    this._seekers = [];
    this._onSpawnerKilled?.();
  }
}

// Global clan counter
ZylonSpawner._nextClanId = 0;
