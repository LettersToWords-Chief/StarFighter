/**
 * ZylonSpawner.js — Zylon production hub.
 *
 * Every Spawner (initial and sub-spawners) is identical in behavior:
 *  1. Immediately begins producing 6 Seeker pairs — one per hex direction, 1 pair per minute.
 *  2. After the bloom, waits for Beacon signals to decide what to produce next.
 *  3. Responds to beacon signals: starbase → 2 Warrior pairs; resource → 1 sub-Spawner.
 *  4. Re-sends 1 Seeker pair whenever one of its Beacons is destroyed.
 *  5. Lifetime caps: 12 Seeker pairs · 12 Warrior pairs · 2 sub-Spawners → then dies.
 *
 * Each Seeker/Warrior is tied to the Spawner that created it.
 */

class ZylonSpawner {
  /**
   * @param {object} opts
   * @param {number}    opts.q        — galaxy hex col
   * @param {number}    opts.r        — galaxy hex row
   * @param {GalaxyMap} opts.galaxy   — reference for callbacks
   */
  constructor({ q, r, galaxy }) {
    this.q      = q;
    this.r      = r;
    this.galaxy = galaxy;
    this.alive  = true;

    // ── Lifetime counters ──────────────────────────────────
    const cfg = GameConfig.zylon;
    this._maxSeekerPairs   = cfg.maxSeekerPairsPerSpawner;   // 12
    this._maxWarriorPairs  = cfg.maxWarriorPairsPerSpawner;  // 12
    this._maxSubSpawners   = cfg.maxSubSpawnersPerSpawner;   // 2

    this._seekerPairsSpawned   = 0;
    this._warriorPairsSpawned  = 0;
    this._subSpawnersSpawned   = 0;

    // ── Production queue ──────────────────────────────────
    // Each item: { type: 'seeker'|'warrior'|'spawner', beaconRef, remaining }
    this._queue        = [];
    this._produceTimer    = 0;
    this._produceInterval = GameConfig.zylon.spawnerSpawnIntervalSec; // 60 s

    // ── Bloom state ──────────────────────────────────────
    // Directions still needing initial seekers
    this._bloomDirections = [0, 1, 2, 3, 4, 5]; // facing indices: 0=12 o'clock … 5=10 o'clock
    this._bloomSent = 0; // pairs dispatched so far

    // ── Tracking ─────────────────────────────────────────
    this._seekers  = []; // all living Seekers from this Spawner
    this._warriors = []; // all living Warriors from this Spawner
  }

  get key() { return `${this.q},${this.r}`; }

  // ─────────────────────────────────────────────
  // TICK — called every frame by GalaxyMap._updateZylons
  // ─────────────────────────────────────────────

  tick(dt, galaxy) {
    if (!this.alive) return;

    // Interval is always the real game value — the caller scales dt during fast-forward
    this._produceInterval = GameConfig.zylon.spawnerSpawnIntervalSec;

    this._produceTimer += dt;
    if (this._produceTimer < this._produceInterval) return;
    this._produceTimer -= this._produceInterval; // carry remainder

    this._processProductionCycle(galaxy);
  }

  _processProductionCycle(galaxy) {
    // ── Priority 1: initial bloom (6 pairs, one per direction) ──
    if (this._bloomSent < 6 && this._bloomDirections.length > 0) {
      const dir = this._bloomDirections.shift();
      this._spawnSeekerPair(dir, galaxy);
      this._bloomSent++;
      return; // one unit per cycle
    }

    // ── The queue now drives everything ──
    if (this._queue.length === 0) return;

    const job = this._queue[0];

    if (job.type === 'warrior') {
      if (this._warriorPairsSpawned < this._maxWarriorPairs) {
        this._spawnWarriorPair(job.beaconRef, galaxy);
        job.remaining--;
        if (job.remaining <= 0) this._queue.shift();
      } else {
        this._queue.shift(); // cap reached — skip
      }
    } else if (job.type === 'seeker') {
      if (this._seekerPairsSpawned < this._maxSeekerPairs) {
        // Replacement seeker: pick any open direction or a random one
        const dir = this._pickReplacementDirection(galaxy);
        this._spawnSeekerPair(dir, galaxy);
      }
      this._queue.shift();
    } else if (job.type === 'spawner') {
      if (this._subSpawnersSpawned < this._maxSubSpawners) {
        this._spawnSubSpawner(job.beaconRef, galaxy);
      }
      this._queue.shift();
    }

    // Check if this Spawner has exhausted all limits
    this._checkExhaustion();
  }

