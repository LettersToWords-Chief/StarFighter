# Star Fighter — Project Brief
*Living document. Update this file whenever a plan is approved or significant work is completed.*
*Last updated: 2026-04-07*

---

## What This Game Is

A 3D space combat game built in Three.js / Node.js. The player flies a fighter, warps between sectors on a galaxy map, defends starbases, and fights an evolving Zylon AI faction. The aesthetic is wireframe / retro sci-fi (red wireframe Zylons, cockpit HUD, targeting scope).

Stack: Node.js + Express server (`server.js`), vanilla JS front-end in `public/js/`, Three.js for 3D rendering, no build step.

---

## Current Implementation Status

### ✅ Done and Working
- Galaxy map with sectors, starbases, cargo ships, commerce lanes
- Sector view: 3D cockpit, targeting scope, contact list, front + aft cannons
- Zylon Spawners, Seekers (TIE Fighter + Bird), Beacons, Warriors — all spawning and active
- Zylon fast-forward initialization (beacon deploys rapidly at session start → Red Alert)
- Beacon orbital behavior (3D planes, hit-evasion speed burst)
- Warrior summon logic (2 pairs on beacon activation, clan-based resupply)
- Aft targeting computer: pulsing amber diagonal lines on scope when enemy is behind player within 500u; predictive lead-aiming for aft cannon
- Dogfight AI: committed-arc maneuver system with zone classification and weight-table learning
- Zylon evasion: smooth jink via evasion-axis rotation; committed 90° collision-avoidance breakoff
- 3D lock bracket indicator on locked target (green = firing solution, red = tracking only)
- Symmetric warp ramp: 5× accel outbound, 5× decel inbound; warp hazard (5× damage + cancel if hit)
- Planet solid in habitable sectors; sector 3D object distribution doubled

### 🔄 Most Recent Work
- **Dogfight + HUD polish** — smooth jink arc, committed collision avoidance, 3D lock bracket with firing-solution indicator (green/red), sector object distribution doubled, warp hazard damage, planet solidity.

### 📋 Planned But Not Yet Built (in priority order)
See Sections E–H below.

| # | Feature | Status |
|---|---|---|
| E | Game Opening (backstory crawl + Red Alert trigger) | 📋 Planned |
| F | Win / Loss Conditions | 📋 Planned |
| G | Sound Effects | 📋 Planned (media TBD) |
| H | Spawner 3D Presence + Boss-Fight Behavior | 📋 Planned |

---

---

## Section A: Architecture

```
server.js                   — Express server, static files, /api/zylon-log, /api/zylon-weights
public/
  js/
    GameConfig.js           — All tunable constants (zylon block has dogfight subsection)
    main.js                 — Boot, input loop, view switching
    galaxy/                 — GalaxyMap, ZylonAI, CommerceLane, etc.
    sector/
      SectorView.js         — 3D sector rendering, _updateZylons loop, torpedo handling
      ZylonShip.js          — All Zylon ship types: seeker_tie, seeker_bird, warrior, beacon
    warp/                   — Warp drive logic
    utils/                  — Shared helpers
  css/style.css
data/
  zylon_combat_log.jsonl    — Maneuver outcome log (appended by server)
  weights_tie.json          — Persistent weight table for TIE seekers (225 floats)
  weights_bird.json         — Persistent weight table for Bird seekers (225 floats)
```

---

## Section B: Dogfight AI Design (approved, partially implemented)

### Zone Classification
Both the seeker and the player are classified relative to each other via dot product against each ship's forward vector.

| Zone | Dot | Meaning |
|---|---|---|
| `HOT_FRONT` | > 0.8 | In the forward fire cone |
| `FRONT_Q` | 0.3–0.8 | Forward hemisphere, outside cone |
| `BEAM` | −0.3–0.3 | Perpendicular — the safe arc |
| `REAR_Q` | −0.8–−0.3 | Rear hemisphere, outside aft cone |
| `HOT_REAR` | < −0.8 | In the aft fire cone |

Two zone values → 25-cell state table `(myZone, playerZone)`.

### Committed Maneuver
`{ pitchDir, yawDir, duration }` — 3×3 = 9 combinations.  
Ship executes the arc for the full duration. No re-evaluation mid-maneuver.  
Only the collision interrupt can momentarily override execution.

