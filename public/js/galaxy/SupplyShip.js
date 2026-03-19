/**
 * SupplyShip.js — NPC supply ship that cycles along a commerce lane.
 *
 * State machine:
 *   RECHARGE → WARP → TRANSIT → ... → APPROACHING → DOCKED → DEPARTING → RECHARGE
 *
 * Ship travels a pre-computed hex path from one starbase to the other,
 * micro-jumping one sector at a time with a recharge delay between jumps.
 * On arrival it docks briefly, then reverses and repeats.
 */

class SupplyShip {
  /**
   * @param {object} opts
   * @param {Array}  opts.path         — [{q,r}, ...] hex path from A to B
   * @param {number} opts.startIndex   — which hex in path to start on (for pipeline spacing)
   * @param {boolean} opts.forward     — initial travel direction
   * @param {string} opts.resource     — resource type being carried
   * @param {number} opts.rechargeTime — seconds between jumps (base)
   * @param {number} opts.dockTime     — seconds to spend docked
   */
  constructor({ path, startIndex = 0, forward = true, resource = 'fuel',
                rechargeTime = 2.5, dockTime = 3.0 }) {
    this.path         = path;           // [{q,r}] full route
    this.pathIndex    = startIndex;     // current position in path
    this.forward      = forward;        // travel direction
    this.resource     = resource;
    this.baseRecharge = rechargeTime;
    this.dockTime     = dockTime;

    // State: 'recharge' | 'warp' | 'docked'
    this.state        = 'recharge';
    this.stateTimer   = rechargeTime * (startIndex / Math.max(path.length - 1, 1));
    // ↑ offset start time to space pipeline ships evenly

    this.health       = 100;   // 0–100; degrades on encounter
    this.underAttack  = false;

    // Visual
    this.flashPhase   = Math.random() * Math.PI * 2; // random phase for desync
    this.warpFlash    = 0; // 0–1 flash intensity on warp
  }

  // ---- Computed state ----

  get currentHex() { return this.path[this.pathIndex]; }

  get nextHex() {
    const ni = this.forward ? this.pathIndex + 1 : this.pathIndex - 1;
    if (ni < 0 || ni >= this.path.length) return null;
    return this.path[ni];
  }

  get rechargeTime() {
    // Damaged ships recharge slower
    return this.baseRecharge * (1 + (1 - this.health / 100) * 1.5);
  }

  get colorState() {
    if (this.underAttack || this.health < 25) return 'critical';
    if (this.health < 60)                     return 'damaged';
    return 'normal';
  }

  /** True when the current hex is one of the route endpoints (starbase location) */
  get isAtEndpoint() {
    return this.pathIndex === 0 || this.pathIndex === this.path.length - 1;
  }

  // ---- Update ----

  /**
   * @param {number} dt  — delta time in seconds
   * @returns {boolean}  — true if ship just warped (for external logging)
   */
  update(dt) {
    this.warpFlash = Math.max(0, this.warpFlash - dt * 4);
    let warped = false;

    if (this.state === 'docked') {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) {
        // Finished docking — reverse direction, begin recharge
        this.forward    = !this.forward;
        this.state      = 'recharge';
        this.stateTimer = this.rechargeTime;
      }

    } else if (this.state === 'recharge') {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) {
        this._doWarp();
        warped = true;
      }

    }
    return warped;
  }

  _doWarp() {
    const next = this.forward ? this.pathIndex + 1 : this.pathIndex - 1;

    // At boundary — dock if at endpoint, otherwise reverse
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

    this.pathIndex  = next;
    this.warpFlash  = 1.0;
    this.state      = 'recharge';
    this.stateTimer = this.rechargeTime;

    // Dock if we just arrived at an endpoint
    if (this.isAtEndpoint) {
      this.state      = 'docked';
      this.stateTimer = this.dockTime;
    }
  }

  // ---- Rendering ----

  /**
   * Draw this ship on the galaxy canvas.
   * @param {CanvasRenderingContext2D} ctx
   * @param {function} hexToScreen  — (q,r) => {x,y}
   * @param {number} zoom
   */
  draw(ctx, hexToScreen, zoom) {
    const cur = this.currentHex;
    if (!cur) return;

    const sc = hexToScreen(cur.q, cur.r);
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
      // Small square with animated ping ring — clearly "parked", not moving
      const t = Date.now() * 0.003;
      const pingR = sz * (1.2 + 0.8 * ((t * 0.5) % 1));
      const pingAlpha = 1 - ((t * 0.5) % 1);

      ctx.save();
      ctx.translate(sc.x, sc.y);

      // Ping ring
      ctx.strokeStyle = baseColor;
      ctx.lineWidth   = 1;
      ctx.globalAlpha = pingAlpha * 0.6;
      ctx.beginPath();
      ctx.arc(0, 0, pingR, 0, Math.PI * 2);
      ctx.stroke();

      // Square body
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = baseColor;
      ctx.fillStyle   = 'rgba(0,0,0,0.4)';
      ctx.lineWidth   = 1.5;
      const hs = sz * 0.65;
      ctx.fillRect(-hs, -hs, hs * 2, hs * 2);
      ctx.strokeRect(-hs, -hs, hs * 2, hs * 2);

      // Center dot
      ctx.fillStyle   = baseColor;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(0, 0, sz * 0.25, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      ctx.globalAlpha = 1;
      return;
    }

    // ---- TRANSIT visual (arrow) ----

    // Pre-jump flash — rapid pulse in last 30% of recharge
    const flashFraction = this.state === 'recharge'
      ? Math.max(0, 1 - this.stateTimer / this.rechargeTime)
      : 0;
    const isPreJump = flashFraction > 0.7;
    const flashPulse = isPreJump
      ? 0.5 + 0.5 * Math.sin(Date.now() * 0.015 + this.flashPhase)
      : 1.0;

    const warpGlow = this.warpFlash;
    const alpha    = 0.7 + 0.3 * flashPulse;

    // Direction angle + perpendicular lane offset
    let angle = 0;
    let ox = 0, oy = 0;

    if (nxt) {
      const ns = hexToScreen(nxt.q, nxt.r);
      angle = Math.atan2(ns.y - sc.y, ns.x - sc.x);
      const perpAngle  = angle + Math.PI / 2;
      const laneOffset = Math.max(4, 7 * zoom);
      ox = Math.cos(perpAngle) * laneOffset;
      oy = Math.sin(perpAngle) * laneOffset;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(sc.x + ox, sc.y + oy);
    ctx.rotate(angle);

    // Warp glow burst on jump
    if (warpGlow > 0) {
      const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, sz * 3);
      grd.addColorStop(0, `rgba(255,255,255,${warpGlow * 0.6})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(0, 0, sz * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Arrow pointing right (+x), rotated by angle
    ctx.fillStyle   = baseColor;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    ctx.moveTo( sz,           0);
    ctx.lineTo(-sz * 0.6,     sz * 0.5);
    ctx.lineTo(-sz * 0.2,     0);
    ctx.lineTo(-sz * 0.6,    -sz * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
