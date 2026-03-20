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
   * @param {Array}  opts.path         — [{q,r}, ...] hex path from A to B
   * @param {number} opts.startIndex   — which hex in path to start on (for pipeline spacing)
   * @param {boolean} opts.forward     — initial travel direction
   * @param {string} opts.resource     — resource type being carried
   * @param {number} opts.rechargeTime — idle cooldown seconds (base)
   * @param {number} opts.dockTime     — seconds to spend docked
   */
  constructor({ path, startIndex = 0, forward = true, resource = 'fuel',
                rechargeTime = GameConfig.supplyShip.rechargeTime,
                dockTime     = GameConfig.supplyShip.dockTime }) {
    this.path         = path;
    this.pathIndex    = startIndex;
    this.forward      = forward;
    this.resource     = resource;
    this.baseRecharge = rechargeTime;
    this.dockTime     = dockTime;
    this.fuel         = GameConfig.supplyShip.fuelCapacity;

    // State: 'recharge' | 'departing' | 'docked'
    this.state      = 'recharge';
    // Stagger start times so a full pipeline of ships is evenly spaced
    this.stateTimer = rechargeTime * (startIndex / Math.max(path.length - 1, 1));

    this.health      = 100;
    this.underAttack = false;

    // Visual
    this.flashPhase  = Math.random() * Math.PI * 2;
    this.warpFlash   = 0;   // 0→1 burst intensity, fades quickly
    this.departFlash = 0;   // 0→1 first-flash intensity when drive engages
  }

  // ---- Computed state ----

  get currentHex()   { return this.path[this.pathIndex]; }

  get nextHex() {
    const ni = this.forward ? this.pathIndex + 1 : this.pathIndex - 1;
    if (ni < 0 || ni >= this.path.length) return null;
    return this.path[ni];
  }

  get rechargeTime() {
    return this.baseRecharge * (1 + (1 - this.health / 100) * 1.5);
  }

  get colorState() {
    if (this.underAttack || this.health < 25) return 'critical';
    if (this.health < 60)                     return 'damaged';
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
      } else {
        this.forward    = !this.forward;
        this.state      = 'recharge';
        this.stateTimer = this.rechargeTime;
      }
      return;
    }

    this.pathIndex = next;
    this.warpFlash = 1.0;
    this.state     = 'recharge';
    this.stateTimer = this.rechargeTime;

    if (this.isAtEndpoint) {
      this.state      = 'docked';
      this.stateTimer = this.dockTime;
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
