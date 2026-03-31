/**
 * GalaxyMap.js — Procedural hex galaxy map renderer (HTML5 Canvas 2D)
 *
 * Responsibilities:
 *  - Generate a hex grid of the right size for the difficulty
 *  - Place starbases and commerce lanes
 *  - Track fog of war and sector visibility
 *  - Handle mouse input (hover, select target)
 *  - Render the full galaxy map each frame
 */

class GalaxyMap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {string} opts.difficulty  — 'cadet' | 'commander' | 'star_raider' | 'hardcore'
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.difficulty = opts.difficulty || 'cadet';

    // Layout
    this.hexSize    = 36;      // circumradius in pixels (base)
    this.zoom       = 1.0;     // current zoom multiplier
    this.minZoom    = 0.35;
    this.maxZoom    = 2.5;
    this.origin     = { x: 0, y: 0 }; // offset so grid is centered

    // Galaxy data
    this.hexes        = new Map(); // key -> hex data object
    this.starbases    = [];
    this.lanes        = [];
    this.supplyShips  = [];        // all active NPC supply ships
    this.droneLost    = new Map(); // key -> timestamp (ms) when sensor drone was last destroyed
    this.playerPos    = { q: 0, r: 0 }; // current player sector
    this.targetPos    = null;            // selected warp target

    // Zylon units
    this.zylonSpawners = [];
    this.zylonSeekers  = [];
    this.zylonWarriors = [];
    this.zylonBeacons  = [];
    this.redAlert      = false;   // true once first starbase Beacon is placed

    // Callbacks
    this.onRedAlert    = null;    // () => void — fired once at game start

    // Fog of war
    this.revealed = new Set();  // known sectors (ever visited or in sensor range)
    this.visible  = new Set();  // currently live sensor coverage

    // Input
    this.hoveredHex = null;
    this.onWarpSelected = null; // callback({ from, to, fuelCost })

    // Stars (background parallax)
    this.stars = this._generateStars(180);

    // Pan state
    this.pan = { x: 0, y: 0 };
    this.isPanning = false;
    this.panStart  = { x: 0, y: 0 };

    this._initGrid();
    this._initInput();
    this._loop();
  }

  // =========================================================
  // GRID GENERATION
  // =========================================================

  /** Config per difficulty — radius and number of outer player starbases */
  _config() {
    return {
      cadet:       { radius: 7,  outerBases: 3 },
      commander:   { radius: 9,  outerBases: 5 },
      star_raider: { radius: 11, outerBases: 7 },
      hardcore:    { radius: 14, outerBases: 9 },
    }[this.difficulty] || { radius: 7, outerBases: 3 };
  }

  _initGrid() {
    const { radius, outerBases } = this._config();
    this.gridRadius = radius;

    // All hexes start as plain void
    HexMath.hexesInRange(0, 0, radius).forEach(({ q, r }) => {
      this.hexes.set(HexMath.key(q, r), this._makeHex(q, r));
    });

    // Force center to nebula — Capital produces fuel
    const center = this.hexes.get('0,0');
    if (center) { center.type = 'nebula'; center.sectorMod = 1.5; }

    // Seed resource hexes, then place starbases on them
    const resourceHexes = this._seedResourceHexes();
    this._placeStarbases(outerBases, resourceHexes);
    this._buildLanes();
    this._spawnSupplyShips();
    this._placeZylonSpawner();
    this._fastForwardZylons();   // always runs — synchronous, invisible, completes before frame 1
    this._updateVisibility();
    this._centerOrigin();
  }

  /** All hexes are plain void by default; resource hexes are seeded explicitly. */
  _makeHex(q, r) {
    return {
      q, r,
      type:          'void',
      sectorMod:     1.0,
      zylonPresence: 0,
      visited:       false,
      isResource:    false,
      zylonProspect: false,
    };
  }

  /**
   * Seed exactly 2 of each resource type randomly across the map.
   * Constraints: distance ≥ 2 from center, min spacing ≥ 3 between resource hexes.
   * Returns sorted array of {q,r,type} for downstream starbase placement.
   */
  _seedResourceHexes() {
    const TYPES = ['nebula', 'asteroid', 'habitable', 'void'];
    const TYPE_MOD = { nebula: 1.5, asteroid: 1.25, habitable: 1.0, void: 1.0 };
    const SECTOR_RESOURCE = {
      nebula:   { key: 'plasma',   label: 'PLASMA CRYSTALS', color: '#cc44ff' },
      asteroid: { key: 'duranite', label: 'DURANITE',        color: '#ffaa22' },
      habitable:{ key: 'organics', label: 'ORGANICS',        color: '#22cc66' },
      void:     { key: 'isotopes', label: 'RARE ISOTOPES',   color: '#44ccff' },
    };

    const placed = []; // [{q,r}] of already-placed resource hexes

    for (const type of TYPES) {
      // Build eligible candidates: dist ≥ 2, not already a resource, spaced ≥ 3 apart
      const eligible = [...this.hexes.keys()].filter(k => {
        const pos = HexMath.parseKey(k);
        if (HexMath.distance({ q: 0, r: 0 }, pos) < 2) return false;
        const hex = this.hexes.get(k);
        if (hex.isResource) return false;
        return !placed.some(p => HexMath.distance(pos, p) < 3);
      });

      // Shuffle for equal chance at any ring
      const shuffled = eligible.sort(() => Math.random() - 0.5);

      let count = 0;
      for (const k of shuffled) {
        if (count >= 2) break;
        const pos = HexMath.parseKey(k);
        const hex = this.hexes.get(k);
        hex.type       = type;
        hex.sectorMod  = TYPE_MOD[type];
        hex.isResource = true;
        hex.resource   = SECTOR_RESOURCE[type];
        placed.push(pos);
        count++;
      }
    }

    // Return sorted by distance from center (closest first)
    return placed.sort((a, b) =>
      HexMath.distance({ q: 0, r: 0 }, a) - HexMath.distance({ q: 0, r: 0 }, b)
    );
  }

  /**
   * Place starbases on resource hexes.
   * Capital at center (nebula). Closest outerBases resource hexes → player starbases.
   * Remaining resource hexes → Zylon prospect zones.
   */
  _placeStarbases(outerBases, resourceHexes) {
    const SECTOR_RESOURCE = {
      nebula:   { key: 'plasma',   label: 'PLASMA CRYSTALS', color: '#cc44ff' },
      asteroid: { key: 'duranite', label: 'DURANITE',        color: '#ffaa22' },
      habitable:{ key: 'organics', label: 'ORGANICS',        color: '#22cc66' },
      void:     { key: 'isotopes', label: 'RARE ISOTOPES',   color: '#44ccff' },
    };

    const names = [
      'Arcturus Station', 'Vega Outpost', 'Sirius Base', 'Centauri Relay',
      'Rigel Platform', 'Aldebaran Keep', 'Betelgeuse Depot', 'Pollux Haven',
      'Deneb Watch', 'Altair Forge', 'Spica Rampart', 'Castor Reach',
      'Procyon Gate', 'Regulus Front', 'Fomalhaut Bulwark', 'Achernar Point',
    ];

    // Capital — center hex which is forced nebula
    const capitalRes = SECTOR_RESOURCE.nebula;
    const capital = new Starbase({
      q: 0, r: 0,
      name: 'Earth Command',
      isCapital: true,
      sensorRange: 1,
      produces: capitalRes,
    });
    this.starbases.push(capital);
    const centerHex = this.hexes.get('0,0');
    if (centerHex) { centerHex.visited = true; }

    // Pick outer starbases: closest of each type in priority order,
    // then cycle to 2nd-closest of each type for higher difficulty counts.
    // Capital is already a nebula, so non-nebula types get first priority.
    const TYPE_PRIORITY = ['asteroid', 'habitable', 'void', 'nebula'];
    const byType = {};
    for (const type of TYPE_PRIORITY) {
      // For each type, sort its hexes by distance
      byType[type] = resourceHexes
        .filter(pos => this.hexes.get(HexMath.key(pos.q, pos.r))?.type === type)
        .sort((a, b) => HexMath.distance({ q:0,r:0 }, a) - HexMath.distance({ q:0,r:0 }, b));
    }

    const playerHexes = [];
    const usedKeys    = new Set();
    let pass = 0; // 0 = closest of each type, 1 = 2nd closest, etc.
    while (playerHexes.length < outerBases) {
      let addedThisPass = 0;
      for (const type of TYPE_PRIORITY) {
        if (playerHexes.length >= outerBases) break;
        const candidate = byType[type]?.[pass];
        if (candidate) {
          const k = HexMath.key(candidate.q, candidate.r);
          if (!usedKeys.has(k)) {
            playerHexes.push(candidate);
            usedKeys.add(k);
            addedThisPass++;
          }
        }
      }
      if (addedThisPass === 0) break; // no more candidates
      pass++;
    }

    const zylonProspects = resourceHexes.filter(pos =>
      !usedKeys.has(HexMath.key(pos.q, pos.r))
    );


    let nameIdx = 0;
    for (const pos of playerHexes) {
      const hexData = this.hexes.get(HexMath.key(pos.q, pos.r));
      const res = SECTOR_RESOURCE[hexData?.type] || SECTOR_RESOURCE.void;
      const sb = new Starbase({
        q: pos.q, r: pos.r,
        name: names[nameIdx++] || `Station ${nameIdx}`,
        isCapital: false,
        sensorRange: 0,
        produces: res,
      });
      // Wire shield-failure and restore callbacks so galaxy map can react
      sb.onShieldsFailed = (fallen) => this._onStarbaseFallen(fallen);
      sb.onRestored      = (sb)     => this._onStarbaseRestored(sb);
      this.starbases.push(sb);
    }

    // Remaining resource hexes → Zylon prospect zones (visible as danger markers later)
    for (const pos of zylonProspects) {
      const hex = this.hexes.get(HexMath.key(pos.q, pos.r));
      if (hex) hex.zylonProspect = true;
    }
    this.zylonProspects = zylonProspects;

    this.playerPos = { q: 0, r: 0 };
  }

  _buildLanes() {
    // Hub-and-spoke: every outer starbase gets one direct lane to the capital.
    // No daisy-chains — every delivery goes straight to/from the capital.
    const capital = this.starbases.find(s => s.isCapital);
    if (!capital) return;
    const laneIds = new Set();
    for (const sb of this.starbases) {
      if (sb.isCapital) continue;
      const lane = new CommerceLane(capital, sb);
      if (!laneIds.has(lane.id)) {
        this.lanes.push(lane);
        laneIds.add(lane.id);
      }
    }
  }

  _spawnSupplyShips() {
    this.supplyShips = [];
    const capital = this.starbases.find(s => s.isCapital);

    for (const lane of this.lanes) {
      // Each lane is capital ↔ one outer base (hub-and-spoke).
      // lane.from is always the capital (set in _buildLanes).
      const outerSb = lane.to;

      // Use up to 2 alternate paths — path always runs capital→outer (path[0] = capital)
      const paths = HexMath.hexAlternatePaths(lane.from, lane.to, 2);
      const d     = paths[0].length - 1;
      if (d < 1) continue;

      // Spawn d ships — one per hop — evenly spaced, alternating direction.
      for (let i = 0; i < d; i++) {
        const path    = paths[i % paths.length];
        const reverse = (i % 2 === 1);
        this.supplyShips.push(new SupplyShip({
          path,
          startIndex:   i,
          forward:      !reverse,
          resource:     outerSb.produces?.key || 'duranite',
          rechargeTime: GameConfig.supplyShip.rechargeTime,
          dockTime:     GameConfig.supplyShip.dockTime,
          capital,
          outerBase:    outerSb,
        }));
      }
    }
  }

  /** Returns all supply ships currently in the given sector. */
  shipsInSector(q, r) {
    return this.supplyShips.filter(s => {
      const h = s.currentHex;
      return h && h.q === q && h.r === r;
    });
  }

  // =========================================================
  // VISIBILITY / FOG OF WAR
  // =========================================================

  _updateVisibility() {
    this.visible.clear();
    for (const sb of this.starbases) {
      if (sb.state === 'active') {
        const ring = HexMath.hexesInRange(sb.q, sb.r, sb.sensorLevel);
        ring.forEach(h => {
          const k = HexMath.key(h.q, h.r);
          if (this.hexes.has(k)) {
            this.visible.add(k);
            this.revealed.add(k);
          }
        });
      }
    }

    // Player's own sector and adjacent hexes always visible
    const playerRing = HexMath.hexesInRange(this.playerPos.q, this.playerPos.r, 1);
    playerRing.forEach(h => {
      const k = HexMath.key(h.q, h.r);
      if (this.hexes.has(k)) {
        this.visible.add(k);
        this.revealed.add(k);
      }
    });

    // Supply ships reveal the sector they currently occupy
    for (const ship of this.supplyShips) {
      const h = ship.currentHex;
      if (!h) continue;
      const k = HexMath.key(h.q, h.r);
      if (this.hexes.has(k)) {
        this.visible.add(k);
        this.revealed.add(k);
      }
    }

    // Mark hexes as visited
    const playerKey = HexMath.key(this.playerPos.q, this.playerPos.r);
    if (this.hexes.has(playerKey)) this.hexes.get(playerKey).visited = true;
  }

  // =========================================================
  // COORDINATE HELPERS
  // =========================================================

  _centerOrigin() {
    this.origin = {
      x: this.canvas.width  / 2,
      y: this.canvas.height / 2,
    };
  }

  _hexToScreen(q, r) {
    const effectiveSize = this.hexSize * this.zoom;
    const px = HexMath.axialToPixel(q, r, effectiveSize);
    return {
      x: this.origin.x + this.pan.x + px.x,
      y: this.origin.y + this.pan.y + px.y,
    };
  }

  _screenToHex(sx, sy) {
    const effectiveSize = this.hexSize * this.zoom;
    const x = sx - this.origin.x - this.pan.x;
    const y = sy - this.origin.y - this.pan.y;
    return HexMath.pixelToAxial(x, y, effectiveSize);
  }

  // =========================================================
  // INPUT
  // =========================================================

  _initInput() {
    const c = this.canvas;

    c.addEventListener('mousemove', e => {
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (this.isPanning) {
        const dx = mx - this.panStart.x;
        const dy = my - this.panStart.y;
        if (!this._hasDragged && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
          this._hasDragged = true;
          c.style.cursor = 'grabbing';
          this.hoveredHex = null;
          this._hideTooltip();
        }
        if (this._hasDragged) {
          this.pan.x += dx;
          this.pan.y += dy;
          this.panStart = { x: mx, y: my };
          return;
        }
      }

      const h = this._screenToHex(mx, my);
      if (this.hexes.has(HexMath.key(h.q, h.r))) {
        this.hoveredHex = h;
        this._showTooltip(mx, my, h);
      } else {
        this.hoveredHex = null;
        this._hideTooltip();
      }

      // Preview fuel cost
      if (this.hoveredHex) {
        const cost = HexMath.fuelCost(this.playerPos, this.hoveredHex);
        document.getElementById('hud-warp-cost').textContent = cost + ' UNITS';
      } else {
        document.getElementById('hud-warp-cost').textContent = '--';
      }
    });

    c.addEventListener('click', e => {
      if (this._hasDragged) return;  // was a drag, not a click
      if (!this.hoveredHex) return;
      const k = HexMath.key(this.hoveredHex.q, this.hoveredHex.r);
      if (!this.hexes.has(k)) return;

      this.targetPos    = { ...this.hoveredHex };
      this._selectedHex = { ...this.hoveredHex }; // store for live refresh
      document.getElementById('hud-status').textContent = 'TARGET LOCKED';
      this._updateResourcesPanel(this.hoveredHex);
    });

    c.addEventListener('mousedown', e => {
      if (e.button === 0) {
        const rect = c.getBoundingClientRect();
        this.isPanning = true;
        this._hasDragged = false;
        this.panStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }
    });

    c.addEventListener('mouseup',    () => { this.isPanning = false; c.style.cursor = 'default'; });
    c.addEventListener('mouseleave', () => { this.isPanning = false; });
    c.addEventListener('contextmenu', e => e.preventDefault());

    c.addEventListener('wheel', e => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * zoomFactor));

      // Zoom toward the mouse cursor position relative to the galaxy origin
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left - this.origin.x;
      const my = e.clientY - rect.top  - this.origin.y;

      // Adjust pan so the point under the cursor stays fixed
      const scaleChange = newZoom / this.zoom;
      this.pan.x = mx - scaleChange * (mx - this.pan.x);
      this.pan.y = my - scaleChange * (my - this.pan.y);

      this.zoom = newZoom;
    }, { passive: false });

    window.addEventListener('keydown', e => {
      // H is owned by main.js — do not handle here
      if (e.key === 'Escape') {
        this.targetPos    = null;
        this._selectedHex = null;
        document.getElementById('hud-status').textContent = 'STANDBY';
        this._updateResourcesPanel(null);
      }
    });

    window.addEventListener('resize', () => {
      this._resizeCanvas();
      this._centerOrigin();
    });
  }

  _warpTo(target) {
    const baseCost = HexMath.fuelCost(this.playerPos, target);
    const destHex  = this.hexes.get(HexMath.key(target.q, target.r));
    const mod      = destHex?.sectorMod ?? 1.0;
    const cost     = Math.round(baseCost * mod);
    if (this.onWarpSelected) {
      this.onWarpSelected({ from: { ...this.playerPos }, to: { ...target }, fuelCost: cost });
    }
    // Keep targetPos — player expects last target to remain locked for next H press
    document.getElementById('hud-status').textContent = 'WARPING...';
  }

  /** Return current warp target (null if none set). Used by main.js for H-key warp. */
  getTarget() { return this.targetPos ? { ...this.targetPos } : null; }

  /** Called by main.js after the warp tunnel completes. */
  teleportPlayer({ q, r }) {
    this.playerPos = { q, r };
    const key = HexMath.key(q, r);
    if (this.hexes.has(key)) this.hexes.get(key).visited = true;
    this._updateVisibility();
    document.getElementById('hud-status').textContent = 'ARRIVAL';
    document.getElementById('hud-sector').textContent = key;
    setTimeout(() => {
      document.getElementById('hud-status').textContent = 'STANDBY';
    }, 2000);
  }

  _showTooltip(mx, my, hex) {
    const tt = document.getElementById('sector-tooltip');
    const hd = this.hexes.get(HexMath.key(hex.q, hex.r));
    const k  = HexMath.key(hex.q, hex.r);
    const sb = this.starbases.find(s => s.q === hex.q && s.r === hex.r);
    const vis = this.visible.has(k);
    const rev = this.revealed.has(k);

    let html = `<div class="tt-title">SECTOR ${k}</div>`;
    if (vis) {
      html += `TYPE: ${hd.type.toUpperCase()}<br>`;
      if (sb) {
        const nameColor = sb.isCapital ? '#ffd700' : '#00b4ff';
        html += `<span style="color:${nameColor}">${sb.name.toUpperCase()}</span><br>`;
        html += `SHIELDS: ${Math.round(sb.shields)}%`;
      }
    } else if (rev) {
      html += `<span style="color:#4488aa">CHARTED</span>`;
    } else {
      html += `<span style="color:#333">UNKNOWN</span>`;
    }

    const baseCost = HexMath.fuelCost(this.playerPos, hex);
    const mod      = hd?.sectorMod ?? 1.0;
    const cost     = Math.round(baseCost * mod);
    const modStr   = mod !== 1.0 ? ` ×${mod}` : '';
    html += `<br><span style="color:#00b4ff">WARP: ${cost}E${modStr}</span>`;

    tt.innerHTML = html;
    tt.classList.remove('hidden');
    const pad = 12;
    tt.style.left = (mx + pad) + 'px';
    tt.style.top  = (my + pad) + 'px';
  }

  /** Populate the RESOURCES panel (right HUD) for a clicked hex. Pass null to clear. */
  _updateResourcesPanel(hex) {
    const el = document.getElementById('hud-resources-body');
    if (!el) return;
    if (!hex) { el.innerHTML = '—'; return; }

    const k   = HexMath.key(hex.q, hex.r);
    const sb  = this.starbases.find(s => s.q === hex.q && s.r === hex.r);
    const vis = this.visible.has(k);

    if (!vis || !sb) {
      el.innerHTML = vis ? '<span style="color:#4488aa">No base</span>' : '<span style="color:#333">Unknown</span>';
      return;
    }

    const fmt = (label, val, tgt, col) => {
      const bar = Math.round((val / tgt) * 8);
      const filled = '▮'.repeat(bar) + '▯'.repeat(8 - bar);
      return `<span style="color:${col || 'rgba(0,180,255,0.75)'}">${label}</span>` +
             `<span style="color:#ccc"> ${Math.floor(val)}/${tgt}</span>`;
    };

    const inv = sb.inventory;
    const tgt = sb.target;
    const rows = [];

    if (sb.isCapital) {
      rows.push(fmt('ENERGY',    inv.energy        ?? 0, tgt.energy,        '#ffcc00'));
      rows.push(fmt('ENGINES',   inv.engineParts   ?? 0, tgt.engineParts,   '#00e5ff'));
      rows.push(fmt('CANNONS',   inv.cannonParts   ?? 0, tgt.cannonParts,   '#00e5ff'));
      rows.push(fmt('SHIELDS',   inv.shieldParts   ?? 0, tgt.shieldParts,   '#00e5ff'));
      rows.push(fmt('COMPUTERS', inv.computerParts ?? 0, tgt.computerParts, '#00e5ff'));
      rows.push(fmt('TORPEDOES', inv.torpedoes     ?? 0, tgt.torpedoes,     '#ff9900'));
      rows.push(fmt('SPARE PTS', inv.spareParts    ?? 0, tgt.spareParts,    '#aaffaa'));
      rows.push('<span style="color:rgba(0,180,255,0.4)">── RAWS ──</span>');
      for (const [k, v] of Object.entries(sb.raws)) {
        rows.push(`<span style="color:rgba(160,204,238,0.6)">${k.toUpperCase()}: ${Math.floor(v)}</span>`);
      }
    } else {
      if (sb.produces) {
        rows.push(`<span style="color:${sb.produces.color}">▲ ${sb.produces.label.toUpperCase()}</span>`);
      }
      rows.push(fmt('ENERGY',    inv.energy        ?? 0, tgt.energy,        '#ffcc00'));
      rows.push(fmt('ENGINES',   inv.engineParts   ?? 0, tgt.engineParts,   '#00e5ff'));
      rows.push(fmt('CANNONS',   inv.cannonParts   ?? 0, tgt.cannonParts,   '#00e5ff'));
      rows.push(fmt('SHIELDS',   inv.shieldParts   ?? 0, tgt.shieldParts,   '#00e5ff'));
      rows.push(fmt('COMPUTERS', inv.computerParts ?? 0, tgt.computerParts, '#00e5ff'));
      rows.push(fmt('TORPEDOES', inv.torpedoes     ?? 0, tgt.torpedoes,     '#ff9900'));
      rows.push(fmt('SPARE PTS', inv.spareParts    ?? 0, tgt.spareParts,    '#aaffaa'));
    }

    el.innerHTML = rows.join('<br>');
  }

  _hideTooltip() {
    document.getElementById('sector-tooltip').classList.add('hidden');
  }

  // =========================================================
  // RENDERING
  // =========================================================

  _loop() {
    this._resizeCanvas();
    let lastTime = performance.now();
    const tick = (now) => {
      requestAnimationFrame(tick);
      this._resizeCanvas();

      try {
        const dt = Math.min((now - lastTime) / 1000, 0.1);
        lastTime = now;
        // Always update ships regardless of map visibility
        this._updateSupplyShips(dt);
        this._updateZylons(dt);

        // Refresh the selected-sector resources panel every 2 seconds
        if (this._selectedHex) {
          this._lastPanelRefresh = (this._lastPanelRefresh ?? 0) + dt;
          if (this._lastPanelRefresh >= 2) {
            this._lastPanelRefresh = 0;
            this._updateResourcesPanel(this._selectedHex);
          }
        }

        // Skip draw when canvas has no size (map overlay hidden)
        if (this.canvas.width === 0 || this.canvas.height === 0) return;
        this._draw();
      } catch (err) {
        console.error('[GalaxyMap] tick error (loop preserved):', err);
      }
    };
    requestAnimationFrame(tick);
  }

  _updateSupplyShips(dt) {
    // Tick all starbases (mining, maintenance, capital manufacturing)
    for (const sb of this.starbases) {
      sb.tick(dt);
    }

    for (const ship of this.supplyShips) {
      ship.update(dt);
    }

    // Capital ship build queue — check after all ticks so inventory is current
    const capital = this.starbases.find(s => s.isCapital);
    if (capital) capital._shipBuildTick(dt, this.supplyShips);

    // Recompute visibility every frame — ships move, so fog must stay current
    this._updateVisibility();
  }

  // =========================================================
  // ZYLON SYSTEM
  // =========================================================

  /** Place the initial Spawner on the resource prospect hex farthest from all player starbases. */
  _placeZylonSpawner() {
    if (!this.zylonProspects || this.zylonProspects.length === 0) return;

    // Score each prospect: farthest = highest minimum distance to any starbase
    let best = null;
    let bestScore = -1;
    for (const pos of this.zylonProspects) {
      const minDist = Math.min(
        ...this.starbases.map(sb => HexMath.distance(pos, { q: sb.q, r: sb.r }))
      );
      if (minDist > bestScore) {
        bestScore = minDist;
        best = pos;
      }
    }
    if (!best) return;

    const spawner = new ZylonSpawner({ q: best.q, r: best.r, galaxy: this });
    this.zylonSpawners.push(spawner);
  }

  /**
   * Fast-forward the Zylon AI synchronously (no rendering) until the first
   * starbase Beacon is placed. This ensures Red Alert fires on frame 1.
   */
  _fastForwardZylons() {
    // Each step = 15 simulated seconds. At 45s/jump a Seeker moves every 3 steps;
    // at 60s/cycle a Spawner produces every 4 steps.
    // Runs synchronously with no rendering — completes in milliseconds.
    const step = GameConfig.zylon.fastForwardStepSec;
    const MAX_STEPS = 2000; // safety cap (~500 simulated minutes)
    let steps = 0;
    this.fastForwarding = true;
    // The Spawner fires redAlert + onRedAlert() automatically when the beacon is deployed.
    while (
      !this.zylonBeacons.some(b => b.active && b.type === 'starbase') &&
      steps < MAX_STEPS
    ) {
      this._updateZylons(step);
      steps++;
    }
    this.fastForwarding = false;
  }

  /** Tick all Zylon units. Called every frame (and during fast-forward). */
  _updateZylons(dt) {
    for (const spawner of this.zylonSpawners) {
      spawner.tick(dt, this);
    }
    for (const seeker of this.zylonSeekers) {
      seeker.tick(dt, this);
    }
    for (const warrior of this.zylonWarriors) {
      warrior.tick(dt, this);
    }
    for (const beacon of this.zylonBeacons) {
      beacon.tick(dt);
    }
    // Clean up dead units
    this.zylonSpawners = this.zylonSpawners.filter(s => s.alive);
    this.zylonSeekers  = this.zylonSeekers.filter(s => s.alive);
    this.zylonWarriors = this.zylonWarriors.filter(w => w.alive);
    this.zylonBeacons  = this.zylonBeacons.filter(b => b.active);
  }

  /** Called when a Warrior arrives at its beacon sector. */
  _onWarriorArrived(warrior) {
    if (this.onWarriorArrived) this.onWarriorArrived(warrior);
  }

  /** Called by ZylonSeeker._moveTo when it steps into a new sector. */
  _onSeekerArrived(seeker) {
    if (this.onSeekerArrived) this.onSeekerArrived(seeker);
  }

  /** Called when a starbase's shields fail and it goes dormant. */
  _onStarbaseFallen(sb) {
    console.log(`[GalaxyMap] Starbase ${sb.name} has gone DORMANT.`);
    const k = HexMath.key(sb.q, sb.r);
    this.revealed.add(k);
  }

  /** Called when a dormant starbase auto-reactivates from supply ship fuel. */
  _onStarbaseRestored(sb) {
    console.log(`[GalaxyMap] Starbase ${sb.name} RESTORED.`);
    if (this.onStarbaseRestored) this.onStarbaseRestored(sb);
  }

  /** Called by ZylonSpawner when it creates a new sub-Spawner. */
  _onSubSpawnerCreated(spawner) {
    // Already pushed into this.zylonSpawners by the parent — nothing extra needed
  }

  /** Returns all Zylon Seekers currently in the given galaxy sector. */
  seekersInSector(q, r) {
    return this.zylonSeekers.filter(s => s.q === q && s.r === r && s.alive);
  }

  /** Returns all Zylon Warriors currently in the given galaxy sector. */
  warriorsInSector(q, r) {
    return this.zylonWarriors.filter(w => w.q === q && w.r === r && w.alive && w.state !== 'WARPING');
  }

  /** Returns all Beacons in the given galaxy sector. */
  beaconsInSector(q, r) {
    return this.zylonBeacons.filter(b => b.q === q && b.r === r && b.active);
  }


  _resizeCanvas() {
    const c = this.canvas;
    if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
      c.width  = c.clientWidth;
      c.height = c.clientHeight;
      this._centerOrigin();
    }
  }

  _draw() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);

    // Deep space background
    this._drawBackground(ctx, width, height);

    // Commerce lanes (behind hexes)
    const effectiveSize = this.hexSize * this.zoom;
    for (const lane of this.lanes) {
      lane.draw(ctx, effectiveSize, {
        x: this.origin.x + this.pan.x,
        y: this.origin.y + this.pan.y,
      });
    }

    // Hexes
    for (const [k, hex] of this.hexes) {
      this._drawHex(ctx, hex, k, effectiveSize);
    }

    // Starbases
    for (const sb of this.starbases) {
      this._drawStarbase(ctx, sb);
    }

    // Supply ships (above hexes, below player)
    for (const ship of this.supplyShips) {
      const k = HexMath.key(ship.currentHex.q, ship.currentHex.r);
      if (this.visible.has(k) || this.revealed.has(k)) {
        ship.draw(ctx, (q, r) => this._hexToScreen(q, r), this.zoom);
      }
    }

    // Player ship marker
    this._drawPlayer(ctx);

    // Warp target indicator
    if (this.targetPos) {
      this._drawTarget(ctx);
    }

    // Zylon units (always drawn in test mode, regardless of fog)
    if (GameConfig.testMode) {
      this._drawZylons(ctx);
      // Frozen banner
      if (this._testFrozen) {
        const { width, height } = this.canvas;
        ctx.save();
        ctx.fillStyle = 'rgba(255, 40, 40, 0.18)';
        ctx.fillRect(0, 0, width, height);
        ctx.font        = 'bold 22px Orbitron, sans-serif';
        ctx.fillStyle   = '#ff4444';
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = '#ff0000';
        ctx.shadowBlur  = 18;
        ctx.fillText('⚠ GAME START STATE — AI FROZEN', width / 2, 38);
        ctx.restore();
      }
    }
  }

  _drawBackground(ctx, w, h) {
    // Gradient
    const grad = ctx.createRadialGradient(w/2, h/2, 0, w/2, h/2, Math.max(w,h)*0.7);
    grad.addColorStop(0,   'rgba(5,15,40,1)');
    grad.addColorStop(1,   'rgba(2,5,15,1)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Stars
    const t = Date.now() * 0.00005;
    for (const s of this.stars) {
      const drift = s.speed * t;
      const sx = ((s.x + this.pan.x * s.speed * 0.05) % w + w) % w;
      const sy = ((s.y + drift * 0.5) % h + h) % h;
      const twinkle = 0.5 + 0.5 * Math.sin(Date.now() * 0.001 * s.twinkle + s.phase);
      ctx.globalAlpha = s.alpha * (0.6 + 0.4 * twinkle);
      ctx.fillStyle   = s.color;
      ctx.fillRect(sx, sy, s.size, s.size);
    }
    ctx.globalAlpha = 1;
  }

  _drawHex(ctx, hex, key, effectiveSize) {
    effectiveSize = effectiveSize || this.hexSize * this.zoom;
    const sc = this._hexToScreen(hex.q, hex.r);
    const corners = HexMath.hexCorners(sc.x, sc.y, effectiveSize - 1);
    const isVis  = this.visible.has(key);
    const isRev  = this.revealed.has(key);
    const isHov  = this.hoveredHex && HexMath.key(this.hoveredHex.q, this.hoveredHex.r) === key;
    const isTgt  = this.targetPos  && HexMath.key(this.targetPos.q,  this.targetPos.r)  === key;
    const isPlayer = HexMath.key(this.playerPos.q, this.playerPos.r) === key;

    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();

    // Fill — revealed and visible hexes show the same sector color
    if (!isVis && !isRev) {
      ctx.fillStyle = 'rgba(0,0,0,0)'; // completely unknown
    } else {
      // Both live and charted show sector type
      const colors = {
        nebula:    'rgba(60,20,80,0.55)',
        asteroid:  'rgba(50,40,20,0.55)',
        habitable: 'rgba(10,60,30,0.55)',
        void:      'rgba(5,15,35,0.55)',
      };
      ctx.fillStyle = colors[hex.type] || 'rgba(5,15,35,0.55)';
    }
    ctx.fill();

    // Border
    if (isVis || isRev) {
      let borderColor, borderWidth, borderAlpha;
      if (isTgt) {
        borderColor = '#00ffaa'; borderWidth = 2; borderAlpha = 0.9;
      } else if (isHov) {
        borderColor = '#00b4ff'; borderWidth = 2; borderAlpha = 0.8;
      } else if (isPlayer) {
        borderColor = '#fff';    borderWidth = 2; borderAlpha = 0.5;
      } else if (isVis) {
        borderColor = '#1a3a5a'; borderWidth = 1; borderAlpha = 0.7;
      } else {
        borderColor = '#0d1f33'; borderWidth = 1; borderAlpha = 0.4;
      }
      ctx.strokeStyle = `rgba(${this._hexToRgb(borderColor)},${borderAlpha})`;
      ctx.lineWidth   = borderWidth;
      ctx.stroke();
    }

    // Resource / type dot — show for all charted sectors (live or revealed)
    if ((isVis || isRev) && hex.type !== 'void') {
      const dotColors = { nebula: '#8844aa', asteroid: '#aa7722', habitable: '#22aa55' };
      ctx.fillStyle   = dotColors[hex.type] || '#fff';
      ctx.globalAlpha = isVis ? 0.5 : 0.35;  // slightly dimmer when unmonitored
      ctx.beginPath();
      ctx.arc(sc.x, sc.y + this.hexSize * 0.55, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // ---- FOG OVERLAYS (drawn last so they sit on top of fills/borders) ----

    if (!isVis && !isRev) {
      // Unknown — full black, no visual info at all
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.92)';
      ctx.fill();

    } else if (!isVis && isRev) {
      // Charted but unmonitored — light veil only.
      // Sector identity (type, resource, starbase) fully readable.
      // Only current enemy presence is unknown.
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fill();

      // Small badge near top of hex
      ctx.globalAlpha  = 0.40;
      ctx.font         = `${Math.max(5, 5 * this.zoom)}px Share Tech Mono, monospace`;
      ctx.fillStyle    = '#4488aa';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('○ UNMONITORED', sc.x, sc.y - effectiveSize * 0.55);
      ctx.globalAlpha  = 1;
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'alphabetic';

      // Drone-lost marker — orange exclamation badge if a drone was destroyed here
      const dlTime = this.droneLost.get(key);
      if (dlTime) {
        const elapsed = Math.floor((Date.now() - dlTime) / 60000); // minutes
        const pulse   = 0.6 + 0.4 * Math.sin(Date.now() * 0.004);
        ctx.globalAlpha = 0.85 * pulse;
        ctx.font        = `bold ${Math.max(8, 9 * this.zoom)}px Orbitron, sans-serif`;
        ctx.fillStyle   = '#ff8800';
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', sc.x, sc.y - effectiveSize * 0.18);
        ctx.font        = `${Math.max(6, 7 * this.zoom)}px Share Tech Mono, monospace`;
        ctx.fillStyle   = 'rgba(255,136,0,0.7)';
        ctx.fillText(`${elapsed}m ago`, sc.x, sc.y + effectiveSize * 0.22);
        ctx.globalAlpha = 1;
        ctx.textAlign   = 'left';
        ctx.textBaseline = 'alphabetic';
      }
    }
  }

  _drawStarbase(ctx, sb) {
    if (!this.visible.has(sb.key) && !this.revealed.has(sb.key)) return;
    const sc  = this._hexToScreen(sb.q, sb.r);
    const vis = this.visible.has(sb.key);

    // ── DORMANT starbase: red ✖ marker ────────────────────
    if (sb.state === 'dormant') {
      const alpha = vis ? 1.0 : 0.5;
      const pulse = 0.6 + 0.4 * Math.sin(Date.now() * 0.004 + sb.q);
      ctx.save();
      ctx.globalAlpha = alpha * pulse;

      // Red glow
      if (vis) {
        const grd = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, 28);
        grd.addColorStop(0, 'rgba(255,40,40,0.35)');
        grd.addColorStop(1, 'rgba(255,40,40,0)');
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(sc.x, sc.y, 28, 0, Math.PI * 2); ctx.fill();
      }

      // Dark diamond
      const sz = sb.isCapital ? 10 : 7;
      ctx.strokeStyle = '#ff2222';
      ctx.fillStyle   = 'rgba(80,0,0,0.5)';
      ctx.lineWidth   = sb.isCapital ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(sc.x,      sc.y - sz);
      ctx.lineTo(sc.x + sz, sc.y);
      ctx.lineTo(sc.x,      sc.y + sz);
      ctx.lineTo(sc.x - sz, sc.y);
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      // ✖ cross
      const cr = sz * 0.45;
      ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sc.x - cr, sc.y - cr); ctx.lineTo(sc.x + cr, sc.y + cr);
      ctx.moveTo(sc.x + cr, sc.y - cr); ctx.lineTo(sc.x - cr, sc.y + cr);
      ctx.stroke();

      // Label
      ctx.globalAlpha = alpha;
      ctx.font = '9px Orbitron, sans-serif';
      ctx.fillStyle = '#ff4444';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(sb.name.toUpperCase(), sc.x, sc.y + sz + 14);
      ctx.font = '7px Share Tech Mono, monospace';
      ctx.fillStyle = 'rgba(255,80,80,0.8)';
      ctx.fillText('DORMANT', sc.x, sc.y + sz + 26);

      ctx.restore();
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      return;
    }

    // ── ACTIVE starbase: normal blue rendering ─────────────

    const alpha     = vis ? 1.0 : 0.4;
    const baseColor = sb.isCapital ? '#ffd700' : '#00b4ff';
    const glowColor = sb.isCapital ? 'rgba(255,215,0,' : 'rgba(0,180,255,';

    ctx.globalAlpha = alpha;

    // Glow
    if (vis) {
      const t = Date.now() * 0.002;
      const pulse = 0.6 + 0.4 * Math.sin(t + sb.q);
      const grd = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, 28);
      grd.addColorStop(0,   glowColor + (0.35 * pulse) + ')');
      grd.addColorStop(1,   glowColor + '0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, 28, 0, Math.PI * 2);
      ctx.fill();
    }

    // Icon — diamond shape
    const sz = sb.isCapital ? 10 : 7;
    ctx.strokeStyle = baseColor;
    ctx.fillStyle   = sb.isCapital ? 'rgba(255,215,0,0.25)' : 'rgba(0,180,255,0.20)';
    ctx.lineWidth   = sb.isCapital ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(sc.x,      sc.y - sz);
    ctx.lineTo(sc.x + sz, sc.y);
    ctx.lineTo(sc.x,      sc.y + sz);
    ctx.lineTo(sc.x - sz, sc.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Shield bar
    if (vis && sb.state === 'active') {
      const barW = 32, barH = 4;
      const barX = sc.x - barW / 2;
      const barY = sc.y + sz + 6;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(barX, barY, barW, barH);
      const shieldColor = sb.shields > 50 ? '#0affb2' : sb.shields > 25 ? '#ffaa00' : '#ff3a3a';
      ctx.fillStyle = shieldColor;
      ctx.fillRect(barX, barY, barW * sb.shields / 100, barH);
    }

    // Distress flash
    if (sb.distressActive && vis) {
      const t = Date.now() * 0.005;
      ctx.globalAlpha = alpha * (0.5 + 0.5 * Math.sin(t));
      ctx.strokeStyle = '#ff3a3a';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, 18, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Label + resource badge — show for both live and charted (revealed) sectors
    if (vis || this.revealed.has(sb.key)) {
      ctx.globalAlpha = vis ? 1 : 0.75;
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'top';

      // Base name
      ctx.font      = '9px Orbitron, sans-serif';
      ctx.fillStyle = baseColor;
      ctx.fillText(sb.name.toUpperCase(), sc.x, sc.y + sz + 14);

      // Resource badge
      const badgeY = sc.y + sz + 26;
      if (sb.isCapital) {
        ctx.font      = '7px Share Tech Mono, monospace';
        ctx.fillStyle = 'rgba(255,215,0,0.7)';
        ctx.fillText('COMMAND', sc.x, badgeY);
      } else if (sb.produces) {
        ctx.font      = '7px Share Tech Mono, monospace';
        ctx.fillStyle = sb.produces.color;
        ctx.fillText('▲ ' + sb.produces.label, sc.x, badgeY);
      }
    }

    ctx.globalAlpha  = 1;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * Draw the animated sector indicator for the local player (or any player in multiplayer).
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ q, r }}  pos        Hex position to highlight
   * @param {string}    color      CSS color string (cyan for P1, magenta for P2, etc.)
   */
  _drawPlayerSector(ctx, pos, color = '#00e5ff') {
    const effectiveSize = this.hexSize * this.zoom;
    const sc      = this._hexToScreen(pos.q, pos.r);
    const corners = HexMath.hexCorners(sc.x, sc.y, effectiveSize - 1);
    const t       = Date.now() * 0.001;

    // ---- 1. Outer pulsing glow fill ----
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = color.replace(')', `,${0.07 + 0.07 * pulse})`).replace('rgb', 'rgba');
    // Safer: just use a fixed rgba string based on color
    ctx.fillStyle = `rgba(0,229,255,${0.06 + 0.06 * pulse})`;
    ctx.fill();

    // ---- 2. Marching-ants hex border ----
    const dashLen   = effectiveSize * 0.35;
    const dashOffset = (t * effectiveSize * 0.8) % (dashLen * 2);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.setLineDash([dashLen, dashLen * 0.6]);
    ctx.lineDashOffset = -dashOffset;
    ctx.strokeStyle    = color;
    ctx.lineWidth      = 2.2;
    ctx.globalAlpha    = 0.85 + 0.15 * pulse;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha    = 1;

    // ---- 3. Sparkle dots at each corner (phase-offset) ----
    for (let i = 0; i < 6; i++) {
      const phase   = t * 3 + (i / 6) * Math.PI * 2;
      const sparkle = 0.5 + 0.5 * Math.sin(phase);
      const r       = 2.5 + 1.5 * sparkle;
      ctx.globalAlpha = 0.4 + 0.6 * sparkle;
      ctx.fillStyle   = color;
      ctx.beginPath();
      ctx.arc(corners[i].x, corners[i].y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  _drawPlayer(ctx) {
    // Draw sector highlight for local player (P1 = cyan)
    this._drawPlayerSector(ctx, this.playerPos, '#00e5ff');

    // Ship chevron on top
    const sc    = this._hexToScreen(this.playerPos.q, this.playerPos.r);
    const t     = Date.now() * 0.003;
    const pulse = 0.7 + 0.3 * Math.sin(t);
    const sz    = 7;

    // Glow
    ctx.globalAlpha = 0.5 * pulse;
    const grd = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, 16);
    grd.addColorStop(0, 'rgba(0,229,255,0.6)');
    grd.addColorStop(1, 'rgba(0,229,255,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(sc.x, sc.y, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Chevron
    ctx.fillStyle   = '#ffffff';
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(sc.x,             sc.y - sz);
    ctx.lineTo(sc.x + sz * 0.7,  sc.y + sz * 0.6);
    ctx.lineTo(sc.x,             sc.y + sz * 0.2);
    ctx.lineTo(sc.x - sz * 0.7,  sc.y + sz * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  /** TEST MODE — draw all Zylon units on the map regardless of fog of war. */
  _drawZylons(ctx) {
    const t = Date.now() * 0.003;

    // Clock-angle for each facing index (0=12, 1=2, 2=4, 3=6, 4=8, 5=10 o'clock)
    // In canvas radians: 12 o'clock = -π/2, then +60° per step
    const FACING_ANGLE = [
      -Math.PI / 2,         // 0 = 12 o'clock
      -Math.PI / 2 + Math.PI / 3,  // 1 = 2 o'clock
      -Math.PI / 2 + 2 * Math.PI / 3, // 2 = 4 o'clock
       Math.PI / 2,         // 3 = 6 o'clock
       Math.PI / 2 + Math.PI / 3,  // 4 = 8 o'clock
       Math.PI / 2 + 2 * Math.PI / 3, // 5 = 10 o'clock
    ];

    const label = (ctx, text, x, y, color) => {
      ctx.save();
      ctx.font        = `${Math.max(7, 7 * this.zoom)}px Share Tech Mono, monospace`;
      ctx.fillStyle   = color;
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'top';
      ctx.globalAlpha = 0.9;
      ctx.fillText(text, x, y);
      ctx.restore();
    };

    // ── Spawners ──────────────────────────────────────────
    for (const sp of this.zylonSpawners) {
      if (!sp.alive) continue;
      const sc = this._hexToScreen(sp.q, sp.r);
      const pulse = 0.6 + 0.4 * Math.sin(t * 1.5 + sp.q);
      ctx.save();
      ctx.globalAlpha = 0.85 * pulse;
      ctx.font        = `${Math.max(14, 14 * this.zoom)}px monospace`;
      ctx.fillStyle   = '#ff8800';
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✦', sc.x, sc.y);
      ctx.restore();
      label(ctx, 'SPAWNER', sc.x, sc.y + 10 * this.zoom, '#ff8800');
    }

    // ── Seekers ───────────────────────────────────────────
    for (const sk of this.zylonSeekers) {
      if (!sk.alive) continue;
      const sc    = this._hexToScreen(sk.q, sk.r);
      const angle = FACING_ANGLE[sk.facing] ?? 0;
      const sz    = Math.max(6, 7 * this.zoom);
      const pulse = 0.7 + 0.3 * Math.sin(t * 2 + sk.q + sk.r);

      ctx.save();
      ctx.globalAlpha = 0.9 * pulse;
      ctx.translate(sc.x, sc.y);
      ctx.rotate(angle);

      // Arrowhead pointing in facing direction
      ctx.fillStyle   = '#00ffee';
      ctx.strokeStyle = '#00b4cc';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(0, -sz);          // tip
      ctx.lineTo(sz * 0.55,  sz * 0.7);
      ctx.lineTo(0, sz * 0.3);
      ctx.lineTo(-sz * 0.55, sz * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      const stateAbbr = sk.state === 'GUARDING' ? 'GRD' : sk.state === 'FOLLOWING' ? 'FOL' : sk.state === 'FALLBACK' ? 'FBK' : 'SKR';
      label(ctx, `${stateAbbr} f${sk.facing}`, sc.x, sc.y + 9 * this.zoom, '#00ffee');
    }

    // ── Beacons ───────────────────────────────────────────
    for (const bc of this.zylonBeacons) {
      if (!bc.active) continue;
      const sc    = this._hexToScreen(bc.q, bc.r);
      const pulse = 0.5 + 0.5 * Math.sin(t * 3 + bc.q);
      const color = bc.type === 'starbase' ? '#ff3a3a' : '#ff9900';

      ctx.save();
      ctx.globalAlpha = 0.85 * pulse;
      ctx.font        = `${Math.max(12, 12 * this.zoom)}px monospace`;
      ctx.fillStyle   = color;
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('◆', sc.x, sc.y - 5 * this.zoom);
      ctx.restore();
      label(ctx, 'BCN ' + bc.type.toUpperCase(), sc.x, sc.y + 6 * this.zoom, color);
    }

    // ── Warriors ──────────────────────────────────────────
    for (const wr of this.zylonWarriors) {
      if (!wr.alive || wr.state === 'WARPING') continue;
      const sc    = this._hexToScreen(wr.q, wr.r);
      const pulse = 0.6 + 0.4 * Math.sin(t * 2.5 + wr.q);

      ctx.save();
      ctx.globalAlpha = 0.9 * pulse;
      ctx.font        = `${Math.max(12, 12 * this.zoom)}px monospace`;
      ctx.fillStyle   = '#ff44ff';
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('★', sc.x, sc.y + 14 * this.zoom);
      ctx.restore();
      label(ctx, 'WRR', sc.x, sc.y + 22 * this.zoom, '#ff44ff');
    }
  }

  _drawTarget(ctx) {
    const sc = this._hexToScreen(this.targetPos.q, this.targetPos.r);
    const t  = Date.now() * 0.004;
    const r  = 16 + 3 * Math.sin(t);

    ctx.strokeStyle = 'rgba(0,255,170,0.8)';
    ctx.lineWidth   = 1.5;

    // Rotating brackets
    ctx.save();
    ctx.translate(sc.x, sc.y);
    ctx.rotate(t * 0.5);
    const gap = 0.55;
    for (let i = 0; i < 4; i++) {
      ctx.save();
      ctx.rotate(i * Math.PI / 2);
      ctx.beginPath();
      ctx.arc(0, 0, r, gap, Math.PI / 2 - gap);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // Center dot
    ctx.fillStyle = 'rgba(0,255,170,0.9)';
    ctx.beginPath();
    ctx.arc(sc.x, sc.y, 3, 0, Math.PI * 2);
    ctx.fill();

    // Fuel cost label
    const cost = HexMath.fuelCost(this.playerPos, this.targetPos);
    ctx.font      = '9px Orbitron, sans-serif';
    ctx.fillStyle = '#0affb2';
    ctx.textAlign = 'center';
    ctx.fillText(`WARP: ${cost}`, sc.x, sc.y - r - 6);
    ctx.textAlign = 'left';
  }

  // =========================================================
  // UTILITIES
  // =========================================================

  _generateStars(count) {
    return Array.from({ length: count }, () => ({
      x:       Math.random() * 3000,
      y:       Math.random() * 1800,
      size:    Math.random() < 0.05 ? 2 : 1,
      alpha:   0.3 + Math.random() * 0.7,
      speed:   0.05 + Math.random() * 0.15,
      twinkle: 0.5 + Math.random() * 2,
      phase:   Math.random() * Math.PI * 2,
      color:   ['#ffffff','#aaccff','#ffeecc','#ccddff'][Math.floor(Math.random()*4)],
    }));
  }

  _hexToRgb(hex) {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return `${r},${g},${b}`;
  }
}
