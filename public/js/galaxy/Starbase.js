/**
 * Starbase.js — Represents a single starbase on the galaxy map.
 *
 * Inventory system:
 *   - Outer bases hold manufactured goods (shipped from capital) + raw materials (always replenished).
 *   - Capital holds raw materials received from outer bases and manufactures finished goods.
 *   - Each manufacturing recipe runs as an independent queue; queues compete for shared raws
 *     using shortage-severity ordering (output farthest below target % wins access first).
 */

class Starbase {
  /**
   * @param {object} opts
   * @param {number}  opts.q
   * @param {number}  opts.r
   * @param {string}  opts.name
   * @param {boolean} opts.isCapital
   * @param {number}  opts.sensorRange
   * @param {object|null} opts.produces  — { key, label, color } — raw resource this hex yields
   */
  constructor({ q, r, name, isCapital = false, sensorRange = 0, produces = null }) {
    this.q          = q;
    this.r          = r;
    this.name       = name;
    this.isCapital  = isCapital;
    this.sensorRange = sensorRange;
    this.produces   = produces;

    // Status
    this.state      = 'active'; // 'active' | 'dormant' | 'occupied'
    this.shields    = 100;
    this.underAttack     = false;
    this.distressActive  = false;

    // Upgrade levels
    this.sensorLevel  = sensorRange;
    this.repairLevel  = 1;
    this.stockpileLevel = 1;

    // ---- Inventory ----
    // Outer bases: primed with 1 of each spare part — normal operating day, not day 1.
    // Capital: starts at half its safety-stock targets.
    const tgt = isCapital ? GameConfig.capital.target : GameConfig.starbase.outerTarget;
    this.inventory = {
      energy:        isCapital ? Math.floor(tgt.energy        / 2) : Math.floor(tgt.energy / 2),
      engineParts:   isCapital ? Math.floor(tgt.engineParts   / 2) : 1,
      cannonParts:   isCapital ? Math.floor(tgt.cannonParts   / 2) : 1,
      shieldParts:   isCapital ? Math.floor(tgt.shieldParts   / 2) : 1,
      computerParts: isCapital ? Math.floor(tgt.computerParts / 2) : 1,
      torpedoes:     isCapital ? Math.floor(tgt.torpedoes     / 2) : 50,
      spareParts:    isCapital ? Math.floor(tgt.spareParts    / 2) : 1,
    };

    // Raws: capital primed with 1 full delivery (2000 units) of each raw.
    // Outer bases have infinite raws — they never run out.
    const rawPrime = isCapital ? GameConfig.supplyShip.inboundRawAmount : 0;
    this.raws = {
      plasma:   rawPrime,
      duranite: rawPrime,
      organics: rawPrime,
      isotopes: rawPrime,
    };

    // ---- Inventory targets ----
    const cfg = GameConfig;
    this.target = isCapital
      ? { ...cfg.capital.target }
      : { ...cfg.starbase.outerTarget };

    // ---- Manufacturing (capital only) ----
    // One queue object per recipe; they run in parallel.
    this._mfgQueues = isCapital
      ? GameConfig.capital.recipes.map(recipe => ({
          recipe,
          active:   false,   // true = cycle in progress
          progress: 0,       // seconds elapsed in current cycle
        }))
      : null;
  }

  // ------------------------------------------------------------------
  get key() { return HexMath.key(this.q, this.r); }

  visibleSectors() {
    return HexMath.hexesInRange(this.q, this.r, this.sensorLevel);
  }

  // ------------------------------------------------------------------
  // TICK METHODS (called every frame from GalaxyMap._updateSupplyShips)
  // ------------------------------------------------------------------

  /** Master tick — calls the right sub-ticks depending on base type. */
  tick(dt) {
    if (this.state !== 'active') return;
    if (this.isCapital) {
      this._capitalPlasmaTick(dt);
      this._manufacturingTick(dt);
    } else {
      this._maintenanceTick(dt);
    }
  }

  /** Capital passively harvests plasma from its nebula sector. */
  _capitalPlasmaTick(dt) {
    const cfg = GameConfig.capital;
    this.raws.plasma = Math.min(
      cfg.plasmaRawCap ?? 500,
      (this.raws.plasma ?? 0) + cfg.plasmaHarvestPerSec * dt
    );
  }

