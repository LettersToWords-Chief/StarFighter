# Star Fighter — Project Brief
*Living document. Update this file whenever a plan is approved or significant work is completed.*
*Last updated: 2026-04-04*

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
- Dogfight AI: committed-arc maneuver system with zone classification and weight-table learning (see Section B below)
- Zylon evasion: seekers execute a committed 1-second evasion turn when inside player's firing cone, using a fixed rotation axis to prevent jitter

### 🔄 Most Recent Work
- **Warp Drive Redesign (Item 9)** — Two-step align + engage flow. H arms warp mode (destination diamond + 30s countdown). E engages. G or map open cancels. All 9 items on the Zylon Redesign Roadmap are now complete.

### 📋 Planned But Not Yet Built (in priority order)
See Section C below.

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

## How to Use This File (for AI)

At the start of every session on this project:
1. Read this file
2. Check what's marked ✅ vs 📋
3. Ask Bill what he wants to work on today
4. Do not propose changes until asked
