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
    this.q       = q;
    this.r       = r;
    this.galaxy  = galaxy;
    this.alive   = true;
    this.clanId  = ZylonSpawner._nextClanId++;

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
    this._bloomDirections = [0, 1, 2, 3, 4, 5];
    this._bloomSent = 0;

    // ── Lifecycle phase ───────────────────────────────────
    this._phase        = 'active';  // 'transit' | 'active'
    this._destBeacon   = null;      // for transit spawners: the beacon they will merge with
    this._defenseQueued = false;    // true once defender jobs are queued after bloom

    // ── SectorView callbacks (set when player is in this sector) ──
    this._onUnitBorn      = null;   // (type, data) — visual birth flash
    this._onDefenderBirth = null;   // (type) — spawn a sector-only defender
    this._onSpawnerKilled = null;   // () — sector-level clan kill cascade
    // Defenders that fired while no player was present — drained on sector entry
    this._pendingDefenders = [];    // array of type strings: 'warrior'|'tie'|'bird'

    // ── Tracking ─────────────────────────────────────────
    this._seekers  = [];
    this._warriors = [];
  }

  get key() { return `${this.q},${this.r}`; }

  // ─────────────────────────────────────────────
  // TICK — called every frame by GalaxyMap._updateZylons
  // ─────────────────────────────────────────────

  tick(dt, galaxy) {
    if (!this.alive) return;
    if (this._phase === 'transit') return;  // transit spawners don't produce until merged

    const isFastForwardBloom = galaxy.fastForwarding && this._bloomSent < 6;
    // Peek at next queued job's interval (replacements use 30s, normal is 60s)
    const queueInterval = this._queue[0]?.interval;
    this._produceInterval = isFastForwardBloom
      ? GameConfig.zylon.fastForwardStepSec
      : (queueInterval ?? GameConfig.zylon.spawnerSpawnIntervalSec);

    this._produceTimer += dt;
    if (this._produceTimer < this._produceInterval) return;
    this._produceTimer -= this._produceInterval;

    this._processProductionCycle(galaxy);
  }

  _processProductionCycle(galaxy) {
    // ── Priority 1: ANY beacon-signal job (warrior defence OR sub-spawner) ──
    const signalJob = this._queue.find(j => j.type === 'warrior' || (j.type === 'spawner' && j.beaconRef));
    if (signalJob) {
      if (signalJob.type === 'warrior') {
        if (this._warriorPairsSpawned < this._maxWarriorPairs) {
          this._spawnWarriorPair(signalJob.beaconRef, galaxy);
          signalJob.remaining--;
          if (signalJob.remaining <= 0) this._queue.splice(this._queue.indexOf(signalJob), 1);
        } else {
          this._queue.splice(this._queue.indexOf(signalJob), 1);
        }
      } else {
        // sub-spawner from resource beacon signal
        if (this._subSpawnersSpawned < this._maxSubSpawners) {
          this._spawnSubSpawner(signalJob.beaconRef, galaxy);
        }
        this._queue.splice(this._queue.indexOf(signalJob), 1);
      }
      this._checkExhaustion();
      return;
    }

    // ── Priority 2: initial bloom (6 seeker groups, one per direction) ──
    if (this._bloomSent < 6 && this._bloomDirections.length > 0) {
      const dir = this._bloomDirections.shift();
      this._spawnSeekerPair(dir, galaxy);
      this._bloomSent++;
      this._onUnitBorn?.('seeker_group', { clanId: this.clanId, warpAway: true });
      return;
    }

    // ── Priority 2.5: queue on-site defender sequence once bloom is complete ──
    if (!this._defenseQueued) {
      this._defenseQueued = true;
      this._queue.push({ type: 'defender_warrior', remaining: 2, interval: 60 });
      this._queue.push({ type: 'defender_tie',     remaining: 1, interval: 60 });
      this._queue.push({ type: 'defender_bird',    remaining: 1, interval: 60 });
    }

    // ── Priority 3: remaining queue items ──
    if (this._queue.length === 0) return;
    const job = this._queue[0];

    if (job.type === 'seeker') {
      if (this._seekerPairsSpawned < this._maxSeekerPairs) {
        const dir = this._pickReplacementDirection(galaxy);
        this._spawnSeekerPair(dir, galaxy);
        this._onUnitBorn?.('seeker_group', { clanId: this.clanId, warpAway: true });
      }
      this._queue.shift();
    } else if (job.type === 'defender_warrior') {
      if (this._onDefenderBirth) this._onDefenderBirth('warrior');
      else this._pendingDefenders.push('warrior');
      job.remaining--;
      if (job.remaining <= 0) this._queue.shift();
    } else if (job.type === 'defender_tie') {
      if (this._onDefenderBirth) this._onDefenderBirth('tie');
      else this._pendingDefenders.push('tie');
      this._queue.shift();
    } else if (job.type === 'defender_bird') {
      if (this._onDefenderBirth) this._onDefenderBirth('bird');
      else this._pendingDefenders.push('bird');
      this._queue.shift();
    }

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
      // Reset the production timer — the beacon deployment IS the starting gun.
      // Warriors should take exactly one full cycle (60s) from this moment.
      this._produceTimer = 0;
    } else if (beacon.type === 'resource') {
      this._queue.push({ type: 'spawner', beaconRef: beacon, remaining: 1 });
    }
  }

  /** Called when a Beacon guarded by our Seekers is destroyed. */
  onBeaconDestroyed(beacon, galaxy) {
    if (!this.alive) return;
    // If a transit sub-spawner was destined for this beacon, kill it — they are linked
    for (const sp of (galaxy?.zylonSpawners ?? [])) {
      if (sp._destBeacon === beacon && sp._phase === 'transit' && sp.alive) {
        sp.alive  = false;
        sp._queue = [];
        break;
      }
    }
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
    if (this._warriorPairsSpawned >= this._maxWarriorPairs) return;

    // Spawn TWO warriors per pair — they begin as READY and warp to any active beacon
    for (let i = 0; i < 2; i++) {
      const warrior = new ZylonWarrior({
        q: this.q,   // start at spawner's sector
        r: this.r,
        beacon,
        spawner: this,
      });
      // Near-immediate first check so they warp right away if a beacon is already active
      warrior._waitTimer = 29;
      this._warriors.push(warrior);
      galaxy.zylonWarriors.push(warrior);
    }
    this._warriorPairsSpawned++; // counts pairs, not individual warriors
  }

  _spawnSubSpawner(beacon, galaxy) {
    if (!beacon?.active) return;
    if (this._subSpawnersSpawned >= this._maxSubSpawners) return;

    const sub = new ZylonSpawner({ q: beacon.q, r: beacon.r, galaxy });
    sub._phase      = 'transit';  // born in transit — waits for merge before producing
    sub._destBeacon = beacon;     // the specific beacon it is destined to merge with
    galaxy.zylonSpawners.push(sub);
    this._subSpawnersSpawned++;

    // Birth visual in parent's sector (if player is present)
    this._onUnitBorn?.('sub_spawner', { clanId: this.clanId, warpAway: true });

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

  /**
   * Called by an active Beacon when its warrior count drops below the target.
   * Queues additional warrior pairs through the existing production pipeline.
   * If a warrior job for this beacon is already queued, tops it up rather than
   * adding a duplicate entry.
   */
  onResupplyRequested(beacon, pairsNeeded, galaxy) {
    if (!this.alive) return;
    if (!beacon.active) return;
    if (this._warriorPairsSpawned >= this._maxWarriorPairs) return; // lifetime cap reached

    const existing = this._queue.find(j => j.type === 'warrior' && j.beaconRef === beacon);
    if (existing) {
      // Increase the pending count if the deficit grew since last request
      existing.remaining = Math.max(existing.remaining, pairsNeeded);
    } else {
      this._queue.push({ type: 'warrior', beaconRef: beacon, remaining: pairsNeeded });
    }
  }

  // ─────────────────────────────────────────────
  // MERGE & DEFENDER CALLBACKS
  // ─────────────────────────────────────────────

  /** Called by SectorView when the transit spawner catches and merges with its beacon in 3D. */
  onMerged(newClanId) {
    this._phase      = 'active';
    this._destBeacon = null;
    this.clanId      = newClanId;   // new clan identity — all future units use this ID
    this._produceTimer = 0;         // start fresh production cadence
  }

  /** Called by SectorView when an on-site defender is destroyed; queues a 30s replacement. */
  onDefenderKilled(type) {
    if (!this.alive) return;
    const jobType = type === 'warrior' ? 'defender_warrior'
                  : type === 'tie'     ? 'defender_tie'
                  :                      'defender_bird';
    this._queue.push({ type: jobType, remaining: 1, interval: 30 });
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
    // ── Clan kill cascade: all units hatched by this Spawner die with it ──
    for (const s of this._seekers)  s.dead = true;
    for (const w of this._warriors) w.dead = true;
    // Mark all beacons of this clan dead on the galaxy map
    this.galaxy?._markBeaconsDeadForClan?.(this.clanId);
    // Notify SectorView (if player is present) to purge all matching 3D Zylons
    this._onSpawnerKilled?.();
  }
}

// Global clan counter — increments each time a new Spawner (initial or sub) is created.
ZylonSpawner._nextClanId = 0;
