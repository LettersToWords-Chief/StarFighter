/**
 * GameConfig.js — Central balance constants for Star Fighter.
 *
 * All tunable values live here. Nothing is hard-coded elsewhere.
 * Tech upgrades multiply these base values; difficulty modifiers scale them.
 *
 * Units:
 *   Rates  — units per real-time second (during active game tick)
 *   Capacity — total units storable
 *   Cost   — units consumed per event
 */

const GameConfig = Object.freeze({

  // =========================================================
  // SUPPLY SHIP (cargo ship NPC)
  // =========================================================
  supplyShip: {
    /** Total energy a cargo ship carries (used for jump fuel + delivery). */
    energyCapacity: 3000,

    /** Energy consumed per one-hex jump. */
    energyPerJump: 100,

    /** Cargo slots per outbound leg (capital → outer base). */
    outboundCargo: Object.freeze({
      spareParts:    3,   // generic ship-repair parts
      engineParts:   1,
      cannonParts:   1,
      shieldParts:   1,
      computerParts: 1,
      torpedoes:     10,
    }),

    /** Raw material units loaded per inbound leg (outer base → capital). */
    inboundRawAmount: 2000,

    /** Idle cooldown while warp drive recharges (seconds). */
    rechargeTime: 36,

    /** Acceleration burn before the hyperspace flash (seconds). */
    warpBurnTime: 4,

    /** In-sector flight speed (units/sec). */
    sectorSpeed: 6,

    /** Spawn offset from starbase (units). */
    spawnOffset: 90,

    /** Seconds docked at starbase (covers drone exchange). */
    dockTime: 10,

    /** Legacy fuel capacity reference (used by SupplyShip internal tracking). */
    fuelCapacity: 3000,

    /** Generic spare parts required to build a replacement cargo ship. */
    replacementCost: 10,

    /** HP threshold — replace component at dock if HP ≤ this fraction. */
    replaceThreshold: 0.50,

    /** HP threshold — skip replacement if HP ≥ this fraction. */
    skipThreshold: 0.90,
  },

  // =========================================================
  // STARBASE ECONOMY
  // =========================================================
  starbase: {
    /**
     * Outer base inventory targets.
     * Pull system: when stock falls below target, next outbound ship
     * prioritises refilling that item.
     */
    outerTarget: Object.freeze({
      energy:        100000,
      engineParts:   4,
      cannonParts:   3,
      shieldParts:   2,
      computerParts: 2,
      torpedoes:     100,
      spareParts:    20,
    }),

    /**
     * Passive maintenance drain per second at each outer base.
     * Represents life support, navigation, point defence.
     */
    maintenanceEnergyPerSec: 10,     // ~600 per minute
    maintenancePartsPerSec:  0.005,  // ~0.3 parts per minute
  },

  // =========================================================
  // CAPITAL
  // =========================================================
  capital: {
    /** Capital inventory targets (pull triggers manufacturing). */
    target: Object.freeze({
      energy:        100000,
      engineParts:   8,
      cannonParts:   6,
      shieldParts:   4,
      computerParts: 4,
      torpedoes:     200,
      spareParts:    40,
    }),

    /** Passive energy replenishment at the capital (units/sec). */
    energyReplenishPerSec: 167,  // ≈ 10 000 per minute

    /**
     * Manufacturing recipes.
     * All inputs must be present simultaneously before the cycle starts.
     * One unit is produced per cycle; queue auto-restarts if output < target.
     *
     * Raw material keys: plasma | duranite | organics | isotopes
     */
    recipes: Object.freeze([
      {
        output: 'torpedoes',
        inputs: { plasma: 10, isotopes: 5 },
        cycleSeconds: 6,
      },
      {
        output: 'engineParts',
        inputs: { duranite: 200 },
        cycleSeconds: 60,
      },
      {
        output: 'cannonParts',
        inputs: { duranite: 50, isotopes: 150 },
        cycleSeconds: 60,
      },
      {
        output: 'shieldParts',
        inputs: { organics: 150, duranite: 50 },
        cycleSeconds: 60,
      },
      {
        output: 'computerParts',
        inputs: { organics: 150, isotopes: 100 },
        cycleSeconds: 60,
      },
      {
        output: 'spareParts',
        inputs: { duranite: 100, organics: 100, isotopes: 100 },
        cycleSeconds: 60,
      },
    ]),
  },

  // =========================================================
  // PLAYER SHIP
  // =========================================================
  player: {
    /** Maximum fuel / energy the player's ship can carry (unified E: pool). */
    maxFuel: 9999,

    /** Maximum shield points. */
    maxShields: 100,

    /** Starting torpedo count. */
    startingTorpedoes: 20,

    /** Maximum torpedoes the player can carry. */
    maxTorpedoes: 200,

    /**
     * Fuel consumed per warp sector.
     * Total cost = distance² × fuelPerWarpSector.
     */
    fuelPerWarpSector: 100,

    /** Photon charges consumed per weapon burst (energy cannon). */
    photonPerShot: 1,

    /** Energy consumed per cannon round fired. */
    energyPerShot: 20,

    /** Always-on ship systems drain (life support, navigation). */
    energyBasePerSec: 0.5,

    /** Tracking computer drain per second when active. */
    energyComputerPerSec: 0.5,

    /** Engine energy multiplier — full throttle costs this many E/s. */
    energyEngineMultiplier: 5,

    /** Shield point drain per hit taken in combat. */
    shieldDrainPerHit: 15,

    /** HP threshold — auto-replace component at dock if HP ≤ this. */
    replaceAt: 0.50,

    /** HP threshold — skip replacement if HP ≥ this. */
    skipAt: 0.90,
  },

  // =========================================================
  // COMBAT
  // =========================================================
  combat: {
    /** Photon charges a starbase point-defence fires per second. */
    starbasePointDefenseRatePerSec: 0.5,

    /** Shield drain per second on a starbase under active siege. */
    starbaseShieldDrainPerSec: 5,
  },

  // =========================================================
  // TECH UPGRADE MULTIPLIERS
  // =========================================================
  upgrades: {
    cargoCapacity:     [1.0, 1.5, 2.0, 3.0],
    manufacturingRate: [1.0, 1.25, 1.6, 2.0],
    rechargeTime:      [1.0, 0.85, 0.70, 0.55],
    shipShields:       [1.0, 1.3, 1.6, 2.0],
  },

  // =========================================================
  // DIFFICULTY MODIFIERS
  // =========================================================
  difficulty: {
    cadet:       { zylonAggressionMult: 0.6, startingFuel: 9999, warpCorrectionForce: 2.0, warpDrift: 0.0 },
    commander:   { zylonAggressionMult: 1.0, startingFuel: 9999, warpCorrectionForce: 1.5, warpDrift: 0.3 },
    star_raider: { zylonAggressionMult: 1.4, startingFuel: 9999, warpCorrectionForce: 1.0, warpDrift: 0.6 },
    hardcore:    { zylonAggressionMult: 2.0, startingFuel: 9999, warpCorrectionForce: 0.7, warpDrift: 0.9 },
  },

  // =========================================================
  // CANNON THERMAL MODEL
  // =========================================================
  cannons: {
    tempSlowChargeAt:          25,
    tempNoChargeAt:            95,
    tempDamageAt:             100,
    tempPerShot:               20,
    coolingBaseline:           10,
    coolingPerEnginePerSpeed:   2.5,
    maxCoolingTempDrop:        50,
    optimalChargeTime:          0.2,
    tempFireMax:               95,
  },

  // =========================================================
  // SHIELDS
  // =========================================================
  shields: {
    rechargeRatePerSec:       20,
    systemDamageThreshold:    0.50,
  },

});