  /** Outer bases drain energy and spare parts for maintenance. */
  _maintenanceTick(dt) {
    const cfg = GameConfig.starbase;
    this.inventory.energy = Math.max(0,
      this.inventory.energy - cfg.maintenanceEnergyPerSec * dt);
    this.inventory.spareParts = Math.max(0,
      this.inventory.spareParts - cfg.maintenancePartsPerSec * dt);
  }

  /**
   * Capital manufacturing — runs all 6 queues in parallel.
   *
   * Shared-raw contention: before each tick we sort active queues by
   * shortage severity (how far their output is below target, as a fraction).
   * The most-needed output gets first pick of raws.
   */
  _manufacturingTick(dt) {
    if (!this._mfgQueues) return;

    // Sort queues by shortage severity (descending) so the most-needed
    // output wins when raws are scarce.
    const sorted = [...this._mfgQueues].sort((a, b) => {
      const sevA = this._shortage(a.recipe.output);
      const sevB = this._shortage(b.recipe.output);
      return sevB - sevA;
    });

    for (const q of sorted) {
      const { recipe } = q;
      const tgt = this.target[recipe.output] ?? 0;

      // Don't start a new cycle if already at or above target
      if (!q.active && (this.inventory[recipe.output] ?? 0) >= tgt) continue;

      // Start a new cycle: check + reserve inputs
      if (!q.active) {
        if (!this._canAfford(recipe.inputs)) continue;
        this._consumeInputs(recipe.inputs);
        q.active   = true;
        q.progress = 0;
      }

      // Advance the cycle
      q.progress += dt;
      if (q.progress >= recipe.cycleSeconds) {
        // Output recipe.amount units (defaults to 1 for parts, 10000 for energy)
        const amount = recipe.amount ?? 1;
        this.inventory[recipe.output] = Math.min(
          this.target[recipe.output] ?? Infinity,
          (this.inventory[recipe.output] ?? 0) + amount
        );
        q.active   = false;
        q.progress = 0;
      }
    }
  }

  /** Fraction by which an output item is below its target (0 = at target, 1 = empty). */
  _shortage(key) {
    const tgt = this.target[key] ?? 1;
    const cur = this.inventory[key] ?? 0;
    return Math.max(0, (tgt - cur) / tgt);
  }

  _canAfford(inputs) {
    for (const [raw, amount] of Object.entries(inputs)) {
      if ((this.raws[raw] ?? 0) < amount) return false;
    }
    return true;
  }

  _consumeInputs(inputs) {
    for (const [raw, amount] of Object.entries(inputs)) {
      this.raws[raw] = Math.max(0, (this.raws[raw] ?? 0) - amount);
    }
  }

  // ------------------------------------------------------------------
  // CARGO TRANSFER
  // ------------------------------------------------------------------

  /**
   * Receive a cargo manifest from a docking supply ship.
   * @param {object} manifest — { energy?, engineParts?, cannonParts?, ... }
   */
  receiveDelivery(manifest) {
    for (const [key, amount] of Object.entries(manifest)) {
      if (amount <= 0) continue;
      if (key in this.inventory) {
        this.inventory[key] = Math.min(
          this.target[key] ?? Infinity,
          (this.inventory[key] ?? 0) + amount
        );
      } else if (key in this.raws) {
        // Raw material delivery to capital
        this.raws[key] = (this.raws[key] ?? 0) + amount;
      }
    }
  }