### Weight Table
225-cell table per seeker (25 states × 9 maneuvers). Initialized to equal weights. Updated at maneuver end based on outcome scoring. Persisted to `data/weights_tie.json` and `data/weights_bird.json`.

### Three Constant Interrupts (every tick)
1. **Collision avoidance** — distance to player < `colAvoidRadius` → override pitch/yaw to pull away. Does not reset maneuver timer.
2. **Front cannon** — `myZone === HOT_FRONT` AND in range AND recharged → fire
3. **Rear cannon** — `myZone === HOT_REAR` AND in range AND recharged → fire

### GameConfig values (dogfight block)
```javascript
dogfightTurnRate:      45,    // deg/s
dogfightManeuverMin:   1.2,   // s
dogfightManeuverMax:   2.8,   // s
dogfightLearnRate:     0.05,
dogfightColAvoidR:     30,    // u
dogfightFrontFireR:    500,   // u
dogfightRearFireR:     400,   // u
dogfightFrontCoolMin:  2.0,   // s
dogfightFrontCoolMax:  4.0,   // s
dogfightRearCoolMin:   2.5,   // s
dogfightRearCoolMax:   5.0,   // s
```

---

## Section C: Zylon Redesign Roadmap (approved plan, not yet built)

These are built sequentially. Each item must be approved before implementation begins.

| # | Feature | Status |
|---|---|---|
| 1 | Fast-forward seeker bloom speed | ✅ Done |
| 2 | Zylon clan tracking (warrior summons by clan) | ✅ Done |
| 3 | Seeker group composition scaling (1 TIE + 1 Bird + 1 Beacon at easy) | ✅ Done |
| 4 | Seeker sector-entry priority logic (beacon, tracking mode, resource deploy, cargo follow) | ✅ Done |
| 5 | 3D beacon orbital planes (full 360° yaw/pitch/roll freedom, 750U radius) | ✅ Done |
| 6 | Beacon hit evasion (new orbital plane, speed to 100u/s for 10s) | ✅ Done |
| 7 | TIE/Bird defender role split + dynamic flight | ✅ Done |
| 8 | Warrior clan-based resupply logic | ✅ Done |
| **9** | **Warp drive UX redesign** | ✅ Done |

### Item 7 Detail: TIE/Bird Defender Roles + Dynamic Flight
- **TIE Fighter** = close defender, stays near Beacon
- **Bird** = far defender, ventures farther out
- Guard radii and attack/retreat ranges → GameConfig values (to be set at implementation time)
- Dynamic flight: smoother turns, fly toward player → get close → shoot → veer off → loop back from new direction. More like actual flight, less hovering.

### Item 8 Detail: Warrior Resupply Logic
- Activated beacon maintains 4 warriors from its own clan in sector
- Two beacons, same clan: both signal simultaneously → double reinforcements
- Two beacons, different clans: each independently maintains 4 of its own clan
- Signal timing and triggers: TBD at implementation time

### Item 9 Detail: Warp Drive Redesign
1. Player selects sector on galaxy map, presses **H** → Warp Mode activates, galaxy map closes
2. Player is back in cockpit; must physically orient ship toward destination heading
3. **Orientation arrows** on HUD point toward required heading
4. **Virtual target HUD element** appears once player is close to correct heading
5. Player presses **E (Engage)** → warp initiates
6. Mis-alignment: warp fires at same distance but wrong direction → lands in different sector
7. Miss logic: TBD at implementation time

---

## Section D: Design Principles (non-negotiable)

- **Bill is the designer. AI is the technical expert.** No changes to design without explicit approval.
- All tunable constants go in `GameConfig.js` — never hardcoded.
- Plans must be approved before code is written.
- One feature at a time, tested independently before moving to the next.
- Wireframe red aesthetic, retro sci-fi HUD — do not introduce visual elements that clash.
- Ask clarifying questions early rather than assuming and rewriting.

---

## Section E: Game Opening

### Concept
A Star Wars-style text crawl that delivers the backstory and ends with the moment the Zylons launch their first attack, triggering Red Alert. The crawl leads directly into the live game — no separate title screen.

### Flow
1. Player loads the game → **backstory crawl** begins (slow upward scroll, starfield behind it)
2. Crawl ends with the call to arms and the first Zylon attack
3. Galaxy map fades in — Red Alert is already active (Zylon beacon has deployed per normal fast-forward logic)
4. Game is live

