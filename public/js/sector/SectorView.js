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
  const SB_POS      = new THREE.Vector3(0, 0, -500);
  const TORPEDO_SPEED  = 600;  // units/sec
  const TORPEDO_LIFE   = 2.5;  // seconds (travels 1500 units max in sector of radius 1000)
  const TORPEDO_OFFSET = 1.0;  // horizontal spawn offset
  const TORPEDO_ENERGY = 35;
  const TORPEDO_CD     = 0.28;

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
  const _keys = new Set();

  let _sectorType = 'void', _sectorName = '', _hasStarbase = false;
  let _sectorQ = 0, _sectorR = 0;   // current sector coords — used by cargo ship system
  let _sbGroup = null, _starsMesh = null, _dustMesh = null;
  let _nearSB = false, _entryTimer = 3.5;
  let _voidObjects = [];   // translucent fragments in void sectors — recycled as camera moves

  // Dashboard stats
  let _energy  = 9999;
  let _kills   = 0;
  let _targets = 0;

  // ---- Shield Capacitor ----
  // charge  : current energy stored (0-100)
  // capacity: max ceiling (degrades with S-system hp)
  // rechargeRate: units/sec refill speed (degrades with S-system hp)
  let _shieldCharge     = 100;
  let _shieldCapacity   = 100;
  let _shieldRechargeRate = 20;

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
    _shieldCharge = 100;
    _shieldCapacity = 100;
    _shieldRechargeRate = 20;
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
    // Each engine contributes 25% of max speed range
    const w = _workingEngineCount();
    if (w >= 4) return 9;
    if (w === 3) return 7;
    if (w === 2) return 5;
    if (w === 1) return 3;
    return 1; // emergency thruster
  }

  // ---- Cannon thermal model — see GameConfig.cannons for all tuned values ----
  // Each cannon: hp (0–100), temp (0–200+), charge (0–100)
  let _cannon = null;
  let _fRPending = 0;
  let _cannonCoolingRate = 10; // updated each tick; shown on dashboard
  let _targetLocked = false;
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
    return c.hp > 25 && c.temp < GameConfig.cannons.tempFireMax && c.charge >= 99.5;
  }

  // ---- View modes ----
  let _shieldsOn    = true;
  let _computerOn   = true;
  let _rearView     = false;
  let _lrsOn        = false;
  let _inputBound   = false;
  let _redAlert     = false;

  // ---- Zylon ships ----
  let _zylons = [];  // ZylonShip instances

  // ---- Asteroids ----
  let _asteroids    = [];
  let _cargoShips   = [];
  let _allSupplyShips = [];
  let _cargoDrones  = []; // service drones flying between SB and docked cargo ships

  // ---- Docking state machine ----
  // idle → outbound → connected → returning → done → idle
  const DOCK_MIN = 100, DOCK_MAX = 105;      // valid distance range to starbase
  const DRONE_SPEED = 12;                    // units/sec for both legs
  const DOCK_CONNECT_SECS = 8;              // seconds connected while refueling
  // Camera-local attach point: lower-right as if docking with ship belly
  const PLUG_CAM_LOCAL = new THREE.Vector3(1.8, -1.2, -2.8);
  let _dockState  = 'idle'; // 'idle'|'outbound'|'connected'|'returning'|'done'
  let _plugMesh   = null;
  let _plugEndPos = new THREE.Vector3(); // world-space attach point (lower-right of view)
  let _connectTimer = 0;


  // ---- Input ----
  function _onMM(e) {
    if (!_canvas) return;
    const r     = _canvas.getBoundingClientRect();
    const DH    = 120; // dashboard height — must match _drawHUD
    const scale = r.width * 0.45;
    const viewCy = r.top + (r.height - DH) / 2; // crosshair center Y in page coords
    _mnx = Math.max(-1, Math.min(1, (e.clientX - r.left - r.width / 2) / scale));
    _mny = Math.max(-1, Math.min(1, (e.clientY - viewCy)               / scale));
  }
  function _onMD(e) {
    if (e.button === 0) { _fireFront(); } // left  = front cannon (always forward)
    if (e.button === 2) { _rearView = !_rearView; } // right = front/rear toggle
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
    if (e.code === 'Space') { e.preventDefault(); _fireAft(); } // Space = AFT cannon
  }
  function _onKU(e) { _keys.delete(e.code); }
  function _onW(e)  {
    e.preventDefault();
    _speed = Math.max(0, Math.min(9, _speed + (e.deltaY < 0 ? 1 : -1)));
  }
  function _bind() {
    if (_inputBound) return;
    _inputBound = true;
    window.addEventListener('mousemove', _onMM);
    window.addEventListener('mousedown', _onMD);
    window.addEventListener('keydown',   _onKD);
    window.addEventListener('keyup',     _onKU);
    if (_canvas) {
      _canvas.addEventListener('wheel',       _onW,  { passive: false });
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
    if (_canvas) {
      _canvas.removeEventListener('wheel',       _onW);
      _canvas.removeEventListener('contextmenu', _onCM);
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
    _renderer.setSize(W, H);
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
    if (_hasStarbase) { _buildStarbase(); _buildPlug(); }
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

  // ---- Repair & Refuel ----
  function _repairAndRefuel() {
    _resetSystems();
    _resetEngines();
    _energy = 9999;
    const p = _shieldParamsFromHP(100);
    _shieldCapacity = p.cap; _shieldRechargeRate = p.rate;
    _shieldCharge   = _shieldCapacity;
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

  // ---- Docking state machine ----
  function _updateDocking(dt) {
    if (!_hasStarbase || !_running) return;

    const distToSB  = _camera.position.distanceTo(SB_POS);
    const condDist  = distToSB >= DOCK_MIN && distToSB <= DOCK_MAX;
    const condLock  = _starbaseLocked;
    const condSpeed = _currentVelocity < 0.5;
    const condsMet  = condDist && condLock && condSpeed;

    if (_dockState === 'idle') {
      if (condsMet && _plugMesh) {
        // Compute lower-right world-space attach point from camera orientation
        _plugEndPos.copy(PLUG_CAM_LOCAL).applyMatrix4(_camera.matrixWorld);
        _plugMesh.position.copy(SB_POS);
        _plugMesh.visible = true;
        _dockState = 'outbound';
      }

    } else if (_dockState === 'outbound') {
      if (!condsMet) {
        // Conditions broken mid-flight — return to base
        _dockState = 'returning';
      } else {
        const toTarget = _plugEndPos.clone().sub(_plugMesh.position);
        if (toTarget.length() < 1) {
          _plugMesh.position.copy(_plugEndPos);
          _connectTimer = DOCK_CONNECT_SECS;
          _dockState = 'connected';
        } else {
          _plugMesh.position.addScaledVector(toTarget.normalize(), DRONE_SPEED * dt);
        }
      }

    } else if (_dockState === 'connected') {
      // Keep the plug locked to the (moving) attach point during connection
      _plugEndPos.copy(PLUG_CAM_LOCAL).applyMatrix4(_camera.matrixWorld);
      _plugMesh.position.copy(_plugEndPos);
      if (!condsMet) {
        _dockState = 'returning'; // abort
      } else {
        _connectTimer -= dt;
        if (_connectTimer <= 0) {
          _repairAndRefuel();
          _dockState = 'returning'; // head back after refuel
        }
      }

    } else if (_dockState === 'returning') {
      const toSB = SB_POS.clone().sub(_plugMesh.position);
      if (toSB.length() < 1) {
        _plugMesh.position.copy(SB_POS);
        _plugMesh.visible = false;
        _dockState = 'done';
      } else {
        _plugMesh.position.addScaledVector(toSB.normalize(), DRONE_SPEED * dt);
      }

    } else if (_dockState === 'done') {
      if (!condsMet) _dockState = 'idle'; // ready for next docking
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
    _updateTorpedoes(dt);
    _updateCannons(dt);
    _updateCargoDrones(dt);
    _updateZylons(dt);
    _updateCargoShips(dt);
    _checkAsteroidCollision();
    if (_hitFlash  > 0) _hitFlash  -= dt;
    if (_fireFlash > 0) _fireFlash -= dt;
    _renderer.render(_scene, _camera);
    _drawHUD();
    if (_lrsOn) _drawLRS();
    if (_entryTimer > 0) _entryTimer -= dt;
  }

  function _updateFlight(dt) {
    // Post-warp decel: _warpMult decays 5.0→1.0 over ~24s of dramatic deceleration
    if (_warpMult > 1.0) {
      _warpMult = Math.max(1.0, _warpMult - dt * 0.17); // 4 units over 24s
    }

    // Clamp normal speed to engine capability (not enforced during warp decel)
    const maxIdx = _maxSpeedIdx();
    if (_warpMult <= 1.0 && _speed > maxIdx) _speed = maxIdx;

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
      // Normal throttle ramping
      const targetVel = SPD_VALS[Math.min(_speed, maxIdx)];
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
    // Energy drain proportional to velocity²
    if (_energy > 0 && _currentVelocity > 0) _energy = Math.max(0, _energy - (_currentVelocity * _currentVelocity / 9801) * dt);
    // Shield recharge
    if (_shieldsOn && _shieldCapacity > 0) {
      _shieldCharge = Math.min(_shieldCapacity, _shieldCharge + _shieldRechargeRate * dt);
    }
  }

  function _updateZylons(dt) {
    if (!_zylons.length) return;
    const playerPos = _camera.position.clone();
    let anyAlive = false;
    for (let i = _zylons.length - 1; i >= 0; i--) {
      const z = _zylons[i];
      if (z.dead) { _zylons.splice(i, 1); continue; }
      anyAlive = true;
      const torp = z.update(dt, playerPos);
      if (torp) {
        // Spawn Zylon torpedo (orange)
        _spawnZylonTorpedo(torp.pos, torp.vel);
      }
    }
    if (!anyAlive && _zylons.length === 0) _redAlert = false;
  }

  function _spawnZylonTorpedo(pos, vel) {
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
    _torpedoes.push({ mesh, pos: pos.clone(), vel, life: 2.5, isZylon: true });
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
    if (_energy <= 0 || _systems.P <= 0) return;
    const c = _cannon.aft;
    if (!_cannonReady(c)) return;
    _doFire(c, 0, true);
    _energy = Math.max(0, _energy - TORPEDO_ENERGY);
  }

  // ---- Player hit handler ----
  function _applyPlayerHit(dmg) {
    _hitFlash = 0.5;
    // Shield capacitor absorbs proportionally
    const absorbed = Math.floor(dmg * (_shieldCharge / 100));
    _shieldCharge  = Math.max(0, _shieldCharge - absorbed);
    const hull = dmg - absorbed;
    if (hull <= 0) return;
    // Hull damage: S=0 → 3× to random system
    const multiplier = _systems.S <= 0 ? 3 : 1;
    const sysKeys = ['P','E','S','C','L','R'];
    const key = sysKeys[Math.floor(Math.random() * sysKeys.length)];
    damageSystem(key, hull * multiplier);
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
                  .addScaledVector(down, 0.8);
    const vel = fireDir.multiplyScalar(TORPEDO_SPEED);

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
        // Zylon torpedo → player (camera)
        if (t.pos.distanceTo(_camera.position) < 18) {
          _applyPlayerHit(25);
          hit = true;
        }
      } else {
        // Player torpedo → asteroid
        for (let j = _asteroids.length - 1; j >= 0; j--) {
          if (t.pos.distanceTo(_asteroids[j].pos) < _asteroids[j].radius + 5) {
            if (_asteroids[j].mesh) _scene.remove(_asteroids[j].mesh);
            _asteroids.splice(j, 1);
            hit = true;
            break;
          }
        }
        // Player torpedo → Zylon ships
        if (!hit) {
          for (const z of _zylons) {
            if (z.dead) continue;
            if (t.pos.distanceTo(z.position) < 22) {
              const destroyed = z.takeDamage(25);
              if (destroyed) {
                z.destroy();
                _kills++;
                _targets = Math.max(0, _targets - 1);
              }
              hit = true;
              break;
            }
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
    for (const ast of _asteroids) {
      const dist = _camera.position.distanceTo(ast.pos);
      if (dist < ast.radius + 6) {
        const pushDir = _camera.position.clone().sub(ast.pos).normalize();
        _camera.position.copy(ast.pos).addScaledVector(pushDir, ast.radius + 8);
        _applyPlayerHit(15);
        _speed = 0;
      }
    }
  }

  // ---- Cargo ship 3D presence ----
  function _buildCargoShipMesh() {
    const group = new THREE.Group();
    // Main hull — small flat freighter
    group.add(Object.assign(new THREE.Mesh(
      new THREE.BoxGeometry(3, 1, 5),
      new THREE.MeshLambertMaterial({ color: 0x445566 })
    ), { name: 'hull' }));
    // Bridge module on top/front
    const bridge = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.8, 1.8),
      new THREE.MeshLambertMaterial({ color: 0x223344 })
    );
    bridge.position.set(0, 0.9, -1.5);
    group.add(bridge);
    // Engine glow — rear
    const eng = new THREE.PointLight(0x4488ff, 1.5, 20);
    eng.position.set(0, 0, 2.5);
    eng.name = 'EngineLight';
    group.add(eng);
    // Running lights
    const port = new THREE.PointLight(0xff2222, 0.3, 8);
    port.position.set(-1.5, 0, 0);
    group.add(port);
    const stbd = new THREE.PointLight(0x22ff22, 0.3, 8);
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
          _spawnCargoDrone(cs.pos.clone()); // send drone to service this ship
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
          cs.phase = 'ready_to_depart';
          cs.pos.copy(cs.spawnPos);
        } else {
          const dir = toTarget.normalize();
          cs.pos.addScaledVector(dir, Math.min(spd * dt, dist));
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1), dir);
        }

      } else if (cs.phase === 'ready_to_depart') {
        if (ship.isDeparting) {
          cs.phase = 'pulsing'; cs.phaseTimer = SS.warpBurnTime;
          _warpBurst3D(cs.pos, 0xff8800);
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

  function _spawnCargoDrone(shipPos) {
    if (!_scene || !_hasStarbase) return;
    const mesh = _buildCargoDroneMesh();
    mesh.position.copy(SB_POS);
    _scene.add(mesh);
    _cargoDrones.push({
      mesh,
      pos:     SB_POS.clone(),
      target:  shipPos.clone(),
      state:   'flying_to',
      timer:   0,
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
    const DH = 120; // expanded dashboard height
    const DY = H - DH;
    const cx = W/2, cy = DY / 2;

    // C-system corruption factor (0=perfect, 1=totally corrupt)
    const cCorrupt = _systems.C <= 0 ? 1.0 : Math.max(0, (75 - _systems.C) / 75);
    // Helper: corrupt a value (returns true if this frame's value should glitch)
    function _glitch() { return cCorrupt > 0 && Math.random() < cCorrupt * 0.4; }
    // Helper: corrupt a bar fill (±noise proportion)
    function _corruptVal(v) { return _glitch() ? v + (Math.random()-0.5)*50 : v; }

    // Shield tint (from capacitor charge)
    if (_shieldsOn && _shieldCharge > 0) {
      const a = 0.05 + 0.08 * (_shieldCharge / 100);
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
      const alpha = _fireFlash > 0 ? 1.0 : 0.82;
      oc.strokeStyle = `rgba(0,255,200,${alpha})`; oc.lineWidth = _fireFlash > 0 ? 2 : 1.2;
      oc.beginPath();
      oc.moveTo(cx-cr*1.8, cy); oc.lineTo(cx-cr*0.4, cy);
      oc.moveTo(cx+cr*0.4, cy); oc.lineTo(cx+cr*1.8, cy);
      oc.moveTo(cx, cy-cr*1.8); oc.lineTo(cx, cy-cr*0.4);
      oc.moveTo(cx, cy+cr*0.4); oc.lineTo(cx, cy+cr*1.8);
      oc.stroke();
      const dotCol = _fireFlash > 0 ? 'rgba(255,255,255,0.95)' : 'rgba(0,255,200,0.9)';
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
        if (!z.dead) rawContacts.push({ pos: z.position, color: '#ff3300', size: 3, label: `ZY-${zyIdx++}` });
      }
      if (_hasStarbase) rawContacts.push({ pos: SB_POS.clone(), color: '#00e5ff', size: 3.5, label: 'SB' });
      for (const cs of _cargoShips) {
        rawContacts.push({ pos: cs.pos.clone(), color: '#aaff44', size: 2.5, label: 'CS' });
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

      // ---- Layout: list below scope ----
      const scopeW = 180, scopeH = 140;
      const rowH = 18, listH = contacts.length * rowH + 6;
      const scopeX  = W - scopeW - 18;
      const listY   = DY - listH - 6;
      const scopeY  = listY - scopeH - 4;
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

      // Contact dots + lock detection
      let scopeLock = 0;
      _starbaseLocked = false;
      for (const ct of contacts) {
        if (ct.dist < 0.1) continue;
        const sx2 = scopeCx + Math.max(-maxH, Math.min(maxH, ct.rDot * maxH * 1.4));
        const sy2 = scopeCy - Math.max(-maxV, Math.min(maxV, ct.uDot * maxV * 1.4));
        const dotR = Math.max(5, Math.min(15, ct.size * 3 * Math.min(1.6, 200 / Math.max(1, ct.dist))));
        if (damaged && Math.random() < 0.35) continue;
        oc.beginPath(); oc.arc(sx2, sy2, dotR, 0, Math.PI * 2);
        if (ct.fwd > 0) { oc.fillStyle = ct.color; oc.fill(); }
        else            { oc.strokeStyle = ct.color; oc.lineWidth = 1.2; oc.stroke(); }
        // Check lock: only for targets IN FRONT (fwd > 0)
        const dx = sx2 - scopeCx, dy = sy2 - scopeCy;
        if (ct.fwd > 0 && Math.abs(dx) < sibW) {
          if (Math.abs(dy) < sibH)  scopeLock = Math.max(scopeLock, 3);
          else if (dy < -sibH)      scopeLock = Math.max(scopeLock, 1);
          else if (dy >  sibH)      scopeLock = Math.max(scopeLock, 2);
        }
        // Only lock targets that are IN FRONT (ct.fwd > 0)
        if (ct.fwd > 0 && ct.label === 'SB' && Math.abs(dx) < sibW && Math.abs(dy) < sibH) {
          _starbaseLocked = true;
        }
      }
      _lockState = scopeLock;

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
      // Docking status indicator above scope
      if (_hasStarbase) {
        const dockMsgs = {
          idle:      null,
          outbound:  { text: 'DRONE EN ROUTE',   col: '#00ffee' },
          connected: { text: 'DOCKING...',        col: '#ffdd00' },
          returning: { text: 'DOCK ABORTED',      col: '#ff4400' },
          done:      { text: 'SYSTEMS RESTORED',  col: '#00ff88' },
        };
        const dm = dockMsgs[_dockState];
        // Show conditions when idle
        if (!dm && _hasStarbase) {
          const distToSB  = _camera.position.distanceTo(SB_POS);
          const condDist  = distToSB >= DOCK_MIN && distToSB <= DOCK_MAX;
          const condSpeed = _currentVelocity < 0.5;
          if (condDist && condSpeed && _starbaseLocked) {
            oc.font = 'bold 8px Share Tech Mono, monospace'; oc.fillStyle = '#ffdd00'; oc.textAlign = 'center';
            oc.fillText('DOCK READY', scopeCx, scopeY - 4);
          } else if (condDist) {
            const hints = [];
            if (!_starbaseLocked) hints.push('LOCK SB');
            if (!condSpeed)       hints.push('STOP');
            oc.font = '7px Share Tech Mono, monospace'; oc.fillStyle = 'rgba(255,200,0,0.6)'; oc.textAlign = 'center';
            oc.fillText(hints.join(' · '), scopeCx, scopeY - 4);
          }
        } else if (dm) {
          const pulse = (_dockState === 'outbound' || _dockState === 'connected')
            ? 0.6 + 0.4 * Math.sin(Date.now() * 0.008) : 1.0;
          oc.font = 'bold 8px Share Tech Mono, monospace';
          oc.fillStyle = dm.col; oc.globalAlpha = pulse; oc.textAlign = 'center';
          oc.fillText(dm.text, scopeCx, scopeY - 4);
          oc.globalAlpha = 1;
        }
      }

      // ---- Draw contact list below scope ----
      oc.fillStyle = 'rgba(0,4,16,0.80)'; oc.fillRect(scopeX, listY, scopeW, listH);
      oc.strokeStyle = bdrCol; oc.lineWidth = 1; oc.strokeRect(scopeX, listY, scopeW, listH);

      contacts.forEach((ct, i) => {
        const ry = listY + 4 + i * rowH + 9;
        const tSign = n => (n >= 0 ? '+' : '') + String(Math.abs(n)).padStart(3, '0');
        const rStr  = String(Math.round(ct.dist)).padStart(5, '0');
        if (damaged && Math.random() < 0.4) {
          oc.font = '12px Share Tech Mono, monospace'; oc.fillStyle = 'rgba(255,80,0,0.5)'; oc.textAlign = 'left';
          oc.fillText(`${ct.label}  --   ---  -----`, scopeX + 6, ry); return;
        }
        // Label in contact color
        oc.font = 'bold 12px Share Tech Mono, monospace'; oc.fillStyle = ct.color; oc.textAlign = 'left';
        oc.fillText(ct.label.padEnd(4), scopeX + 6, ry);
        // θ φ R in scope color
        oc.font = '12px Share Tech Mono, monospace'; oc.fillStyle = txtCol;
        oc.fillText(`θ${tSign(ct.theta)} φ${tSign(ct.phi)} R${rStr}`, scopeX + 50, ry);
      });

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

    // ========================= DASHBOARD =========================
    const alertBorder = _systems.S <= 0;
    oc.fillStyle = 'rgba(0,4,18,0.97)'; oc.fillRect(0, DY, W, DH);
    oc.strokeStyle = alertBorder ? 'rgba(255,200,0,0.5)' : 'rgba(0,180,255,0.35)';
    oc.lineWidth = 1;
    oc.beginPath(); oc.moveTo(0, DY); oc.lineTo(W, DY); oc.stroke();

    const lbC  = alertBorder ? 'rgba(255,200,0,0.90)' : 'rgba(0,200,255,0.80)';
    const valC = alertBorder ? '#ffdd00' : '#00e5ff';

    // Zone widths
    const Z1W = Math.floor(W * 0.12);  const Z1X = 0;
    const Z2W = Math.floor(W * 0.37);  const Z2X = Z1W + 1;
    const Z3W = Math.floor(W * 0.22);  const Z3X = Z2X + Z2W + 1;
    const Z4W = Math.floor(W * 0.15);  const Z4X = Z3X + Z3W + 1;

    // Zone dividers
    oc.strokeStyle = 'rgba(0,80,130,0.5)'; oc.lineWidth = 1;
    [Z2X, Z3X, Z4X].forEach(zx => {
      oc.beginPath(); oc.moveTo(zx, DY+4); oc.lineTo(zx, DY+DH-4); oc.stroke();
    });

    // Common bar extents
    const barTop = DY + 18;
    const barH   = DH - 32;  // ~88px
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

    // ── ZONE 1: FLIGHT ──
    _lbl('VELOCITY', Z1X + Z1W/2, DY + 11, 'center', lbC, 9);
    const actualVelocity = Math.round(_currentVelocity);
    const dispSpeed = _glitch()
      ? String(Math.floor(Math.random() * 999)).padStart(3, '0')
      : actualVelocity > 999 ? '999' : String(actualVelocity).padStart(3, '0');
    oc.font = 'bold 28px Orbitron, monospace';
    oc.fillStyle = actualVelocity === 0 ? 'rgba(0,180,255,0.4)' : valC;
    oc.textAlign = 'center';
    oc.fillText(dispSpeed, Z1X + Z1W/2, DY + 52);

    _lbl('ENERGY', Z1X + Z1W/2, DY + 62, 'center', lbC);
    const ePct    = _energy / 9999;
    const eBarCol = ePct > 0.5 ? '#00e5ff' : ePct > 0.25 ? '#ffaa00' : '#ff3300';
    const eBarX = Z1X + 8, eBarY = DY + 66, eBarW = Z1W - 16, eBarH = 10;
    oc.fillStyle = 'rgba(0,0,0,0.5)'; oc.fillRect(eBarX, eBarY, eBarW, eBarH);
    oc.fillStyle = eBarCol; oc.fillRect(eBarX, eBarY, eBarW * ePct, eBarH);
    const dispEnergy = _glitch() ? '????' : String(Math.floor(_energy)).padStart(4,'0');
    _lbl(dispEnergy, Z1X + Z1W/2, DY + 88, 'center', eBarCol, 9);
    _lbl(`K:${String(_kills).padStart(3,'0')}  T:${_targets > 0 ? String(_targets).padStart(2,'0') : '--'}`,
      Z1X + Z1W/2, DY + 105, 'center', lbC, 8);

    // ── ZONE 2: CANNONS ──
    _lbl('CANNONS', Z2X + Z2W/2, DY + 11, 'center', lbC, 9);
    const CC = GameConfig.cannons;
    const cannonDefs = [
      { c: _cannon.fL,  label: 'LEFT',  x: Z2X },
      { c: _cannon.fR,  label: 'RIGHT', x: Z2X + Math.floor(Z2W/3) },
      { c: _cannon.aft, label: 'AFT',   x: Z2X + Math.floor(Z2W/3)*2 },
    ];
    const cgW    = Math.floor(Z2W / 3);
    const bW     = 16, bGap = 12;
    const bGrpW  = bW*3 + bGap*2;

    cannonDefs.forEach(({ c, label, x }) => {
      const grpCx   = x + cgW/2;
      const bStartX = Math.floor(grpCx - bGrpW/2);
      const dead     = c.hp <= 0;
      _lbl(label, grpCx, DY + 22, 'center', dead ? 'rgba(180,50,50,0.7)' : lbC, 10);

      if (dead) {
        oc.font = '9px Orbitron, monospace'; oc.fillStyle = '#662222'; oc.textAlign = 'center';
        oc.fillText('OFFLINE', grpCx, DY + DH/2 + 6);
        return;
      }

      // CHRG bar
      const chgV   = _corruptVal(c.charge);
      const chgCol = chgV >= 99 ? '#00ff88' : chgV > 40 ? '#ffdd00' : chgV > 5 ? '#ff8800' : '#333';
      _vBar(chgV, 100, bStartX,            barTop, bW, barH - 16, chgCol);
      _lbl('CHRG', bStartX + bW/2,            barBot, 'center', lbC, 8);

      // TEMP bar (display capped at 120 for scale; anything above 100 = red zone)
      const tmpRaw = c.temp;
      const tmpV   = _corruptVal(Math.min(tmpRaw, 120));
      const tmpCol = tmpRaw > CC.tempDamageAt ? '#ff0000'
                   : tmpRaw > CC.tempNoChargeAt ? '#ff4400'
                   : tmpRaw > CC.tempSlowChargeAt ? '#ff9900' : '#00cc66';
      _vBar(tmpV, 120, bStartX + bW + bGap,  barTop, bW, barH - 16, tmpCol);
      _lbl('TEMP', bStartX + bW + bGap + bW/2, barBot, 'center', lbC, 8);

      // HLTH bar
      const hpV   = _corruptVal(c.hp);
      const hpCol = hpV > 75 ? '#00e5ff' : hpV > 25 ? '#ffaa00' : '#ff3300';
      _vBar(hpV, 100, bStartX + (bW + bGap)*2, barTop, bW, barH - 16, hpCol);
      _lbl('HLTH', bStartX + (bW+bGap)*2 + bW/2, barBot, 'center', lbC, 8);
    });

    // Shared COOLING bar at the bottom of cannon zone
    const coolV   = _glitch() ? Math.random()*100 : _cannonCoolingRate;
    const coolCol = coolV > 60 ? '#00ccff' : coolV > 30 ? '#ffaa00' : '#ff4400';
    const coolBarY = barBot + 4, coolBarH = 5;
    oc.fillStyle = 'rgba(0,0,0,0.5)'; oc.fillRect(Z2X + 6, coolBarY, Z2W - 12, coolBarH);
    oc.fillStyle = coolCol; oc.fillRect(Z2X + 6, coolBarY, (Z2W - 12) * (coolV/100), coolBarH);
    _lbl('COOLING', Z2X + Z2W/2, coolBarY + coolBarH + 9, 'center', lbC, 8);

    // ── ZONE 3: ENGINES ──
    _lbl('ENGINES', Z3X + Z3W/2, DY + 11, 'center', lbC, 9);
    _lbl('THRUST', Z3X + Z3W/2, DY + 20, 'center', lbC, 8);
    oc.font = 'bold 22px Orbitron, monospace';
    oc.fillStyle = valC; oc.textAlign = 'center';
    oc.fillText(String(_speed), Z3X + Z3W/2, DY + 42);

    const engBarH  = barH - 30, engBarTop = DY + 46;
    const engBarW  = Math.floor((Z3W - 16) / 4);
    _engines.forEach((eng, i) => {
      const ex    = Z3X + 8 + engBarW * i;
      const eHp   = _glitch() ? Math.random()*100 : eng.hp;
      const eColE = eng.hp <= 0 ? 'rgba(60,10,10,0.4)' : eHp < 25 ? '#ff3300' : eHp < 75 ? '#ffaa00' : '#00ff88';
      _vBar(eHp, 100, ex, engBarTop, engBarW - 4, engBarH, eColE);
      _lbl(`E${i+1}`, ex + (engBarW-4)/2, engBarTop + engBarH + 9, 'center', lbC, 8);
    });

    // ── ZONE 4: SHIELDS ──
    _lbl('SHIELDS', Z4X + Z4W/2, DY + 11, 'center', lbC, 9);
    const shBarW  = Math.floor((Z4W - 24) / 2);
    const shBarX1 = Z4X + 8, shBarX2 = shBarX1 + shBarW + 8;

    // HEALTH bar (shield system hp = ceiling/max charge possible)
    const shHp    = _glitch() ? Math.random()*100 : _shieldCapacity;
    const shHpCol = shHp > 75 ? '#00aaff' : shHp > 40 ? '#7766ff' : '#aa3366';
    _vBar(shHp, 100, shBarX1, barTop, shBarW, barH - 16, shHpCol);
    _lbl('HLTH', shBarX1 + shBarW/2, barBot, 'center', lbC, 8);

    // CHARGE bar (current shield energy; capped by health ceiling)
    const shChg    = _glitch() ? Math.random()*100 : _shieldCharge;
    const shChgCol = shChg > 60 ? '#00ffcc' : shChg > 30 ? '#ffaa00' : '#ff3300';
    // Background tinted by health ceiling
    const shCapH = (barH-16) * (_shieldCapacity / 100);
    oc.fillStyle = 'rgba(0,0,0,0.5)'; oc.fillRect(shBarX2, barTop, shBarW, barH-16);
    oc.fillStyle = 'rgba(0,50,100,0.35)'; oc.fillRect(shBarX2, barTop + (barH-16) - shCapH, shBarW, shCapH);
    const shChgH = (barH-16) * (shChg / 100);
    oc.fillStyle = shChgCol; oc.fillRect(shBarX2, barTop + (barH-16) - shChgH, shBarW, shChgH);
    _lbl('CHRG', shBarX2 + shBarW/2, barBot, 'center', lbC, 8);

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
    const { W, H } = _canvasSize();
    if (!_overlayCanvas) {
      _overlayCanvas = document.createElement('canvas');
      _overlayCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10;';
      _overlayCtx = _overlayCanvas.getContext('2d');
    }
    _overlayCanvas.width = W; _overlayCanvas.height = H;
    const par = _canvas.parentElement || document.body;
    par.style.position = 'relative';
    par.appendChild(_overlayCanvas);
  }
  function _rmOverlay() {
    if (_overlayCanvas?.parentElement) _overlayCanvas.parentElement.removeChild(_overlayCanvas);
  }

  // ---- HUD hint update ----
  // (sector name + G hint drawn in _drawHUD)

  let _warpDecelTimer = 0;  // kept for compat — actual decel uses _warpMult

  // ---- Public ----
  function enter({ canvas, sector, arrivalOffset = null, arrivalSpeed = 0, arrivalVelocity, throttleSpeed, onExit, onMapToggle }) {
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
    _energy      = 9999;
    _kills       = 0;
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
    _resetCannons();
    _resetSystems();
    _resetEngines();
    _sectorType  = sector?.type        || 'void';
    _sectorQ     = sector?.q            ?? 0;
    _sectorR     = sector?.r            ?? 0;
    _hasStarbase = !!sector?.hasStarbase;
    _sectorName  = sector?.name        || `SECTOR ${sector?.q ?? '?'},${sector?.r ?? '?'}`;

    // Spawn Zylon enemies if sector has them
    const zylonCount = sector?.zylons ?? 0;
    _targets = zylonCount;
    if (zylonCount > 0) _redAlert = true;

    _initThree();
    _buildScene();
    _spawnCargoShips(sector?.supplyShips || []);

    // Spawn Zylons after scene is built
    for (let i = 0; i < zylonCount; i++) {
      const angle = (i / zylonCount) * Math.PI * 2 + Math.random() * 0.5;
      const dist  = 350 + Math.random() * 400;
      const startPos = new THREE.Vector3(
        Math.cos(angle) * dist,
        (Math.random() - 0.5) * 200,
        Math.sin(angle) * dist,
      );
      _zylons.push(new ZylonShip(_scene, startPos));
    }

    // Arrival position: object {x,z} from warp accuracy; null/0 = near centre
    const off = arrivalOffset && typeof arrivalOffset === 'object' ? arrivalOffset : { x: 0, z: 0 };
    _camera.position.set(off.x ?? 0, 0, off.z ?? 0);
    // When arriving from a warp burst, pre-offset so the deburst travel cancels out
    // and the player lands at the arrivalOffset position (near centre for accurate jump).
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
    _zylons.forEach(z => z.destroy());
    _zylons = [];
    _scene = null;
    _asteroids = [];
    _cargoShips.forEach(cs => cs.mesh && _removeCargoMesh(cs.mesh));
    _cargoShips = [];
    _cargoDrones.forEach(d => d.mesh && _removeCargoMesh(d.mesh));
    _cargoDrones = [];
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

  /** Directly set Zylon count in current sector (for testing / galaxy map events) */
  function spawnZylons(count) {
    if (!_scene || !_running) return;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = 350 + Math.random() * 400;
      const pos = new THREE.Vector3(Math.cos(angle)*dist, (Math.random()-0.5)*200, Math.sin(angle)*dist);
      _zylons.push(new ZylonShip(_scene, pos));
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

  return { enter, pause, resume, hideView, showView, suspendInput, exit, damageSystem, spawnZylons, beginWarpCharge, beginWarpBurst,
           get systems()       { return _systems;       },
           get engines()       { return _engines;       },
           get speed()         { return _speed;         },
           get lockState()     { return _lockState;     },
           get shieldCharge()  { return _shieldCharge;  },
           get shieldCapacity(){ return _shieldCapacity;} };
})();
