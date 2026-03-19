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
  // SUPPLY SHIP
  // =========================================================
  ship: {
    /** Units of each material the ship can carry in each hold slot (raw or goods). */
    cargoSlotCapacity: 10,

    /** Fuel consumed per one-sector micro-jump. Round-trip = 2 × distance. */
    fuelPerJump: 1,

    /** Base seconds between jumps (recharge). Scales with health damage. */
    baseRechargeTime: 2.5,

    /** Seconds docked at a starbase for load/unload. */
    baseDockTime: 3.0,

    /** Recharge penalty multiplier when health is 0 (worst case). */
    damagedRechargeMult: 2.5,

    /** Shield points a ship starts with. */
    maxShields: 100,

    /** Shield drain per second during a Zylon encounter. */
    shieldDrainRate: 12,
  },

  // =========================================================
  // STARBASE ECONOMY
  // =========================================================
  starbase: {
    /** Max units of each resource a base can stockpile. */
    stockpileCapacity: 100,

    /**
     * Mining rate — raw units produced per second by an active outer base.
     * Applies to whichever raw resource that base's sector type yields.
     */
    miningRatePerSec: 0.5,

    /**
     * Passive maintenance fuel cost per second at each base.
     * A base that goes unresupplied will drain its fuel stockpile at this rate.
     */
    maintenanceFuelPerSec: 0.05,

    /**
     * Passive maintenance spare-parts drain per second.
     * Represents routine upkeep even when not under attack.
     */
    maintenancePartsPerSec: 0.02,
  },

  // =========================================================
  // CAPITAL MANUFACTURING
  // =========================================================
  capital: {
    /** Max units of processed goods the Capital can stockpile per type. */
    stockpileCapacity: 500,

    /**
     * Manufacturing rate — processed units output per second per recipe,
     * assuming all inputs are available.
     */
    manufacturingRatePerSec: 0.4,

    /**
     * Conversion recipes: each entry consumes `inputs` to produce `output` units.
     * Inputs are consumed proportionally to manufacturingRatePerSec.
     *
     *   1 plasma                        → 2 fuel
     *   1 plasma + 1 isotope            → 2 photon_charges
     *   1 duranite + 1 isotope          → 1 shield_generator
     *   1 duranite + 1 organics         → 2 spare_parts
     */
    recipes: [
      { inputs: { plasma: 1 },                     output: { fuel: 2 } },
      { inputs: { plasma: 1, isotopes: 1 },         output: { photon_charges: 2 } },
      { inputs: { duranite: 1, isotopes: 1 },       output: { shield_generators: 1 } },
      { inputs: { duranite: 1, organics: 1 },       output: { spare_parts: 2 } },
    ],
  },

  // =========================================================
  // PLAYER SHIP
  // =========================================================
  player: {
    /** Maximum fuel / energy the player's ship can carry (unified E: pool). */
    maxFuel: 9999,

    /** Maximum shield points. */
    maxShields: 100,

    /**
     * Fuel consumed per warp sector.
     * Total cost = distance² × fuelPerWarpSector.
     * At 100, a distance-1 hop costs 100 E, distance-3 costs 900 E.
     */
    fuelPerWarpSector: 100,

    /** Photon charges consumed per weapon burst. */
    photonPerShot: 1,

    /** Shield point drain per hit taken in combat. */
    shieldDrainPerHit: 15,

    /** Spare parts consumed per heavy-damage repair event. */
    partsPerRepair: 2,
  },

  // =========================================================
  // COMBAT
  // =========================================================
  combat: {
    /** Photon charges a starbase point-defense system fires per second. */
    starbasePointDefenseRatePerSec: 0.5,

    /** Shield drain per second on a starbase under active siege. */
    starbaseShieldDrainPerSec: 5,

    /** Spare parts consumed per second of passive maintenance on a starbase. */
    starbaseMaintenancePartsPerSec: 0.02,
  },

  // =========================================================
  // TECH UPGRADE MULTIPLIERS (applied to base values above)
  // =========================================================
  upgrades: {
    /**
     * Each upgrade tier multiplies the base value.
     * Example: miningRate tier 2 → miningRatePerSec × upgrades.miningRate[2]
     */
    miningRate:        [1.0, 1.3, 1.7, 2.2],   // 4 tiers
    cargoCapacity:     [1.0, 1.5, 2.0, 3.0],
    manufacturingRate: [1.0, 1.25, 1.6, 2.0],
    rechargeTime:      [1.0, 0.85, 0.70, 0.55], // lower = faster (multiplier on baseRechargeTime)
    shipShields:       [1.0, 1.3, 1.6, 2.0],
  },

  // =========================================================
  // DIFFICULTY MODIFIERS
  // =========================================================
  difficulty: {
    /**
     * warpCorrectionForce — how strongly placing the mouse on the outer crosshair
     * pulls it back toward center. Higher = easier to stay on course.
     *   Cadet:       2.0 — almost locks the crosshair in place at center
     *   Commander:   1.5 — requires attention but not constant focus
     *   Star Raider: 1.0 — must actively chase; brief lapses cause drift
     *   Hardcore:    0.7 — drift force nearly matches max correction; no margin for error
     */
    cadet:       { miningMult: 1.4, zylonAggressionMult: 0.6, startingFuel: 9999, warpCorrectionForce: 2.0, warpDrift: 0.0 },
    commander:   { miningMult: 1.0, zylonAggressionMult: 1.0, startingFuel: 9999, warpCorrectionForce: 1.5, warpDrift: 0.3 },
    star_raider: { miningMult: 0.8, zylonAggressionMult: 1.4, startingFuel: 9999, warpCorrectionForce: 1.0, warpDrift: 0.6 },
    hardcore:    { miningMult: 0.6, zylonAggressionMult: 2.0, startingFuel: 9999, warpCorrectionForce: 0.7, warpDrift: 0.9 },
  },

});