### Open Items
- **Backstory text:** Bill is writing this. No code until text is approved.
- **Crawl styling:** classic Star Wars perspective-recede effect, or flat scroll? TBD.
- **Skip option:** allow player to skip crawl on subsequent playthroughs? TBD.

---

## Section F: Win / Loss Conditions

### Loss Conditions (any one triggers Game Over — Loss)

| Trigger | Message | Notes |
|---|---|---|
| Player hull → 0 | SHIP DESTROYED | Standard combat death |
| Player energy = 0 AND not actively docking | ADRIFT — SYSTEMS DARK | Energy management is critical; must initiate dock before zero |
| Capital starbase shields fall (energy = 0) | THE CAPITAL HAS FALLEN | Capital is highest-priority starbase; its loss ends the economy |

**Loss screen:** Show cause-of-death message, final statistics (sectors cleared, Spawners destroyed, time elapsed), and a restart option.

### Capital Special Status
- The Capital is the economic hub. Its loss = no economy = inevitable death.
- Losing ANY starbase is serious; losing the Capital is immediately fatal to the game.
- Players should be nudged to defend the Capital above all other starbases.
- **Implementation note:** The game engine needs to know which starbase is the Capital. Flag it in the galaxy data.

### Win Condition (ALL must be true simultaneously)
1. All Zylon Spawners are destroyed
2. All starbases are active (shields up, energy > 0)

**Spawner-Zylon linkage — CONFIRMED:** Destroying a Spawner instantly kills or deactivates all Zylons of that clan. This makes Spawner-hunting the fastest path to victory — find the Spawners, kill them, and the infestation collapses.

**Win screen:** Victory message, statistics, credits.

---

## Section G: Sound Effects

### Approach
- Mix of provided media files (Bill will supply) and procedurally generated sounds
- Implementation session deferred until media assets are ready
- Bill will provide a list of desired sounds and media at implementation time

### Anticipated Sound Categories (preliminary)
- Weapon fire (front cannon, aft cannon)
- Torpedo impact / explosion
- Warp drive charge, burst, and decel
- HUD alerts (Red Alert, lock-on, incoming fire)
- Starbase docking sequence
- Game Over (loss and win)
- Ambient sector sound (void, nebula, asteroid)

---

## Section H: Zylon Spawner — 3D Presence + Boss-Fight Behavior

### Role in the Game
Spawners are the strategic root of the Zylon infestation. They are the "boss fights" of the game — not because they fight, but because finding and killing them is the win condition and they are well-defended.

### Galaxy-Level Behavior (existing, in ZylonSpawner.js)
- Game begins with **one Spawner**
- Each Spawner can produce up to **2 child Spawners**
- A new Spawner deploys to a sector when:
  - A Beacon finds a sector with **resources and no starbase** (expansion)
  - A Beacon finds a sector with a **deactivated starbase** (conquest)
- Spawners are hidden by **fog of war** — must be discovered by flying to resource sectors
- More Spawners = faster Zylon growth = harder to win

### 3D Sector Presence (to be built)

**Visual model:**
- Same size as a Beacon
- Distinct appearance — "fancier Beacon" (design TBD at implementation time)
- Wireframe red aesthetic, consistent with all Zylon units

**Behavior:**
- Beacon-like flee-and-evade — does not fight, only runs
- Orbits at same radius as a Beacon (~750u), evades with speed bursts when hit
- Can spawn replacement TIE/Bird defenders if existing defenders are killed too slowly

**Defenders:**
- TIE Fighters — same close-defense behavior as in seeker groups
- Birds — same far-defense behavior
- Warriors — present as guards; exact warrior behavior when guarding a Spawner is TBD
- All defenders from the Spawner's own clan

**Destruction:**
- Torpedoes (same as Beacon and all other Zylon units)
- Spawner itself is no harder to kill than a Beacon — difficulty comes from its defender screen

### Spawner-Zylon Linkage — CONFIRMED
Destroying a Spawner kills or deactivates all Zylons that belong to its clan. The cascade effect makes Spawner-hunting the dominant strategic priority: finding and eliminating a Spawner is more efficient than grinding down its individual units one by one.

### Open Items
- Spawner visual model (wireframe design)
- Warrior guard behavior spec (TBD when ready to implement)
- Spawner health / evasion tuning

---

## How to Use This File (for AI)

At the start of every session on this project:
1. Read this file
2. Check what's marked ✅ vs 📋
3. Ask Bill what he wants to work on today
4. Do not propose changes until asked
