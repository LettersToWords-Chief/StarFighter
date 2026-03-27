/**
 * SupplyShip.js — NPC supply ship that cycles along a commerce lane.
 *
 * State machine:
 *   recharge → departing → [warp flash + jump] → ... → docked → recharge
 *
 *   recharge  — warp drive cooling down (GameConfig.supplyShip.rechargeTime seconds)
 *   departing — drive engaged; ship accelerates toward jump point, pre-jump strobe visible
 *               (GameConfig.supplyShip.warpBurnTime = 4 seconds)
 *   docked    — at a starbase endpoint; drone exchange happens here
 *
 * Ship travels a pre-computed hex path from one starbase to the other,
 * jumping one sector at a time. On arrival at an endpoint it docks, then
 * reverses direction and repeats.
 */

class SupplyShip {
  /**
   * @param {object} opts
   * @param {Array}   opts.path         — [{q,r}, ...] hex path; path[0] = capital end
   * @param {number}  opts.startIndex   — which hex in path to start on
   * @param {boolean} opts.forward      — initial travel direction
   * @param {string}  opts.resource     — raw resource this lane carries (inbound leg)
   * @param {number}  opts.rechargeTime — idle cooldown seconds
   * @param {number}  opts.dockTime     — seconds docked at each endpoint
   * @param {Starbase} opts.capital     — the capital starbase (path[0] end)
   * @param {Starbase} opts.outerBase   — the outer starbase (path[last] end)
   */
  constructor({ path, startIndex = 0, forward = true, resource = 'fuel',
                rechargeTime = GameConfig.supplyShip.rechargeTime,
                dockTime     = GameConfig.supplyShip.dockTime,
                capital      = null,
                outerBase    = null }) {
    this.path         = path;
    this.pathIndex    = startIndex;
    this.forward      = forward;
    this.resource     = resource;
    this.baseRecharge = rechargeTime;
    this.dockTime     = dockTime;
    this.fuel         = GameConfig.supplyShip.fuelCapacity;

    // Cargo endpoints
    this.capital   = capital;
    this.outerBase = outerBase;

    // Current cargo manifest — filled on each dock
    this.cargo = {};

    // State: 'recharge' | 'departing' | 'docked'
    this.state      = 'recharge';
    this.stateTimer = rechargeTime * (startIndex / Math.max(path.length - 1, 1));

    this.health      = GameConfig.supplyShip.maxHealth; // 1000 HP
    this.destroyed   = false;
    this.underAttack = false;

    // Visual
    this.flashPhase  = Math.random() * Math.PI * 2;
    this.warpFlash   = 0;
    this.departFlash = 0;
  }

  // ---- Computed state ----

  get currentHex()   { return this.path[this.pathIndex]; }

  get nextHex() {
    const ni = this.forward ? this.pathIndex + 1 : this.pathIndex - 1;
    if (ni < 0 || ni >= this.path.length) return null;
    return this.path[ni];
  }

  get rechargeTime() {
    const healthFrac = this.health / (GameConfig.supplyShip.maxHealth ?? 1000);
    return this.baseRecharge * (1 + (1 - healthFrac) * 1.5);
  }

  get colorState() {
    if (this.underAttack || this.health < 250) return 'critical';
    if (this.health < 600)                     return 'damaged';
    return 'normal';
  }

  get isAtEndpoint() {
    return this.pathIndex === 0 || this.pathIndex === this.path.length - 1;
  }

  /** True when in the departing phase (pre-warp strobe) */
  get isDeparting() { return this.state === 'departing'; }

  // ---- Update ----