  // ─────────────────────────────────────────────
  // BEACON EVENTS
  // ─────────────────────────────────────────────

  /** Called by a Seeker when it deploys a Beacon. */
  onBeaconDeployed(beacon, galaxy) {
    if (!this.alive) return;

    if (beacon.type === 'starbase') {
      // Fire Red Alert the first time any starbase Beacon is planted —
      // works in both normal play and test mode.
      if (!galaxy.redAlert) {
        galaxy.redAlert = true;
        if (galaxy.onRedAlert) galaxy.onRedAlert();
      }
      // Queue 2 Warrior pairs for this beacon
      const pairs = GameConfig.zylon.warriorPairsPerBeacon; // 2
      this._queue.push({ type: 'warrior', beaconRef: beacon, remaining: pairs });
    } else if (beacon.type === 'resource') {
      this._queue.push({ type: 'spawner', beaconRef: beacon, remaining: 1 });
    }
  }

  /** Called when a Beacon guarded by our Seekers is destroyed. */
  onBeaconDestroyed(beacon, galaxy) {
    if (!this.alive) return;
    // Queue a replacement Seeker pair
    this._queue.push({ type: 'seeker', beaconRef: null, remaining: 1 });
  }

  // ─────────────────────────────────────────────
  // UNIT CREATION
  // ─────────────────────────────────────────────

  _spawnSeekerPair(direction, galaxy) {
    if (this._seekerPairsSpawned >= this._maxSeekerPairs) return;

    const seeker = new ZylonSeeker({
      q: this.q,
      r: this.r,
      facing: direction,   // direction is now an integer 0–5
      spawner: this,
      galaxy,
    });
    this._seekers.push(seeker);
    galaxy.zylonSeekers.push(seeker);
    this._seekerPairsSpawned++;
  }

  _spawnWarriorPair(beacon, galaxy) {
    if (!beacon?.active) return; // beacon was destroyed while warriors were queued
    if (this._warriorPairsSpawned >= this._maxWarriorPairs) return;

    // Spawn TWO warriors per pair — staggered warp delays so they don't arrive at the exact same tick
    for (let i = 0; i < 2; i++) {
      const warrior = new ZylonWarrior({
        q: beacon.q,
        r: beacon.r,
        beacon,
        spawner: this,
      });
      // Small fixed stagger so the pair don't appear on the exact same tick
      warrior._warpTimer = -(i * 2); // second warrior arrives ~2s after the first
      this._warriors.push(warrior);
      galaxy.zylonWarriors.push(warrior);
    }
    this._warriorPairsSpawned++; // counts pairs, not individual warriors
  }

  _spawnSubSpawner(beacon, galaxy) {
    if (!beacon?.active) return;
    if (this._subSpawnersSpawned >= this._maxSubSpawners) return;

    const sub = new ZylonSpawner({ q: beacon.q, r: beacon.r, galaxy });
    galaxy.zylonSpawners.push(sub);
    this._subSpawnersSpawned++;

    // Notify galaxy map so it can start ticking the new spawner
    galaxy._onSubSpawnerCreated(sub);
  }

  // ─────────────────────────────────────────────
  // UNIT DEATH CALLBACKS
  // ─────────────────────────────────────────────

  onSeekerDestroyed(seeker) {
    this._seekers = this._seekers.filter(s => s !== seeker);
  }

  onWarriorDestroyed(warrior) {
    this._warriors = this._warriors.filter(w => w !== warrior);
  }

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────

  _pickReplacementDirection(galaxy) {
    // Prefer a facing not already used by a living Seeker
    const usedFacings = new Set(this._seekers.map(s => s.facing));
    const free = [0, 1, 2, 3, 4, 5].filter(f => !usedFacings.has(f));
    if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
    // All facings occupied — pick random
    return Math.floor(Math.random() * 6);
  }

  _checkExhaustion() {
    const done =
      this._seekerPairsSpawned  >= this._maxSeekerPairs &&
      this._warriorPairsSpawned >= this._maxWarriorPairs &&
      this._subSpawnersSpawned  >= this._maxSubSpawners &&
      this._queue.length === 0;

    if (done) {
      this.alive = false;
      // GalaxyMap will clean up dead spawners on next pass
    }
  }

  // ─────────────────────────────────────────────
  // COMBAT (player destroys the Spawner itself)
  // ─────────────────────────────────────────────

  destroy() {
    this.alive  = false;
    this._queue = [];
  }
}
