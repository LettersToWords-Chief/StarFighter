/**
 * SectorView.js — First-person sector flight.
 *
 * Mouse → steer (joystick model: offset from center = turn rate)
 * 0-9 keys / scroll → set speed
 * G / Escape → return to galaxy map
 * D → dock (when near starbase)
 */
const SectorView = (() => {
  'use strict';

  // ---- Constants ----
  const TURN_YAW    = 1.3;
  const TURN_PITCH  = 0.9;
  const ACCEL_RATE      = 25;    // u/s² — rate used for all speed changes
  const WARP_VELOCITY   = 99;    // u/s cap during warp charge
  const WARP_CHARGE_TIME = 4.0;  // seconds of steering before accuracy is captured
  // User-specified speed table (u/s): throttle 0=stopped, 1–9 as below
  const SPD_VALS    = [0, 2, 4, 6, 9, 13, 19, 28, 42, 64];
  const SECTOR_R    = 1000;
  const DOCK_R      = 100;
  const SB_POS      = new THREE.Vector3(0, 0, 0);   // Starbase is always at world origin
  const TORPEDO_SPEED  = 200;  // units/sec
  const TORPEDO_LIFE   = 2.5;  // seconds (travels 1500 units max in sector of radius 1000)
  const TORPEDO_OFFSET = 1.0;  // horizontal spawn offset
  const TORPEDO_ENERGY        = GameConfig.player.energyPerShot;
  const ENERGY_BASE_DRAIN     = GameConfig.player.energyBasePerSec;
  const ENERGY_COMPUTER_DRAIN = GameConfig.player.energyComputerPerSec;
  const ENERGY_ENGINE_FACTOR  = GameConfig.player.energyEngineMultiplier;
  const TORPEDO_CD     = 0.28;

  // Subspace message flash
  let _msgTimer = 0, _msgFrom = '', _msgText = '', _msgClock = '';

  // Force shield
  const SHIELD_R      = 82;    // radius — outside starbase ring+arms (~65u), inside cargo dock (102u)
  const SHIELD_DAMAGE = 100;   // HP dealt to player per collision event
  const SHIELD_CD     = 1.0;   // seconds between player collision damage ticks

  // Beacon combat
  const BEACON_HIT_R       = 20;   // torpedo/ram collision radius (units)
  const BEACON_SPEED       = 100;  // orbital evasion speed (u/s)
  const BEACON_EVASION_DUR = 10;   // seconds of orbit after each hit
  const BEACON_HIT_DELAY   = 0.2;  // delay before flight starts (seconds)

  // ---- State ----
  let _renderer = null, _scene = null, _camera = null;
  let _running  = false, _paused = false, _rafId = null;
  let _canvas = null, _glCanvas = null;
  let _onExit = null, _onMapToggle = null;
  let _lastTime = 0;
  let _overlayCanvas = null, _overlayCtx = null;

  // Flight
  let _speed = 0;
  let _currentVelocity = 0;  // actual live velocity (u/s), ramps toward target
  let _cameraQuat = new THREE.Quaternion();
  let _mnx = 0, _mny = 0;
  let _warpCharging = false;
  let _warpChargeTimer = 0;          // counts up during charge phase (fires at WARP_CHARGE_TIME)
  let _warpChargeCallback = null;
  let _warpBursting = false;         // true during 99→999 u/s burst (1 s, locked)
  let _warpBurstCallback = null;     // called when burst peaks at 999
  let _warpDebursting = false;       // true during 999→99 decel in new sector (1 s, locked)
  let _warpTargetDir = new THREE.Vector3(0, 0, -1);
  let _warpDrift = 0;
  let _warpMult = 1.0;
  let _lockState = 0;          // 0=none 1=partial-top 2=partial-bottom 3=full
  let _starbaseLocked = false;  // true when SB dot is inside inner scope box
  let _targetLocked   = false;  // true when any combat contact is fully locked
  let _aftLocked      = false;  // true when a rear enemy is within 500u and centered on scope
  let _lockedContactPos    = null;               // 3D world position of the front-locked contact
  let _lockedContactVel    = new THREE.Vector3(); // velocity of the front-locked contact
  let _aftLockedContactPos = null;               // 3D world position of the aft-locked contact
  let _aftLockedContactVel = new THREE.Vector3(); // velocity of the aft-locked contact
  const _keys = new Set();

  let _sectorType = 'void', _sectorName = '', _hasStarbase = false;
  let _sectorQ = 0, _sectorR = 0;   // current sector coords — used by cargo ship system
  let _sbGroup = null, _starsMesh = null, _dustMesh = null;
  let _nearSB = false, _entryTimer = 3.5;
  let _voidObjects = [];   // translucent fragments in void sectors — recycled as camera moves

  // Dashboard stats
  let _energy       = 9999;
  let _torpedoCount = 200;   // current torpedo inventory
  let _kills   = 0;
  let _targets = 0;
  let _currentStarbase = null;  // Starbase object for the sector we're in

  // Energy telemetry
  let _galacticClock      = 0;          // total seconds played (never resets)
  let _energyTotalConsumed = 0;         // cumulative energy spent this session
  let _energyHistory  = new Array(60).fill(0);  // ring buffer: E/sec for each of last 60 s
  let _energyHistIdx  = 0;             // ring buffer write pointer
  let _energySampleTimer = 0;          // time accumulated within the current 1-second window
  let _energyRate     = 0;            // last completed second's consumption rate (E/s)
  let _energyLastSec  = 9999;         // energy snapshot at start of each 1-second window

  // ---- Shield Capacitor ----
  // charge  : current energy stored (0-100)
  // capacity: max ceiling (degrades with S-system hp)
  // rechargeRate: units/sec refill speed (degrades with S-system hp)
  let _shieldCharge       = 400;
  let _shieldCapacity     = 400;  // also the shield's own HP pool
  let _shieldRechargeRate = 67;   // units/sec

  function _shieldParamsFromHP(hp) {
    if (hp >= 75) return { cap: 100, rate: 20 };
    if (hp >= 50) return { cap: 75,  rate: 12 };
    if (hp >= 25) return { cap: 40,  rate: 5  };
    if (hp >= 1)  return { cap: 15,  rate: 1  };
    return             { cap: 0,   rate: 0  };
  }

  // ---- Ship systems (hull health) ----
  let _systems = null;
  function _resetSystems() {
    _systems = { P: 100, E: 100, S: 100, C: 100, L: 100, R: 100 };
    _shieldCharge       = 400;
    _shieldCapacity     = 400;
    _shieldRechargeRate = 67;
  }

  // ---- Computer Subsystems ----
  // Each subsystem: 100 HP. >=50=healthy, 1-49=damaged, 0=destroyed.
  let _computer = null;
  function _resetComputer() {
    _computer = {
      warpAutopilot: 100,
      targeting:     100,
      radio:         100,
      scanner:       100,
      dashboard:     100,
    };
  }
  const _computerKeys = ['warpAutopilot','targeting','radio','scanner','dashboard'];
  function _damageComputer(dmg) {
    if (!_computer || dmg <= 0) return;
    const key = _computerKeys[Math.floor(Math.random() * _computerKeys.length)];
    _computer[key] = Math.max(0, _computer[key] - dmg);
  }

  // ---- Engines (4 independent) ----
  let _engines = null;
  function _resetEngines() {
    _engines = [{ hp:100 },{ hp:100 },{ hp:100 },{ hp:100 }];
  }
  function _workingEngineCount() {
    return _engines ? _engines.filter(e => e.hp > 0).length : 4;
  }
  function _maxSpeedIdx() {
    // Use total combined engine HP (max 400) proportional to max speed index 9
    if (!_engines) return 9;
    const totalHP = _engines.reduce((s, e) => s + e.hp, 0);
    return Math.max(1, Math.floor(totalHP / 400 * 9));
  }

  // ---- Warp Drive ----
  let _warpDriveHP = 100;
  function _resetWarpDrive() { _warpDriveHP = 100; }
  // Max warp range: half of 10% of HP, floor 1
  function _maxWarpRange() { return Math.max(1, _warpDriveHP * 0.05); }

  // ---- Cannon thermal model — see GameConfig.cannons for all tuned values ----
  // Each cannon: hp (0–100), temp (0–200+), charge (0–100)
  let _cannon = null;
  let _fRPending = 0;
  let _cannonCoolingRate = 10; // updated each tick; shown on dashboard
  let _torpedoes    = [];
  let _fireFlash    = 0;
  let _hitFlash     = 0;

  function _resetCannons() {
    _cannon = {
      fL:  { hp:100, temp:0, charge:100 },
      fR:  { hp:100, temp:0, charge:100 },
      aft: { hp:100, temp:0, charge:100 },
    };
    _fRPending = 0;
  }

  function _cannonReady(c) {
    return c.hp > 0 && c.temp < GameConfig.cannons.tempFireMax && c.charge >= 99.5;
  }

  // ---- View modes ----
  let _shieldsOn    = true;
  let _computerOn   = true;
  let _rearView     = false;
  let _lrsOn        = false;
  let _inputBound   = false;
  let _redAlert     = false;

  // ---- Zylon ships ----
  let _zylons = [];  // ZylonShip instances (seeker_tie, seeker_bird, seeker_beacon, warrior)

  // ---- Asteroids ----
  let _asteroids    = [];
  let _cargoShips   = [];
  let _allSupplyShips = [];
  let _cargoDrones  = [];

  // ---- Starbase force shield ----
  let _sbShieldMeshes     = [];
  let _sbShieldFlash      = 0;
  let _sbShieldDmgCooldown = 0;
  let _shieldImpacts      = []; // active hit animations [{ring, light, age, maxAge}]
  let _explosions         = []; // active explosion animations

  // service drones flying between SB and docked cargo ships

  // ---- Docking state machine ----
  // idle → outbound → connected → returning → done → idle
  const DOCK_RANGE = 250;                     // max distance to starbase to initiate docking
  const DRONE_SPEED = 12;                    // units/sec for both legs
  const DOCK_CONNECT_SECS = 8;              // seconds connected while refueling
  // Camera-local attach point: lower-right as if docking with ship belly
  const PLUG_CAM_LOCAL = new THREE.Vector3(1.8, -1.2, -2.8);
  let _dockState  = 'idle'; // 'idle'|'outbound'|'connected'|'returning'|'done'
  let _dockIsKickstart       = false;
  let _kickstartPending       = false;
  let _starbaseDormantNotified = false; // fires sector alert once when SB goes dormant
  let _plugMesh   = null;
  let _plugEndPos = new THREE.Vector3(); // world-space attach point (lower-right of view)
  let _connectTimer = 0;

  // ---- Repair plan (player docking repair system) ----
  let _repairPlan     = [];    // [{id, label, hp, maxHP, partKey, checked, damaged, apply}]
  let _repairReserved = {};   // { engineParts: N, ... } — total taken from base at dock-start
  let _repairDockMode = false; // true=docking, false=read-only (R key)
  let _repairPanelOpen = false;

  // ---- Mouse-in-view tracking ----
  let _mouseInView       = true;  // assume mouse starts in view (corrected by mouseleave)
  let _windowFocused     = true;  // false while user is in another app/tab
  let _skipNextMousedown = false; // true after window regains focus — absorbs return-click


  // ---- Input ----
  function _onMM(e) {
    if (!_canvas || !_mouseInView) return;  // ignore mouse movement outside the game
    const r     = _canvas.getBoundingClientRect();
    const DH    = 130; // dashboard height — must match _drawHUD
    const scale = r.width * 0.45;
    const viewCy = r.top + r.height / 2; // true canvas center = camera aim point
    _mnx = Math.max(-1, Math.min(1, (e.clientX - r.left - r.width / 2) / scale));
    _mny = Math.max(-1, Math.min(1, (e.clientY - viewCy)               / scale));
  }
  function _onMD(e) {
    // Absorb the first click after the browser tab regains focus
    if (_skipNextMousedown) { _skipNextMousedown = false; return; }
    if (_repairPanelOpen) return;  // damage report open — don't fire
    if (e.button === 0) { _fireLeft();  } // left  click = left  front cannon
    if (e.button === 2) { _fireRight(); } // right click = right front cannon
  }
  function _onCM(e) { e.preventDefault(); } // suppress right-click context menu
  function _onKD(e) {
    _keys.add(e.code);
    if (e.code.startsWith('Digit')) { const d = +e.key; if (!isNaN(d)) _speed = d; }
    if (e.code === 'BracketRight' || e.code === 'PageUp')   _speed = Math.min(9, _speed + 1);
    if (e.code === 'BracketLeft'  || e.code === 'PageDown') _speed = Math.max(0, _speed - 1);
    if (e.code === 'KeyF') { _rearView = false; _computerOn = true; } // Front view
    if (e.code === 'KeyA') { _rearView = true;  _computerOn = true; } // Aft view
    if (e.code === 'KeyS') { _shieldsOn = !_shieldsOn;   }           // Shields
    if (e.code === 'KeyC') { _computerOn = !_computerOn; }           // Attack computer
    if (e.code === 'KeyL') { _lrsOn = !_lrsOn; }                     // Long range scan
    if (e.code === 'KeyM') { /* TODO: manual target */    }           // Manual target
    if (e.code === 'KeyP') { _paused ? resume() : pause(); }         // Pause
    if (e.code === 'KeyD') {
      // Initiate docking: must be within range, stopped, starbase present, and idle
      if (_hasStarbase && _dockState === 'idle') {
        const distToSB = _camera.position.distanceTo(SB_POS);
        if (distToSB < DOCK_RANGE && _currentVelocity < 0.5) {
          _plugEndPos.copy(PLUG_CAM_LOCAL).applyMatrix4(_camera.matrixWorld);
          _plugMesh.position.copy(SB_POS);
          _plugMesh.visible = true;
          // Choose dock type based on starbase state
          _dockIsKickstart = (_currentStarbase?.state === 'dormant');
          _dockState = 'outbound';
          // Build repair plan and open overlay (drone departs simultaneously)
          if (!_dockIsKickstart) {
            _buildRepairPlan(true);
            _openDamageReport();
          }
        }
      }
    }
    if (e.code === 'KeyR') {
      // Damage report — read-only view at any time
      if (!_repairPanelOpen) {
        _buildRepairPlan(false);
        _openDamageReport();
      } else {
        _closeDamageReport();
      }
    }
    if (e.code === 'Space') { e.preventDefault(); _fireAft(); } // Space = AFT cannon
  }
  function _onKU(e) { _keys.delete(e.code); }
  function _onW(e) {
    e.preventDefault();
    // Scroll forward (wheel up, deltaY < 0) = front view
    // Scroll back    (wheel down, deltaY > 0) = rear  view
    if (e.deltaY < 0) { _rearView = false; _computerOn = true; }
    else              { _rearView = true;  _computerOn = true; }
  }
  let _combatViewEl = null; // cached #combat-view element for enter/leave listeners
  function _onMouseEnter() {
    _mouseInView = true;
  }
  function _onMouseLeave() {
    _mouseInView = false;
    _mnx = 0;   // stop rotation when mouse leaves the playing field
    _mny = 0;
  }
  function _onWinFocus() {
    _windowFocused     = true;
    _skipNextMousedown = true;  // first click back restores focus — don’t fire cannon
  }
  function _onWinBlur() {
    _windowFocused     = false;
    _skipNextMousedown = false; // reset (no pending return click)
    _mouseInView = false;
    _mnx = 0;
    _mny = 0;
  }

  function _bind() {
    if (_inputBound) return;
    _inputBound = true;
    window.addEventListener('mousemove', _onMM);
    window.addEventListener('mousedown', _onMD);
    window.addEventListener('keydown',   _onKD);
    window.addEventListener('keyup',     _onKU);
    window.addEventListener('resize',      _onResize);
    window.addEventListener('contextmenu', _onCM);
    window.addEventListener('wheel',       _onW, { passive: false });
    window.addEventListener('focus', _onWinFocus);
    window.addEventListener('blur',  _onWinBlur);
    _combatViewEl = document.getElementById('combat-view');
    if (_combatViewEl) {
      _mouseInView = _combatViewEl.matches?.(':hover') ?? true;
      _combatViewEl.addEventListener('mouseenter', _onMouseEnter);
      _combatViewEl.addEventListener('mouseleave', _onMouseLeave);
    }
    if (_canvas) {
      _canvas.addEventListener('contextmenu', _onCM);
    }
  }
  function _unbind() {
    if (!_inputBound) return;
    _inputBound = false;
    window.removeEventListener('mousemove', _onMM);
    window.removeEventListener('mousedown', _onMD);
    window.removeEventListener('keydown',   _onKD);
    window.removeEventListener('keyup',     _onKU);
    window.removeEventListener('resize',      _onResize);
    window.removeEventListener('contextmenu', _onCM);
    window.removeEventListener('wheel',       _onW);
    window.removeEventListener('focus', _onWinFocus);
    window.removeEventListener('blur',  _onWinBlur);
    if (_combatViewEl) {
      _combatViewEl.removeEventListener('mouseenter', _onMouseEnter);
      _combatViewEl.removeEventListener('mouseleave', _onMouseLeave);
    }
    if (_canvas) {
      _canvas.removeEventListener('contextmenu', _onCM);
    }
  }

  function _onResize() {
    if (!_renderer || !_canvas) return;
    const par = _canvas.parentElement;
    const W = par?.offsetWidth  || _canvas.clientWidth  || window.innerWidth;
    const H = par?.offsetHeight || _canvas.clientHeight || window.innerHeight;
    if (W === 0 || H === 0) return;
    _renderer.setSize(W, H, false);
    if (_camera) {
      _camera.aspect = W / H;
      _camera.updateProjectionMatrix();
    }
    // Sync overlay canvas size on resize
    if (_overlayCanvas) {
      _overlayCanvas.width  = W || _overlayCanvas.width;
      _overlayCanvas.height = H || _overlayCanvas.height;
    }
  }

  // Gamepad left-stick as mouse substitute
  function _gamepad() {
    for (const p of (navigator.getGamepads?.() || [])) {
      if (!p) continue;
      const dz = 0.12;
      if (Math.abs(p.axes[0]) > dz) _mnx = p.axes[0];
      if (Math.abs(p.axes[1]) > dz) _mny = p.axes[1];
      if (p.buttons[5]?.pressed) _speed = Math.min(9, _speed + 1);
      if (p.buttons[4]?.pressed) _speed = Math.max(0, _speed - 1);
      break;
    }
  }

  // ---- Three.js ----
  function _canvasSize() {
    const W = _canvas.clientWidth  || _canvas.offsetWidth  || window.innerWidth;
    const H = _canvas.clientHeight || _canvas.offsetHeight || window.innerHeight;
    return { W: W || 940, H: H || 680 };
  }

  function _initThree() {
    const { W, H } = _canvasSize();
    // Remove any previous _glCanvas to prevent stacked canvases after warp (fisheye bug)
    if (_glCanvas && _glCanvas.parentElement) {
      _glCanvas.parentElement.removeChild(_glCanvas);
    }
    if (_renderer) { _renderer.dispose(); }

    _glCanvas = document.createElement('canvas');
    _glCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:1;';
    (_canvas.parentElement || document.body).appendChild(_glCanvas);

    _renderer = new THREE.WebGLRenderer({ canvas: _glCanvas, antialias: true });
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    _renderer.setSize(W, H, false); // false = let CSS control canvas display size
    _renderer.setClearColor(0x000005, 1);
    _camera = new THREE.PerspectiveCamera(60, W / H, 0.5, 40000);
    _camera.rotation.order = 'YXZ';
  }

  function _buildScene() {
    _scene = new THREE.Scene();
    _scene.add(new THREE.AmbientLight(0x111122, 1.2));
    _buildStars();
    _buildDust();
    if (_sectorType === 'void')      _buildVoidObjects();
    if (_sectorType === 'nebula')    _buildNebula();
    if (_sectorType === 'asteroid')  _buildAsteroids();
    if (_sectorType === 'habitable') _buildPlanet();
    if (_hasStarbase) { _buildStarbase(); _buildPlug(); _buildShield(); }
  }

  // Fixed background star field — 2000 stars at large radius, 3px each for HD visibility
  function _buildStars() {
    const n = 2000;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 1500 + Math.random() * 1000;
      pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i*3+2] = r * Math.cos(phi);
      col[i*3]   = 0.78 + Math.random() * 0.22;
      col[i*3+1] = 0.78 + Math.random() * 0.22;
      col[i*3+2] = 0.88 + Math.random() * 0.12;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    _starsMesh = new THREE.Points(g, new THREE.PointsMaterial({
      size: 3, vertexColors: true, sizeAttenuation: false,
    }));
    _scene.add(_starsMesh);
  }

  // Close-range space dust — rescaled for SECTOR_R=1000
  function _buildDust() {
    const n = 300, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 10 + Math.random() * 60; // 10-70 units around camera
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i*3+2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    _dustMesh = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.5, color: 0x7799bb, sizeAttenuation: false, transparent: true, opacity: 0.38,
    }));
    _scene.add(_dustMesh);
  }

  // Translucent crystal/rock fragments scattered through void sectors.
  // At various depths they stream by at different apparent speeds as the camera moves,
  // giving genuine parallax and sense of velocity without any stars.
  function _buildVoidObjects() {
    _voidObjects = [];
    const COUNT = 120;
    const geos  = [
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.TetrahedronGeometry(1, 0),
      new THREE.OctahedronGeometry(1, 0),
    ];
    const PALETTE = [0x3a4f6a, 0x2e3d55, 0x4a5a6b, 0x556070, 0x354862, 0x223344];

    for (let i = 0; i < COUNT; i++) {
      const r     = 200 + Math.random() * 4800;
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const px = r * Math.sin(phi) * Math.cos(theta);
      const py = r * Math.sin(phi) * Math.sin(theta);
      const pz = r * Math.cos(phi);

      // Keep a clear zone around the starbase
      if (_hasStarbase) {
        const dx = px - SB_POS.x, dy = py - SB_POS.y, dz = pz - SB_POS.z;
        if (dx*dx + dy*dy + dz*dz < 400*400) { i--; continue; }
      }

      const scale   = 2 + Math.random() * 16;
      const opacity = 0.04 + Math.random() * 0.10;
      const color   = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      const geo     = geos[Math.floor(Math.random() * geos.length)];

      const mat  = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(px, py, pz);
      mesh.scale.setScalar(scale);
      mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
      _scene.add(mesh);
      _voidObjects.push(mesh);
    }
  }

  // Recycle void objects that fall behind the camera — makes space feel infinite
  function _updateVoidObjects() {
    if (!_voidObjects.length || !_camera) return;
    const fwd  = new THREE.Vector3(0, 0, -1).applyQuaternion(_cameraQuat);
    const camP = _camera.position;
    for (const m of _voidObjects) {
      const rel    = m.position.clone().sub(camP);
      const behind = rel.dot(fwd);
      if (behind < -3000) {
        // Respawn 500–2000 units ahead in a wide cone
        const dist   = 500 + Math.random() * 1500;
        const spread = 1500;
        const right  = new THREE.Vector3(1, 0, 0).applyQuaternion(_cameraQuat);
        const up     = new THREE.Vector3(0, 1, 0).applyQuaternion(_cameraQuat);
        m.position.copy(camP)
          .addScaledVector(fwd,   dist)
          .addScaledVector(right, (Math.random() - 0.5) * spread)
          .addScaledVector(up,    (Math.random() - 0.5) * spread * 0.6);
      }
    }
  }


  function _buildNebula() {
    _scene.fog = new THREE.FogExp2(0x0a0012, 0.0004);
    const n = 600, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i*3]   = (Math.random() - 0.5) * 1500;
      pos[i*3+1] = (Math.random() - 0.5) * 500;
      pos[i*3+2] = (Math.random() - 0.5) * 1500;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    _scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 14, color: 0xaa44cc, transparent: true, opacity: 0.3, sizeAttenuation: true })));
    const g2 = g.clone();
    _scene.add(new THREE.Points(g2, new THREE.PointsMaterial({ size: 50, color: 0x551188, transparent: true, opacity: 0.10, sizeAttenuation: true })));
    const l = new THREE.PointLight(0xaa44cc, 1.5, 1100);
    l.position.set(150, 50, -350);
    _scene.add(l);
  }

  function _buildAsteroids() {
    _asteroids = [];
    const dir = new THREE.DirectionalLight(0xffeedd, 0.9);
    dir.position.set(1, 0.5, 0.3);
    _scene.add(dir);
    for (let i = 0; i < 20; i++) {
      const sz  = 6 + Math.random() * 28;
      const geo = new THREE.DodecahedronGeometry(sz, 0);
      const pa  = geo.attributes.position;
      for (let v = 0; v < pa.count; v++) {
        pa.setXYZ(v, pa.getX(v)*(0.8+Math.random()*0.4), pa.getY(v)*(0.8+Math.random()*0.4), pa.getZ(v)*(0.8+Math.random()*0.4));
      }
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x665544 }));
      const ang  = Math.random() * Math.PI * 2, dist = 200 + Math.random() * 900;
      mesh.position.set(Math.cos(ang)*dist, (Math.random()-0.5)*300, Math.sin(ang)*dist - 150);
      mesh.rotation.set(Math.random()*6, Math.random()*6, Math.random()*6);
      _scene.add(mesh);
      // Store collision data including mesh reference for destruction
      _asteroids.push({ mesh, pos: mesh.position, radius: sz * 0.75 });
    }
  }


  function _buildPlanet() {
    const dir = new THREE.DirectionalLight(0xfff8ee, 1.2);
    dir.position.set(2, 1, 1);
    _scene.add(dir);
    const planet = new THREE.Mesh(new THREE.SphereGeometry(290, 32, 32), new THREE.MeshLambertMaterial({ color: 0x225599 }));
    planet.position.set(550, -140, -1900);
    _scene.add(planet);
    const atm = new THREE.Mesh(new THREE.SphereGeometry(310, 32, 32), new THREE.MeshBasicMaterial({ color: 0x44aaff, transparent: true, opacity: 0.08, side: THREE.BackSide }));
    atm.position.copy(planet.position);
    _scene.add(atm);
  }

  function _buildStarbase() {
    _sbGroup = new THREE.Group();
    _sbGroup.position.copy(SB_POS);
    // Hub
    _sbGroup.add(new THREE.Mesh(new THREE.OctahedronGeometry(21, 0), new THREE.MeshBasicMaterial({ color: 0x00b4ff, wireframe: true })));
    _sbGroup.add(new THREE.Mesh(new THREE.OctahedronGeometry(19, 0), new THREE.MeshLambertMaterial({ color: 0x001133 })));
    // Arms
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const arm   = new THREE.Mesh(new THREE.BoxGeometry(3.5, 3.5, 55), new THREE.MeshLambertMaterial({ color: 0x002244 }));
      arm.position.set(Math.cos(angle)*39, 0, Math.sin(angle)*39);
      arm.rotation.y = -angle;
      _sbGroup.add(arm);
      const tip = new THREE.PointLight(0x00aaff, 0.7, 90);
      tip.position.set(Math.cos(angle)*65, 0, Math.sin(angle)*65);
      _sbGroup.add(tip);
    }
    // Ring
    const ringGeo = new THREE.TorusGeometry(47.5, 2, 6, 24);
    const ring     = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x004488 }));
    ring.rotation.x = Math.PI / 2; ring.name = 'ring';
    _sbGroup.add(ring);
    const ringW = new THREE.Mesh(ringGeo.clone(), new THREE.MeshBasicMaterial({ color: 0x00b4ff, wireframe: true }));
    ringW.rotation.x = Math.PI / 2; ringW.name = 'ringW';
    _sbGroup.add(ringW);
    _sbGroup.add(Object.assign(new THREE.PointLight(0x00b4ff, 2, 250)));
    _scene.add(_sbGroup);
  }

  // ============================================================
  // REPAIR PLAN — build, render, apply, abort
  // ============================================================

  function _buildRepairPlan(dockMode) {
    _repairDockMode = dockMode;
    _repairReserved = {};

    // All ship systems in priority order
    const allSystems = [
      // ── PROPULSION ──
      { id:'warpDrive',  label:'WARP DRIVE',      group:'PROPULSION', sortPriority:0,
        hp: _warpDriveHP,       maxHP: 100, partKey:'engineParts',
        apply: () => { _warpDriveHP = 100; } },
      { id:'engine0',    label:'ENGINE 1',         group:'PROPULSION', sortPriority:1,
        hp: _engines[0].hp,    maxHP: 100, partKey:'engineParts',
        apply: () => { _engines[0].hp = 100; } },
      { id:'engine1',    label:'ENGINE 2',         group:'PROPULSION', sortPriority:1,
        hp: _engines[1].hp,    maxHP: 100, partKey:'engineParts',
        apply: () => { _engines[1].hp = 100; } },
      { id:'engine2',    label:'ENGINE 3',         group:'PROPULSION', sortPriority:1,
        hp: _engines[2].hp,    maxHP: 100, partKey:'engineParts',
        apply: () => { _engines[2].hp = 100; } },
      { id:'engine3',    label:'ENGINE 4',         group:'PROPULSION', sortPriority:1,
        hp: _engines[3].hp,    maxHP: 100, partKey:'engineParts',
        apply: () => { _engines[3].hp = 100; } },
      // ── COMPUTERS ──
      { id:'comp_warp',  label:'WARP AUTOPILOT',   group:'COMPUTERS',  sortPriority:0,
        hp: _computer.warpAutopilot, maxHP: 100, partKey:'computerParts',
        apply: () => { _computer.warpAutopilot = 100; } },
      { id:'comp_tgt',   label:'TARGETING COMP',   group:'COMPUTERS',  sortPriority:1,
        hp: _computer.targeting,     maxHP: 100, partKey:'computerParts',
        apply: () => { _computer.targeting = 100; } },
      { id:'comp_radio', label:'RADIO SYSTEM',     group:'COMPUTERS',  sortPriority:2,
        hp: _computer.radio,         maxHP: 100, partKey:'computerParts',
        apply: () => { _computer.radio = 100; } },
      { id:'comp_scan',  label:'SCANNER ARRAY',    group:'COMPUTERS',  sortPriority:3,
        hp: _computer.scanner,       maxHP: 100, partKey:'computerParts',
        apply: () => { _computer.scanner = 100; } },
      { id:'comp_dash',  label:'DASHBOARD',        group:'COMPUTERS',  sortPriority:4,
        hp: _computer.dashboard,     maxHP: 100, partKey:'computerParts',
        apply: () => { _computer.dashboard = 100; } },
      // ── CANNONS ──
      { id:'cannon_fL',  label:'FWD CANNON L',     group:'WEAPONS',    sortPriority:0,
        hp: _cannon.fL.hp,           maxHP: 100, partKey:'cannonParts',
        apply: () => { _cannon.fL.hp = 100; } },
      { id:'cannon_fR',  label:'FWD CANNON R',     group:'WEAPONS',    sortPriority:0,
        hp: _cannon.fR.hp,           maxHP: 100, partKey:'cannonParts',
        apply: () => { _cannon.fR.hp = 100; } },
      { id:'cannon_aft', label:'AFT CANNON',       group:'WEAPONS',    sortPriority:0,
        hp: _cannon.aft.hp,          maxHP: 100, partKey:'cannonParts',
        apply: () => { _cannon.aft.hp = 100; } },
      // ── SHIELDS ──
      { id:'shields',    label:'SHIELD GENERATOR', group:'SHIELDS',    sortPriority:0,
        hp: _shieldCapacity, maxHP: 400, partKey:'shieldParts',
        apply: () => { _shieldCapacity = 400; _shieldRechargeRate = 67; } },
    ];

    // Annotate damaged flag + initial checked = false
    allSystems.forEach(s => {
      s.damaged = s.hp < s.maxHP;
      s.checked = false;
    });

    if (dockMode && _currentStarbase) {
      // Group damaged items by partKey, sort most-damaged first within each group
      // (warpDrive is first in the array so it wins ties over regular engines)
      const byKey = {};
      for (const s of allSystems) {
        if (!s.damaged) continue;
        if (!byKey[s.partKey]) byKey[s.partKey] = [];
        byKey[s.partKey].push(s);
      }
      for (const [key, items] of Object.entries(byKey)) {
        // Sort: sortPriority first (warpDrive=0 always beats engines=1),
        // then most-damaged (lowest hp%) within the same priority tier
        items.sort((a, b) => {
          const pDiff = (a.sortPriority ?? 0) - (b.sortPriority ?? 0);
          if (pDiff !== 0) return pDiff;
          return (a.hp / a.maxHP) - (b.hp / b.maxHP);
        });
        const avail   = Math.floor(_currentStarbase.inventory[key] ?? 0);
        const canFix  = Math.min(avail, items.length);
        if (canFix > 0) {
          _currentStarbase.inventory[key] -= canFix;  // reserve from base
          _repairReserved[key] = canFix;
        }
        items.forEach((item, idx) => { item.checked = idx < canFix; });
      }
    }

    _repairPlan = allSystems;
  }

  function _checkedCount(partKey) {
    return _repairPlan.filter(s => s.partKey === partKey && s.checked).length;
  }

  function _openDamageReport() {
    _repairPanelOpen = true;
    const el = document.getElementById('damage-report');
    if (el) el.style.display = 'flex';
    _renderDamageReport();

    const closeBtn = document.getElementById('dr-close');
    if (closeBtn) {
      closeBtn.onclick = _closeDamageReport;
    }
  }

  function _closeDamageReport() {
    _repairPanelOpen = false;
    const el = document.getElementById('damage-report');
    if (el) el.style.display = 'none';
  }

  function _renderDamageReport() {
    const badge = document.getElementById('dr-mode-badge');
    const hint  = document.getElementById('dr-hint');
    const budgetEl = document.getElementById('dr-budget');
    const rowsEl   = document.getElementById('dr-rows');
    if (!rowsEl) return;

    if (badge) {
      if (_repairDockMode) {
        badge.textContent = 'DOCK IN PROGRESS';
        badge.classList.remove('dr-readonly');
        if (hint) hint.textContent = 'Uncheck to skip a repair — unused parts return to base.';
      } else {
        badge.textContent = 'STATUS ONLY';
        badge.classList.add('dr-readonly');
        if (hint) hint.textContent = 'Read-only view. Dock to initiate repairs.';
      }
    }

    // Budget bar
    if (budgetEl) {
      const partLabels = {
        engineParts:   'ENGINES', computerParts: 'COMPUTERS',
        cannonParts:   'CANNONS', shieldParts:   'SHIELDS',
      };
      const partsWithDamage = {};
      for (const s of _repairPlan) {
        if (s.damaged) partsWithDamage[s.partKey] = true;
      }
      let budgetHtml = '';
      for (const [key, label] of Object.entries(partLabels)) {
        if (!partsWithDamage[key]) continue;
        const reserved = _repairReserved[key] ?? 0;
        const checked  = _checkedCount(key);
        const inv      = _currentStarbase ? Math.floor(_currentStarbase.inventory[key] ?? 0) : 0;
        budgetHtml += `<span class="dr-budget-item">${label}: <span>${checked}/${reserved}</span> reserved`;
        if (!_repairDockMode) budgetHtml += ` &nbsp;(${reserved + inv} avail)`;
        budgetHtml += `</span>`;
      }
      budgetEl.innerHTML = budgetHtml || '<span style="color:rgba(0,180,255,0.4)">NO DAMAGE DETECTED</span>';
    }

    // System rows grouped
    const groups = ['PROPULSION', 'COMPUTERS', 'WEAPONS', 'SHIELDS'];
    let html = '';
    for (const g of groups) {
      const items = _repairPlan.filter(s => s.group === g);
      if (!items.length) continue;
      html += `<div class="dr-group-header">${g}</div>`;
      for (const item of items) {
        const pct  = Math.round((item.hp / item.maxHP) * 100);
        const barClass = pct >= 75 ? 'ok' : pct >= 40 ? 'warn' : pct > 0 ? 'danger' : 'dead';
        const dmg  = item.damaged ? ' dr-damaged' : '';
        const reserved = _repairReserved[item.partKey] ?? 0;
        const checked  = _checkedCount(item.partKey);
        // Checkbox: enabled only if item is damaged AND (checked OR there's a free reserved slot)
        const canCheck = item.damaged && (item.checked || checked < reserved);
        const chkDisabled = (!item.damaged || (!item.checked && checked >= reserved)) ? 'disabled' : '';
        const chkChecked  = item.checked ? 'checked' : '';
        // In read-only mode, all checkboxes disabled
        const disabled = (!_repairDockMode || !canCheck) ? 'disabled' : chkDisabled;
        const checkboxHtml = item.damaged
          ? `<input type="checkbox" class="dr-check" data-id="${item.id}" ${chkChecked} ${disabled}>`
          : `<input type="checkbox" class="dr-check" disabled>`;
        html += `<div class="dr-row${dmg}">
          <div class="dr-row-name">${item.label}</div>
          <div>
            <div class="dr-bar-wrap"><div class="dr-bar ${barClass}" style="width:${pct}%"></div></div>
            <div class="dr-row-hp">${item.hp}/${item.maxHP}</div>
          </div>
          ${checkboxHtml}
          <div style="font-size:9px;color:rgba(160,204,238,0.4);text-align:center">${item.damaged && item.checked ? '✓' : item.damaged ? '—' : 'OK'}</div>
        </div>`;
      }
    }
    rowsEl.innerHTML = html;

    // Attach checkbox listeners
    rowsEl.querySelectorAll('.dr-check:not([disabled])').forEach(cb => {
      cb.addEventListener('change', () => {
        const item = _repairPlan.find(s => s.id === cb.dataset.id);
        if (!item) return;
        const key = item.partKey;
        const count = _checkedCount(key);
        const reserved = _repairReserved[key] ?? 0;
        if (cb.checked && count < reserved) item.checked = true;
        else if (!cb.checked) item.checked = false;
        else cb.checked = item.checked; // revert if over budget
        _renderDamageReport();
      });
    });
  }

  /** Abort: return ALL reserved parts to base and close panel. */
  function _returnRepairPlanParts() {
    if (_currentStarbase) {
      for (const [key, count] of Object.entries(_repairReserved)) {
        _currentStarbase.inventory[key] = (_currentStarbase.inventory[key] ?? 0) + count;
      }
    }
    _repairPlan = [];
    _repairReserved = {};
    _closeDamageReport();
  }

  /** Dock-end: apply checked repairs, return unused reserved parts to base. */
  function _applyRepairPlan() {
    // Apply checked items
    for (const item of _repairPlan) {
      if (item.checked && item.damaged) item.apply();
    }
    // Return unused reserved parts
    if (_currentStarbase) {
      for (const [key, reserved] of Object.entries(_repairReserved)) {
        const used = _repairPlan.filter(s => s.partKey === key && s.checked).length;
        const back = reserved - used;
        if (back > 0) {
          _currentStarbase.inventory[key] = (_currentStarbase.inventory[key] ?? 0) + back;
        }
      }
    }
    _repairPlan = [];
    _repairReserved = {};
    _closeDamageReport();
  }

  // ---- Repair & Refuel (energy + torpedoes only) ----
  function _repairAndRefuel() {
    const sb  = _currentStarbase;
    const cfg = GameConfig.player;
    const log = [];  // collects messages about what was done / unavailable

    // ── 1. ENERGY ──
    if (sb) {
      const needed  = cfg.maxFuel - _energy;
      const avail   = sb.inventory.energy ?? 0;
      const deliver = Math.min(needed, avail);
      sb.inventory.energy = Math.max(0, avail - deliver);
      _energy = Math.min(cfg.maxFuel, _energy + deliver);
      if (deliver < needed) log.push(`LOW FUEL — ${Math.floor(sb.inventory.energy)} remaining`);
    } else {
      _energy = cfg.maxFuel;
    }

    // ── 2. TORPEDOES ──
    if (sb) {
      const needed  = cfg.maxTorpedoes - _torpedoCount;
      const avail   = sb.inventory.torpedoes ?? 0;
      const deliver = Math.min(needed, avail);
      sb.inventory.torpedoes = Math.max(0, avail - deliver);
      _torpedoCount = Math.min(cfg.maxTorpedoes, _torpedoCount + deliver);
      if (deliver < needed && avail === 0) log.push('NO TORPEDOES in stock');
    } else {
      _torpedoCount = cfg.maxTorpedoes;
    }

    // ── 5. Log if anything was short ──
    if (log.length && typeof showMessage === 'function') {
      showMessage('DOCK REPORT', log.join(' | '));
    }
  }

  // ---- Docking drone: orange plug mesh ----
  function _buildPlug() {
    _plugMesh = new THREE.Group();
    // Cylinder handle
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 1.0, 8),
      new THREE.MeshBasicMaterial({ color: 0xff8800 }));
    handle.rotation.z = Math.PI / 2;
    _plugMesh.add(handle);
    // Two prong tines
    for (let i = -1; i <= 1; i += 2) {
      const tine = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.7, 6),
        new THREE.MeshBasicMaterial({ color: 0xffcc00 }));
      tine.rotation.z = Math.PI / 2;
      tine.position.set(0.9, i * 0.22, 0);
      _plugMesh.add(tine);
    }
    _plugMesh.add(new THREE.PointLight(0xff8800, 1.5, 8));
    _plugMesh.position.copy(SB_POS);
    _plugMesh.visible = false;
    _scene.add(_plugMesh);
  }

  // ---- Starbase force shield ----
  function _buildShield() {
    if (!_scene) return;
    _sbShieldMeshes = [];

    // Inner bubble — main visible surface
    const inner = new THREE.Mesh(
      new THREE.SphereGeometry(SHIELD_R, 40, 30),
      new THREE.MeshBasicMaterial({
        color: 0x00aaff, transparent: true, opacity: 0.055,
        side: THREE.FrontSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    inner.position.copy(SB_POS);
    _scene.add(inner);

    // Outer halo — back-face for depth/glow
    const outer = new THREE.Mesh(
      new THREE.SphereGeometry(SHIELD_R * 1.03, 40, 30),
      new THREE.MeshBasicMaterial({
        color: 0x0055bb, transparent: true, opacity: 0.025,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    outer.position.copy(SB_POS);
    _scene.add(outer);

    _sbShieldMeshes = [inner, outer];
  }

  function _updateShield(dt) {
    if (!_hasStarbase || _sbShieldMeshes.length === 0) return;

    _sbShieldFlash       = Math.max(0, _sbShieldFlash - dt * 2.5);
    _sbShieldDmgCooldown = Math.max(0, _sbShieldDmgCooldown - dt);

    // Health-driven base color (cyan → orange → red)
    const sbHP = _currentStarbase ? Math.round(_currentStarbase.shieldCharge / 10) : 100;
    const healthT = sbHP / 100;
    const baseCol = healthT > 0.5
      ? new THREE.Color().lerpColors(new THREE.Color(0xff8800), new THREE.Color(0x00aaff), (healthT - 0.5) * 2)
      : new THREE.Color().lerpColors(new THREE.Color(0xff2200), new THREE.Color(0xff8800), healthT * 2);

    const flashCol  = new THREE.Color(0xffffff);
    const finalCol  = _sbShieldFlash > 0
      ? flashCol.clone().lerpColors(baseCol, flashCol, _sbShieldFlash)
      : baseCol;

    const [inner, outer] = _sbShieldMeshes;
    const baseOpacity = 0.055 * healthT;

    inner.material.color.copy(finalCol);
    inner.material.opacity = baseOpacity + _sbShieldFlash * 0.25;
    outer.material.color.copy(finalCol);
    outer.material.opacity = 0.025 * healthT + _sbShieldFlash * 0.08;

    inner.visible = outer.visible = sbHP > 0;
    if (sbHP <= 0) {
      // Shields depleted — hide bubble, but still enforce hull solidity below
    } else {
      // Shield bubble collision — only when shields are charged
      if (!_warpDebursting) {
        const dist = _camera.position.distanceTo(SB_POS);
        if (dist < SHIELD_R) {
          const pushDir = _camera.position.clone().sub(SB_POS);
          if (pushDir.lengthSq() < 0.001) pushDir.set(0, 0, 1);
          pushDir.normalize();
          _camera.position.copy(SB_POS).addScaledVector(pushDir, SHIELD_R + 1);
          if (_sbShieldDmgCooldown <= 0) {
            _applyPlayerHit(SHIELD_DAMAGE);
            _sbShieldFlash       = 1.0;
            _sbShieldDmgCooldown = SHIELD_CD;
          }
        }
      }
    }

    // ── Physical structure collision (when shields are down or always for the hull) ──
    if (!_warpDebursting) {
      const rel   = _camera.position.clone().sub(SB_POS); // player relative to base center
      const HUB_R = 26;   // octahedron (~21u) + player body (~5u)
      const RING_MAJOR = 47.5;  // torus major radius (ring centre-line)
      const RING_TUBE  = 7;     // torus tube radius (2u ring + 5u player)
      const shieldsDown = (_currentStarbase?.shieldCharge ?? 1000) < 1;

      // ── Hub (central diamond) ──
      const hubDist = rel.length();
      if (hubDist < HUB_R) {
        const pushDir = hubDist > 0.001 ? rel.clone().normalize() : new THREE.Vector3(0, 0, 1);
        _camera.position.copy(SB_POS).addScaledVector(pushDir, HUB_R + 1);
        if (shieldsDown && _sbShieldDmgCooldown <= 0) {
          _applyPlayerHit(SHIELD_DAMAGE);
          _sbShieldDmgCooldown = SHIELD_CD;
        }
      }

      // ── Ring (torus in XZ plane) ──
      // Nearest point on ring centre-line: project onto XZ, scale to RING_MAJOR
      const flatX = rel.x, flatZ = rel.z;
      const flatDist = Math.sqrt(flatX * flatX + flatZ * flatZ);
      if (flatDist > 0.001) {
        // Point on ring centreline closest to player
        const cx = (flatX / flatDist) * RING_MAJOR + SB_POS.x;
        const cy = SB_POS.y;
        const cz = (flatZ / flatDist) * RING_MAJOR + SB_POS.z;
        const toRing = _camera.position.clone().sub(new THREE.Vector3(cx, cy, cz));
        const ringDist = toRing.length();
        if (ringDist < RING_TUBE) {
          const pushDir = ringDist > 0.001 ? toRing.clone().normalize() : new THREE.Vector3(0, 1, 0);
          _camera.position.copy(new THREE.Vector3(cx, cy, cz)).addScaledVector(pushDir, RING_TUBE + 1);
          if (shieldsDown && _sbShieldDmgCooldown <= 0) {
            _applyPlayerHit(SHIELD_DAMAGE);
            _sbShieldDmgCooldown = SHIELD_CD;
          }
        }
      }
    }
  }

  // ---- Docking state machine ----
  function _updateDocking(dt) {
    if (!_hasStarbase || !_running || _dockState === 'idle' || _dockState === 'done') {
      if (_dockState === 'done') {
        const distToSB = _camera.position.distanceTo(SB_POS);
        if (distToSB >= DOCK_RANGE || _currentVelocity >= 0.5) _dockState = 'idle';
      }
      return;
    }

    // Abort if player starts moving
    if (_currentVelocity >= 0.5 && (_dockState === 'outbound' || _dockState === 'connected')) {
      if (!_dockIsKickstart && _repairPlan.length) _returnRepairPlanParts();
      _dockState = 'returning';
    }

    if (_dockState === 'outbound') {
      _plugEndPos.copy(PLUG_CAM_LOCAL).applyMatrix4(_camera.matrixWorld);
      const toTarget = _plugEndPos.clone().sub(_plugMesh.position);
      if (toTarget.length() < 1) {
        _plugMesh.position.copy(_plugEndPos);
        _connectTimer = DOCK_CONNECT_SECS;
        _dockState = 'connected';
      } else {
        _plugMesh.position.addScaledVector(toTarget.normalize(), DRONE_SPEED * dt);
      }

    } else if (_dockState === 'connected') {
      _plugEndPos.copy(PLUG_CAM_LOCAL).applyMatrix4(_camera.matrixWorld);
      _plugMesh.position.copy(_plugEndPos);
      _connectTimer -= dt;
      if (_connectTimer <= 0) {
        if (_dockIsKickstart) {
          // Deduct energy from player now — starbase receives it when drone returns
          const needed = GameConfig.zylon.starbaseKickstartEnergy;
          if (_energy >= needed && _currentStarbase) {
            _energy -= needed;
            _kickstartPending = true;
          } else {
            if (typeof showMessage === 'function') {
              showMessage('DOCK FAILED', `INSUFFICIENT ENERGY — NEED ${needed}E`);
            }
            _kickstartPending = false;
          }
        } else {
          // Apply player repair plan (checked items), then refuel
          _applyRepairPlan();
          _repairAndRefuel();
        }
        _dockState = 'returning';
      }

    } else if (_dockState === 'returning') {
      const toSB = SB_POS.clone().sub(_plugMesh.position);
      if (toSB.length() < 1) {
        _plugMesh.position.copy(SB_POS);
        _plugMesh.visible = false;
        // If kickstart was pending, apply it now that the drone has returned
        if (_kickstartPending && _currentStarbase) {
          _currentStarbase.kickstart();
          _kickstartPending = false;
          if (typeof showMessage === 'function') {
            showMessage('STARBASE RESTORED', `${_currentStarbase.name.toUpperCase()} BACK ONLINE`);
          }
        }
        _dockState = 'done';
      } else {
        _plugMesh.position.addScaledVector(toSB.normalize(), DRONE_SPEED * dt);
      }
    }
  }

  // ---- Shield impact animations ----
  function _spawnShieldImpact(hitPos) {
    if (!_scene) return;
    const normal = hitPos.clone().sub(SB_POS).normalize();
    // Flat ring, tangent to shield surface at hit point
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2, 5, 36),
      new THREE.MeshBasicMaterial({
        color: 0x88ddff, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    ring.position.copy(hitPos);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    _scene.add(ring);
    // Bright local flash
    const light = new THREE.PointLight(0x88ddff, 12, 80);
    light.position.copy(hitPos);
    _scene.add(light);
    _shieldImpacts.push({ ring, light, age: 0, maxAge: 0.5 });
  }

  function _updateShieldImpacts(dt) {
    for (let i = _shieldImpacts.length - 1; i >= 0; i--) {
      const imp = _shieldImpacts[i];
      imp.age += dt;
      const t = Math.min(1, imp.age / imp.maxAge);
      imp.ring.scale.setScalar(1 + t * 8);          // grows from 1× to 9×
      imp.ring.material.opacity = 0.9 * (1 - t);
      imp.light.intensity       = 12  * (1 - t);
      if (imp.age >= imp.maxAge) {
        _scene?.remove(imp.ring);
        _scene?.remove(imp.light);
        _shieldImpacts.splice(i, 1);
      }
    }
  }

  // ---- Explosion system ----
  // opts: { scale=1, debris=0, fireColor=0xff6600, debrisColor=0xff4400 }
  function _spawnExplosion(pos, { scale = 1, debris = 0, fireColor = 0xff6600, debrisColor = 0xff4400 } = {}) {
    if (!_scene) return;
    const exp = { parts: [], age: 0, maxAge: 0.65 };

    // Bright point light flash
    const light = new THREE.PointLight(0xffffff, 20 * scale, 150 * scale);
    light.position.copy(pos);
    _scene.add(light);
    exp.parts.push({ type: 'light', obj: light, peak: 20 * scale });

    // Expanding fireball sphere
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(3 * scale, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    ball.position.copy(pos);
    _scene.add(ball);
    exp.parts.push({ type: 'fireball', obj: ball, fireColor: new THREE.Color(fireColor) });

    // Shockwave ring (random orientation)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.5 * scale, 4 * scale, 32),
      new THREE.MeshBasicMaterial({
        color: fireColor, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    ring.position.copy(pos);
    const rn = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), rn);
    _scene.add(ring);
    exp.parts.push({ type: 'ring', obj: ring });

    // Debris chunks
    for (let i = 0; i < debris; i++) {
      const chunk = new THREE.Mesh(
        new THREE.BoxGeometry(1.2 * scale, 0.7 * scale, 0.9 * scale),
        new THREE.MeshBasicMaterial({ color: debrisColor, transparent: true, opacity: 1 })
      );
      chunk.position.copy(pos);
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 80 * scale,
        (Math.random() - 0.5) * 80 * scale,
        (Math.random() - 0.5) * 80 * scale
      );
      _scene.add(chunk);
      exp.parts.push({ type: 'debris', obj: chunk, vel });
    }

    _explosions.push(exp);
  }

  function _updateExplosions(dt) {
    for (let i = _explosions.length - 1; i >= 0; i--) {
      const exp = _explosions[i];
      exp.age += dt;
      const t = Math.min(1, exp.age / exp.maxAge);
      for (const p of exp.parts) {
        if (p.type === 'light') {
          p.obj.intensity = p.peak * Math.max(0, 1 - t * 2.5);
        } else if (p.type === 'fireball') {
          p.obj.scale.setScalar(1 + t * 9);
          // White core → fire color → transparent
          const fc = p.fireColor;
          if (t < 0.25) p.obj.material.color.lerpColors(new THREE.Color(0xffffff), fc, t / 0.25);
          else          p.obj.material.color.copy(fc);
          p.obj.material.opacity = 0.95 * (1 - t);
        } else if (p.type === 'ring') {
          p.obj.scale.setScalar(1 + t * 11);
          p.obj.material.opacity = 0.85 * (1 - t);
        } else if (p.type === 'debris') {
          p.vel.multiplyScalar(Math.max(0, 1 - dt * 2.5));
          p.obj.position.addScaledVector(p.vel, dt);
          p.obj.rotation.x += dt * 4; p.obj.rotation.y += dt * 6;
          p.obj.material.opacity = 1 - t;
        }
      }
      if (exp.age >= exp.maxAge) {
        for (const p of exp.parts) _scene?.remove(p.obj);
        _explosions.splice(i, 1);
      }
    }
  }

  // ---- Loop ----
  function _tick(now) {
    if (!_running) return;
    requestAnimationFrame(_tick);
    const dt = Math.min((now - _lastTime) / 1000, 0.05);
    _lastTime = now;
    _gamepad();
    _updateFlight(dt);
    _updateSB(dt);
    _updateDust();
    _updateVoidObjects();
    _updateDocking(dt);
    _updateShield(dt);
    _updateShieldImpacts(dt);
    _updateExplosions(dt);
    _updateTorpedoes(dt);
    _updateCannons(dt);
    _updateCargoDrones(dt);
    _updateZylons(dt);
    // Tick the current starbase so its shield recharge drains energy in real-time
    if (_currentStarbase && !_currentStarbase.isCapital) {
      _currentStarbase.tick(dt);
    }
    // One-shot dormant notification when starbase transitions while player is in sector
    if (_hasStarbase && _currentStarbase && !_starbaseDormantNotified
        && _currentStarbase.state === 'dormant') {
      _starbaseDormantNotified = true;
      _sbShieldMeshes.forEach(m => { m.visible = false; });
      // Purge any in-flight shield impact animations immediately
      for (const imp of _shieldImpacts) {
        _scene?.remove(imp.ring);
        _scene?.remove(imp.light);
      }
      _shieldImpacts.length = 0;
      if (typeof showMessage === 'function') {
        showMessage('SHIELDS FAILED',
          `${_currentStarbase.name.toUpperCase()} OFFLINE — DOCK TO RESTORE`);
      }
    }
    // If base was restored (e.g. cargo ship), reset flag and re-show shields
    if (_starbaseDormantNotified && _currentStarbase?.state === 'active') {
      _starbaseDormantNotified = false;
      _sbShieldMeshes.forEach(m => { m.visible = true; });
      if (typeof showMessage === 'function') {
        showMessage('SHIELDS RESTORED',
          `${_currentStarbase.name.toUpperCase()} BACK ONLINE`);
      }
    }

    _updateCargoShips(dt);
    _checkAsteroidCollision();
    _checkCargoCollisions();
    if (_hitFlash  > 0) _hitFlash  -= dt;
    if (_fireFlash > 0) _fireFlash -= dt;

    // ── Energy telemetry clock + ring buffer ──
    _galacticClock     += dt;
    _energySampleTimer += dt;
    if (_energySampleTimer >= 1.0) {
      const delta = Math.max(0, _energyLastSec - _energy); // ignore refuels (positive spikes)
      _energyHistory[_energyHistIdx] = delta;
      _energyRate        = delta;
      _energyTotalConsumed += delta;
      _energyHistIdx     = (_energyHistIdx + 1) % 60;
      _energyLastSec     = _energy;   // reset baseline for next second
      _energySampleTimer -= 1.0;
    }

    if (_renderer && _scene) _renderer.render(_scene, _camera);
    _drawHUD();
    if (_lrsOn) _drawLRS();
    if (GameConfig.testMode && _hasStarbase && _currentStarbase) _drawStarbaseDebug();
    if (_entryTimer > 0) _entryTimer -= dt;
  }

  function _drawStarbaseDebug() {
    const oc = _overlayCtx; if (!oc || !_currentStarbase) return;
    const sb = _currentStarbase;
    const energy    = sb.inventory?.energy ?? 0;
    const energyOn  = energy >= 1;
    const shieldChg = sb.shieldCharge ?? 0;
    const shieldsOn = shieldChg >= 1;
    const status    = sb.state ?? '?';

    const lines = [
      `SB: ${sb.name}`,
      `ENERGY : ${Math.floor(energy)}  [${energyOn ? 'ON' : 'OFF'}]`,
      `SHIELDS: ${Math.floor(shieldChg)}  [${shieldsOn ? 'ON' : 'OFF'}]`,
      `STATUS : ${status.toUpperCase()}`,
    ];

    const pad = 10, lh = 16, panW = 210, panH = pad * 2 + lh * lines.length;
    const x = 10, y = 10;

    oc.save();
    oc.fillStyle = 'rgba(0,0,0,0.65)';
    oc.fillRect(x, y, panW, panH);
    oc.strokeStyle = energyOn ? '#00ff88' : '#ff4444';
    oc.lineWidth = 1;
    oc.strokeRect(x, y, panW, panH);

    oc.font = '11px Share Tech Mono, monospace';
    oc.textAlign = 'left'; oc.textBaseline = 'top';
    lines.forEach((line, i) => {
      const isOff = line.includes('[OFF]');
      const isDormant = line.includes('DORMANT');
      oc.fillStyle = isOff || isDormant ? '#ff4444' : '#00ff88';
      oc.fillText(line, x + pad, y + pad + i * lh);
    });
    oc.restore();
  }

  function _updateFlight(dt) {
    // Post-warp decel: _warpMult decays 5.0→1.0 over ~24s of dramatic deceleration
    if (_warpMult > 1.0) {
      _warpMult = Math.max(1.0, _warpMult - dt * 0.17); // 4 units over 24s
    }

    // Per-engine speed: don't clamp _speed — each engine contributes individually

    const dz = 0.05;
    const nx = Math.abs(_mnx) > dz ? _mnx : 0;
    const ny = Math.abs(_mny) > dz ? _mny : 0;
    let kx = 0, ky = 0;
    if (_keys.has('ArrowLeft'))  kx -= 0.6;
    if (_keys.has('ArrowRight')) kx += 0.6;
    if (_keys.has('ArrowUp'))    ky -= 0.6;
    if (_keys.has('ArrowDown'))  ky += 0.6;
    // Lock steering during burst and deburst phases
    const inputLocked = _warpBursting || _warpDebursting;
    const dyaw   = inputLocked ? 0 : -(nx + kx) * TURN_YAW   * dt;
    const dpitch = inputLocked ? 0 : -(ny + ky) * TURN_PITCH  * dt;
    // Quaternion steering: local-axis rotations — no gimbal lock, no pitch limit
    const qRot = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), dyaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dpitch));
    _cameraQuat.multiply(qRot).normalize();
    // Velocity state machine
    if (_warpCharging) {
      // Phase 1: always 4 seconds of steering, velocity ramps at ACCEL_RATE and caps at 99
      _warpChargeTimer += dt;
      _currentVelocity += ACCEL_RATE * dt;  // ramp freely — no cap during charge
      if (_warpDrift > 0) {
        const wobble = _warpDrift * 1.0 * dt;
        const wRight = new THREE.Vector3(1, 0, 0).applyQuaternion(_cameraQuat);
        const wUp    = new THREE.Vector3(0, 1, 0).applyQuaternion(_cameraQuat);
        _warpTargetDir
          .addScaledVector(wRight, (Math.random() - 0.5) * wobble)
          .addScaledVector(wUp,    (Math.random() - 0.5) * wobble)
          .normalize();
      }
      if (_warpChargeTimer >= WARP_CHARGE_TIME) {
        _warpCharging = false;
        // Capture accuracy at exactly T=4s
        const hRight = new THREE.Vector3(1, 0, 0).applyQuaternion(_cameraQuat);
        const hUp    = new THREE.Vector3(0, 1, 0).applyQuaternion(_cameraQuat);
        const rx = _warpTargetDir.dot(hRight);
        const uy = _warpTargetDir.dot(hUp);
        const cb = _warpChargeCallback; _warpChargeCallback = null;
        if (cb) cb({ rx, uy });
        return;
      }
    } else if (_warpBursting) {
      // Phase 2: slam to 99999 in 1 second (~99900 u/s²), locked
      _currentVelocity = Math.min(99999, _currentVelocity + 99900 * dt);
      if (_currentVelocity >= 99999) {
        _warpBursting = false;
        const cb = _warpBurstCallback; _warpBurstCallback = null;
        if (cb) cb();
        return;
      }
    } else if (_warpDebursting) {
      // Post-arrival: decel from 99999 → WARP_VELOCITY in 1 second, locked
      _currentVelocity = Math.max(WARP_VELOCITY, _currentVelocity - 99900 * dt);
      if (_currentVelocity <= WARP_VELOCITY) _warpDebursting = false;
    } else {
      // Normal throttle ramping — each engine contributes SPD_VALS[min(speed, engMaxIdx)] / 4
      const targetVel = _engines
        ? _engines.reduce((sum, eng) => {
            const engMaxIdx = Math.max(0, Math.floor(eng.hp / 100 * 9));
            return sum + SPD_VALS[Math.min(_speed, engMaxIdx)] / 4;
          }, 0)
        : SPD_VALS[_speed];
      const diff = targetVel - _currentVelocity;
      const step = ACCEL_RATE * dt;
      _currentVelocity += diff > 0 ? Math.min(diff, step) : Math.max(diff, -step);
    }
    const vel = new THREE.Vector3(0, 0, -1).applyQuaternion(_cameraQuat).multiplyScalar(_currentVelocity * dt);
    _camera.position.add(vel);  // no boundary — infinite free flight
    // Aft view: flip 180° in local Y (look straight backward) without touching ship orientation
    if (_rearView) {
      _camera.quaternion.copy(_cameraQuat).multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
      );
    } else {
      _camera.quaternion.copy(_cameraQuat);
    }
    // Energy drain: accel → use current velocity²; decel → use power setting²
    // Full throttle (64) = 1 E/s; capped at 64 during warp phases.
    {
      let drainVel;
      if (!_warpCharging && !_warpBursting && !_warpDebursting) {
        // Recompute power-setting target (same formula as throttle ramp above)
        const powerTarget = _engines
          ? _engines.reduce((sum, eng) => {
              const engMaxIdx = Math.max(0, Math.floor(eng.hp / 100 * 9));
              return sum + SPD_VALS[Math.min(_speed, engMaxIdx)] / 4;
            }, 0)
          : SPD_VALS[_speed];
        // Accelerating: cost is how fast you're going; decelerating: cost is your power setting
        drainVel = _currentVelocity < powerTarget ? _currentVelocity : powerTarget;
      } else {
        drainVel = Math.min(_currentVelocity, 64); // warp phases — just cap
      }
      drainVel = Math.min(drainVel, 64);
      if (_energy > 0 && drainVel > 0)
        _energy = Math.max(0, _energy - (drainVel * drainVel / 4096) * ENERGY_ENGINE_FACTOR * dt);
    }
    // Shield recharge — costs energy equal to the charge restored
    if (_shieldsOn && _shieldCapacity > 0) {
      const prevCharge = _shieldCharge;
      _shieldCharge = Math.min(_shieldCapacity, _shieldCharge + _shieldRechargeRate * dt);
      _energy = Math.max(0, _energy - (_shieldCharge - prevCharge));
    }
    // Always-on ship systems (life support, navigation)
    _energy = Math.max(0, _energy - ENERGY_BASE_DRAIN * dt);
    // Tracking computer when active
    if (_computerOn) _energy = Math.max(0, _energy - ENERGY_COMPUTER_DRAIN * dt);
  }

  function _updateZylons(dt) {
    if (!_zylons.length) return;
    const playerPos = _camera.position.clone();

    // Build targeting context for warrior orbit AI
    const context = {
      starbase:   (_hasStarbase && _currentStarbase)
                  ? { pos: SB_POS.clone(), shieldCharge: _currentStarbase.shieldCharge ?? 0 }
                  : null,
      cargoShips: _cargoShips.map(cs => ({ pos: cs.pos.clone() })),
      drones:     _cargoDrones.map(d  => ({ pos: d.pos.clone() })),
      beaconPos:  (() => { const bs = _zylons.find(z => !z.dead && z.type === 'seeker_beacon'); return bs ? bs.position.clone() : null; })(),
    };

    let anyAlive = false;
    for (let i = _zylons.length - 1; i >= 0; i--) {
      const z = _zylons[i];
      if (z.dead) { _zylons.splice(i, 1); continue; }
      anyAlive = true;
      const result = z.update(dt, playerPos, _currentVelocity, context);
      if (result) {
        _spawnZylonTorpedo(result.pos, result.vel, result.isWarriorCannon ?? false);
      }
    }
    if (!anyAlive && _zylons.length === 0) {
      if (_redAlert) {
        // Transition: last Zylon just died — announce sector clear
        _redAlert = false;
        if (window.SubspaceComm) {
          const tc = Math.floor(_galacticClock || 0);
          const clk = `${String(Math.floor(tc/3600)).padStart(2,'0')}:${String(Math.floor((tc%3600)/60)).padStart(2,'0')}:${String(tc%60).padStart(2,'0')}`;
          window.SubspaceComm.send('SECTOR CLEAR', clk, 'ALL ZYLON FORCES ELIMINATED');
        }
        // Reset detection flag on starbase so next Zylon arrival triggers a fresh message
        if (_currentStarbase?.onSectorCleared) _currentStarbase.onSectorCleared();
      }
    }
  }

  function _spawnZylonTorpedo(pos, vel, isWarriorCannon = false) {
    if (!_scene) return;
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 6, 5);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff6600 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    // Align to velocity direction
    const dir = vel.clone().normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
    const gl = new THREE.PointLight(0xff4400, 1.2, 30);
    mesh.add(gl);
    _scene.add(mesh);
    const life = isWarriorCannon
      ? (GameConfig.zylon.warriorCannonLife ?? 2.5)
      : 2.5;
    _torpedoes.push({ mesh, pos: pos.clone(), vel, life,
                      isZylon: !isWarriorCannon, isWarriorCannon });
  }

  function _updateDust() {
    if (!_dustMesh || _speed === 0) return;
    const pa  = _dustMesh.geometry.attributes.position;
    const cam = _camera.position;
    // Use actual flight direction (not view direction)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_cameraQuat);

    for (let i = 0; i < pa.count; i++) {
      const dx = pa.getX(i) - cam.x;
      const dy = pa.getY(i) - cam.y;
      const dz = pa.getZ(i) - cam.z;
      const dist  = Math.sqrt(dx*dx + dy*dy + dz*dz);
      const ahead = dx * fwd.x + dy * fwd.y + dz * fwd.z;
      if (dist > 75 || ahead < -10) {
        const r  = 10 + Math.random() * 60;
        const ox = (Math.random() - 0.5) * 0.7;
        const oy = (Math.random() - 0.5) * 0.7;
        const dir = new THREE.Vector3(ox, oy, -1).normalize().multiplyScalar(r);
        dir.applyQuaternion(_cameraQuat).add(cam);
        pa.setXYZ(i, dir.x, dir.y, dir.z);
      }
    }
    pa.needsUpdate = true;
  }

  function _updateSB(dt) {
    if (!_sbGroup) return;
    const t    = Date.now() * 0.001;
    const ring  = _sbGroup.getObjectByName('ring');
    const ringW = _sbGroup.getObjectByName('ringW');
    if (ring)  ring.rotation.z  = t * 0.28;
    if (ringW) ringW.rotation.z = t * 0.28;
    _sbGroup.rotation.y = t * 0.05;
  }


  // ---- Weapon helpers (thermal model) ----


  // Update cannon thermals each tick
  function _updateCannons(dt) {
    const CC = GameConfig.cannons;
    // Cooling = baseline + each engine's contribution (engine health × speed)
    const engCooling = _engines
      ? _engines.reduce((s, e) => s + CC.coolingPerEnginePerSpeed * _speed * (e.hp / 100), 0)
      : 0;
    _cannonCoolingRate = Math.min(100, CC.coolingBaseline + engCooling);
    const tempDrop = (_cannonCoolingRate / 100) * CC.maxCoolingTempDrop; // °/sec
    const optRate  = 100 / CC.optimalChargeTime; // 500 units/sec at optimal

    for (const c of Object.values(_cannon)) {
      if (c.hp <= 0) continue;
      c.temp = Math.max(0, c.temp - tempDrop * dt);
      // Charge rate: full below slowChargeAt, linear decay to 0 at noChargeAt
      let chargeRate = 0;
      if (c.temp < CC.tempSlowChargeAt) {
        chargeRate = optRate;
      } else if (c.temp < CC.tempNoChargeAt) {
        const t = (c.temp - CC.tempSlowChargeAt) / (CC.tempNoChargeAt - CC.tempSlowChargeAt);
        chargeRate = optRate * (1 - t);
      }
      // Damaged cannons charge slower: hp=100 → 100%, hp=0 → 20%
      chargeRate *= (0.2 + 0.8 * (c.hp / 100));
      if (c.charge < 100) c.charge = Math.min(100, c.charge + chargeRate * dt);
    }
    // Delayed right cannon stagger
    if (_fRPending > 0) {
      _fRPending -= dt;
      if (_fRPending <= 0 && _cannonReady(_cannon.fR)) {
        _doFire(_cannon.fR, +TORPEDO_OFFSET, false);
      }
    }
  }

  // Fire a single cannon shot: apply heat, possible damage, spawn torpedo
  function _doFire(c, xOffset, aft) {
    const CC = GameConfig.cannons;
    const tempRise = CC.tempPerShot * (1 + (100 - c.hp) / 100);
    c.temp = Math.min(c.temp + tempRise, 200);
    if (c.temp > CC.tempDamageAt) {
      c.hp = Math.max(0, c.hp - (c.temp - CC.tempDamageAt));
    }
    c.charge = 0;
    _spawnTorpedo(xOffset, aft);
  }

  // Front cannon — always fires ship-forward (left-click)
  function _fireFront() {
    if (_energy <= 0 || _systems.P <= 0) return;
    const fL = _cannon.fL, fR = _cannon.fR;
    const bothAllowed = _systems.P >= 50;
    let fired = false;
    if (_cannonReady(fL)) {
      _doFire(fL, -TORPEDO_OFFSET, false);
      fired = true;
    }
    if (bothAllowed && _cannonReady(fR)) {
      if (_targetLocked) {
        _doFire(fR, +TORPEDO_OFFSET, false);
      } else {
        _fRPending = 0.20;
      }
      fired = true;
    }
    if (fired) {
      _fireFlash = 0.18;
      _energy = Math.max(0, _energy - TORPEDO_ENERGY);
    }
  }

  // Aft cannon — always fires ship-backward (Space)
  function _fireAft() {
    if (_torpedoCount <= 0) return;
    if (_energy <= 0 || _systems.P <= 0) return;
    const c = _cannon.aft;
    if (!_cannonReady(c)) return;
    _torpedoCount--;
    _doFire(c, 0, true);
    _energy = Math.max(0, _energy - TORPEDO_ENERGY);
  }

  // Left front cannon only (left mouse button)
  function _fireLeft() {
    if (_torpedoCount <= 0) return;
    if (_energy <= 0 || _systems.P <= 0) return;
    if (!_cannonReady(_cannon.fL)) return;
    _torpedoCount--;
    _doFire(_cannon.fL, -TORPEDO_OFFSET, false);
    _fireFlash = 0.18;
    _energy = Math.max(0, _energy - TORPEDO_ENERGY);
  }

  // Right front cannon only (right mouse button)
  function _fireRight() {
    if (_torpedoCount <= 0) return;
    if (_energy <= 0 || _systems.P <= 0) return;
    if (!_cannonReady(_cannon.fR)) return;
    _torpedoCount--;
    _doFire(_cannon.fR, +TORPEDO_OFFSET, false);
    _fireFlash = 0.18;
    _energy = Math.max(0, _energy - TORPEDO_ENERGY);
  }

  // ---- Player hit handler ----
  function _applyPlayerHit(dmg) {
    _hitFlash = 0.5;
    let remaining = dmg;
    let hull      = 0;

    // Five-tier absorption — each tier covers a charge band with a fixed absorption rate.
    // Layers are consumed top-down; charge below a tier's threshold is handled by the next.
    const tiers = [
      { threshold: 200, rate: 1.00 },  // 400–200 (> 50%): 100% absorbed
      { threshold: 150, rate: 0.90 },  // 200–150:  90%
      { threshold: 100, rate: 0.80 },  // 150–100:  80%
      { threshold:  50, rate: 0.70 },  // 100– 50:  70%
      { threshold:   0, rate: 0.60 },  //  50–  0:  60%
    ];

    for (const tier of tiers) {
      if (remaining <= 0) break;
      if (_shieldCharge <= tier.threshold) continue;  // shield below this tier

      const available  = _shieldCharge - tier.threshold;
      const tierCapDmg = available / tier.rate;        // max damage this tier can handle

      if (remaining <= tierCapDmg) {
        _shieldCharge -= remaining * tier.rate;
        hull          += remaining * (1 - tier.rate);
        remaining      = 0;
      } else {
        _shieldCharge -= available;
        hull          += tierCapDmg * (1 - tier.rate);
        remaining     -= tierCapDmg;
      }
    }

    // Any damage left after shields are fully depleted becomes hull damage
    hull += remaining;
    _shieldCharge = Math.max(0, _shieldCharge);

    hull = Math.round(hull);
    if (hull <= 0) return;

    // ── 120-slot weighted component draw ──────────────────────────────────────
    // Shields 40, Engine×4 10ea, Cannon×3 10ea, WarpDrive 10 = 120 total
    const roll = Math.floor(Math.random() * 120) + 1;
    let comp, isAlreadyDead;

    if (roll <= 40) {
      // Shields (HP pool)
      isAlreadyDead = _shieldCapacity <= 0;
      _shieldCapacity = Math.max(0, _shieldCapacity - hull);
      // Cap charge at new capacity ceiling
      _shieldCharge = Math.min(_shieldCharge, _shieldCapacity);
      comp = 'shield';
    } else if (roll <= 50) {
      isAlreadyDead = _engines[0].hp <= 0;
      _engines[0].hp = Math.max(0, _engines[0].hp - hull); comp = 'E1';
    } else if (roll <= 60) {
      isAlreadyDead = _engines[1].hp <= 0;
      _engines[1].hp = Math.max(0, _engines[1].hp - hull); comp = 'E2';
    } else if (roll <= 70) {
      isAlreadyDead = _engines[2].hp <= 0;
      _engines[2].hp = Math.max(0, _engines[2].hp - hull); comp = 'E3';
    } else if (roll <= 80) {
      isAlreadyDead = _engines[3].hp <= 0;
      _engines[3].hp = Math.max(0, _engines[3].hp - hull); comp = 'E4';
    } else if (roll <= 90) {
      isAlreadyDead = _cannon.fL.hp <= 0;
      _cannon.fL.hp = Math.max(0, _cannon.fL.hp - hull); comp = 'fL';
    } else if (roll <= 100) {
      isAlreadyDead = _cannon.fR.hp <= 0;
      _cannon.fR.hp = Math.max(0, _cannon.fR.hp - hull); comp = 'fR';
    } else if (roll <= 110) {
      isAlreadyDead = _cannon.aft.hp <= 0;
      _cannon.aft.hp = Math.max(0, _cannon.aft.hp - hull); comp = 'aft';
    } else {
      isAlreadyDead = _warpDriveHP <= 0;
      _warpDriveHP = Math.max(0, _warpDriveHP - hull); comp = 'warp';
    }

    // ── Cascade rule: overflow to computer ────────────────────────────────────
    // If component was already dead, or just got destroyed, 50% of damage hits computer
    const justDestroyed = !isAlreadyDead && (
      (comp === 'shield' && _shieldCapacity <= 0) ||
      (comp === 'E1' && _engines[0].hp <= 0) ||
      (comp === 'E2' && _engines[1].hp <= 0) ||
      (comp === 'E3' && _engines[2].hp <= 0) ||
      (comp === 'E4' && _engines[3].hp <= 0) ||
      (comp === 'fL' && _cannon.fL.hp <= 0) ||
      (comp === 'fR' && _cannon.fR.hp <= 0) ||
      (comp === 'aft' && _cannon.aft.hp <= 0) ||
      (comp === 'warp' && _warpDriveHP <= 0)
    );
    if (isAlreadyDead || justDestroyed) {
      _damageComputer(Math.round(hull * 0.5));
    }
  }

  function _spawnTorpedo(xOffset, aft) {
    if (!_scene) return;
    // Always use ship quaternion for fire direction (not view direction)
    const fwd   = new THREE.Vector3(0, 0, -1).applyQuaternion(_cameraQuat);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(_cameraQuat);
    const down  = new THREE.Vector3(0,-1, 0).applyQuaternion(_cameraQuat);
    // Aft: flip forward direction
    const fireDir = aft ? fwd.clone().negate() : fwd.clone();

    const pos = _camera.position.clone()
                  .addScaledVector(right, xOffset)
                  .addScaledVector(down, 1.5);
    // Aim: when combat-locked, lead the target; otherwise fire in the cannon's natural direction
    let vel;
    if (!aft && _targetLocked && _lockedContactPos) {
      const toTarget = _lockedContactPos.clone().sub(pos);
      const dist     = toTarget.length();
      if (dist > 0.1) {
        const travelTime = dist / TORPEDO_SPEED;
        const leadPos    = _lockedContactPos.clone().addScaledVector(_lockedContactVel, travelTime);
        vel = leadPos.sub(pos).normalize().multiplyScalar(TORPEDO_SPEED);
      } else {
        vel = fireDir.multiplyScalar(TORPEDO_SPEED);
      }
    } else if (aft && _aftLocked && _aftLockedContactPos) {
      // Aft lead aiming: same first-order intercept, firing backward toward the rear target
      const toTarget = _aftLockedContactPos.clone().sub(pos);
      const dist     = toTarget.length();
      if (dist > 0.1) {
        const travelTime = dist / TORPEDO_SPEED;
        const leadPos    = _aftLockedContactPos.clone().addScaledVector(_aftLockedContactVel, travelTime);
        vel = leadPos.sub(pos).normalize().multiplyScalar(TORPEDO_SPEED);
      } else {
        vel = fireDir.multiplyScalar(TORPEDO_SPEED);
      }
    } else {
      vel = fireDir.multiplyScalar(TORPEDO_SPEED);
    }

    const coreColor = 0xff9933;
    const glowColor = 0xff5500;

    // Bright inner core
    const coreGeo = new THREE.SphereGeometry(1.0, 8, 6);
    const coreMat = new THREE.MeshBasicMaterial({ color: coreColor });
    const mesh = new THREE.Mesh(coreGeo, coreMat);

    // Soft outer glow halo (additive blend for bloom-like effect)
    const glowGeo = new THREE.SphereGeometry(2.2, 8, 6);
    const glowMat = new THREE.MeshBasicMaterial({
      color: glowColor,
      transparent: true,
      opacity: 0.30,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    mesh.add(new THREE.Mesh(glowGeo, glowMat));

    // Dynamic light so it illuminates nearby objects
    const gl = new THREE.PointLight(glowColor, 5, 50);
    mesh.add(gl);

    mesh.position.copy(pos);
    _scene.add(mesh);
    _torpedoes.push({ mesh, pos: pos.clone(), vel, life: TORPEDO_LIFE });
  }

  function _updateTorpedoes(dt) {
    for (let i = _torpedoes.length - 1; i >= 0; i--) {
      const t = _torpedoes[i];
      t.life -= dt;
      t.pos.addScaledVector(t.vel, dt);
      t.mesh.position.copy(t.pos);

      let hit = false;

      if (t.isZylon) {
        // Seeker torpedo → player only
        if (t.pos.distanceTo(_camera.position) < 10) {
          _applyPlayerHit(GameConfig.zylon.zylonTorpedoDamage);
          hit = true;
        }

      } else if (t.isWarriorCannon) {
        // Warrior cannon → starbase shield, cargo ships, service drones, player
        // (Same hit detection order as the warrior's own target selection.)

        // Starbase shield
        if (!hit && _hasStarbase && _currentStarbase?.state === 'active'
            && (_currentStarbase.shieldCharge ?? 0) > 0) {
          if (t.pos.distanceTo(SB_POS) < SHIELD_R + 4) {
            _currentStarbase.takeCombatHit(GameConfig.zylon.torpedoDamage);
            _spawnShieldImpact(t.pos.clone());
            _sbShieldFlash = 1.0;
            if (_currentStarbase.state === 'dormant') {
              _sbShieldMeshes.forEach(m => { m.visible = false; });
              if (typeof showMessage === 'function') {
                showMessage('SHIELDS FAILED',
                  _currentStarbase.name.toUpperCase() + ' OFFLINE — DOCK TO RESTORE');
              }
            }
            hit = true;
          }
        }
        // Cargo ships
        if (!hit) {
          for (let ci = _cargoShips.length - 1; ci >= 0; ci--) {
            if (t.pos.distanceTo(_cargoShips[ci].pos) < 8) {
              const cs     = _cargoShips[ci];
              const dmg    = GameConfig.zylon.torpedoDamage;
              const shipId = cs.ship.outerBase?.name || cs.ship.resource || 'CARGO';
              cs.ship.health = Math.max(0, (cs.ship.health ?? 1000) - dmg);
              if (cs.ship.health <= 0) {
                cs.ship.destroyed = true; cs.ship.forward = !cs.ship.forward;
                cs.ship.state = 'departing'; cs.ship.stateTimer = 0.1;
                cs.ship._pendingFuelDelivery = 0; cs.ship._pendingRepairHp = 0;
                if (GameConfig.testMode) {
                  const clk = window.SubspaceComm?.clockStr?.() || '?';
                  window.SubspaceComm?.send('CARGO LOST', clk, `[${shipId}] DESTROYED BY ZYLON`);
                }
                _spawnExplosion(cs.pos.clone(),
                  { scale: 2, debris: 8, fireColor: 0xff6600, debrisColor: 0xff4400 });
                _removeCargoMesh(cs.mesh); _cargoShips.splice(ci, 1);
              } else {

                _spawnExplosion(cs.pos.clone(),
                  { scale: 0.6, debris: 2, fireColor: 0xff8800, debrisColor: 0xcc6600 });
              }
              hit = true; break;
            }
          }
        }
        // Service drones
        if (!hit) {
          for (let di = _cargoDrones.length - 1; di >= 0; di--) {
            if (t.pos.distanceTo(_cargoDrones[di].pos) < 5) {
              if (_cargoDrones[di].cargoShip?.ship) {
                _cargoDrones[di].cargoShip.ship._pendingRepairHp = 0;
              }
              _spawnExplosion(_cargoDrones[di].pos.clone(),
                { scale: 1, debris: 0, fireColor: 0xff8800, debrisColor: 0 });
              _removeCargoMesh(_cargoDrones[di].mesh);
              _cargoDrones.splice(di, 1);
              hit = true; break;
            }
          }
        }
        // Docking drone (plug mesh)
        if (!hit && _plugMesh && _plugMesh.visible
            && _dockState !== 'idle' && _dockState !== 'done') {
          if (t.pos.distanceTo(_plugMesh.position) < 5) {
            _spawnExplosion(_plugMesh.position.clone(),
              { scale: 0.8, debris: 3, fireColor: 0xff8800, debrisColor: 0xffcc00 });
            _dockState = 'returning';
            hit = true;
          }
        }
        // Player
        if (!hit && t.pos.distanceTo(_camera.position) < 10) {
          _applyPlayerHit(GameConfig.zylon.zylonTorpedoDamage);
          hit = true;
        }

      } else {
        // Player torpedo → intercept incoming Zylon fire (10u detection radius)
        // Marks the intercepted torpedo life=-1 so the outer loop cleans it up safely.
        if (!hit) {
          for (let ti2 = 0; ti2 < _torpedoes.length; ti2++) {
            if (ti2 === i) continue;
            const t2 = _torpedoes[ti2];
            if (!t2.isZylon && !t2.isWarriorCannon) continue;
            if (t.pos.distanceTo(t2.pos) < 10) {
              t2.life = -1; // mark for cleanup; removed when outer loop reaches it
              _spawnExplosion(t.pos.clone(),
                { scale: 0.4, debris: 2, fireColor: 0xff6600, debrisColor: 0xff4400 });
              hit = true;
              break;
            }
          }
        }

        // Player torpedo → asteroid
        for (let j = _asteroids.length - 1; j >= 0; j--) {
          if (t.pos.distanceTo(_asteroids[j].pos) < _asteroids[j].radius + 5) {
            _spawnExplosion(_asteroids[j].pos.clone(),
              { scale: 1.5, debris: 6, fireColor: 0xcc8833, debrisColor: 0x887755 });
            if (_asteroids[j].mesh) _scene.remove(_asteroids[j].mesh);
            _asteroids.splice(j, 1);
            hit = true;
            break;
          }
        }
        // Player torpedo → starbase shield (only when shields are charged)
        if (!hit && _hasStarbase && _currentStarbase?.state === 'active' && _currentStarbase.shieldCharge >= 1) {
          if (t.pos.distanceTo(SB_POS) < SHIELD_R + 4) {
            _currentStarbase.hitByPhoton();
            _spawnShieldImpact(t.pos.clone());
            _sbShieldFlash = 1.0;
            hit = true;
            // Check if the hit just caused the base to go dormant
            if (_currentStarbase.state === 'dormant') {
              _sbShieldMeshes.forEach(m => { m.visible = false; });
              if (typeof showMessage === 'function') {
                showMessage('SHIELDS FAILED', _currentStarbase.name.toUpperCase() + ' OFFLINE — DOCK TO RESTORE');
              }
            }
          }
        }
        // Player torpedo → starbase hull (when shields are down)
        if (!hit && _hasStarbase && _currentStarbase
            && (_currentStarbase.shieldCharge ?? 1000) < 1
            && t.pos.distanceTo(SB_POS) < 75) {
          _spawnExplosion(t.pos.clone(),
            { scale: 0.5, debris: 4, fireColor: 0x886644, debrisColor: 0x555555 });
          hit = true;
        }
        // Player torpedo → Zylon ships

        if (!hit) {
          for (const z of _zylons) {
            if (z.dead) continue;
            if (t.pos.distanceTo(z.position) < 10) {
              const isBeaconShip = z.type === 'seeker_beacon';
              const destroyed = z.takeDamage(GameConfig.zylon.torpedoDamage);
              if (isBeaconShip) {
                // Beacon: green explosion (same as original)
                _spawnExplosion(t.pos.clone(), {
                  scale: destroyed ? 2.5 : 0.8, debris: destroyed ? 10 : 3,
                  fireColor: 0x00ff44, debrisColor: 0x004422,
                });
                if (destroyed && typeof showMessage === 'function') {
                  // showMessage('BEACON DESTROYED', '', 'ZYLON REINFORCEMENTS RECALLED');
                }
              } else {
                _spawnExplosion(t.pos.clone(),
                  { scale: destroyed ? 1.5 : 0.5, debris: destroyed ? 6 : 2,
                    fireColor: 0xff4400, debrisColor: 0xcc2200 });
              }
              if (destroyed) {
                z.destroy();
                _kills++;
                _targets = Math.max(0, _targets - 1);
                
                if (window.SubspaceComm) {
                   const aliveCount = _zylons.filter(zShip => !zShip.dead).length;
                   const tc = Math.floor(_galacticClock || 0);
                   const clk = `${String(Math.floor(tc/3600)).padStart(2,'0')}:${String(Math.floor((tc%3600)/60)).padStart(2,'0')}:${String(tc%60).padStart(2,'0')}`;
                   window.SubspaceComm.send('DEBUG KILL', clk, `[${_sectorQ},${_sectorR}] ZYLONS ALIVE: ${aliveCount}`);
                }
              }
              hit = true;
              break;
            }
          }
        }
        // Player torpedo → cargo ships
        if (!hit) {
          for (let ci = _cargoShips.length - 1; ci >= 0; ci--) {
            if (t.pos.distanceTo(_cargoShips[ci].pos) < 8) {
              const cs        = _cargoShips[ci];
              const dmg       = GameConfig.supplyShip.torpedoDamage ?? 100;
              const shipId    = cs.ship.outerBase?.name || cs.ship.resource || 'CARGO';
              cs.ship.health  = Math.max(0, (cs.ship.health ?? 1000) - dmg);
              if (cs.ship.health <= 0) {
                // Destroyed — permanent
                cs.ship.destroyed              = true;
                cs.ship.forward               = !cs.ship.forward;
                cs.ship.state                 = 'departing';
                cs.ship.stateTimer            = 0.1;
                cs.ship._pendingFuelDelivery  = 0;
                cs.ship._pendingRepairHp      = 0;
                if (GameConfig.testMode) {
                  const clk = window.SubspaceComm?.clockStr?.() || '?';
                  window.SubspaceComm?.send('CARGO LOST', clk, `[${shipId}] SHIP DESTROYED`);
                }
                _spawnExplosion(cs.pos.clone(),
                  { scale: 2, debris: 8, fireColor: 0xff6600, debrisColor: 0xff4400 });
                _removeCargoMesh(cs.mesh);
                _cargoShips.splice(ci, 1);
              } else {
                // Damaged but alive — small hit flash

                _spawnExplosion(cs.pos.clone(),
                  { scale: 0.6, debris: 2, fireColor: 0xff8800, debrisColor: 0xcc6600 });
              }
              hit = true; break;
            }
          }
        }
        // Player torpedo → cargo drones (friendly fire)
        if (!hit) {
          for (let di = _cargoDrones.length - 1; di >= 0; di--) {
            if (t.pos.distanceTo(_cargoDrones[di].pos) < 5) {
              // Parts on this drone are lost
              if (_cargoDrones[di].cargoShip?.ship) {
                _cargoDrones[di].cargoShip.ship._pendingRepairHp = 0;
              }
              _spawnExplosion(_cargoDrones[di].pos.clone(),
                { scale: 1, debris: 0, fireColor: 0xff8800, debrisColor: 0 });
              _removeCargoMesh(_cargoDrones[di].mesh);
              _cargoDrones.splice(di, 1);
              hit = true; break;
            }
          }
        }
        // Player torpedo → docking drone (aborts docking)
        if (!hit && _plugMesh && _plugMesh.visible && _dockState !== 'idle' && _dockState !== 'done') {
          if (t.pos.distanceTo(_plugMesh.position) < 5) {
            _spawnExplosion(_plugMesh.position.clone(),
              { scale: 0.8, debris: 3, fireColor: 0xff8800, debrisColor: 0xffcc00 });
            _dockState = 'returning'; // abort — drone heads home
            hit = true;
          }
        }

      }

      if (t.life <= 0 || hit) {
        _scene.remove(t.mesh);
        _torpedoes.splice(i, 1);
      }
    }
  }

  function _checkAsteroidCollision() {
    if (_sectorType !== 'asteroid') return;
    for (let i = _asteroids.length - 1; i >= 0; i--) {
      const ast = _asteroids[i];
      const dist = _camera.position.distanceTo(ast.pos);
      if (dist < ast.radius + 6) {
        _spawnExplosion(ast.pos.clone(),
          { scale: ast.radius / 10, debris: 5, fireColor: 0xaa8855, debrisColor: 0x887755 });
        if (ast.mesh) _scene.remove(ast.mesh);
        _asteroids.splice(i, 1);
        _applyPlayerHit(250);
      }
    }
  }

  function _checkCargoCollisions() {
    const SHIP_R  = 6;   // hull half-diagonal
    const DRONE_R = 3;   // drone glow zone
    const COLLISION_DMG = 100;

    // ── Cargo ships ──
    for (let i = _cargoShips.length - 1; i >= 0; i--) {
      const cs   = _cargoShips[i];
      const dist = _camera.position.distanceTo(cs.pos);
      if (dist < SHIP_R) {
        // Push cargo ship out of overlap — player stays, freighter gets shunted
        const pushDir = cs.pos.clone().sub(_camera.position);
        if (pushDir.lengthSq() < 0.0001) pushDir.set(0, 0, 1); // degenerate fallback
        else pushDir.normalize();
        cs.pos.addScaledVector(pushDir, SHIP_R + 2 - dist); // clear sphere + 2u buffer

        const shipId = cs.ship.outerBase?.name || cs.ship.resource || 'CARGO';
        cs.ship.health = Math.max(0, cs.ship.health - COLLISION_DMG);
        _spawnExplosion(cs.pos.clone(),
          { scale: 1.2, debris: 4, fireColor: 0xff8800, debrisColor: 0xcc4400 });
        if (cs.ship.health <= 0) {
          cs.ship.destroyed             = true;
          cs.ship.forward              = !cs.ship.forward;
          cs.ship.state                = 'departing';
          cs.ship.stateTimer           = 0.1;
          cs.ship._pendingFuelDelivery = 0;
          cs.ship._pendingRepairHp     = 0;
          if (GameConfig.testMode) {
            const clk = window.SubspaceComm?.clockStr?.() || '?';
            window.SubspaceComm?.send('CARGO LOST', clk, `[${shipId}] DESTROYED — COLLISION`);
          }
          _spawnExplosion(cs.pos.clone(),
            { scale: 2, debris: 8, fireColor: 0xff6600, debrisColor: 0xff4400 });
          _removeCargoMesh(cs.mesh);
          _cargoShips.splice(i, 1);
        } else if (GameConfig.testMode) {
          const clk = window.SubspaceComm?.clockStr?.() || '?';
          window.SubspaceComm?.send('CARGO COLL', clk, `[${shipId}]  HP: ${cs.ship.health}/1000`);
        }
        _applyPlayerHit(COLLISION_DMG);
      }
    }

    // ── Cargo drones ──
    for (let i = _cargoDrones.length - 1; i >= 0; i--) {
      const d = _cargoDrones[i];
      if (_camera.position.distanceTo(d.pos) < DRONE_R) {
        // Cancel pending repair — parts are scattered
        if (d.cargoShip?.ship) d.cargoShip.ship._pendingRepairHp = 0;
        _spawnExplosion(d.pos.clone(),
          { scale: 0.5, debris: 2, fireColor: 0xff8800, debrisColor: 0 });
        _removeCargoMesh(d.mesh);
        _cargoDrones.splice(i, 1);
        _applyPlayerHit(COLLISION_DMG);
      }
    }
  }

  // ---- Cargo ship 3D presence ----
  function _buildCargoShipMesh() {
    const group = new THREE.Group();
    // Main hull — light steel grey freighter
    group.add(Object.assign(new THREE.Mesh(
      new THREE.BoxGeometry(3, 1, 5),
      new THREE.MeshLambertMaterial({ color: 0xaabbcc })
    ), { name: 'hull' }));
    // Bridge module on top/front
    const bridge = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.8, 1.8),
      new THREE.MeshLambertMaterial({ color: 0x6688aa })
    );
    bridge.position.set(0, 0.9, -1.5);
    group.add(bridge);
    // Engine glow — rear
    const eng = new THREE.PointLight(0x4488ff, 2.5, 30);
    eng.position.set(0, 0, 2.5);
    eng.name = 'EngineLight';
    group.add(eng);
    // Running lights
    const port = new THREE.PointLight(0xff2222, 0.5, 10);
    port.position.set(-1.5, 0, 0);
    group.add(port);
    const stbd = new THREE.PointLight(0x22ff22, 0.5, 10);
    stbd.position.set(1.5, 0, 0);
    group.add(stbd);
    return group;
  }

  function _spawnCargoShips(ships) {
    _cargoShips = [];
    if (!_scene || !ships || ships.length === 0) return;
    const SS = GameConfig.supplyShip;
    for (const ship of ships) {
      const mesh = _buildCargoShipMesh();
      const angle    = Math.random() * Math.PI * 2;
      const spawnDir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const spawnPos = _hasStarbase
        ? SB_POS.clone().addScaledVector(spawnDir, 102 + SS.spawnOffset)
        : new THREE.Vector3((Math.random()-0.5)*200, 0, (Math.random()-0.5)*200);
      const dockPos = _hasStarbase
        ? SB_POS.clone().addScaledVector(spawnDir, 102)
        : spawnPos.clone();
      mesh.position.copy(spawnPos);
      _scene.add(mesh);
      _cargoShips.push({
        ship, mesh,
        pos:       spawnPos.clone(),
        dockPos:   dockPos.clone(),
        spawnPos:  spawnPos.clone(),
        phase:     _hasStarbase ? 'arriving' : 'waiting',
        phaseTimer: 0,
      });
    }
  }

  function _warpBurst3D(pos, color) {
    if (!_scene) return;
    const light = new THREE.PointLight(color, 25, 400);
    light.position.copy(pos);
    _scene.add(light);
    let elapsed = 0;
    const fade = () => {
      elapsed += 1/60;
      light.intensity = 25 * Math.max(0, 1 - elapsed / 0.5);
      if (elapsed < 0.5 && _scene) requestAnimationFrame(fade);
      else if (_scene) _scene.remove(light);
    };
    requestAnimationFrame(fade);
  }

  // Bulletproof mesh removal — traverse all children, then detach from parent
  function _removeCargoMesh(mesh) {
    mesh.traverse(c => { c.visible = false; });
    if (mesh.parent) mesh.parent.remove(mesh);
    else _scene?.remove(mesh);
  }

  function _updateCargoShips(dt) {
    const SS    = GameConfig.supplyShip;
    const spd   = SS.sectorSpeed;
    const toRem = [];

    for (let i = 0; i < _cargoShips.length; i++) {
      const cs   = _cargoShips[i];
      const { ship, mesh } = cs;

      // Highest priority: if the galaxy-level ship has warped to a different sector, remove immediately
      const curHex = ship.currentHex;
      if (!curHex || curHex.q !== _sectorQ || curHex.r !== _sectorR) {
        _warpBurst3D(cs.pos, 0xffffff);
        _removeCargoMesh(cs.mesh);
        toRem.push(i);
        continue;
      }

      // Pre-warp strobe
      if (ship.isDeparting) {
        const strobe = 0.5 + 0.5 * Math.sin(Date.now() * 0.02);
        const eng = mesh.getObjectByName('EngineLight');
        if (eng) { eng.intensity = 2 + 12 * strobe; eng.color.set(0xff8800); }
      }

      if (cs.phase === 'arriving') {
        const toTarget = cs.dockPos.clone().sub(cs.pos);
        const dist     = toTarget.length();
        if (dist < 4) {
          cs.phase = 'docked'; cs.phaseTimer = SS.dockTime;
          _spawnCargoDrone(cs); // send drone to service this ship
        } else {
          const dir = toTarget.normalize();
          cs.pos.addScaledVector(dir, Math.min(spd * dt, dist));
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1), dir);
        }

      } else if (cs.phase === 'docked') {
        cs.phaseTimer -= dt;
        if (cs.phaseTimer <= 0) cs.phase = 'leaving';

      } else if (cs.phase === 'leaving') {
        const toTarget = cs.spawnPos.clone().sub(cs.pos);
        const dist     = toTarget.length();
        if (dist < 6) {
          // No snap, no wait — fire first flash and start warp burn immediately
          cs.phase = 'pulsing'; cs.phaseTimer = SS.warpBurnTime;
          _warpBurst3D(cs.pos, 0xff8800);
        } else {
          const dir = toTarget.normalize();
          cs.pos.addScaledVector(dir, Math.min(spd * dt, dist));
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1), dir);
        }

      } else if (cs.phase === 'pulsing' || cs.phase === 'pulsing_solo') {
        cs.phaseTimer -= dt;
        const awayDir = cs.pos.clone().sub(SB_POS).normalize();
        if (awayDir.lengthSq() < 0.01) awayDir.set(0, 0, 1);
        cs.pos.addScaledVector(awayDir, spd * 2.5 * dt);
        if (cs.phaseTimer <= 0) {
          _warpBurst3D(cs.pos, 0xffffff);
          _removeCargoMesh(cs.mesh);
          toRem.push(i);
        }

      } else if (cs.phase === 'waiting') {
        if (ship.isDeparting) {
          cs.phase = 'pulsing_solo'; cs.phaseTimer = SS.warpBurnTime;
          _warpBurst3D(cs.pos, 0xff8800);
        }
      }

      mesh.position.copy(cs.pos);
    }

    for (let i = toRem.length - 1; i >= 0; i--) {
      _cargoShips.splice(toRem[i], 1);
    }

    // Poll for ships that have warped INTO this sector since we entered
    if (_scene && _allSupplyShips.length > 0) {
      const knownShips = new Set(_cargoShips.map(cs => cs.ship));
      for (const ship of _allSupplyShips) {
        if (knownShips.has(ship)) continue;
        if (ship.destroyed) continue;              // permanently gone
        const h = ship.currentHex;
        if (!h || h.q !== _sectorQ || h.r !== _sectorR) continue;
        const mesh   = _buildCargoShipMesh();
        const angle  = Math.random() * Math.PI * 2;
        const spawnDir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
        const spawnPos = _hasStarbase
          ? SB_POS.clone().addScaledVector(spawnDir, 102 + SS.spawnOffset)
          : new THREE.Vector3((Math.random()-0.5)*200, 0, (Math.random()-0.5)*200);
        const dockPos = _hasStarbase
          ? SB_POS.clone().addScaledVector(spawnDir, 102)
          : spawnPos.clone();
        mesh.position.copy(spawnPos);
        _scene.add(mesh);
        _warpBurst3D(spawnPos, 0x88aaff);
        _cargoShips.push({ ship, mesh, pos: spawnPos.clone(), dockPos: dockPos.clone(),
          spawnPos: spawnPos.clone(), phase: _hasStarbase ? 'arriving' : 'waiting', phaseTimer: 0 });
      }
    }
  }

  // ---- Cargo service drones ----
  function _buildCargoDroneMesh() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.8, 0),
      new THREE.MeshBasicMaterial({ color: 0xff8800, wireframe: true }));
    g.add(body);
    const glow = new THREE.PointLight(0xff8800, 2, 18);
    g.add(glow);
    return g;
  }

  function _spawnCargoDrone(cs) {
    if (!_scene || !_hasStarbase) return;
    const mesh = _buildCargoDroneMesh();
    mesh.position.copy(SB_POS);
    _scene.add(mesh);
    _cargoDrones.push({
      mesh,
      pos:       SB_POS.clone(),
      target:    cs.pos.clone(),
      cargoShip: cs,          // reference so drone can apply fuel on return
      state:     'flying_to',
      timer:     0,
    });
  }

  function _updateCargoDrones(dt) {
    const spd   = DRONE_SPEED;
    const toRem = [];
    for (let i = 0; i < _cargoDrones.length; i++) {
      const d = _cargoDrones[i];
      if (d.state === 'flying_to') {
        const toTarget = d.target.clone().sub(d.pos);
        const dist     = toTarget.length();
        if (dist < 2) {
          d.state = 'connected'; d.timer = 3;
          d.pos.copy(d.target);
        } else {
          d.pos.addScaledVector(toTarget.normalize(), Math.min(spd * dt, dist));
        }
      } else if (d.state === 'connected') {
        d.timer -= dt;
        // Small hover bob while connected
        d.pos.y = d.target.y + Math.sin(Date.now() * 0.004) * 0.3;
        if (d.timer <= 0) { d.state = 'returning'; }
      } else if (d.state === 'returning') {
        const toSB = SB_POS.clone().sub(d.pos);
        const dist  = toSB.length();
        if (dist < 3) {
          // Drone arrived back at starbase — apply pending fuel AND repair
          const pending = d.cargoShip?.ship?._pendingFuelDelivery ?? 0;
          if (pending > 0 && _currentStarbase?.inventory) {
            _currentStarbase.inventory.energy = Math.min(
              _currentStarbase.target?.energy ?? Infinity,
              (_currentStarbase.inventory.energy ?? 0) + pending
            );
            d.cargoShip.ship._pendingFuelDelivery = 0;
          }
          // Apply pending repair (parts were on this drone)
          const repairHp = d.cargoShip?.ship?._pendingRepairHp ?? 0;
          if (repairHp > 0 && d.cargoShip?.ship) {
            const maxH = GameConfig.supplyShip.maxHealth;
            d.cargoShip.ship.health = Math.min(maxH, (d.cargoShip.ship.health ?? maxH) + repairHp);
            d.cargoShip.ship._pendingRepairHp = 0;
            if (GameConfig.testMode) {
              const sid = d.cargoShip.ship.outerBase?.name || d.cargoShip.ship.resource || 'CARGO';
              const clk = window.SubspaceComm?.clockStr?.() || '?';
              window.SubspaceComm?.send('CARGO RPR', clk, `[${sid}]  HP: ${d.cargoShip.ship.health}/1000`);
            }
          }
          toRem.push(i);
        } else {
          d.pos.addScaledVector(toSB.normalize(), Math.min(spd * dt, dist));
        }
      }
      d.mesh.position.copy(d.pos);
    }
    for (let i = toRem.length - 1; i >= 0; i--) {
      _removeCargoMesh(_cargoDrones[toRem[i]].mesh);
      _cargoDrones.splice(toRem[i], 1);
    }
  }


  // ---- HUD ----
  function _drawHUD() {
    const oc = _overlayCtx; if (!oc) return;
    const W = _overlayCanvas.width, H = _overlayCanvas.height;
    oc.clearRect(0, 0, W, H);

    // Dashboard destroyed → blank overlay
    if (_computer && _computer.dashboard <= 0) return;

    const DH = 130; // dashboard height
    const DY = H - DH;
    const cx = W/2, cy = H / 2; // H/2 = true camera aim point (camera renders full canvas)
    let _postDraw = () => {}; // contact-list rendered after dashboard so it overlays it
    // ---- Right-section geometry (scope + two contact columns) ----
    const scopeW = 180, scopeH = 140;
    const colW = 95, colGap = 8, rightMargin = 8;
    const col2X = W - rightMargin - colW;
    const col1X = col2X - colGap - colW;
    const scopeX = Math.round(col1X + colW / 2 - scopeW / 2);  // centered above col1
    const scopeY = DY - scopeH - Math.round(scopeH / 2); // bottom sits scopeH/2 above dashboard

    // Dashboard HP available for future degraded-display effects (no per-frame flicker)
    const dashHP = _computer ? _computer.dashboard : 100;
    // _glitch() stub: always false — flicker permanently disabled
    function _glitch() { return false; }

    // Shield tint (from capacitor charge)
    if (_shieldsOn && _shieldCharge > 0) {
      const a = 0.05 + 0.08 * (_shieldCharge / 400);
      oc.fillStyle = `rgba(0,15,55,${a})`;
      oc.fillRect(0, 0, W, DY);
    }

    // Vignette
    const vig = oc.createRadialGradient(cx, cy, cy*0.22, cx, cy, cy*0.70);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,5,15,0.50)');
    oc.fillStyle = vig; oc.fillRect(0, 0, W, DY);

    // Hit flash
    if (_hitFlash > 0) {
      oc.fillStyle = `rgba(255,30,0,${Math.min(0.55, _hitFlash * 1.1)})`;
      oc.fillRect(0, 0, W, DY);
    }

    // RED ALERT overlay
    if (_redAlert) {
      const t = Date.now() * 0.004;
      const ra = 0.4 + 0.35 * Math.sin(t);
      oc.strokeStyle = `rgba(255,0,0,${ra})`;
      oc.lineWidth = 4;
      oc.strokeRect(4, 4, W-8, DY-8);
      oc.font = 'bold 16px Orbitron, sans-serif';
      oc.fillStyle = `rgba(255,60,60,${ra + 0.2})`;
      oc.textAlign = 'center';
      oc.fillText('RED ALERT', cx, 30);
    }


    // Corner brackets
    const bs = 42, bo = 22;
    oc.strokeStyle = 'rgba(0,180,255,0.32)'; oc.lineWidth = 1.5;
    [[bo,bo,1,1],[W-bo,bo,-1,1]].forEach(([x,y,sx,sy]) => {
      oc.beginPath(); oc.moveTo(x, y+sy*bs); oc.lineTo(x,y); oc.lineTo(x+sx*bs,y); oc.stroke();
    });

    // ---- Crosshair / Targeting Computer ----
    const cr = 15;
    if (_rearView) {
      const lx = W * 0.25;
      oc.strokeStyle = 'rgba(0,255,200,0.72)'; oc.lineWidth = 1.2;
      oc.beginPath();
      oc.moveTo(lx, cy - 22); oc.lineTo(W - lx, cy - 22);
      oc.moveTo(lx, cy + 22); oc.lineTo(W - lx, cy + 22);
      oc.stroke();
      oc.font = '8px Share Tech Mono, monospace'; oc.fillStyle = 'rgba(0,255,200,0.45)'; oc.textAlign = 'center';
      oc.fillText('AFT VIEW', cx, cy - 36);
      _lockState = 0;
    } else if (_computerOn && _systems.C > 0) {
      // Orange = browser unfocused (click will restore focus, not fire); green = ready
      const xhairBase = _windowFocused ? '0,255,200' : '255,140,0';
      const alpha = _fireFlash > 0 ? 1.0 : 0.82;
      oc.strokeStyle = `rgba(${xhairBase},${alpha})`; oc.lineWidth = _fireFlash > 0 ? 2 : 1.2;
      oc.beginPath();
      oc.moveTo(cx-cr*1.8, cy); oc.lineTo(cx-cr*0.4, cy);
      oc.moveTo(cx+cr*0.4, cy); oc.lineTo(cx+cr*1.8, cy);
      oc.moveTo(cx, cy-cr*1.8); oc.lineTo(cx, cy-cr*0.4);
      oc.moveTo(cx, cy+cr*0.4); oc.lineTo(cx, cy+cr*1.8);
      oc.stroke();
      const dotCol = _fireFlash > 0 ? 'rgba(255,255,255,0.95)' : `rgba(${xhairBase},0.9)`;
      oc.fillStyle = dotCol; oc.beginPath(); oc.arc(cx, cy, _fireFlash > 0 ? 4 : 2, 0, Math.PI*2); oc.fill();
      if (_fireFlash > 0) {
        const bAlpha = Math.min(1, _fireFlash/0.12);
        oc.strokeStyle = `rgba(68,221,255,${0.75*bAlpha})`; oc.lineWidth = 2;
        oc.beginPath();
        oc.moveTo(40, DY-5); oc.lineTo(cx, cy);
        oc.moveTo(W-40, DY-5); oc.lineTo(cx, cy);
        oc.stroke();
      }
      // Warp charge inner targeting reticle
      if (_warpCharging && _computerOn && _systems.C > 25) {
        const hRight = new THREE.Vector3(1, 0, 0).applyQuaternion(_cameraQuat);
        const hUp    = new THREE.Vector3(0, 1, 0).applyQuaternion(_cameraQuat);
        const rx = _warpTargetDir.dot(hRight);
        const uy = _warpTargetDir.dot(hUp);
        const WSCALE = Math.min(W, DY) * 0.55;
        const tx = cx + rx * WSCALE;
        const ty = cy - uy * WSCALE;
        const err = Math.sqrt(rx * rx + uy * uy);
        const ON_TARGET = 0.04, NEAR_TARGET = 0.10;
        const warpCol = err < ON_TARGET ? '#00ff88' : err < NEAR_TARGET ? '#ffcc00' : '#ff3300';
        const tR = 14;
        oc.strokeStyle = warpCol; oc.lineWidth = 1.8;
        oc.beginPath();
        oc.moveTo(tx, ty - tR); oc.lineTo(tx + tR, ty);
        oc.lineTo(tx, ty + tR); oc.lineTo(tx - tR, ty);
        oc.closePath(); oc.stroke();
        const wp = 0.5 + 0.5 * Math.sin(Date.now() * 0.008);
        oc.fillStyle = warpCol; oc.globalAlpha = 0.4 + 0.6 * wp;
        oc.beginPath(); oc.arc(tx, ty, 3, 0, Math.PI * 2); oc.fill();
        oc.globalAlpha = 1;
        oc.font = '7px Share Tech Mono, monospace'; oc.fillStyle = warpCol; oc.textAlign = 'center';
        oc.fillText('WARP LOCK', cx, cy + cr * 2.6);
      }
    } else {
      oc.strokeStyle = 'rgba(0,255,200,0.20)'; oc.lineWidth = 1;
      oc.beginPath(); oc.arc(cx, cy, 3, 0, Math.PI*2); oc.stroke();
      _lockState = 0;
    }

    // ---- Multi-target bearing scope + contact list (computer on & C system alive) ----
    if (_computerOn && _systems.C > 0) {
      const damaged = _systems.C < 50;
      const bdrCol  = damaged ? 'rgba(255,160,0,0.45)' : 'rgba(0,200,255,0.45)';
      const txtCol  = damaged ? 'rgba(255,160,0,0.7)'  : 'rgba(0,200,255,0.7)';

      // ---- Ship heading vectors (quaternion, aft-view immune) ----
      const camFwd   = new THREE.Vector3(0, 0, -1).applyQuaternion(_cameraQuat);
      const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(_cameraQuat);
      const camUp    = new THREE.Vector3(0, 1, 0).applyQuaternion(_cameraQuat);

      // ---- Build contacts with computed bearings ----
      const rawContacts = [];
      let zyIdx = 1;
      for (const z of _zylons) {
        if (!z.dead) {
          // Compute contact velocity: beacon uses orbit tangent; warriors compute from orbit; seekers use _vel
          let zVel = new THREE.Vector3();
          if (z._bOrbitDir !== undefined) {
            // Beacon ship: tangential velocity — same proximity tiers as _updateBeaconShip
            const bp = z.mesh.position;
            const br = new THREE.Vector3(bp.x, 0, bp.z);
            if (br.length() > 0.1) {
              br.normalize();
              const cfg = GameConfig.zylon;
              const dP  = _camera.position.distanceTo(bp);
              let bSpeed;
              if      (z._bEvasion > 0) bSpeed = 100;
              else if (dP < 50)         bSpeed = cfg.beaconSpeedTier4 ?? 65;
              else if (dP < 100)        bSpeed = cfg.beaconSpeedTier3 ?? 55;
              else if (dP < 150)        bSpeed = cfg.beaconSpeedTier2 ?? 45;
              else if (dP < 200)        bSpeed = cfg.beaconSpeedTier1 ?? 35;
              else                      bSpeed = cfg.beaconNormalSpeed ?? 25;
              zVel.set(-br.z, 0, br.x).multiplyScalar(bSpeed * z._bOrbitDir);
            }
          } else if (z._worbitDir !== undefined) {
            // Warrior: tangential velocity from orbit
            const zp  = z.mesh.position;
            const zr  = new THREE.Vector3(zp.x, 0, zp.z);
            if (zr.length() > 0.1) {
              zr.normalize();
              const ws = GameConfig.zylon.warriorOrbitSpeed ?? 50;
              zVel.set(-zr.z, 0, zr.x).multiplyScalar(ws * z._worbitDir);
            }
          } else if (z._vel) {
            zVel = z._vel.clone(); // seeker: use actual velocity
          }
          rawContacts.push({ pos: z.position, vel: zVel, color: '#ff3300', size: 3, label: `ZY-${zyIdx++}` });
        }
      }
      if (_hasStarbase) rawContacts.push({ pos: SB_POS.clone(), vel: new THREE.Vector3(), color: '#00e5ff', size: 3.5, label: 'SB' });
      // Beacon: approximate tangential orbit velocity
      for (const cs of _cargoShips) {
        rawContacts.push({ pos: cs.pos.clone(), color: '#aaff44', size: 2.5, label: 'CS' });
      }
      // Docking drone — show as 'DD' contact when in transit or connected
      if (_plugMesh && _plugMesh.visible &&
          (_dockState === 'outbound' || _dockState === 'connected' || _dockState === 'returning')) {
        rawContacts.push({ pos: _plugMesh.position.clone(), color: '#ff8800', size: 2, label: 'DD' });
      }
      // Cargo service drones
      for (const d of _cargoDrones) {
        rawContacts.push({ pos: d.pos.clone(), color: '#ff8800', size: 2, label: 'DD' });
      }
      if (rawContacts.length === 0)
        rawContacts.push({ pos: new THREE.Vector3(0,0,0), color: 'rgba(160,180,200,0.55)', size: 2, label: 'ORG' });

      const contacts = rawContacts.map(ct => {
        const rel  = ct.pos.clone().sub(_camera.position);
        const dist = rel.length();
        const dir  = dist > 0.1 ? rel.clone().normalize() : new THREE.Vector3(0,0,-1);
        const fwd  = dir.dot(camFwd);
        const rDot = dir.dot(camRight);
        const uDot = dir.dot(camUp);
        // θ = horizontal bearing from forward (atan2: 0=ahead, ±180=behind)
        // φ = vertical elevation (asin: 0=level)
        const theta = Math.round(Math.atan2(rDot, fwd) * 180 / Math.PI);
        const phi   = Math.round(Math.asin(Math.max(-1, Math.min(1, uDot))) * 180 / Math.PI);
        return { ...ct, dist, fwd, rDot, uDot, theta, phi };
      });

      // ---- Scope geometry (scopeW/H/X/Y defined at top of _drawHUD) ----
      const rowH = 18;
      const scopeCx = scopeX + scopeW / 2, scopeCy = scopeY + scopeH / 2;
      const maxH = scopeW / 2 - 6, maxV = scopeH / 2 - 8;

      // Bearing scope: outer box
      oc.fillStyle = 'rgba(0,6,20,0.82)'; oc.fillRect(scopeX, scopeY, scopeW, scopeH);
      oc.strokeStyle = bdrCol; oc.lineWidth = 1; oc.strokeRect(scopeX, scopeY, scopeW, scopeH);
      oc.font = '5px Share Tech Mono, monospace'; oc.fillStyle = damaged ? 'rgba(255,160,0,0.4)' : 'rgba(0,200,255,0.35)';
      oc.textAlign = 'center'; oc.fillText('BEARING SCOPE', scopeCx, scopeY + 7);

      // Inner box centered, + 4 connector lines from outer edge-centers to inner edge-centers
      const sibW = scopeW * 0.18, sibH = scopeH * 0.22; // inner box half-extents
      const dashGap = scopeH * 0.08;                     // distance above/below horizontal connectors
      oc.strokeStyle = bdrCol; oc.lineWidth = 0.8;
      oc.strokeRect(scopeCx - sibW, scopeCy - sibH, sibW * 2, sibH * 2); // inner box
      oc.beginPath();
      // Horizontal connectors: outer left/right edge-center → inner left/right edge-center
      oc.moveTo(scopeX,            scopeCy); oc.lineTo(scopeCx - sibW, scopeCy);
      oc.moveTo(scopeCx + sibW,    scopeCy); oc.lineTo(scopeX + scopeW, scopeCy);
      // Vertical connectors: outer top/bottom edge-center → inner top/bottom edge-center
      oc.moveTo(scopeCx, scopeY);            oc.lineTo(scopeCx, scopeCy - sibH);
      oc.moveTo(scopeCx, scopeCy + sibH);    oc.lineTo(scopeCx, scopeY + scopeH);
      oc.stroke();

      // Center cross-dot
      oc.strokeStyle = 'rgba(0,255,200,0.25)'; oc.lineWidth = 0.5;
      oc.beginPath();
      oc.moveTo(scopeCx-4, scopeCy); oc.lineTo(scopeCx+4, scopeCy);
      oc.moveTo(scopeCx, scopeCy-4); oc.lineTo(scopeCx, scopeCy+4);
      oc.stroke();

      // ── Docking indicator (only when computer on and healthy) ──
      if (_hasStarbase && !damaged) {
        const distToSB = _camera.position.distanceTo(SB_POS);
        const dockReady = distToSB < DOCK_RANGE && _currentVelocity < 0.5;
        const dockActive = _dockState === 'outbound' || _dockState === 'connected' || _dockState === 'returning';

        if (dockActive) {
          const pulse = 0.55 + 0.45 * Math.sin(Date.now() * 0.006);
          const msg = _dockState === 'connected' ? 'CONNECTED' : _dockState === 'returning' ? 'DRONE RETURNING' : 'DOCKING IN PROGRESS';
          oc.font = '9px Share Tech Mono, monospace'; oc.textAlign = 'center';
          oc.fillStyle = `rgba(0,255,180,${pulse})`;
          oc.fillText(msg, scopeCx, scopeY + scopeH - 5);
          // Pulsing ring around scope center
          oc.strokeStyle = `rgba(0,220,160,${pulse * 0.6})`; oc.lineWidth = 1.2;
          oc.beginPath(); oc.arc(scopeCx, scopeCy, sibH * 1.1, 0, Math.PI * 2); oc.stroke();
        } else if (dockReady && _dockState === 'idle') {
          const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.003);
          oc.font = '9px Share Tech Mono, monospace'; oc.textAlign = 'center';
          oc.fillStyle = `rgba(0,255,120,${0.6 + 0.4 * pulse})`;
          oc.fillText('DOCK READY  PRESS D', scopeCx, scopeY + scopeH - 5);
        }
      }

      // Contact dots + lock detection
      let scopeLock = 0;
      _starbaseLocked = false;
      _aftLocked      = false; // reset each frame
      for (const ct of contacts) {
        if (ct.dist < 0.1) continue;
        const sx2 = scopeCx + Math.max(-maxH, Math.min(maxH, ct.rDot * maxH * 1.4));
        const sy2 = scopeCy - Math.max(-maxV, Math.min(maxV, ct.uDot * maxV * 1.4));
        const dotR = Math.max(5, Math.min(15, ct.size * 3 * Math.min(1.6, 200 / Math.max(1, ct.dist))));
        if (damaged && Math.random() < 0.35) continue;
        oc.beginPath(); oc.arc(sx2, sy2, dotR, 0, Math.PI * 2);
        if (ct.fwd > 0) { oc.fillStyle = ct.color; oc.fill(); }
        else            { oc.strokeStyle = ct.color; oc.lineWidth = 1.2; oc.stroke(); }
        // Check lock: only for ENEMY targets IN FRONT and within combat range
        const dx = sx2 - scopeCx, dy = sy2 - scopeCy;
        const isEnemy = ct.label.startsWith('ZY') || ct.label === 'BN';
        if (ct.fwd > 0 && isEnemy && ct.dist < 1500 && Math.abs(dx) < sibW) {
          if (Math.abs(dy) < sibH)  scopeLock = Math.max(scopeLock, 3);
          else if (dy < -sibH)      scopeLock = Math.max(scopeLock, 1);
          else if (dy >  sibH)      scopeLock = Math.max(scopeLock, 2);
        }
        // Only lock targets that are IN FRONT (ct.fwd > 0)
        if (ct.fwd > 0 && ct.label === 'SB' && Math.abs(dx) < sibW && Math.abs(dy) < sibH) {
          _starbaseLocked = true;
        }
        // Rear lock: enemy behind player, within 500u, centered on scope
        if (ct.fwd < 0 && isEnemy && ct.dist < 500) {
          if (Math.abs(dx) < sibW && Math.abs(dy) < sibH) _aftLocked = true;
        }
      }
      _lockState = scopeLock;

      // Update combat lock: true only when lockState is full (3)
      _targetLocked = (_lockState === 3);
      if (_targetLocked) {
        // Find the most-centered forward enemy contact to aim at
        const best = contacts
          .filter(ct => ct.fwd > 0.1 && (ct.label.startsWith('ZY') || ct.label === 'BN') && ct.dist < 1500)
          .sort((a, b) => (Math.abs(a.rDot) + Math.abs(a.uDot)) - (Math.abs(b.rDot) + Math.abs(b.uDot)))[0];
        _lockedContactPos = best ? best.pos.clone() : null;
        _lockedContactVel = best?.vel ? best.vel.clone() : new THREE.Vector3();
      } else {
        _lockedContactPos = null;
        _lockedContactVel.set(0, 0, 0);
      }

      // Aft lock: find the most-centered rear enemy for lead aiming
      if (_aftLocked) {
        const bestAft = contacts
          .filter(ct => ct.fwd < 0 && (ct.label.startsWith('ZY') || ct.label === 'BN') && ct.dist < 500)
          .sort((a, b) => (Math.abs(a.rDot) + Math.abs(a.uDot)) - (Math.abs(b.rDot) + Math.abs(b.uDot)))[0];
        _aftLockedContactPos = bestAft ? bestAft.pos.clone() : null;
        _aftLockedContactVel = bestAft?.vel ? bestAft.vel.clone() : new THREE.Vector3();
      } else {
        _aftLockedContactPos = null;
        _aftLockedContactVel.set(0, 0, 0);
      }

      // Drone dot on scope when plug is in transit
      if (_plugMesh && (_dockState === 'outbound' || _dockState === 'returning')) {
        const droneRel = _plugMesh.position.clone().sub(_camera.position);
        const dDist    = droneRel.length();
        if (dDist > 0.1) {
          const dDir  = droneRel.normalize();
          const camFwd2  = new THREE.Vector3(0, 0, -1).applyQuaternion(_cameraQuat);
          const camRt2   = new THREE.Vector3(1, 0, 0).applyQuaternion(_cameraQuat);
          const camUp2   = new THREE.Vector3(0, 1, 0).applyQuaternion(_cameraQuat);
          const dsx = scopeCx + Math.max(-maxH, Math.min(maxH, dDir.dot(camRt2) * maxH * 1.4));
          const dsy = scopeCy - Math.max(-maxV, Math.min(maxV, dDir.dot(camUp2) * maxV * 1.4));
          oc.beginPath(); oc.arc(dsx, dsy, 4, 0, Math.PI * 2);
          oc.fillStyle = _dockState === 'returning' ? '#ff8800' : '#00ffee'; oc.fill();
        }
      }

      // Lock indicator lines on the scope
      if (_lockState > 0) {
        const lockCol = 'rgba(110,245,255,0.90)';
        const dashLen = (scopeW / 2 - sibW) * 0.60;
        const pulse   = _lockState === 3 ? 1.0 : 0.55 + 0.45 * Math.sin(Date.now() * 0.006);
        oc.strokeStyle = lockCol; oc.lineWidth = 1.5; oc.globalAlpha = pulse;
        oc.beginPath();
        if (_lockState === 1 || _lockState === 3) {
          // Top pair: above horizontal connector
          oc.moveTo(scopeX + 2,          scopeCy - dashGap); oc.lineTo(scopeX + dashLen,          scopeCy - dashGap);
          oc.moveTo(scopeX + scopeW - 2, scopeCy - dashGap); oc.lineTo(scopeX + scopeW - dashLen, scopeCy - dashGap);
        }
        if (_lockState === 2 || _lockState === 3) {
          // Bottom pair: below horizontal connector
          oc.moveTo(scopeX + 2,          scopeCy + dashGap); oc.lineTo(scopeX + dashLen,          scopeCy + dashGap);
          oc.moveTo(scopeX + scopeW - 2, scopeCy + dashGap); oc.lineTo(scopeX + scopeW - dashLen, scopeCy + dashGap);
        }
        oc.stroke(); oc.globalAlpha = 1;
      }

      // Aft lock indicator: amber diagonal lines through inner-square corners
      if (_aftLocked) {
        const pulse = 0.6 + 0.4 * Math.sin(Date.now() * 0.006);
        oc.strokeStyle = 'rgba(255,160,0,0.90)'; oc.lineWidth = 1.5; oc.globalAlpha = pulse;
        oc.beginPath();
        // Each line runs from just inside a scope outer corner to the matching inner-square corner
        oc.moveTo(scopeX + 4,              scopeY + 4);              oc.lineTo(scopeCx - sibW, scopeCy - sibH); // TL
        oc.moveTo(scopeX + scopeW - 4,    scopeY + 4);              oc.lineTo(scopeCx + sibW, scopeCy - sibH); // TR
        oc.moveTo(scopeX + 4,              scopeY + scopeH - 4);    oc.lineTo(scopeCx - sibW, scopeCy + sibH); // BL
        oc.moveTo(scopeX + scopeW - 4,    scopeY + scopeH - 4);    oc.lineTo(scopeCx + sibW, scopeCy + sibH); // BR
        oc.stroke(); oc.globalAlpha = 1;
      }
      // Docking status above scope — kept minimal, detail is in the scope indicator
      if (_hasStarbase) {
        const dockMsgs = {
          outbound:  { text: 'DRONE EN ROUTE',   col: '#00ffee' },
          connected: { text: 'DOCKING...',        col: '#ffdd00' },
          returning: { text: 'DRONE RETURNING',   col: '#ff4400' },
          done:      { text: 'SYSTEMS RESTORED',  col: '#00ff88' },
        };
        const dm = dockMsgs[_dockState];
        if (dm) {
          const pulse = (_dockState === 'outbound' || _dockState === 'connected')
            ? 0.6 + 0.4 * Math.sin(Date.now() * 0.008) : 1.0;
          oc.font = 'bold 8px Share Tech Mono, monospace';
          oc.fillStyle = dm.col; oc.globalAlpha = pulse; oc.textAlign = 'center';
          oc.fillText(dm.text, scopeCx, scopeY - 4);
          oc.globalAlpha = 1;
        }
      }

      // ---- Defer contact list draw so it renders on top of everything ----
      _postDraw = () => {
        const rowH = Math.floor(DH / 6);  // 6 rows fill full column height, no header
        const drawCol = (start, colX) => {
          contacts.slice(start, start + 6).forEach((ct, i) => {
            const ry = DY + (i + 1) * rowH - 4;  // bottom of each row slot
            const rVal = Math.min(9999, Math.round(ct.dist));
            const rStr = String(rVal).padStart(4, '0');
            if (damaged && Math.random() < 0.4) {
              oc.font = 'bold 13px Share Tech Mono, monospace';
              oc.fillStyle = 'rgba(255,80,0,0.5)'; oc.textAlign = 'left';
              oc.fillText(`${ct.label}  ----`, colX + 5, ry); return;
            }
            // Label (type)
            oc.font = 'bold 13px Share Tech Mono, monospace';
            oc.fillStyle = ct.color; oc.textAlign = 'left';
            oc.fillText(ct.label, colX + 5, ry);
            // Range — right-aligned, bright white for readability
            oc.font = '13px Share Tech Mono, monospace';
            oc.fillStyle = '#ffffff'; oc.textAlign = 'right';
            oc.fillText(rStr, colX + colW - 5, ry);
          });
        };
        drawCol(0, col1X);
        drawCol(6, col2X);
        oc.textAlign = 'left';
      };

      oc.textAlign = 'left';
    }

    // Sector name
    oc.font = 'bold 10px Orbitron, sans-serif'; oc.fillStyle = 'rgba(0,180,255,0.55)'; oc.textAlign = 'center';
    oc.fillText(_sectorName, cx, _redAlert ? 52 : 28);

    // Hint line
    oc.font = '7px Share Tech Mono, monospace'; oc.fillStyle = 'rgba(0,180,255,0.28)'; oc.textAlign = 'left';
    oc.fillText(`G-MAP | F-FWD | A-AFT | S-SH:${_shieldsOn?'ON':'OFF'} | C-CPU:${_computerOn?'ON':'OFF'} | L-LRS | LMB-FORE | SPC-AFT`, 26, _redAlert ? 52 : 28);

    // Entry msg
    if (_entryTimer > 0) {
      const a = Math.min(1, _entryTimer * 0.8);
      oc.font = 'bold 15px Orbitron, sans-serif'; oc.fillStyle = `rgba(0,229,255,${a})`; oc.textAlign = 'center';
      oc.fillText('SECTOR ENTERED', cx, DY/2 - 55);
      oc.font = '9px Share Tech Mono, monospace'; oc.fillStyle = `rgba(160,204,238,${a*0.8})`;
      oc.fillText('MOUSE TO STEER  •  0-9 OR SCROLL = SPEED  •  G = GALAXY MAP', cx, DY/2 - 32);
    }

    // Docking status banner
    if (_hasStarbase && _dockState === 'connected') {
      const pct = Math.round((1 - _connectTimer / DOCK_CONNECT_SECS) * 100);
      const bw  = W * 0.4, bx = (W - bw) / 2, by = DY - 24;
      const p2  = 0.7 + 0.3 * Math.sin(Date.now() * 0.008);
      oc.fillStyle = 'rgba(0,40,20,0.92)'; oc.fillRect(bx, by, bw, 20);
      oc.fillStyle = '#00ffaa'; oc.fillRect(bx, by, bw * (pct/100), 20);
      oc.font = 'bold 9px Orbitron, sans-serif'; oc.fillStyle = '#001a10';
      oc.textAlign = 'center';
      oc.fillText(`DOCKED — REFUELING ${pct}%`, W/2, by + 14);
    }

    // ── Subspace message flash ──
    if (_msgTimer > 0) {
      _msgTimer -= (1/60); // approx per-frame decay (60fps)
      const fade = Math.min(1, _msgTimer);
      const panW = Math.min(560, W * 0.58);
      const panX = (W - panW) / 2;
      const panH = 62;
      const panY = DY - panH - 6;
      oc.fillStyle = `rgba(0,6,22,${0.88 * fade})`;
      oc.fillRect(panX, panY, panW, panH);
      oc.strokeStyle = `rgba(0,180,255,${0.5 * fade})`;
      oc.lineWidth = 1;
      oc.strokeRect(panX, panY, panW, panH);
      oc.globalAlpha = 1;
      oc.font = 'bold 13px Share Tech Mono, monospace';
      oc.textAlign = 'left';
      oc.fillStyle = 'rgba(0,229,255,0.95)';
      oc.fillText(_msgFrom + ': (' + _msgClock + ')', panX + 12, panY + 22);
      // Line 2: message
      oc.font = '13px Share Tech Mono, monospace';
      oc.fillStyle = `rgba(255,255,255,${fade})`;
      oc.fillText(_msgText, panX + 12, panY + 46);
    }

    // ========================= DASHBOARD =========================
    const alertBorder = _systems.S <= 0;
    oc.fillStyle = 'rgba(0,4,18,0.97)'; oc.fillRect(0, DY, W, DH);
    oc.strokeStyle = alertBorder ? 'rgba(255,200,0,0.5)' : 'rgba(0,180,255,0.35)';
    oc.lineWidth = 1;
    oc.beginPath(); oc.moveTo(0, DY); oc.lineTo(W, DY); oc.stroke();

    // Contact column backgrounds (drawn before scope so scope renders on top)
    const colBg  = 'rgba(0,2,14,0.95)';
    const colBdr = alertBorder ? 'rgba(255,200,0,0.40)' : 'rgba(0,80,180,0.55)';
    oc.fillStyle = colBg; oc.fillRect(col1X, DY, colW, DH);
    oc.fillRect(col2X, DY, colW, DH);
    oc.strokeStyle = colBdr; oc.lineWidth = 1;
    oc.strokeRect(col1X, DY, colW, DH);
    oc.strokeRect(col2X, DY, colW, DH);
    oc.textAlign = 'left';

    const lbC  = alertBorder ? 'rgba(255,200,0,0.90)' : 'rgba(0,200,255,0.80)';
    const valC = alertBorder ? '#ffdd00' : '#00e5ff';

    // Zone widths — fit into indicator area left of contact columns
    const indicW = col1X - 4;
    const Z1W = Math.floor(indicW * 0.28);  const Z1X = 0;
    const Z2W = Math.floor(indicW * 0.40);  const Z2X = Z1W + 1;
    const Z3W = Math.floor(indicW * 0.21);  const Z3X = Z2X + Z2W + 1;
    const Z4W = Math.floor(indicW * 0.11);  const Z4X = Z3X + Z3W + 1;

    // Zone dividers
    oc.strokeStyle = 'rgba(0,80,130,0.5)'; oc.lineWidth = 1;
    [Z2X, Z3X, Z4X].forEach(zx => {
      oc.beginPath(); oc.moveTo(zx, DY+4); oc.lineTo(zx, DY+DH-4); oc.stroke();
    });

    // Common bar extents
    const barTop = DY + 14;
    const barH   = DH - 20;  // bars fill most of dashboard; labels land at DY+(DH-6)
    const barBot = barTop + barH;

    function _lbl(text, x, y, align, col, sz) {
      oc.font = `${sz||7}px Share Tech Mono, monospace`;
      oc.fillStyle = col || lbC;
      oc.textAlign = align || 'center';
      oc.fillText(text, x, y);
    }
    function _vBar(val, maxV, x, y, w, h, col) {
      const v = Math.max(0, Math.min(maxV, val));
      oc.fillStyle = 'rgba(0,0,0,0.5)'; oc.fillRect(x, y, w, h);
      const fillH = h * (v / maxV);
      oc.fillStyle = col; oc.fillRect(x, y + h - fillH, w, fillH);
    }

    // ── ZONE 1: ENERGY TELEMETRY ──
    const ePct    = Math.max(0, Math.min(1, _energy / 9999));
    const eBarCol = ePct > 0.5 ? '#00e5ff' : ePct > 0.25 ? '#ffaa00' : '#ff3300';
    const eDull   = ePct > 0.5 ? 'rgba(0,80,110,0.50)' : ePct > 0.25 ? 'rgba(110,65,0,0.50)' : 'rgba(110,15,0,0.50)';

    // ── Row 1: ENERGY [====bar====] 9964  (16px, full-width row) ──
    const eLblW = 62;   // px reserved for "ENERGY" label
    const eNumW = 42;   // px reserved for 4-digit number
    const bX = Z1X + eLblW + 4,  bW = Math.max(10, Z1W - eLblW - eNumW - 12);
    const bH = 12, bY = DY + 6;
    // Label
    oc.font = '16px Share Tech Mono, monospace'; oc.fillStyle = lbC; oc.textAlign = 'left';
    oc.fillText('ENERGY', Z1X + 4, DY + 18);
    // Bar: dull empty behind, bright fill on top
    oc.fillStyle = eDull;    oc.fillRect(bX, bY, bW, bH);
    oc.fillStyle = eBarCol;  oc.fillRect(bX, bY, bW * ePct, bH);
    // Number right of bar
    oc.font = '16px Share Tech Mono, monospace'; oc.fillStyle = eBarCol; oc.textAlign = 'right';
    oc.fillText(String(Math.floor(_energy)), Z1X + Z1W - 4, DY + 18);

    // ── Rows 2-4: Three-column rate block ──
    {
      const rate1s  = _energyRate;
      const rate60s = _energyHistory.reduce((s, v) => s + v, 0) / 60;
      const rateAll = _galacticClock > 1 ? _energyTotalConsumed / _galacticClock : 0;

      const fmtRate = r => r < 0.05 ? '0.0' : r.toFixed(1);
      const fmtTTE  = r => {
        if (r <= 0) return '---';
        const t = Math.floor(_energy / r);
        if (t > 3600) return '>1hr';
        if (t > 60)   return `${Math.floor(t / 60)}m`;
        return `${t}s`;
      };
      const tteColor = r => {
        if (r <= 0) return valC;
        const t = _energy / r;
        return t < 120 ? '#ff3300' : t < 300 ? '#ffaa00' : valC;
      };

      // Column geometry
      const cW   = Math.floor(Z1W / 3);
      const c1Cx = Z1X + Math.floor(cW / 2);
      const c2Cx = Z1X + cW + Math.floor(cW / 2);
      const c3Cx = Z1X + cW * 2 + Math.floor(cW / 2);
      const divX1 = Z1X + cW, divX2 = Z1X + cW * 2;

      // Vertical dividers spanning all three data rows
      oc.strokeStyle = 'rgba(0,100,160,0.45)'; oc.lineWidth = 1;
      oc.beginPath();
      oc.moveTo(divX1, DY + 22); oc.lineTo(divX1, DY + 56);
      oc.moveTo(divX2, DY + 22); oc.lineTo(divX2, DY + 56);
      oc.stroke();

      // Row 2: column headers (SECOND / MINUTE / ALL)
      _lbl('SECOND', c1Cx, DY + 30, 'center', lbC,    10);
      _lbl('MINUTE', c2Cx, DY + 30, 'center', lbC,    10);
      _lbl('ALL',    c3Cx, DY + 30, 'center', lbC,    10);

      // Row 3: rate values  "2.3 /s"
      _lbl(`${fmtRate(rate1s)} /s`,  c1Cx, DY + 42, 'center', eBarCol, 12);
      _lbl(`${fmtRate(rate60s)} /s`, c2Cx, DY + 42, 'center', eBarCol, 12);
      _lbl(`${fmtRate(rateAll)} /s`, c3Cx, DY + 42, 'center', eBarCol, 12);

      // Row 4: TTE values  "72m TTE"
      _lbl(`${fmtTTE(rate1s)} TTE`,  c1Cx, DY + 54, 'center', tteColor(rate1s),  12);
      _lbl(`${fmtTTE(rate60s)} TTE`, c2Cx, DY + 54, 'center', tteColor(rate60s), 12);
      _lbl(`${fmtTTE(rateAll)} TTE`, c3Cx, DY + 54, 'center', tteColor(rateAll), 12);
    }

    // ── 60-second sparkline — FIXED scale (200 E/s ceiling) ──
    {
      const gX = Z1X + 4, gY = DY + 59, gW = Z1W - 8, gH = 26;
      const GRAPH_MAX = 200;
      const logMaxE   = Math.log1p(GRAPH_MAX);
      oc.fillStyle = 'rgba(0,0,0,0.40)'; oc.fillRect(gX, gY, gW, gH);
      for (let i = 0; i < 60; i++) {
        const val = _energyHistory[(_energyHistIdx - 60 + i + 60) % 60];
        if (val <= 0) continue;
        const logFrac = Math.min(1, Math.log1p(val) / logMaxE);
        const bh  = Math.max(1, Math.round(logFrac * gH));
        const bx  = gX + Math.round(i * gW / 60);
        const bw2 = Math.round((i + 1) * gW / 60) - Math.round(i * gW / 60);
        oc.fillStyle = logFrac < 0.33 ? '#00cc55' : logFrac < 0.67 ? '#ffaa00' : '#ff3300';
        oc.fillRect(bx, gY + gH - bh, bw2, bh);
      }
    }

    // ── Bottom row: TOTAL ENERGY and CLOCK on same line (12px) ──
    {
      const tc = Math.floor(_galacticClock);
      const hh = Math.floor(tc / 3600);
      const mm = Math.floor((tc % 3600) / 60);
      const ss = tc % 60;
      const clockStr = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
      _lbl(`TOTAL ENERGY: ${Math.floor(_energyTotalConsumed)}`, Z1X + 4,        DY + 98, 'left',  valC, 12);
      _lbl(`CLOCK: ${clockStr}`,                                Z1X + Z1W - 4,  DY + 98, 'right', valC, 12);
    }


    // ── ZONE 2: CANNONS ──
    const CC = GameConfig.cannons;

    // Header row: AMMO count snug after label, COOLING: pushed right
    const ammoStr = String(_torpedoCount).padStart(3, '0');
    oc.font = '20px Share Tech Mono, monospace'; oc.fillStyle = lbC; oc.textAlign = 'left';
    oc.fillText('AMMO:', Z2X + 4, DY + 22);
    const ammoLblW = oc.measureText('AMMO: ').width;   // measure with same font before switching
    oc.font = 'bold 20px Share Tech Mono, monospace';
    oc.fillStyle = _torpedoCount > 10 ? valC : _torpedoCount > 0 ? '#ffaa00' : '#ff3300';
    oc.fillText(ammoStr, Z2X + 4 + ammoLblW, DY + 22);
    const coolV   = _cannonCoolingRate;
    const coolCol = coolV > 60 ? '#00ccff' : coolV > 30 ? '#ffaa00' : '#ff4400';
    oc.font = '16px Share Tech Mono, monospace'; oc.fillStyle = lbC; oc.textAlign = 'left';
    oc.fillText('COOLING:', Z2X + 160, DY + 22);
    const chdrBarX = Z2X + 232, chdrBarW = Math.max(0, Z2X + Z2W - chdrBarX - 4);
    const chdrBarY = DY + 10, chdrBarH = 10;
    oc.fillStyle = 'rgba(0,0,0,0.5)'; oc.fillRect(chdrBarX, chdrBarY, chdrBarW, chdrBarH);
    oc.fillStyle = coolCol; oc.fillRect(chdrBarX, chdrBarY, chdrBarW * (coolV/100), chdrBarH);

    // Three cannon sub-boxes
    const cBoxGap    = 3, cBoxMargin = 3;
    const cBoxW      = Math.floor((Z2W - cBoxMargin * 2 - cBoxGap * 2) / 3);
    const cBoxTop    = DY + 28;
    const cBoxH      = DH - 30;
    const cBoxBot    = cBoxTop + cBoxH;

    // Internal Y positions: bar labels (12px) then cannon name (16px) at bottom
    const cNameY   = cBoxBot - 4;
    const cLblY    = cNameY - 19;
    const cBarsTop = cBoxTop + 3;
    const cBarsH   = Math.max(8, cLblY - 14 - cBarsTop); // end before label text top

    [
      { c: _cannon.fL,  label: 'LEFT',  idx: 0 },
      { c: _cannon.fR,  label: 'RIGHT', idx: 1 },
      { c: _cannon.aft, label: 'AFT',   idx: 2 },
    ].forEach(({ c, label, idx }) => {
      const bx  = Z2X + cBoxMargin + idx * (cBoxW + cBoxGap);
      const bcx = bx + cBoxW / 2;
      const dead = c.hp <= 0;

      // Sub-box: red fill when dead, outline always
      if (dead) { oc.fillStyle = 'rgba(140,0,0,0.40)'; oc.fillRect(bx, cBoxTop, cBoxW, cBoxH); }
      oc.strokeStyle = dead ? 'rgba(200,30,30,0.7)' : 'rgba(0,80,130,0.6)';
      oc.lineWidth = 1; oc.strokeRect(bx, cBoxTop, cBoxW, cBoxH);

      // Cannon name at very bottom
      _lbl(label, bcx, cNameY, 'center', dead ? 'rgba(220,80,80,0.9)' : lbC, 16);

      if (dead) return;

      // Divide box into 3 equal columns; center bar and label in each column
      const thirdW = Math.floor(cBoxW / 3);
      const barW   = Math.max(6, Math.floor(thirdW * 0.45));
      const col0cx = bx + Math.floor(thirdW * 0.5);
      const col1cx = bx + thirdW + Math.floor(thirdW * 0.5);
      const col2cx = bx + thirdW * 2 + Math.floor(thirdW * 0.5);

      // CHRG bar + label (first third)
      const chgV   = c.charge;
      const chgCol = chgV >= 99 ? '#00ff88' : chgV > 40 ? '#ffdd00' : chgV > 5 ? '#ff8800' : '#333';
      _vBar(chgV, 100, col0cx - Math.floor(barW/2), cBarsTop, barW, cBarsH, chgCol);
      _lbl('CHRG', col0cx, cLblY, 'center', lbC, 12);

      // TEMP bar + label (second third)
      const tmpRaw = c.temp;
      const tmpV   = Math.min(tmpRaw, 120);
      const tmpCol = tmpRaw > CC.tempDamageAt ? '#ff0000'
                   : tmpRaw > CC.tempNoChargeAt ? '#ff4400'
                   : tmpRaw > CC.tempSlowChargeAt ? '#ff9900' : '#00cc66';
      _vBar(tmpV, 120, col1cx - Math.floor(barW/2), cBarsTop, barW, cBarsH, tmpCol);
      _lbl('TEMP', col1cx, cLblY, 'center', lbC, 12);

      // HLTH bar + label (third column) — green from bottom, red from top
      const hpFrac = Math.max(0, Math.min(1, c.hp / 100));
      const hpBX   = col2cx - Math.floor(barW/2);
      const hpRedH = Math.round((1 - hpFrac) * cBarsH);
      const hpGrnH = Math.round(hpFrac * cBarsH);
      oc.fillStyle = 'rgba(0,0,0,0.5)'; oc.fillRect(hpBX, cBarsTop, barW, cBarsH);
      if (hpGrnH > 0) { oc.fillStyle = '#00ff88'; oc.fillRect(hpBX, cBarsTop + cBarsH - hpGrnH, barW, hpGrnH); }
      if (hpRedH > 0) { oc.fillStyle = '#ff2200'; oc.fillRect(hpBX, cBarsTop, barW, hpRedH); }
      _lbl('HLTH', col2cx, cLblY, 'center', lbC, 12);
    });

    // ── ZONE 3: VELOCITY + ENGINES ──
    // Single header line: VELOCITY: 013  POWER: 5
    const hdrY = DY + 26;
    const actualVelocity = Math.round(_currentVelocity);
    const dispSpeed = actualVelocity > 999 ? '999' : String(actualVelocity).padStart(3, '0');
    oc.font = '16px Share Tech Mono, monospace'; oc.fillStyle = lbC; oc.textAlign = 'left';
    oc.fillText('VELOCITY:', Z3X + 4, hdrY);
    oc.font = 'bold 22px Orbitron, monospace';
    oc.fillStyle = actualVelocity === 0 ? 'rgba(0,180,255,0.5)' : valC; oc.textAlign = 'left';
    oc.fillText(dispSpeed, Z3X + 86, hdrY);
    oc.font = '12px Share Tech Mono, monospace'; oc.fillStyle = lbC; oc.textAlign = 'left';
    oc.fillText('POWER:', Z3X + 150, hdrY);
    oc.font = 'bold 14px Orbitron, monospace'; oc.fillStyle = valC; oc.textAlign = 'left';
    oc.fillText(String(_speed), Z3X + 196, hdrY);

    // Tri-color engine bars: height = power/9, red from top = damage, dull green = available capacity
    const eNameY   = DY + DH - 4;
    const eBarsBot = eNameY - 14;
    const eBarsTop = DY + 34;
    const eBarsH   = Math.max(10, eBarsBot - eBarsTop);
    const engW     = Math.floor((Z3W - 16) / 4);
    const powerFrac = _speed / 9;  // bar target height — power/9 always

    _engines.forEach((eng, i) => {
      const bx = Z3X + 8 + engW * i;
      const bw = engW - 4;
      const eHp    = eng.hp;
      const hpFrac = Math.max(0, Math.min(1, eHp / 100));

      const redH   = Math.round((1 - hpFrac) * eBarsH);                   // damaged (top)
      const powerH = Math.round(Math.min(hpFrac, powerFrac) * eBarsH);    // power delivered (bottom)
      const availH = eBarsH - redH;                                         // healthy zone

      // 1: dark background
      oc.fillStyle = 'rgba(0,0,0,0.5)'; oc.fillRect(bx, eBarsTop, bw, eBarsH);
      // 2: dull green — available but unused healthy capacity
      if (availH > 0) {
        oc.fillStyle = 'rgba(0,255,120,0.22)';
        oc.fillRect(bx, eBarsTop + redH, bw, availH);
      }
      // 3: bright green — power being delivered (from bottom)
      if (powerH > 0) {
        oc.fillStyle = '#00ff88';
        oc.fillRect(bx, eBarsTop + eBarsH - powerH, bw, powerH);
      }
      // 4: red — damaged zone (top, over everything)
      if (redH > 0) {
        oc.fillStyle = '#ff2200';
        oc.fillRect(bx, eBarsTop, bw, redH);
      }

      _lbl(`E${i+1}`, bx + bw/2, eNameY, 'center', lbC, 12);
    });

    // ── ZONE 4: SHIELDS ──
    _lbl('SHIELDS', Z4X + Z4W/2, DY + 15, 'center', lbC, 16);

    const shCapFrac = Math.max(0, Math.min(1, (_glitch() ? Math.random()*400 : _shieldCapacity) / 400));
    const shChgFrac = Math.max(0, Math.min(1, (_glitch() ? Math.random()*400 : _shieldCharge)    / 400));

    const shBH    = barH - 16;          // bar pixel height
    const shBY    = barTop + 6;          // top — shifted down so bottom aligns with engine bars
    const shBX    = Z4X + 6;            // x position
    const shBW    = Z4W - 12;           // full-zone single bar
    const shRedH  = Math.round((1 - shCapFrac) * shBH);   // damaged cap (top)
    const shChgH  = Math.round(shChgFrac * shBH);          // current charge (bottom)
    const shAvailH = shBH - shRedH;                        // rechargeable zone

    // 1: dark background
    oc.fillStyle = 'rgba(0,0,0,0.5)'; oc.fillRect(shBX, shBY, shBW, shBH);
    // 2: dull blue — uncharged but rechargeable capacity
    if (shAvailH > 0) {
      oc.fillStyle = 'rgba(0,60,130,0.50)';
      oc.fillRect(shBX, shBY + shRedH, shBW, shAvailH);
    }
    // 3: bright blue — current charge (from bottom up)
    if (shChgH > 0) {
      oc.fillStyle = '#00aaff';
      oc.fillRect(shBX, shBY + shBH - shChgH, shBW, shChgH);
    }
    // 4: red — damaged zone (top, drawn last)
    if (shRedH > 0) {
      oc.fillStyle = '#cc1100';
      oc.fillRect(shBX, shBY, shBW, shRedH);
    }

    // Draw contact list on top of everything (deferred — overlays dashboard)
    _postDraw();
    oc.textAlign = 'left';
  }

  // ---- LRS Overlay (L key) ----
  function _drawLRS() {
    const oc = _overlayCtx; if (!oc) return;
    const W = _overlayCanvas.width;
    const lrsSize = 180, lrsX = W - lrsSize - 14, lrsY = 14;
    const noiseAmt = _systems.L <= 0 ? 0.9 : Math.max(0, (50 - _systems.L)/50 * 0.4);

    // Background
    oc.fillStyle = 'rgba(0,6,18,0.88)';
    oc.fillRect(lrsX, lrsY, lrsSize, lrsSize);
    oc.strokeStyle = 'rgba(0,180,255,0.4)'; oc.lineWidth = 1;
    oc.strokeRect(lrsX, lrsY, lrsSize, lrsSize);

    // Label
    oc.font = '7px Orbitron, monospace'; oc.fillStyle = 'rgba(0,200,255,0.6)'; oc.textAlign = 'center';
    oc.fillText('LONG RANGE SCAN', lrsX + lrsSize/2, lrsY + 10);

    // Center crosshair (player)
    const cX = lrsX + lrsSize/2, cY = lrsY + lrsSize/2;
    oc.strokeStyle = 'rgba(0,255,200,0.5)'; oc.lineWidth = 1;
    oc.beginPath(); oc.moveTo(cX-6, cY); oc.lineTo(cX+6, cY); oc.moveTo(cX, cY-6); oc.lineTo(cX, cY+6); oc.stroke();

    // Zylon dots
    const scale = lrsSize / (SECTOR_R * 2);
    for (const z of _zylons) {
      if (z.dead) continue;
      const dp = z.position.clone().sub(_camera.position);
      const dx = cX + dp.x * scale;
      const dy = cY + dp.z * scale;
      if (_glitch && _systems.L < 50 && Math.random() < 0.3) continue; // drop dots when damaged
      oc.fillStyle = '#ff4400';
      oc.beginPath(); oc.arc(dx, dy, 3, 0, Math.PI*2); oc.fill();
    }

    // Noise overlay
    if (noiseAmt > 0) {
      const pixels = Math.floor(lrsSize * lrsSize * noiseAmt);
      oc.fillStyle = 'rgba(0,200,255,0.6)';
      for (let i = 0; i < pixels; i++) {
        const nx2 = lrsX + Math.random() * lrsSize;
        const ny2 = lrsY + Math.random() * lrsSize;
        oc.fillRect(nx2, ny2, 1, 1);
      }
    }
    oc.textAlign = 'left';
  }

  // ---- Overlay ----
  function _mkOverlay() {
    // Use parent container (= #combat-view = game-wrapper size) for true canvas dimensions
    const par = _canvas?.parentElement || document.body;
    const W   = par.offsetWidth  || 1280;
    const H   = par.offsetHeight || 720;
    if (!_overlayCanvas) {
      _overlayCanvas = document.createElement('canvas');
      // width/height:100% ensures CSS stretches to fill parent even if attribute lags
      _overlayCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:10;';
      _overlayCtx = _overlayCanvas.getContext('2d');
    }
    _overlayCanvas.width = W; _overlayCanvas.height = H;
    par.appendChild(_overlayCanvas);
  }
  function _rmOverlay() {
    if (_overlayCanvas?.parentElement) _overlayCanvas.parentElement.removeChild(_overlayCanvas);
  }

  // ---- HUD hint update ----
  // (sector name + G hint drawn in _drawHUD)

  let _warpDecelTimer = 0;  // kept for compat — actual decel uses _warpMult

  // ---- Public ----
  function enter({ canvas, sector, arrivalOffset = null, arrivalSpeed = 0, arrivalVelocity, throttleSpeed, onExit, onMapToggle, seekerGalaxyRefs = [], warriorGalaxyRefs = [] }) {
    if (_running) return;
    _canvas       = canvas;
    _onExit       = onExit;
    _onMapToggle  = onMapToggle;
    _speed           = (typeof throttleSpeed === 'number') ? throttleSpeed : (arrivalSpeed || 0);
    _currentVelocity = (typeof arrivalVelocity === 'number') ? arrivalVelocity : 0;
    _warpCharging    = false; _warpChargeCallback = null;
    _warpBursting    = false; _warpBurstCallback  = null;
    _warpDebursting  = (typeof arrivalVelocity === 'number' && arrivalVelocity >= 999);
    _warpMult        = 1.0;
    _cameraQuat.identity(); // reset ship orientation to forward-facing
    _mnx         = 0; _mny   = 0;
    _nearSB      = false;
    _entryTimer  = 3.5;
    _running     = true;
    _dockState      = 'idle';
    _starbaseLocked = false;
    _connectTimer   = 0;
    if (_plugMesh) _plugMesh.visible = false;
    _hitFlash    = 0;
    _asteroids   = [];
    // NOTE: _energy persists across warps — only refilled on dock
    // NOTE: _kills suspended until Zylons are added
    _targets     = 0;
    _shieldsOn   = true;
    _computerOn  = true;
    _rearView    = false;
    _lrsOn       = false;
    _redAlert    = false;
    _inputBound  = false;
    _fireFlash   = 0;
    _fRPending   = 0;
    _targetLocked = false;
    _zylons      = [];
    _torpedoes   = [];
    _cargoShips     = [];
    _allSupplyShips  = sector?.allSupplyShips || [];
    _cargoDrones     = [];
    _sbShieldMeshes     = [];
    _sbShieldFlash      = 0;
    _sbShieldDmgCooldown = 0;
    _shieldImpacts      = [];
    _explosions         = [];
    if (!_cannon)   _resetCannons();     // first entry only — damage persists across warps
    if (!_systems)  _resetSystems();
    if (!_engines)  _resetEngines();
    if (!_computer) _resetComputer();
    // _warpDriveHP starts at 100 at declaration and persists; reset only on dock
    _sectorType  = sector?.type        || 'void';
    _sectorQ     = sector?.q            ?? 0;
    _sectorR     = sector?.r            ?? 0;
    _hasStarbase = !!sector?.hasStarbase;
    _currentStarbase = sector?.starbase || null;
    _sectorName  = sector?.name        || `SECTOR ${sector?.q ?? '?'},${sector?.r ?? '?'}`;

    // ── Spawn Zylon enemies ──────────────────────────────────────────────────
    // Each galaxy ZylonSeeker represents a PAIR — spawn one tie-fighter and one
    // bird silhouette per seeker count so the player always sees both models.
    // Warriors are separate galaxy objects; spawn one saucer each.
    const seekerCount  = sector?.seekerCount  ?? 0;
    const warriorCount = sector?.warriorCount ?? 0;
    const totalZylons  = seekerCount * 2 + warriorCount;
    _targets = totalZylons;
    if (totalZylons > 0 && (!_computer || _computer.scanner > 0)) _redAlert = true;

    _initThree();
    _buildScene();
    _spawnCargoShips(sector?.supplyShips || []);

    // Entry angle — deterministic per sector so the group always arrives from same direction
    const _zEntryAngle = ((_sectorQ * 3 + _sectorR * 7) % 12) * (Math.PI * 2 / 12);
    const _zEntryDist  = (GameConfig.zylon.beaconPlacementUnits ?? 750) + 200; // 950u
    const _zEntryBase  = new THREE.Vector3(
      Math.cos(_zEntryAngle) * _zEntryDist, 0, Math.sin(_zEntryAngle) * _zEntryDist);

    for (let i = 0; i < seekerCount; i++) {
      const seekerRef = seekerGalaxyRefs[i] ?? null;
      // TIE and BIRD enter with jitter around the entry point
      ['seeker_tie', 'seeker_bird'].forEach(type => {
        const jAngle   = Math.random() * Math.PI * 2;
        const jitter   = 30 + Math.random() * 50;
        const spawnPos = _zEntryBase.clone().addScaledVector(
          new THREE.Vector3(Math.cos(jAngle), 0, Math.sin(jAngle)), jitter);
        const ship = new ZylonShip(_scene, spawnPos, type);
        if (seekerRef) ship.setGalaxyRef(seekerRef);
        _zylons.push(ship);
      });
      // BEACON ship starts at its orbit position (750u) along the entry angle
      const BEACON_DIST  = GameConfig.zylon.beaconPlacementUnits ?? 750;
      const beaconStart  = new THREE.Vector3(
        Math.cos(_zEntryAngle) * BEACON_DIST, 0, Math.sin(_zEntryAngle) * BEACON_DIST);
      const beaconShip   = new ZylonShip(_scene, beaconStart, 'seeker_beacon');
      if (seekerRef) beaconShip.setGalaxyRef(seekerRef);
      _zylons.push(beaconShip);
    }
    // Warriors at sector entry come from galaxy ZylonWarriors in ASSAULTING/COMBAT state.
    // Spawn each at its real approach distance so the player sees them in the right place.
    for (let i = 0; i < warriorCount; i++) {
      const wRef = warriorGalaxyRefs[i] ?? null;
      const dist = wRef?._distToStarbase ?? 200;
      let wSpawn;
      if (dist <= 200) {
        // Already at orbit — place at random angle on the 200u orbit circle
        const orbAngle = Math.random() * Math.PI * 2;
        wSpawn = new THREE.Vector3(Math.cos(orbAngle) * 200, 0, Math.sin(orbAngle) * 200);
      } else {
        // Still approaching — place at current distance along entry angle with jitter
        const jAngle = Math.random() * Math.PI * 2;
        const jitter = 30 + Math.random() * 50;
        wSpawn = new THREE.Vector3(
          Math.cos(_zEntryAngle) * dist, 0, Math.sin(_zEntryAngle) * dist
        ).addScaledVector(new THREE.Vector3(Math.cos(jAngle), 0, Math.sin(jAngle)), jitter);
      }
      const wShip = new ZylonShip(_scene, wSpawn, 'warrior');
      if (wRef) wShip.setGalaxyRef(wRef);
      _zylons.push(wShip);
    }

    if (totalZylons > 0 && typeof showMessage === 'function') {
      // showMessage('RED ALERT', '', `${totalZylons} ZYLON FIGHTER${totalZylons > 1 ? 'S' : ''} DETECTED`);
    }






    // Arrival position: object {x,z} from warp accuracy; null/0 = near centre
    const off = arrivalOffset && typeof arrivalOffset === 'object' ? arrivalOffset : { x: 0, z: 0 };
    // Starbase is at world origin (0,0,0). Player arrives 500 units behind it (+Z)
    // so they always enter the sector facing toward the starbase.
    // Non-starbase sectors keep the player at the sector centre (Z = 0).
    // Warp-deburst arrivals at starbase sectors add 100u of Y so the deburst
    // flight path clears the 82u shield radius before the player descends to dock.
    const PLAYER_SPAWN_Z = _hasStarbase ? 500 : 0;
    const arrivalY       = (_hasStarbase && _warpDebursting) ? 100 : 0;
    _camera.position.set(off.x ?? 0, arrivalY, PLAYER_SPAWN_Z + (off.z ?? 0));
    // When arriving from a warp burst, pre-offset so the deburst travel cancels out
    // and the player lands at the intended arrival position.
    // Deburst travels (99999 + WARP_VELOCITY) / 2 ≈ 50049 units in -Z (forward).
    // Pull back by that full distance so the ship ends up back at the intended spot.
    if (_warpDebursting) {
      const deburstTravel = (99999 + WARP_VELOCITY) * 0.5; // ~50049 units
      _camera.position.z += deburstTravel; // offset forward so deburst brings you back
    }
    _camera.rotation.set(0, 0, 0, 'YXZ');

    _mkOverlay();
    _bind();
    _lastTime = performance.now();
    _rafId    = requestAnimationFrame(_tick);
  }

  function pause() {
    if (!_running || _paused) return;
    _paused = true;
    cancelAnimationFrame(_rafId);
    _unbind();
    if (_glCanvas) _glCanvas.style.display = 'none';
    if (_overlayCanvas) _overlayCanvas.style.display = 'none';
  }

  function resume() {
    if (!_running || !_paused) return;
    _paused   = false;
    _mnx      = 0; _mny = 0;
    _lastTime = performance.now();
    if (_glCanvas) _glCanvas.style.display = '';
    if (_overlayCanvas) _overlayCanvas.style.display = '';
    _bind();
    _rafId = requestAnimationFrame(_tick);
  }

  // Hide input while keeping simulation running (galaxy map overlay mode)
  function hideView() {
    _unbind();
    _mnx = 0; _mny = 0;
    if (_glCanvas) _glCanvas.style.display = 'none';
    if (_overlayCanvas) _overlayCanvas.style.display = 'none';
  }

  // Suspend mouse+keyboard input WITHOUT hiding canvases.
  // Use this when the galaxy map floats over the sector view.
  function suspendInput() {
    _unbind();
    _mnx = 0; _mny = 0;  // stop any residual steering
  }

  // Restore input (and optionally set front/aft view direction)
  // mode: 'front' = forward view, 'aft' = rear view, undefined = restore last state
  function showView(mode) {
    if (!_running) return;
    if (mode === 'front') { _rearView = false; _computerOn = true; }
    if (mode === 'aft')   { _rearView = true;  _computerOn = true; }
    _bind();
    _mnx = 0; _mny = 0;
    if (_glCanvas) _glCanvas.style.display = '';
    if (_overlayCanvas) _overlayCanvas.style.display = '';
  }

  function exit() {
    if (!_running) return;
    _running = false; _paused = false;
    cancelAnimationFrame(_rafId);
    _unbind();
    _rmOverlay();
    if (_renderer) { _renderer.dispose(); _renderer = null; }
    if (_glCanvas?.parentElement) { _glCanvas.parentElement.removeChild(_glCanvas); _glCanvas = null; }
    _sbGroup = null; _starsMesh = null; _dustMesh = null;
    if (_plugMesh) { _plugMesh.visible = false; _plugMesh = null; }

    _torpedoes.forEach(t => _scene?.remove(t.mesh));
    _torpedoes = [];
    _zylons.forEach(z => z.detach()); // detach 3D ships — galaxy-level seeker stays alive
    _zylons = [];
    _scene = null;
    _asteroids = [];
    _cargoShips.forEach(cs => cs.mesh && _removeCargoMesh(cs.mesh));
    _cargoShips = [];
    _cargoDrones.forEach(d => d.mesh && _removeCargoMesh(d.mesh));
    _cargoDrones = [];
    _sbShieldMeshes.forEach(m => { if (m.parent) m.parent.remove(m); });
    _sbShieldMeshes = [];
    _shieldImpacts.forEach(imp => { _scene?.remove(imp.ring); _scene?.remove(imp.light); });
    _shieldImpacts = [];
    _explosions.forEach(exp => exp.parts.forEach(p => _scene?.remove(p.obj)));
    _explosions = [];
    if (_onExit) _onExit();
  }

  /** Damage a ship system externally (from Zylon hit, galaxy event, etc.)
   *  SectorView.damageSystem('P', 20) — reduces photon hp by 20
   *  SectorView.damageSystem('E', 25) — damages one engine
   */
  function damageSystem(id, amount) {
    if (!_systems || !(id in _systems)) return;
    _systems[id] = Math.max(0, _systems[id] - amount);

    if (id === 'P') {
      // P-system damage reduces all cannon health directly
      if (_cannon) {
        for (const c of Object.values(_cannon)) {
          c.hp = Math.max(0, c.hp - amount * 0.5);
        }
        if (_systems.P <= 0) {
          for (const c of Object.values(_cannon)) c.hp = 0;
        }
      }
    } else if (id === 'E') {
      // E system: damage lowest-hp engine first
      if (_engines) {
        const target = _engines.filter(e => e.hp > 0).sort((a,b) => a.hp-b.hp)[0];
        if (target) target.hp = Math.max(0, target.hp - amount * 4);
        // Sync _systems.E to average
        _systems.E = Math.round(_engines.reduce((s,e) => s+e.hp, 0) / _engines.length);
      }
    } else if (id === 'S') {
      // S system: update capacitor ceiling
      const p = _shieldParamsFromHP(_systems.S);
      _shieldCapacity    = p.cap;
      _shieldRechargeRate = p.rate;
      _shieldCharge = Math.min(_shieldCharge, _shieldCapacity);
    }
  }

  /** Spawn Zylon ships of mixed types for testing or galaxy-map triggers */
  function spawnZylons(count, forceType, galaxyRef) {
    if (!_scene || !_running) return;
    const types = ['seeker_tie', 'seeker_bird', 'warrior'];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const isBeacon = forceType === 'seeker_beacon';
      const dist  = isBeacon
        ? (GameConfig.zylon.beaconPlacementUnits ?? 750)
        : 350 + Math.random() * 400;
      const pos   = new THREE.Vector3(
        Math.cos(angle) * dist,
        (Math.random() - 0.5) * (isBeacon ? 10 : 200),
        Math.sin(angle) * dist);
      const type = forceType ?? (i % 3 === 2 ? 'warrior' : types[i % 2]);
      const ship = new ZylonShip(_scene, pos, type);
      if (galaxyRef) ship.setGalaxyRef(galaxyRef);
      _zylons.push(ship);
    }
    _targets  += count;
    _redAlert  = true;
  }

  function beginWarpBurst(onComplete) {
    _warpBursting = true;
    _warpBurstCallback = onComplete;
  }

  function beginWarpCharge(driftFactor, onComplete) {
    _warpDrift = typeof driftFactor === 'number' ? driftFactor : 0;
    _warpTargetDir.set(0, 0, -1).applyQuaternion(_cameraQuat);
    _warpChargeTimer = 0;
    _warpCharging = true;
    _warpChargeCallback = onComplete;
  }

  function drainEnergy(amount) {
    _energy = Math.max(0, _energy - amount);
  }

  function showMessage(from, stardate, text) {
    _msgFrom  = from;
    _msgClock = stardate;
    _msgText  = text;
    _msgTimer = 4.0;
  }

  function getZylonCount() { return _zylons ? _zylons.filter(z => !z.dead).length : 0; }
  function getSectorPos()  { return { q: _sectorQ, r: _sectorR }; }

  return { enter, pause, resume, hideView, showView, suspendInput, exit, damageSystem, spawnZylons, beginWarpCharge, beginWarpBurst, drainEnergy, showMessage, getZylonCount, getSectorPos,
           get galacticClock() { return _galacticClock;  },
           get systems()       { return _systems;       },
           get engines()       { return _engines;       },
           get speed()         { return _speed;         },
           get lockState()     { return _lockState;     },
           get shieldCharge()  { return _shieldCharge;  },
           get shieldCapacity(){ return _shieldCapacity;} };
})();