  /**
   * @param {number} dt  — delta time in seconds
   * @returns {boolean}  — true if ship just warped (jumped to next hex)
   */
  update(dt) {
    this.warpFlash   = Math.max(0, this.warpFlash   - dt * 4);
    this.departFlash = Math.max(0, this.departFlash - dt * 3);
    let warped = false;

    if (this.state === 'docked') {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) {
        // Dock complete: drone has returned — apply pending fuel AND repair
        if (this._pendingFuelDelivery > 0 && this.outerBase?.inventory) {
          this.outerBase.inventory.energy = Math.min(
            this.outerBase.target?.energy ?? Infinity,
            (this.outerBase.inventory.energy ?? 0) + this._pendingFuelDelivery
          );
          this._pendingFuelDelivery = 0;
        }
        // Apply pending repair (out-of-sector: no drone animation, apply here)
        if (this._pendingRepairHp > 0) {
          this.health = Math.min(GameConfig.supplyShip.maxHealth, this.health + this._pendingRepairHp);
          this._pendingRepairHp = 0;
          if (GameConfig.testMode) {
            const sid = this.outerBase?.name || this.resource || 'CARGO';
            const clk = window.SubspaceComm?.clockStr?.() || '?';
            window.SubspaceComm?.send('CARGO RPR', clk, `[${sid}]  HP: ${this.health}/1000`);
          }
        }

        // Load raws for return trip (only from active base)
        if (this.outerBase?.state === 'active') {
          this.cargo = this.outerBase.buildDepartureCargo('inbound');
        } else {
          this.cargo = {};
        }
        this.forward    = !this.forward;
        this.state      = 'recharge';
        this.stateTimer = this.rechargeTime;
      }

    } else if (this.state === 'recharge') {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) {
        // Drive engages — first flash, begin burn
        this.state        = 'departing';
        this.stateTimer   = GameConfig.supplyShip.warpBurnTime;
        this.departFlash  = 1.0;
      }

    } else if (this.state === 'departing') {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) {
        // Hyperspace flash — jump!
        this._doWarp();
        warped = true;
      }
    }

    return warped;
  }

  _doWarp() {
    const next = this.forward ? this.pathIndex + 1 : this.pathIndex - 1;

    // At boundary — dock or reverse
    if (next < 0 || next >= this.path.length) {
      if (this.isAtEndpoint) {
        this.state      = 'docked';
        this.stateTimer = this.dockTime;
        this._handleDock();
      } else {
        this.forward    = !this.forward;
        this.state      = 'recharge';
        this.stateTimer = this.rechargeTime;
      }
      return;
    }

    // Consume 110E of fuel per jump (100 warp + 10 for in-sector maneuvering)
    this.fuel = Math.max(0, this.fuel - (GameConfig.supplyShip.energyPerJump ?? 110));

    this.pathIndex = next;
    this.warpFlash = 1.0;
    this.state     = 'recharge';
    this.stateTimer = this.rechargeTime;

    if (this.isAtEndpoint) {
      this.state      = 'docked';
      this.stateTimer = this.dockTime;
      this._handleDock();
    }
  }

  /**
   * Called whenever the ship enters docked state at an endpoint.
   * Delivers current cargo to the docking starbase, then loads return cargo.
   *
   * path[0]          = capital end  (pathIndex === 0)
   * path[last index] = outer base end
   */
  _handleDock() {
    if (this.destroyed) return; // destroyed ships don't dock

    // ── Parts for repair are loaded onto the drone at dock time ──
    // Applied when the drone returns (in SectorView) or at dock-end (out-of-sector).
    const SS   = GameConfig.supplyShip;
    const maxH = SS.maxHealth;
    this._pendingRepairHp = 0;
    if (this.health < maxH) {
      const atCap = this.pathIndex === 0;
      const base  = atCap ? this.capital : this.outerBase;
      const inv   = base?.inventory;
      if (inv) {
        const hpNeeded  = maxH - this.health;
        const partsNeed = Math.ceil(hpNeeded / SS.repairCostPerPart);
        const partsHave = Math.floor(inv.spareParts ?? 0);
        const partsUsed = Math.min(partsNeed, partsHave);
        if (partsUsed > 0) {
          inv.spareParts       = partsHave - partsUsed; // parts leave base on the drone
          this._pendingRepairHp = partsUsed * SS.repairCostPerPart;
        }
      }
    }

    const atCapital   = this.pathIndex === 0;
    const routeHops   = this.path.length - 1;
    const fuelPerHop  = GameConfig.supplyShip.energyPerJump ?? 100;
    const returnCost  = routeHops * fuelPerHop;

    if (atCapital && this.capital) {
      // ── Arrived at capital: deliver raws, refuel ──
      if (Object.keys(this.cargo).length) {
        this.capital.receiveDelivery(this.cargo);
      }

      // Only load outbound cargo if the outer base is still active
      if (this.outerBase?.state === 'active') {
        this.cargo = this.capital.buildDepartureCargo('outbound');
      } else {
        this.cargo = {}; // outer base dormant — idle at capital, carry nothing out
      }

      // Refuel from capital energy stock (respect strategic reserve)
      const reserve   = GameConfig.capital.strategicReserve.energy ?? 10000;
      const capEnergy = this.capital.inventory.energy ?? 0;
      const available = Math.max(0, capEnergy - reserve);
      const needed    = GameConfig.supplyShip.fuelCapacity - this.fuel;
      const refuel    = Math.min(needed, available);
      this.capital.inventory.energy = capEnergy - refuel;
      this.fuel += refuel;

    } else if (!atCapital && this.outerBase) {
      const baseActive = this.outerBase.state === 'active';

      // Deliver manufactured cargo on arrival (active bases only)
      if (baseActive && Object.keys(this.cargo).length) {
        this.outerBase.receiveDelivery(this.cargo);
      }
      this.cargo = {};

      // Store fuel surplus as pending — applied at dock end (drone return)
      const surplus = Math.max(0, this.fuel - returnCost);
      if (surplus > 0) {
        this._pendingFuelDelivery = surplus;
        this.fuel -= surplus;
      } else {
        this._pendingFuelDelivery = 0;
      }
      // Note: raws are loaded at dock END (see update() stateTimer <= 0 above)
    }
  }

  // ---- Rendering ----

  draw(ctx, hexToScreen, zoom) {
    const cur = this.currentHex;
    if (!cur) return;

    const sc  = hexToScreen(cur.q, cur.r);
    const nxt = this.nextHex;

    const COLORS = {
      normal:   '#0affb2',
      damaged:  '#ffaa00',
      critical: '#ff3a3a',
    };
    const baseColor = COLORS[this.colorState];
    const sz = Math.max(3, 6 * zoom);

    // ---- DOCKED visual ----
    if (this.state === 'docked') {
      const t      = Date.now() * 0.003;
      const pingR  = sz * (1.2 + 0.8 * ((t * 0.5) % 1));
      const pingA  = 1 - ((t * 0.5) % 1);

      ctx.save();
      ctx.translate(sc.x, sc.y);

      ctx.strokeStyle = baseColor; ctx.lineWidth = 1; ctx.globalAlpha = pingA * 0.6;
      ctx.beginPath(); ctx.arc(0, 0, pingR, 0, Math.PI * 2); ctx.stroke();

      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = baseColor; ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5;
      const hs = sz * 0.65;
      ctx.fillRect(-hs, -hs, hs * 2, hs * 2); ctx.strokeRect(-hs, -hs, hs * 2, hs * 2);

      ctx.fillStyle = baseColor; ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(0, 0, sz * 0.25, 0, Math.PI * 2); ctx.fill();

      ctx.restore(); ctx.globalAlpha = 1;
      return;
    }

    // ---- TRANSIT / DEPARTING visual (arrow + strobe) ----
    const isDep  = this.state === 'departing';
    // Pre-jump strobe for departing state
    const strobe = isDep
      ? 0.5 + 0.5 * Math.sin(Date.now() * 0.02 + this.flashPhase)
      : 1.0;
    const alpha  = (0.7 + 0.3 * strobe) * (isDep ? (0.8 + 0.4 * strobe) : 1);

    let angle = 0, ox = 0, oy = 0;
    if (nxt) {
      const ns = hexToScreen(nxt.q, nxt.r);
      angle = Math.atan2(ns.y - sc.y, ns.x - sc.x);
      const perpAngle  = angle + Math.PI / 2;
      const laneOffset = Math.max(4, 7 * zoom);
      ox = Math.cos(perpAngle) * laneOffset;
      oy = Math.sin(perpAngle) * laneOffset;
    }

    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.translate(sc.x + ox, sc.y + oy);
    ctx.rotate(angle);

    // Warp burst glow
    if (this.warpFlash > 0 || this.departFlash > 0) {
      const gf  = Math.max(this.warpFlash, this.departFlash);
      const col = isDep ? `rgba(255,160,0,${gf * 0.7})` : `rgba(255,255,255,${gf * 0.6})`;
      const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, sz * 3);
      grd.addColorStop(0, col);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(0, 0, sz * 3, 0, Math.PI * 2); ctx.fill();
    }

    // Arrow — brighter orange when departing
    ctx.fillStyle   = isDep ? '#ffaa00' : baseColor;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo( sz,        0);
    ctx.lineTo(-sz * 0.6,  sz * 0.5);
    ctx.lineTo(-sz * 0.2,  0);
    ctx.lineTo(-sz * 0.6, -sz * 0.5);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
