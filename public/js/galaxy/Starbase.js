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
    this.state      = 'active'; // 'active' | 'dormant'
    this.shieldCharge     = 1000;  // 0–1000 energy pool; shields display = shieldCharge / 10
    this.shields          = 100;   // 0–100 display (derived from shieldCharge)
    this.underAttack      = false;
    this.distressActive   = false;

    // ---- Subspace messaging state ----
    this._attackCooldown  = 0;     // seconds until next "under attack" message may fire
    this._seekerDetected  = false; // true while Zylons are present in this sector
    this._energyLowSent   = false; // true after "defenses low" message; resets above 10000
    this._energyCritSent  = false; // true after "defenses critical" message; resets above 2000

    // Upgrade levels
    this.sensorLevel  = sensorRange;
    this.repairLevel  = 1;
    this.stockpileLevel = 1;

    // ---- Inventory ----
    // Outer bases: primed with 1 of each spare part — normal operating day, not day 1.
    // Capital: starts at half its safety-stock targets.
    const tgt = isCapital ? GameConfig.capital.target : GameConfig.starbase.outerTarget;
    const capStart = GameConfig.capital.capitalStart ?? {};
    this.inventory = {
      energy:        isCapital
        ? (capStart.energy        ?? Math.floor(tgt.energy / 2))
        : (GameConfig.testMode ? GameConfig.zylon.testMode_starbaseEnergy : Math.floor(tgt.energy / 2)),
      engineParts:   isCapital ? (capStart.engineParts   ?? Math.floor(tgt.engineParts   / 2)) : 1,
      cannonParts:   isCapital ? (capStart.cannonParts   ?? Math.floor(tgt.cannonParts   / 2)) : 1,
      shieldParts:   isCapital ? (capStart.shieldParts   ?? Math.floor(tgt.shieldParts   / 2)) : 1,
      computerParts: isCapital ? (capStart.computerParts ?? Math.floor(tgt.computerParts / 2)) : 2,
      torpedoes:     isCapital ? (capStart.torpedoes     ?? Math.floor(tgt.torpedoes     / 2)) : 50,
      spareParts:    isCapital ? (capStart.spareParts    ?? Math.floor(tgt.spareParts    / 2)) : 1,
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
          active:   false,
          progress: 0,
        }))
      : null;

    // ---- Ship build queue (capital only) ----
    this._buildInProgress = null;  // the SupplyShip being rebuilt
    this._buildTimer      = 0;     // seconds remaining on current build
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
    if (this.isCapital) {
      if (this.state !== 'active') return;
      this._capitalPlasmaTick(dt);
      this._manufacturingTick(dt);
    } else if (this.state === 'active') {
      this._maintenanceTick(dt);
      this._shieldRechargeTick(dt);
      this._messagingTick(dt);
    } else if (this.state === 'dormant') {
      // Even when dormant, run the recharge tick so a supply ship can restore us
      this._shieldRechargeTick(dt);
    }
  }

  /**
   * Check energy thresholds and fire subspace messages when crossed.
   * Also ticks down the attack-notification cooldown.
   */
  _messagingTick(dt) {
    // Attack cooldown
    if (this._attackCooldown > 0) this._attackCooldown = Math.max(0, this._attackCooldown - dt);

    const energy = this.inventory.energy ?? 0;

    // Defenses Low: energy falls below 10 000
    if (energy < 10000 && !this._energyLowSent) {
      this._energyLowSent = true;
      this._sendMessage('DEFENSES LOW — ENERGY RESERVES INSUFFICIENT');
    } else if (energy >= 10000 && this._energyLowSent) {
      this._energyLowSent = false; // reset so message can fire again if energy drops again
    }

    // Defenses Critical: energy falls below 2 000
    if (energy < 2000 && !this._energyCritSent) {
      this._energyCritSent = true;
      this._sendMessage('DEFENSES CRITICAL — IMMEDIATE ASSISTANCE REQUIRED');
    } else if (energy >= 2000 && this._energyCritSent) {
      this._energyCritSent = false;
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
      (this.inventory.energy ?? 0) - (cfg.maintenanceEnergyPerSec ?? 0) * dt);
    this.inventory.spareParts = Math.max(0,
      (this.inventory.spareParts ?? 0) - (cfg.maintenancePartsPerSec ?? 0) * dt);
  }

  /**
   * Recharge shield buffer from starbase energy.
   * Rate: 100 shield/sec = 100 energy/sec drained from inventory.
   * If energy is exhausted, shields cannot recharge.
   * If shields reach 0, the base goes dormant.
   */
  _shieldRechargeTick(dt) {
    const energyOn  = (this.inventory.energy ?? 0) >= 1;
    const shieldsOn = this.shieldCharge >= 1;

    // Hold shields at full only while actively online
    if (energyOn && this.state === 'active') this.shieldCharge = 1000;

    this.shields        = Math.round(this.shieldCharge / 10);
    this.distressActive = !energyOn;

    // Dormant base: energy restored from outside — reactivate
    if (this.state === 'dormant') {
      if (energyOn) {
        this.shieldCharge   = 1000;
        this.shields        = 100;
        this.state          = 'active';
        this.underAttack    = false;
        this.distressActive = false;
        if (this.onRestored) this.onRestored(this);
      }
      return;
    }

    // Active base: energy AND shields both gone → dormant
    if (this.state === 'active' && !energyOn && !shieldsOn) {
      this._onShieldsFailed();
    }
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

  /**
   * Capital ship build queue.
   * Detects destroyed ships, checks inventory, commissions a replacement.
   * Called from GalaxyMap._updateSupplyShips() with the full ships array.
   *
   * @param {number}       dt
   * @param {SupplyShip[]} ships
   */
  _shipBuildTick(dt, ships) {
    if (!this.isCapital || this.state !== 'active') return;
    const recipe = GameConfig.supplyShip.buildRecipe;
    if (!recipe) return;

    // Advance current build
    if (this._buildInProgress) {
      this._buildTimer -= dt;
      if (this._buildTimer <= 0) {
        // ── Build complete: reset ship to full health at capital endpoint ──
        const ship        = this._buildInProgress;
        ship.health       = GameConfig.supplyShip.maxHealth;
        ship.destroyed    = false;
        ship.pathIndex    = 0;                   // back at capital
        ship.forward      = true;                // heading toward outer base
        ship.state        = 'recharge';
        ship.stateTimer   = ship.baseRecharge;
        ship.fuel         = GameConfig.supplyShip.fuelCapacity;
        ship._pendingFuelDelivery = 0;
        ship._pendingRepairHp     = 0;
        // if (GameConfig.testMode) {
        //   const sid = ship.outerBase?.name || ship.resource || 'CARGO';
        //   const clk = window.SubspaceComm?.clockStr?.() || '?';
        //   window.SubspaceComm?.send('CARGO BUILT', clk,
        //     `[${sid}] NEW SHIP COMMISSIONED`);
        // }
        this._buildInProgress = null;
      }
      return; // one build at a time
    }

    // Look for the first destroyed ship on any route
    const destroyed = ships.find(s => s.destroyed);
    if (!destroyed) return;

    // Check recipe ingredients are available
    const inv = this.inventory;
    if ((inv.spareParts    ?? 0) < recipe.spareParts    ||
        (inv.engineParts   ?? 0) < recipe.engineParts   ||
        (inv.computerParts ?? 0) < recipe.computerParts) return;

    // Consume parts and start build
    inv.spareParts    -= recipe.spareParts;
    inv.engineParts   -= recipe.engineParts;
    inv.computerParts -= recipe.computerParts;
    this._buildInProgress = destroyed;
    this._buildTimer      = recipe.buildSeconds;

    // if (GameConfig.testMode) {
    //   const sid = destroyed.outerBase?.name || destroyed.resource || 'CARGO';
    //   const clk = window.SubspaceComm?.clockStr?.() || '?';
    //   window.SubspaceComm?.send('CARGO BUILD', clk,
    //     `[${sid}] BUILD STARTED — ${recipe.buildSeconds}s`);
    // }
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

  /**
   * Called by SectorView when a player photon round hits the starbase shield.
   * Drains shieldCharge directly; if charge hits zero, base goes dormant.
   */
  hitByPhoton() {
    if (this.state !== 'active') return;
    this.underAttack  = true;
    const damage      = GameConfig.zylon.torpedoDamage ?? 185;
    this.shieldCharge = Math.max(0, this.shieldCharge - damage);
    this.shields      = Math.round(this.shieldCharge / 10);
    if (this.shieldCharge <= 0) {
      this._onShieldsFailed();
    }
  }

  /**
   * Called by SectorView when a Warrior cannon round hits the starbase shield.
   * Phase 1 — energy > 0: drain inventory.energy (shields held at full by _shieldRechargeTick).
   * Phase 2 — energy = 0: drain shieldCharge directly (same as a player photon hit),
   *            triggering dormant when charge reaches 0.
   */
  takeCombatHit(damage) {
    if (this.state !== 'active') return;
    this.underAttack = true;

    // "Under attack" subspace message — fires when cooldown is off, then resets it
    if (this._attackCooldown <= 0) {
      this._sendMessage('UNDER ATTACK — SHIELDS TAKING FIRE');
    }
    this._attackCooldown = 60; // reset cooldown on every hit

    if ((this.inventory.energy ?? 0) > 0) {
      this.inventory.energy = Math.max(0, this.inventory.energy - damage);
    } else {
      // Energy gone — hit the shields directly
      this.shieldCharge = Math.max(0, this.shieldCharge - damage);
      if (this.shieldCharge <= 0) this._onShieldsFailed();
    }
  }

  /** Shields have failed — starbase goes dormant; must be kickstarted by the player. */
  _onShieldsFailed() {
    this.shieldCharge     = 0;
    this.shields          = 0;
    this.inventory.energy = 0;
    this.state            = 'dormant';
    this.underAttack      = false;
    this.distressActive   = false;
    this._seekerDetected  = false;
    this._attackCooldown  = 0;
    this._sendMessage('DEFENSES LOST — STARBASE OFFLINE');
    if (this.onShieldsFailed) this.onShieldsFailed(this);
  }

  // ------------------------------------------------------------------
  // SUBSPACE MESSAGING
  // ------------------------------------------------------------------

  /**
   * Called by ZylonSeeker when it enters this sector.
   * Sends a detection message the first time; subsequent arrivals are silent
   * until the sector is cleared.
   */
  onSeekerEntered() {
    if (this._seekerDetected) return;
    this._seekerDetected = true;
    const msg = this.isCapital
      ? 'ZYLON FORCES DETECTED — CAPITAL UNDER THREAT'
      : 'ZYLON FORCES DETECTED IN SECTOR';
    this._sendMessage(msg);
  }

  /**
   * Called by SectorView when the last Zylon is eliminated.
   * Resets the detection flag so the next arrival triggers a fresh message.
   */
  onSectorCleared() {
    this._seekerDetected = false;
  }

  /** Internal helper — sends via window.SubspaceComm if available. */
  _sendMessage(text) {
    const comm = window.SubspaceComm;
    if (!comm) return;
    const clk = comm.clockStr?.() || '?';
    comm.send(this.name.toUpperCase(), clk, text);
  }

  /**
   * Player transfers energy to restart the starbase.
   * Fully restores shields and returns to active state.
   */
  kickstart() {
    // Player transfers kickstart energy to the base, restoring power and shields
    this.inventory.energy = GameConfig.zylon.starbaseKickstartEnergy;
    this.shieldCharge     = 1000;
    this.shields          = 100;
    this.state            = 'active';
    this.underAttack      = false;
    this.distressActive   = false;
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
