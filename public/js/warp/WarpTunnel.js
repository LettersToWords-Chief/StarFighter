/**
 * WarpTunnel.js — Interactive hyperspace navigation sequence.
 *
 * Inspired by Star Raiders (Atari, 1979):
 *   - 5-second warp sequence with streaking star particles
 *   - Inner crosshair (fixed center) + outer crosshair (jitters randomly)
 *   - Player must keep outer crosshair aligned with inner via mouse / WASD / gamepad
 *   - Accuracy score determines landing sector
 *   - Damaged hyperdrive hides outer crosshair
 *
 * Usage:
 *   WarpTunnel.play({ canvas, warpDistance, onComplete, damaged })
 *   onComplete(accurate: boolean, driftVector: {x,y})
 */

const WarpTunnel = (() => {
  'use strict';

  // ---- Constants ----
  const DURATION        = 5.0;
  const BASE_PLAYER_FORCE = 1.5;  // overridden per difficulty via play({ correctionForce })
  const MAX_DRIFT_AMP   = BASE_PLAYER_FORCE * 0.80;
  const PHASE_DUR_MIN   = 0.6;
  const PHASE_DUR_MAX   = 1.8;
  const DAMPING         = 0.88;
  const MAX_DRIFT       = 0.40;
  const OUTER_BOX_FRAC  = 0.10;
  const PARTICLE_COUNT  = 900;

  // ---- Internal state ----
  let _renderer, _scene, _camera, _particles;
  let _running = false;
  let _canvas  = null;

  // Crosshair drift (normalized -1..1 relative to half-screen, x/y)
  let _drift    = { x: 0, y: 0 };
  let _driftVel = { x: 0, y: 0 };

  // Mouse / virtual cursor position in canvas pixels (relative to canvas top-left)
  // This is what the player moves to "chase" the outer crosshair
  let _cursorX = 0, _cursorY = 0;     // pixel position on canvas
  let _cursorReady = false;            // true once player moves mouse

  // Keyboard state
  const _keys = new Set();

  // On-course sample tracking
  let _onCourseSamples = 0;
  let _totalSamples    = 0;
  let _finalDriftMag   = 0;

  // Drift phase state (direction + amplitude each lasts a duration then changes)
  let _phase = { dx: 0, dy: 0, amp: 0, timer: 0 };


  // Callbacks
  let _onComplete = null;
  let _damaged    = false;
  let _warpDist   = 1;
  let _playerForce = BASE_PLAYER_FORCE; // set per-play from difficulty setting
  let _elapsed    = 0;
  let _rafId      = null;
  let _lastTime   = 0;

  // ---- Canvas size helper (works even when canvas is display:none) ----
  function _canvasSize(canvas) {
    const W = canvas.clientWidth  || canvas.offsetWidth  || window.innerWidth;
    const H = canvas.clientHeight || canvas.offsetHeight || window.innerHeight;
    return { W: W || 940, H: H || 680 };
  }

  // ---- Setup Three.js ----
  function _initThree(canvas) {
    const { W, H } = _canvasSize(canvas);
    if (_renderer && _renderer.domElement === canvas) {
      _renderer.setSize(W, H);
      _camera.aspect = W / H;
      _camera.updateProjectionMatrix();
      return;
    }

    _renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    _renderer.setSize(W, H);
    _renderer.setClearColor(0x000000, 1);

    _camera = new THREE.PerspectiveCamera(80, W / H, 0.1, 1000);
    _camera.position.set(0, 0, 0);
  }

  function _buildScene(speed) {
    _scene = new THREE.Scene();

    // ---- Star streaks (point cloud drawn as elongated lines via geometry) ----
    const positions = new Float32Array(PARTICLE_COUNT * 6); // 2 verts per line
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const r     = Math.random() * 140 + 10;
      const theta = Math.random() * Math.PI * 2;
      const z     = (Math.random() - 0.5) * 600 - 50; // spread along Z, mostly ahead
      const x     = Math.cos(theta) * r;
      const y     = Math.sin(theta) * r;
      const len   = 4 + Math.random() * 18; // streak length
      // tail
      positions[i * 6]     = x;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = z + len;
      // head
      positions[i * 6 + 3] = x;
      positions[i * 6 + 4] = y;
      positions[i * 6 + 5] = z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.7 });
    _particles = new THREE.LineSegments(geo, mat);
    _scene.add(_particles);

    // ---- Tunnel ring (cylinder wireframe) ----
    const tubeGeo = new THREE.CylinderGeometry(60, 80, 500, 24, 1, true);
    const tubeMat = new THREE.MeshBasicMaterial({
      color: 0x003355, wireframe: true, transparent: true, opacity: 0.15,
    });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.rotation.x = Math.PI / 2;
    tube.position.z = -200;
    _scene.add(tube);

    // ---- Central glow (sprite) ----
    const glowGeo = new THREE.PlaneGeometry(30, 30);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x00ccff, transparent: true, opacity: 0.18, depthWrite: false,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.z = -60;
    _scene.add(glow);
  }

  // ---- Input wiring ----
  function _onMouseMove(e) {
    if (!_canvas) return;
    const rect = _canvas.getBoundingClientRect();
    _cursorX     = e.clientX - rect.left;
    // Offset Y so neutral = crosshair centre = (H-90)/2 from canvas top
    _cursorY     = e.clientY - rect.top;
    _cursorReady = true;
  }

  function _onKeyDown(e) { _keys.add(e.code); }
  function _onKeyUp(e)   { _keys.delete(e.code); }

  function _bindInput() {
    window.addEventListener('mousemove', _onMouseMove);
    window.addEventListener('keydown',   _onKeyDown);
    window.addEventListener('keyup',     _onKeyUp);
  }

  function _unbindInput() {
    window.removeEventListener('mousemove', _onMouseMove);
    window.removeEventListener('keydown',   _onKeyDown);
    window.removeEventListener('keyup',     _onKeyUp);
  }

  // ---- Gamepad polling ----
  // Left stick moves the virtual cursor (for players without a mouse)
  function _readGamepad(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      const ax = pad.axes[0] || 0;
      const ay = pad.axes[1] || 0;
      const dz = 0.12;
      if (Math.abs(ax) > dz || Math.abs(ay) > dz) {
        const W = _canvas.clientWidth;
        const H = _canvas.clientHeight;
        _cursorX     = Math.max(0, Math.min(W, _cursorX + ax * 200 * dt));
        _cursorY     = Math.max(0, Math.min(H, _cursorY + ay * 200 * dt));
        _cursorReady = true;
      }
      break;
    }
  }

  // ---- Main loop ----
  function _tick(now) {
    if (!_running) return;
    const dt = Math.min((now - _lastTime) / 1000, 0.05);
    _lastTime = now;
    _elapsed += dt;

    const W  = _canvas.clientWidth;
    const H  = _canvas.clientHeight;
    const cx = W / 2;
    const cy = (H - 90) / 2;  // match SectorView: exclude 90px dashboard

    // Gamepad moves virtual cursor
    _readGamepad(dt);

    // Keyboard also moves virtual cursor (WASD/arrows)
    if (!_cursorReady) { _cursorX = cx; _cursorY = cy; } // start at center
    let kx = 0, ky = 0;
    if (_keys.has('ArrowLeft')  || _keys.has('KeyA')) kx -= 1;
    if (_keys.has('ArrowRight') || _keys.has('KeyD')) kx += 1;
    if (_keys.has('ArrowUp')    || _keys.has('KeyW')) ky -= 1;
    if (_keys.has('ArrowDown')  || _keys.has('KeyS')) ky += 1;
    if (kx !== 0 || ky !== 0) {
      _cursorX     = Math.max(0, Math.min(W, _cursorX + kx * 220 * dt));
      _cursorY     = Math.max(0, Math.min(H, _cursorY + ky * 220 * dt));
      _cursorReady = true;
    }

    // ---- Phase-based drift ----
    _phase.timer -= dt;
    if (_phase.timer <= 0) {
      const angle = Math.random() * Math.PI * 2;
      _phase.dx    = Math.cos(angle);
      _phase.dy    = Math.sin(angle);
      _phase.amp   = Math.random() * MAX_DRIFT_AMP;
      _phase.timer = PHASE_DUR_MIN + Math.random() * (PHASE_DUR_MAX - PHASE_DUR_MIN);
    }
    _driftVel.x += _phase.dx * _phase.amp * dt;
    _driftVel.y += _phase.dy * _phase.amp * dt;

    // ---- Chase correction ----
    // Outer crosshair is at (cx + drift.x*cx, cy + drift.y*cy) in screen pixels.
    // When the player's cursor is near the outer crosshair, apply force toward center.
    const outerPx = cx + _drift.x * cx;
    const outerPy = cy + _drift.y * cy;
    const CAPTURE_PX = 55; // pixels — cursor within this radius = correction active

    const distToCursor = Math.sqrt(
      (_cursorX - outerPx) * (_cursorX - outerPx) +
      (_cursorY - outerPy) * (_cursorY - outerPy)
    );
    const proximity = _cursorReady
      ? Math.max(0, 1 - distToCursor / CAPTURE_PX)
      : 0;

    // Correction force = toward center (0,0 in drift space), scaled by proximity
    if (proximity > 0) {
      const corrForceMag = proximity * _playerForce;
      // Direction: from outer crosshair toward center (opposite of drift)
      const dMag = Math.sqrt(_drift.x * _drift.x + _drift.y * _drift.y) || 1;
      _driftVel.x -= (_drift.x / dMag) * corrForceMag * dt;
      _driftVel.y -= (_drift.y / dMag) * corrForceMag * dt;
    }

    // ---- Velocity damping ----
    _driftVel.x *= Math.pow(DAMPING, 60 * dt);
    _driftVel.y *= Math.pow(DAMPING, 60 * dt);

    // ---- Integrate ----
    _drift.x += _driftVel.x * dt;
    _drift.y += _driftVel.y * dt;

    // ---- Clamp ----
    _drift.x = Math.max(-MAX_DRIFT, Math.min(MAX_DRIFT, _drift.x));
    _drift.y = Math.max(-MAX_DRIFT, Math.min(MAX_DRIFT, _drift.y));

    // ---- On-course = cursor is near outer crosshair ----
    _totalSamples++;
    if (proximity >= 0.3) _onCourseSamples++; // cursor overlapping = on course
    _finalDriftMag = Math.sqrt(_drift.x * _drift.x + _drift.y * _drift.y);

    // ---- Animate particles ----
    const t        = _elapsed / DURATION;
    const spd      = 20 + t * 80; // accelerates through the warp
    const pos      = _particles.geometry.attributes.position;
    const arr      = pos.array;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Move both vertices (tail and head) toward camera
      arr[i * 6 + 2] += spd * dt;
      arr[i * 6 + 5] += spd * dt;
      // Wrap around
      if (arr[i * 6 + 5] > 80) {
        const shift = arr[i * 6 + 5] - (-300);
        arr[i * 6 + 2] -= shift;
        arr[i * 6 + 5] -= shift;
      }
    }
    pos.needsUpdate = true;

    // ---- Render ----
    _renderer.render(_scene, _camera);

    // ---- Draw 2D crosshair overlay ----
    _drawCrosshairs();

    // ---- Check complete ----
    if (_elapsed >= DURATION) {
      _finish();
      return;
    }

    _rafId = requestAnimationFrame(_tick);
  }

  function _drawCrosshairs() {
    const oc = _overlayCtx;
    if (!oc) return;

    // Use _canvas.clientWidth/Height — same space as _cursorX/Y and _tick cx/cy
    const W  = _canvas.clientWidth  || _overlayCtx.canvas.width;
    const H  = _canvas.clientHeight || _overlayCtx.canvas.height;
    const cx = W / 2;
    const cy = (H - 90) / 2;  // above dashboard — matches SectorView crosshair centre
    oc.clearRect(0, 0, W, H);

    const t = Math.min(_elapsed / DURATION, 1);

    // Inner crosshair is the cockpit's own targeting reticle (visible through the overlay).
    // WarpTunnel only draws the drifting OUTER brackets the pilot must chase.

    // ---- Outer crosshair — drifts; player must chase with cursor ----
    if (!_damaged) {
      const ox = cx + _drift.x * cx;
      const oy = cy + _drift.y * cy;
      const outerR     = 30;
      const CAPTURE_PX = 55;

      // Recompute proximity for the draw (same formula as tick)
      const distToCursor = Math.sqrt(
        (_cursorX - ox) * (_cursorX - ox) +
        (_cursorY - oy) * (_cursorY - oy)
      );
      const prox = _cursorReady ? Math.max(0, 1 - distToCursor / CAPTURE_PX) : 0;

      // Color: green when cursor is on it, red when far
      const driftMag = Math.sqrt(_drift.x * _drift.x + _drift.y * _drift.y) / MAX_DRIFT;
      const r = prox > 0.3 ? 0   : Math.round(Math.min(1, driftMag * 1.5) * 255);
      const g = prox > 0.3 ? 220 : Math.round((1 - driftMag) * 160 + 40);
      const outerColor = `rgb(${r},${g},180)`;

      // Faint capture ring — tells player how close they need to get
      oc.strokeStyle = prox > 0 ? `rgba(0,220,180,${0.15 + prox * 0.3})` : 'rgba(255,255,255,0.08)';
      oc.lineWidth   = 1;
      oc.setLineDash([4, 4]);
      oc.beginPath();
      oc.arc(ox, oy, CAPTURE_PX, 0, Math.PI * 2);
      oc.stroke();
      oc.setLineDash([]);

      _drawCross(oc, ox, oy, outerR, outerColor, 2, 0.95);
      oc.strokeStyle = outerColor;
      oc.lineWidth   = 1.5;
      oc.globalAlpha = 0.8;
      oc.beginPath();
      oc.arc(ox, oy, outerR * 0.55, 0, Math.PI * 2);
      oc.stroke();
      oc.globalAlpha = 1;
      _drawCornerBrackets(oc, ox, oy, outerR * 1.5, outerColor);
    }

    // ---- Mouse cursor — visible on-screen so player can see where they are ----
    if (_cursorReady) {
      const curR = 7;
      oc.strokeStyle = 'rgba(255,255,255,0.9)';
      oc.lineWidth   = 1.5;
      // Small + crosshair
      oc.beginPath();
      oc.moveTo(_cursorX - curR*1.6, _cursorY); oc.lineTo(_cursorX - curR*0.4, _cursorY);
      oc.moveTo(_cursorX + curR*0.4, _cursorY); oc.lineTo(_cursorX + curR*1.6, _cursorY);
      oc.moveTo(_cursorX, _cursorY - curR*1.6); oc.lineTo(_cursorX, _cursorY - curR*0.4);
      oc.moveTo(_cursorX, _cursorY + curR*0.4); oc.lineTo(_cursorX, _cursorY + curR*1.6);
      oc.stroke();
      oc.fillStyle   = 'rgba(255,255,255,0.85)';
      oc.beginPath();
      oc.arc(_cursorX, _cursorY, 2.5, 0, Math.PI * 2);
      oc.fill();
    }


    const barW = W * 0.4;
    const barX = (W - barW) / 2;
    const barY = H - 38;
    const barH = 4;
    oc.fillStyle = 'rgba(0,0,0,0.5)';
    oc.fillRect(barX - 2, barY - 2, barW + 4, barH + 4);
    oc.fillStyle = '#00aaff';
    oc.fillRect(barX, barY, barW * t, barH);

    // ---- Label ----
    oc.font        = `bold 12px Orbitron, sans-serif`;
    oc.fillStyle   = 'rgba(0,180,255,0.8)';
    oc.textAlign   = 'center';
    oc.fillText('HYPERSPACE', W / 2, barY - 10);
    oc.fillStyle   = 'rgba(0,180,255,0.4)';
    oc.font        = '9px Share Tech Mono, monospace';
    oc.fillText('MOVE MOUSE ONTO THE DRIFTING CROSSHAIR TO CORRECT COURSE', W / 2, barY + 18);
    oc.textAlign   = 'left';
  }

  function _drawCross(ctx, cx, cy, r, color, lw, alpha) {
    ctx.strokeStyle = color;
    ctx.lineWidth   = lw;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx - r * 0.25, cy);
    ctx.moveTo(cx + r * 0.25, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - r * 0.25);
    ctx.moveTo(cx, cy + r * 0.25); ctx.lineTo(cx, cy + r);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function _drawCornerBrackets(ctx, cx, cy, r, color) {
    const bs = r * 0.35; // bracket size
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.globalAlpha = 0.6;
    // TL
    ctx.beginPath(); ctx.moveTo(cx - r, cy - r + bs); ctx.lineTo(cx - r, cy - r); ctx.lineTo(cx - r + bs, cy - r); ctx.stroke();
    // TR
    ctx.beginPath(); ctx.moveTo(cx + r, cy - r + bs); ctx.lineTo(cx + r, cy - r); ctx.lineTo(cx + r - bs, cy - r); ctx.stroke();
    // BL
    ctx.beginPath(); ctx.moveTo(cx - r, cy + r - bs); ctx.lineTo(cx - r, cy + r); ctx.lineTo(cx - r + bs, cy + r); ctx.stroke();
    // BR
    ctx.beginPath(); ctx.moveTo(cx + r, cy + r - bs); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx + r - bs, cy + r); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ---- Overlay canvas ----
  let _overlayCanvas = null;
  let _overlayCtx    = null;

  function _ensureOverlay() {
    if (_overlayCanvas) return;
    _overlayCanvas = document.createElement('canvas');
    _overlayCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10;';
    _overlayCtx    = _overlayCanvas.getContext('2d');
  }

  // ---- Finish ----
  function _finish() {
    _running = false;
    cancelAnimationFrame(_rafId);
    _unbindInput();

    const onCourseRatio = _totalSamples > 0 ? _onCourseSamples / _totalSamples : 0;
    const onTarget      = onCourseRatio >= 0.65;
    const arrivalOffset = Math.min(1, _finalDriftMag / MAX_DRIFT);

    // Clean up overlay canvas
    if (_overlayCanvas && _overlayCanvas.parentElement) {
      _overlayCanvas.parentElement.removeChild(_overlayCanvas);
      _overlayCanvas = null;
      _overlayCtx    = null;
    }

    // Hide the warp-view overlay
    document.getElementById('warp-view').classList.remove('warp-active');

    if (_onComplete) _onComplete(onTarget, { ..._drift }, arrivalOffset);
  }

  // ---- Public API ----
  function play({ canvas, warpDistance = 1, onComplete, damaged = false, correctionForce }) {
    if (_running) return;

    // Always use the dedicated warp canvas inside #warp-view
    _canvas = document.getElementById('warp-canvas');

    _warpDist    = warpDistance;
    _onComplete  = onComplete;
    _damaged     = damaged;
    _playerForce = correctionForce ?? BASE_PLAYER_FORCE;
    _elapsed     = 0;
    _lastTime    = performance.now();
    _running     = true;
    _drift       = { x: 0, y: 0 };
    _driftVel    = { x: 0, y: 0 };
    const { W: cW, H: cH } = _canvasSize(_canvas);
    _cursorX      = cW / 2;
    _cursorY      = (cH - 90) / 2;  // start cursor at cockpit center
    _cursorReady  = false;
    _onCourseSamples = 0;
    _totalSamples    = 0;
    _finalDriftMag   = 0;
    _phase           = { dx: 0, dy: 0, amp: 0, timer: 0 };

    // Show the warp overlay
    document.getElementById('warp-view').classList.add('warp-active');

    _initThree(_canvas);
    _buildScene(warpDistance);

    // Create 2D overlay canvas for crosshairs — CSS pixel dimensions to match cursor coords
    _overlayCanvas = null; _overlayCtx = null;
    _ensureOverlay();
    _overlayCanvas.width  = _canvas.clientWidth;
    _overlayCanvas.height = _canvas.clientHeight;
    document.getElementById('warp-view').appendChild(_overlayCanvas);

    _bindInput();
    _rafId = requestAnimationFrame(_tick);
  }

  return { play };
})();
