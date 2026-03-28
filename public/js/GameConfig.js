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

  // Set true to observe Zylon AI in real-time (no fast-forward, units visible on map)
  testMode: true,


  // =========================================================
  // SUPPLY SHIP (cargo ship NPC)
  // =========================================================
  supplyShip: {
    /** Total energy a cargo ship carries (used for jump fuel + delivery). */
    energyCapacity: 3000,

    /** Energy consumed per one-hex jump. */
    energyPerJump: 110,

    /** Cargo slots per outbound leg (capital → outer base). */
    outboundCargo: Object.freeze({
      spareParts:    3,
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
    dockTime: 30,

    /** Legacy fuel capacity reference (used by SupplyShip internal tracking). */
    fuelCapacity: 3000,

    /** Generic spare parts required to build a replacement cargo ship. */
    replacementCost: 10,

    /** Maximum hull HP for a cargo ship. */
    maxHealth: 1000,

    /** Hull damage dealt by one torpedo hit. */
    torpedoDamage: 100,

    /** HP restored per spare part consumed during docked repair. */
    repairCostPerPart: 100,

    /** Recipe to commission a new ship at the Capital. */
    buildRecipe: Object.freeze({
      spareParts:    10,
      engineParts:   2,
      computerParts: 1,
      buildSeconds:  60,
    }),

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
      computerParts: 5,
      torpedoes:     200,
      spareParts:    20,
    }),

    /**
     * Passive maintenance drain per second at each outer base.
     * Represents life support, navigation, point defence.
     */
    maintenanceEnergyPerSec: 0,
    maintenancePartsPerSec:  0,
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
      computerParts: 10,
      torpedoes:     300,
      spareParts:    40,
    }),

    /**
     * Strategic reserve — the minimum the capital keeps for player repairs.
     * buildDepartureCargo will never ship quantities that would drop below these.
     */
    strategicReserve: Object.freeze({
      energy:        10000,
      engineParts:   4,
      cannonParts:   3,
      shieldParts:   1,
      computerParts: 5,
      torpedoes:     200,
      spareParts:    10,
    }),

    /** Plasma harvested per second from the capital's nebula sector (feeds manufacturing). */
    plasmaHarvestPerSec: 2.8,

    /** Cap on raw plasma stockpile at the capital (prevents unbounded accumulation). */
    plasmaRawCap: 500,

    /** Continuous energy replenishment — ZEROED; energy is now batch-manufactured from plasma. */
    energyReplenishPerSec: 0,

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
      {
        // Energy batch: 100 plasma + 60 s = 10 000 energy
        output: 'energy',
        inputs: { plasma: 100 },
        cycleSeconds: 60,
        amount: 10000,   // units produced per completed cycle
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
  // ZYLON AI
  // =========================================================
  zylon: {
    /** Seconds between each Seeker one-hex galaxy move (normal gameplay). */
    seekerMoveIntervalSec:       45,

    /** Seconds to produce one unit/pair (Seeker, Warrior, or sub-Spawner). */
    spawnerSpawnIntervalSec:     60,

    /**
     * Simulated seconds per step in the synchronous fast-forward loop.
     * 45s / 15 = 3 steps per Seeker jump; 60s / 15 = 4 steps per Spawner cycle.
     */
    fastForwardStepSec:          15,

    /** Visual delay (seconds) after a Warrior is dispatched before it "arrives". */
    warriorWarpDelaySec:          5,

    /** Energy the player must transfer to kickstart a dormant starbase (fully restores shields). */
    starbaseKickstartEnergy:   1000,

    /** Test-mode outer base starting energy — low so player can drain shields with cannons. */
    testMode_starbaseEnergy:   2000,


    /** Sector-view distance from starbase where Beacon is placed (units). */
    beaconPlacementUnits:       750,

    /** Seekers attack anything entering within this range of their Beacon. */
    seekerAttackRangeUnits:     250,

    /** Seekers chase targets up to this distance from the Beacon. */
    seekerChaseRangeUnits:      500,

    /** Warrior hp — hits required to destroy one. */
    warriorHp:                    3,

    /** Warrior pairs dispatched per new starbase Beacon. */
    warriorPairsPerBeacon:        2,

    /** Lifetime production caps per Spawner. */
    maxSeekerPairsPerSpawner:    12,
    maxWarriorPairsPerSpawner:   12,
    maxSubSpawnersPerSpawner:     2,

    // ---- Sector combat ----
    // Seeker
    seekerHP:                    25,   // 1 hit to kill

    // Warrior shield model
    warriorShieldMax:           300,
    warriorShieldRegenPerSec:    50,
    warriorShieldZone1:         150,  // above this: 100% absorption
    warriorShieldBleedPct:     0.25,  // below zone1: fraction that bleeds to generator
    warriorGeneratorHP:         100,  // when depleted: regen stops permanently
    warriorHullHP:              185,  // hull after generator destroyed; 1 shot kills

    // Torpedo
    torpedoDamage:              185,  // player torpedo dmg to Zylon ships
    zylonTorpedoDamage:         185,  // Zylon torpedo dmg to player
    zylonTorpedoSpeed:          160,  // u/s  (slower than player's 200)
    zylonTorpedoColor:     0xff4400, // orange-red
    zylonFireCooldownMin:       1.5,  // seconds
    zylonFireCooldownMax:       3.0,

    // Flight
    zylonBaseSpeed:               8,  // u/s — keeps pace with player throttle 3 (6 u/s)
    zylonPassRange:              12,  // break-off distance when approaching player

    // Warrior orbit
    warriorOrbitRadiusMin:      100,  // u — inner orbit distance from starbase
    warriorOrbitRadiusMax:      150,  // u — outer orbit distance from starbase
    warriorOrbitSpeed:           50,  // u/s — tangential orbit speed (also used for approach)
    warriorFireIntervalSec:       5,  // s — delay between cannon shots

    // Warrior cannon projectile
    warriorCannonSpeed:         200,  // u/s — matches player torpedo speed
    warriorCannonLife:          2.5,  // s — projectile lifetime → 500u effective range
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