  /**
   * Build a cargo manifest for a departing supply ship.
   * Outbound (capital → outer base): fill ship slots with what the destination needs most.
   * Inbound (outer base → capital): always return 2000 units of this base's raw material.
   *
   * @param {'outbound'|'inbound'} direction
   * @param {Starbase|null} destination — needed for outbound to know what to prioritise
   * @returns {object} manifest
   */
  buildDepartureCargo(direction, destination = null) {
    if (direction === 'inbound') {
      // Outer base → capital: infinite raw supply
      const rawKey = this.produces?.key ?? 'duranite';
      return { [rawKey]: GameConfig.supplyShip.inboundRawAmount };
    }

    // Outbound (capital → outer base): load template, keeping only what's above strategic reserve
    const slots    = GameConfig.supplyShip.outboundCargo;
    const reserve  = GameConfig.capital.strategicReserve;
    const manifest = {};
    for (const [key, capacity] of Object.entries(slots)) {
      const onHand    = this.inventory[key] ?? 0;
      const floor     = reserve[key] ?? 0;          // never ship below this
      const available = Math.max(0, onHand - floor);
      const load      = Math.min(capacity, available);
      if (load > 0) {
        this.inventory[key] = onHand - load;
        manifest[key] = load;
      }
    }

    return manifest;
  }

  // ------------------------------------------------------------------
  // COMBAT
  // ------------------------------------------------------------------

  siegeTick(deltaSeconds) {
    if (this.state !== 'active') return false;
    const drainRate = 5 * deltaSeconds;
    this.inventory.energy  = Math.max(0, (this.inventory.energy ?? 0) - drainRate * 20);
    this.shields           = Math.max(0, this.shields - drainRate);
    if (this.shields <= 0) {
      this.state          = 'dormant';
      this.underAttack    = false;
      this.distressActive = false;
      return false;
    }
    this.distressActive = this.shields < 40;
    return true;
  }

  /**
   * Called by ZylonWarrior on each warpedo impact.
   * Drains energy; when energy hits 0 shields cannot recharge → shields fail.
   */
  warpedoHit(shieldDamage, energyDamage) {
    if (this.state !== 'active' && this.state !== 'underAssault') return;
    this.state       = 'underAssault';
    this.underAttack = true;

    // Energy absorbs the hit cost first
    this.inventory.energy = Math.max(0, (this.inventory.energy ?? 0) - energyDamage);

    // Shields drain; rate is faster when energy is low (can't recharge as fast)
    this.shields = Math.max(0, this.shields - shieldDamage);

    this.distressActive = this.shields < 40 || (this.inventory.energy ?? 0) < 5000;

    // When energy is exhausted, shields fail permanently
    if ((this.inventory.energy ?? 0) <= 0) {
      this._onShieldsFailed();
    }
  }

  /** Shields have failed — starbase is now vulnerable; Zylons will summon a Spawner. */
  _onShieldsFailed() {
    this.shields    = 0;
    this.state      = 'shieldsFailed';
    this.underAttack = true;
    this.distressActive = true;
    // Galaxy map listens for this via onStarbaseFallen callback
    if (this.onShieldsFailed) this.onShieldsFailed(this);
  }

  repairTick(deltaSeconds) {
    const rate = 10 * this.repairLevel * deltaSeconds;
    this.shields = Math.min(100, this.shields + rate);
  }

  // ------------------------------------------------------------------
  // INVENTORY SUMMARY (for tooltip / UI)
  // ------------------------------------------------------------------

  /** Returns a human-readable inventory snapshot for the tooltip. */
  inventorySummary() {
    const inv = this.inventory;
    const lines = [];
    const fmt = (label, val, tgt) =>
      `${label}: ${Math.floor(val)} / ${tgt}`;

    lines.push(fmt('ENERGY',    inv.energy        ?? 0, this.target.energy));
    lines.push(fmt('ENGINES',   inv.engineParts   ?? 0, this.target.engineParts));
    lines.push(fmt('CANNONS',   inv.cannonParts   ?? 0, this.target.cannonParts));
    lines.push(fmt('SHIELDS',   inv.shieldParts   ?? 0, this.target.shieldParts));
    lines.push(fmt('COMPUTERS', inv.computerParts ?? 0, this.target.computerParts));
    lines.push(fmt('TORPEDOES', inv.torpedoes     ?? 0, this.target.torpedoes));
    lines.push(fmt('SPARE PTS', inv.spareParts    ?? 0, this.target.spareParts));

    if (this.isCapital) {
      lines.push('--- RAWS ---');
      for (const [k, v] of Object.entries(this.raws)) {
        lines.push(`${k.toUpperCase()}: ${Math.floor(v)}`);
      }
    }
    return lines;
  }
}
