/**
 * ZylonShip.js — Sector-level Zylon enemy ships.
 *
 * Four types:
 *   seeker_tie    — TIE-fighter silhouette, no shields, multi-hit kill
 *   seeker_bird   — Horseshoe / bird silhouette, no shields, multi-hit kill
 *   seeker_beacon — The Beacon ship; orbits sector center; no weapons; stops warrior warp when killed
 *   warrior       — Flying saucer, shield + generator + hull model
 *
 * All three seeker types share the same galaxy-level ZylonSeeker reference.
 * Killing the beacon sets _isBeacon=true and calls seeker.onComponentDestroyed(true).
 * Only when all three are killed does the seeker die on the galaxy map.
 */
class ZylonShip {

  // ─────────────────────────────────── constructor ───────────────────────────

  constructor(scene, startPos, type, clanId = 0) {
    this._scene      = scene;
    this._type       = type || 'seeker_tie';
    this._clanId     = clanId;
    this._dead       = false;
    this._galaxyRef  = null;   // galaxy-level ZylonWarrior or ZylonSeeker
    this._isBeacon   = false;  // true for seeker_beacon type (affects kill callback)

    const cfg = GameConfig.zylon;

    // ── Health / shields ──
    if (this._type === 'warrior') {
      this._shieldCharge   = cfg.warriorShieldMax;
      this._shieldMax      = cfg.warriorShieldMax;
      this._shieldRegen    = cfg.warriorShieldRegenPerSec;
      this._generatorHP    = cfg.warriorGeneratorHP;
      this._generatorAlive = true;
      this._hullHP         = cfg.warriorHullHP;
      // Orbit AI
      const rMin = cfg.warriorOrbitRadiusMin ?? 100;
      const rMax = cfg.warriorOrbitRadiusMax ?? 150;
      this._worbitR     = rMin + Math.random() * (rMax - rMin);
      this._worbitAngle = Math.atan2(startPos.z, startPos.x);
      this._worbitDir   = Math.random() < 0.5 ? 1 : -1;
      this._wphase      = 'approach'; // 'approach' | 'orbit'
      this._cannonCd    = cfg.warriorFireIntervalSec ?? 5;
    } else if (this._type === 'seeker_beacon') {
      // Beacon uses the beacon shield pool
      this._hp           = cfg.beaconShieldMax ?? 400;
      this._isBeacon     = true;
      // Orbit state — initialise from start position angle
      this._bOrbitAngle  = Math.atan2(startPos.z, startPos.x);
      this._bOrbitDir    = Math.random() < 0.5 ? 1 : -1;
      this._bEvasion     = 0;  // seconds of fast-orbit evasion remaining
      this._bHitDelay    = 0;  // seconds of post-hit pause (beacon stops, then flees)

      // Random 3D orbital plane — each beacon orbits in its own tilted plane
      const _byaw   = Math.random() * Math.PI * 2;
      const _bpitch = (Math.random() - 0.5) * Math.PI * 0.7;  // ±63° max tilt
      const _bnx = Math.cos(_bpitch) * Math.sin(_byaw);
      const _bny = Math.sin(_bpitch);
      const _bnz = Math.cos(_bpitch) * Math.cos(_byaw);
      const _bnorm = new THREE.Vector3(_bnx, _bny, _bnz).normalize();
      const _bwUp  = new THREE.Vector3(0, 1, 0);
      // U = first orbit axis (perpendicular to normal via world-up cross)
      this._orbitU = Math.abs(_bny) < 0.99
        ? new THREE.Vector3().crossVectors(_bwUp, _bnorm).normalize()
        : new THREE.Vector3(1, 0, 0);
      // V = normal × U (second orbit axis, completes the right-hand frame)
      this._orbitV = new THREE.Vector3().crossVectors(_bnorm, this._orbitU).normalize();
    } else {
      // Seeker: HP pool (takes ~3 hits) + guard AI state
      this._hp        = cfg.seekerHP ?? 400;
      this._sphase    = 'guard';  // 'guard' | 'attack' | 'return' | 'patrol'
      this._sguardDir = Math.random() < 0.5 ? 1 : -1;  // orbit direction

      // ── Dogfight brain ──────────────────────────────────────────────────────
      // 25 zone-pair states × 9 joystick maneuvers = 225 weights (all start equal)
      this._dfWeights  = new Float32Array(225).fill(1.0);
      // timer starts at 999 so the very first tick immediately picks a maneuver
      this._dfManeuver = {
        pitchDir: 0, yawDir: 0, duration: 0, timer: 999,
        manIdx: 4, startState: null, startRange: 0,
        damageTaken: 0, frontFired: 0, frontHit: 0, rearFired: 0, rearHit: 0,
      };
      this._dfLog = [];   // per-session maneuver records, flushed to server on death
      // Independent front / rear cannon cooldowns
      this._frontCooldown = (cfg.dogfightFrontCoolMin ?? 2.0)
        + Math.random() * ((cfg.dogfightFrontCoolMax ?? 4.0) - (cfg.dogfightFrontCoolMin ?? 2.0));
      this._rearCooldown  = (cfg.dogfightRearCoolMin  ?? 2.5)
        + Math.random() * ((cfg.dogfightRearCoolMax  ?? 5.0) - (cfg.dogfightRearCoolMin  ?? 2.5));
      // Async weight load — ship starts with equal defaults; persisted weights override on resolve
      this._dfLoadWeights();
    }

    // ── Cannon cooldown ──
    this._fireCd = cfg.zylonFireCooldownMin +
      Math.random() * (cfg.zylonFireCooldownMax - cfg.zylonFireCooldownMin);

    // ── Flight AI state ──
    this._phase  = 'pursue';  // 'pursue' | 'break' | 'circle'
    this._circleTimer = 0;
    this._circleAxis  = new THREE.Vector3(0, 1, 0);
    this._vel = new THREE.Vector3();

    // ── Build mesh ──
    this.mesh = this['_build_' + this._type]?.() ?? this._buildFallback();
    this.mesh.position.copy(startPos);
    scene.add(this.mesh);
  }

  // ─────────────────────────────────── mesh builders ─────────────────────────

  _buildFallback() {
    const g = new THREE.Group();
    const m = new THREE.Mesh(
      new THREE.OctahedronGeometry(5, 0),
      new THREE.MeshBasicMaterial({ color: 0xff2200, wireframe: true }));
    g.add(m);
    return g;
  }

  /**
   * TIE-fighter: central cockpit sphere flanked by two flat hex wing panels
   * connected by a thin cross-rod.  Palette: dark steel body, red glow.
   */
  _build_seeker_tie() {
    const g     = new THREE.Group();
    const steel = new THREE.MeshBasicMaterial({ color: 0x1a1a22 });
    const red   = new THREE.MeshBasicMaterial({ color: 0xff2200 });
    const redWF = new THREE.MeshBasicMaterial({ color: 0xff2200, wireframe: true });

    // Cockpit sphere
    const cockpit = new THREE.Mesh(new THREE.OctahedronGeometry(2.2, 1), steel);
    g.add(cockpit);

    // Cross-rod (horizontal bar)
    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 12, 6),
      new THREE.MeshBasicMaterial({ color: 0x333344 }));
    rod.rotation.z = Math.PI / 2;
    g.add(rod);

    // Wing panels — flat hexagonal plates
    [[-7, 0, 0], [7, 0, 0]].forEach(([x]) => {
      const panel = new THREE.Mesh(
        new THREE.CylinderGeometry(3.8, 3.8, 0.35, 6),
        steel.clone());
      panel.position.set(x, 0, 0);
      panel.rotation.x = Math.PI / 2;
      g.add(panel);

      // Red wireframe overlay on each panel
      const wf = new THREE.Mesh(
        new THREE.CylinderGeometry(3.85, 3.85, 0.36, 6),
        redWF);
      wf.position.copy(panel.position);
      wf.rotation.copy(panel.rotation);
      g.add(wf);
    });

    // Red point light glows near wing-tips
    [-8, 8].forEach(x => {
      const l = new THREE.PointLight(0xff2200, 0.8, 22);
      l.position.set(x, 0, 0);
      g.add(l);
    });

    this._light = new THREE.PointLight(0xff2200, 0.5, 40);
    g.add(this._light);
    this._addClanMarkings(g);
    g.scale.set(0.5, 0.5, 0.5);  // scale down to fit 10u hitbox
    return g;
  }

  /**
   * Bird / Horseshoe: two swept arms in a V-shape with an open front,
   * inspired by the USAF eagle / Star Raiders "bird" ship.
   */
  _build_seeker_bird() {
    const g     = new THREE.Group();
    const steel = new THREE.MeshBasicMaterial({ color: 0x3a1a1a });
    const redWF = new THREE.MeshBasicMaterial({ color: 0xff2200, wireframe: true });

    // Center spine (short body pointing forward)
    const spine = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1.2, 6),
      new THREE.MeshBasicMaterial({ color: 0x331111 }));
    spine.position.set(0, 0, 2);
    g.add(spine);

    // Two swept arms radiating outward-back in a wide V
    const armGeo = new THREE.BoxGeometry(2, 1.2, 10);
    const angles = [-42, 42]; // degrees from forward axis
    angles.forEach(deg => {
      const rad = THREE.MathUtils.degToRad(deg);
      const arm = new THREE.Mesh(armGeo, steel.clone());
      arm.rotation.y = -rad;
      arm.position.set(Math.sin(rad) * 5, 0, Math.cos(rad) * 5 - 1);
      g.add(arm);

      // Red wireframe on each arm
      const wf = new THREE.Mesh(
        new THREE.BoxGeometry(2.1, 1.25, 10.1), redWF);
      wf.rotation.copy(arm.rotation);
      wf.position.copy(arm.position);
      g.add(wf);

      // Wingtip glow
      const tipX = Math.sin(rad) * 11;
      const tipZ = Math.cos(rad) * 11 - 1;
      const l = new THREE.PointLight(0xff2200, 0.9, 26);
      l.position.set(tipX, 0, tipZ);
      g.add(l);
    });

    // Red wireframe spine overlay
    const spWF = new THREE.Mesh(
      new THREE.BoxGeometry(2.1, 1.25, 6.1), redWF.clone());
    spWF.position.copy(spine.position);
    g.add(spWF);

    this._light = new THREE.PointLight(0xff2200, 0.7, 50);
    g.add(this._light);
    this._addClanMarkings(g);
    g.scale.set(0.5, 0.5, 0.5);  // scale down to fit 10u hitbox
    return g;
  }

  /**
   * Warrior saucer: wide flattened disc body + small upper dome.
   * Shield-health is reflected in the glow intensity of the shield light.
   */
  _build_warrior() {


    const g = new THREE.Group();
    const hullMat = new THREE.MeshBasicMaterial({ color: 0x141420 });
    const rimMat  = new THREE.MeshBasicMaterial({ color: 0x2a0a0a });
    const redWF   = new THREE.MeshBasicMaterial({ color: 0xff2200, wireframe: true });

    // Main disc
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(6, 5, 1.6, 16),
      hullMat);
    g.add(disc);

    // Rim band
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(5.5, 0.5, 6, 16),
      rimMat);
    rim.rotation.x = Math.PI / 2;
    g.add(rim);

    // Red wireframe "energy grid" over disc
    const discWF = new THREE.Mesh(
      new THREE.CylinderGeometry(6.05, 5.05, 1.65, 16),
      redWF);
    g.add(discWF);

    // Dome on top
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(2.8, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x200505 }));
    dome.position.y = 0.8;
    g.add(dome);

    // Shield glow light — intensity tracks shield charge
    this._shieldLight = new THREE.PointLight(0xff2200, 1.5, 60);
    g.add(this._shieldLight);
    this._light = this._shieldLight;

    this._addClanMarkings(g);
    g.scale.set(0.5, 0.5, 0.5);  // scale down to fit 10u hitbox
    return g;
  }

  // ───────────────────────────────── beacon mesh builder ─────────────────

  /** Icosahedral red beacon — identical to the legacy _buildBeaconMesh() in SectorView. */
  _build_seeker_beacon() {
    const g = new THREE.Group();
    // Dark red outer shell
    g.add(new THREE.Mesh(
      new THREE.IcosahedronGeometry(8, 0),
      new THREE.MeshBasicMaterial({ color: 0x330000 })));
    // Bright red wireframe overlay
    g.add(new THREE.Mesh(
      new THREE.IcosahedronGeometry(8.1, 0),
      new THREE.MeshBasicMaterial({ color: 0xff2200, wireframe: true })));
    // Inner glow core
    g.add(new THREE.Mesh(
      new THREE.IcosahedronGeometry(3, 0),
      new THREE.MeshBasicMaterial({ color: 0xff4400 })));
    // Lights
    this._light = new THREE.PointLight(0xff3300, 3.0, 80);
    g.add(this._light);
    g.add(new THREE.PointLight(0xff1100, 1.2, 50));
    this._addClanMarkings(g);
    // Note: beacon is NOT scaled — it lives at full size
    return g;
  }

  // ─────────────────────────────── clan markings ──────────────────────────

  /**
   * Adds subtle, dark clan-specific markings to the ship mesh group.
   * All markings use MeshBasicMaterial with very dark near-black tints —
   * invisible at engagement range, distinctive up close.
   * 8 geometric styles cycle through clan IDs 0–7 (then repeat).
   */
  _addClanMarkings(g) {
    // 8 very dark tints — barely above pure black, each with a slight hue shift
    const COLORS = [
      0x1a0000,  // 0 — dark red-black
      0x001800,  // 1 — dark green-black
      0x00001a,  // 2 — dark blue-black
      0x181800,  // 3 — dark olive-black
      0x001818,  // 4 — dark teal-black
      0x180018,  // 5 — dark purple-black
      0x120800,  // 6 — dark amber-black
      0x00081a,  // 7 — dark navy-black
    ];
    const color = COLORS[this._clanId % 8];
    const mat   = new THREE.MeshBasicMaterial({ color });
    const style = this._clanId % 8;

    switch (this._type) {
      case 'seeker_tie':    this._markTIE(g, style, mat);    break;
      case 'seeker_bird':   this._markBird(g, style, mat);   break;
      case 'warrior':       this._markWarrior(g, style, mat); break;
      case 'seeker_beacon': this._markBeacon(g, style, mat);  break;
    }
  }

  /** Clan markings for the TIE fighter — placed on the cockpit sphere. */
  _markTIE(g, style, mat) {
    const ring  = (r, tube, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 6, 16), mat);
      m.rotation.set(rx, ry, rz);
      g.add(m);
    };
    const pip = (x, y, z, r) => {
      g.add(new THREE.Mesh(new THREE.SphereGeometry(r, 4, 4), mat));
      g.children[g.children.length - 1].position.set(x, y, z);
    };
    switch (style) {
      case 0: ring(2.8, 0.18);                                                break; // equatorial ring
      case 1: ring(2.8, 0.14, 0, 0, 0); ring(2.8, 0.14, Math.PI/2);          break; // cross
      case 2: ring(2.8, 0.18, 0, 0, Math.PI/4);                              break; // diagonal
      case 3: pip(-8.5,0,0,0.45); pip(8.5,0,0,0.45);                         break; // wing pips
      case 4: ring(2.4,0.12); ring(2.4,0.12,0,0,0); g.children[g.children.length-1].position.y=0.7;
               g.children[g.children.length-2].position.y=-0.7;              break; // double band
      case 5: ring(2.8, 0.18, Math.PI/2);                                     break; // meridian
      case 6: [-0.7,0,0.7].forEach(y=>{const m=new THREE.Mesh(new THREE.TorusGeometry(2.6,0.12,6,16),mat);m.position.y=y;g.add(m);}); break; // triple
      case 7: pip(0,0,0,0.55);                                                break; // center dot
    }
  }

  /** Clan markings for the Bird — placed on the spine. */
  _markBird(g, style, mat) {
    const ring = (r, tube, rx = 0, ry = 0, rz = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 6, 16), mat);
      m.rotation.set(rx, ry, rz);
      m.position.set(0, y, z);
      g.add(m);
    };
    const pip = (x, y, z, r) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 4, 4), mat);
      m.position.set(x, y, z);
      g.add(m);
    };
    switch (style) {
      case 0: ring(1.8, 0.15, 0, 0, 0, 0, 2);                                break; // ring on spine
      case 1: ring(1.8,0.13,0,0,0,0,2); ring(1.8,0.13,Math.PI/2,0,0,0,2);  break; // cross on spine
      case 2: ring(1.8, 0.15, 0, 0, Math.PI/4, 0, 2);                       break; // diagonal
      case 3: pip(0,0,4.5,0.5); pip(0,0,-0.5,0.5);                          break; // spine pips
      case 4: ring(1.6,0.12,0,0,0,0,1); ring(1.6,0.12,0,0,0,0,3);          break; // double band
      case 5: ring(1.8, 0.15, Math.PI/2, 0, 0, 0, 2);                       break; // meridian
      case 6: [0,2,4].forEach(z=>{const m=new THREE.Mesh(new THREE.TorusGeometry(1.7,0.11,6,16),mat);m.position.z=z;g.add(m);}); break; // triple
      case 7: pip(0,0,2,0.6);                                                break; // spine dot
    }
  }

  /** Clan markings for the Warrior saucer — placed on the disc. */
  _markWarrior(g, style, mat) {
    const ring = (r, tube, rx = 0, y = 0) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 6, 20), mat);
      m.rotation.x = rx;
      m.position.y = y;
      g.add(m);
    };
    const pip = (x, y, z, r) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 4, 4), mat);
      m.position.set(x, y, z);
      g.add(m);
    };
    switch (style) {
      case 0: ring(3.5, 0.2);                                                  break; // inner ring
      case 1: ring(3.5,0.15); ring(3.5,0.15,Math.PI/2);                       break; // cross
      case 2: ring(3.5, 0.2, 0, 0); { const m=g.children[g.children.length-1]; m.rotation.z=Math.PI/4; } break;
      case 3: pip(4,1,0,0.5); pip(-4,1,0,0.5);                                break; // rim pips
      case 4: ring(2.5,0.15,0,0.9); ring(4.5,0.15,0,0.9);                    break; // double band top
      case 5: ring(3.5, 0.2, Math.PI/2);                                      break; // vertical ring
      case 6: [2.0,3.5,4.8].forEach(r=>{ const m=new THREE.Mesh(new THREE.TorusGeometry(r,0.13,6,20),mat);m.position.y=0.85;g.add(m);}); break;
      case 7: pip(0,2.5,0,0.6);                                               break; // dome pip
    }
  }

  /** Clan markings for the Beacon icosahedron (full scale — no 0.5 group scale). */
  _markBeacon(g, style, mat) {
    const ring = (r, tube, rx = 0, rz = 0) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 6, 20), mat);
      m.rotation.x = rx;
      m.rotation.z = rz;
      g.add(m);
    };
    const pip = (x, y, z, r) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 4, 4), mat);
      m.position.set(x, y, z);
      g.add(m);
    };
    switch (style) {
      case 0: ring(8.8, 0.4);                                                  break; // equatorial
      case 1: ring(8.8,0.35); ring(8.8,0.35,Math.PI/2);                       break; // cross
      case 2: ring(8.8, 0.4, 0, Math.PI/4);                                   break; // diagonal
      case 3: pip(0,9,0,0.9); pip(0,-9,0,0.9);                               break; // poles
      case 4: ring(8.5,0.3,0.5); ring(8.5,0.3,-0.5);                         break; // double band
      case 5: ring(8.8, 0.4, Math.PI/2);                                      break; // meridian
      case 6: [-0.5,0,0.5].forEach(rz=>ring(8.8,0.25,0,rz));                 break; // triple
      case 7: pip(0,0,0,1.2);                                                 break; // center pip
    }
  }

  // ─────────────────────────────────── update ────────────────────────────────

  /**
   * @param {number}           dt
   * @param {THREE.Vector3}    playerPos   camera position
   * @param {number}           playerSpeed current player speed in u/s
   * @returns {{ pos, vel, isZylon } | null}  fired torpedo, or null
   */
  update(dt, playerPos, playerSpeed, context = null) {
    if (this._dead) return null;

    const cfg      = GameConfig.zylon;
    const pos      = this.mesh.position;
    const toPlayer = playerPos.clone().sub(pos);
    const dist     = toPlayer.length();
    const dirToP   = dist > 0.01 ? toPlayer.clone().normalize() : new THREE.Vector3(0, 0, -1);

    // ── Warrior shield regen ──
    if (this._type === 'warrior' && this._generatorAlive) {
      this._shieldCharge = Math.min(
        this._shieldMax,
        this._shieldCharge + cfg.warriorShieldRegenPerSec * dt
      );
      // Update glow intensity to reflect shield charge
      if (this._shieldLight) {
        this._shieldLight.intensity = 0.5 + 1.5 * (this._shieldCharge / this._shieldMax);
      }
    }

    // Dispatcher
    if (this._type === 'warrior')       return this._updateWarrior(dt, playerPos, context);
    if (this._type === 'seeker_beacon') return this._updateBeaconShip(dt, playerPos);
    return this._updateSeeker(dt, playerPos, context);
  }

  // ─────────────────────────────── beacon ship AI ──────────────────────────

  /**
   * Beacon ship: orbits sector center at beaconPlacementUnits radius.
   * Speed increases with player proximity. Evades (reverses orbit direction) when hit.
   * Does not fire weapons.
   */
  _updateBeaconShip(dt, playerPos) {
    const cfg      = GameConfig.zylon;
    const ORBIT_R  = cfg.beaconPlacementUnits ?? 750;
    const pos      = this.mesh.position;

    // Post-hit pause: beacon stops briefly, then flees at full speed
    if (this._bHitDelay > 0) {
      this._bHitDelay -= dt;
      return null; // hold position during the stun
    }

    // Proximity-based orbit speed (evasion overrides)
    const dToPlayer = playerPos.distanceTo(pos);
    let orbitSpeed;
    if (this._bEvasion > 0) {
      this._bEvasion -= dt;
      orbitSpeed = 100; // BEACON_SPEED — full evasion orbit
    } else if (dToPlayer < 50)  { orbitSpeed = cfg.beaconSpeedTier4 ?? 65; }
    else if   (dToPlayer < 100) { orbitSpeed = cfg.beaconSpeedTier3 ?? 55; }
    else if   (dToPlayer < 150) { orbitSpeed = cfg.beaconSpeedTier2 ?? 45; }
    else if   (dToPlayer < 200) { orbitSpeed = cfg.beaconSpeedTier1 ?? 35; }
    else                        { orbitSpeed = cfg.beaconNormalSpeed ?? 25; }

    const omega = orbitSpeed / Math.max(50, ORBIT_R);
    this._bOrbitAngle += this._bOrbitDir * omega * dt;
    // Project orbit angle through the 3D orbital plane basis vectors
    const _bc = Math.cos(this._bOrbitAngle) * ORBIT_R;
    const _bs = Math.sin(this._bOrbitAngle) * ORBIT_R;
    pos.set(
      this._orbitU.x * _bc + this._orbitV.x * _bs,
      this._orbitU.y * _bc + this._orbitV.y * _bs,
      this._orbitU.z * _bc + this._orbitV.z * _bs
    );

    // Slow spin animation
    this.mesh.rotation.y += 0.5 * dt;
    this.mesh.rotation.x += 0.3 * dt;

    return null; // beacon does not fire
  }



  // ─────────────────────────────────── damage ────────────────────────────────

  /**
   * Apply damage from one player torpedo hit.
   * @param {number} amount  damage (from GameConfig.zylon.torpedoDamage)
   * @returns {boolean}      true if the ship is now destroyed
   */
  takeDamage(amount) {
    if (this._dead) return false;

    if (this._type === 'warrior') {
      return this._takeDamageWarrior(amount);
    } else if (this._type === 'seeker_beacon') {
      // Beacon uses an HP pool; hit triggers evasion
      this._hp = Math.max(0, this._hp - amount);
      // Trigger: 0.2s pause, then orbit at full evasion speed for 10s;
      // pick a brand-new random 3D orbital plane on each hit
      this._bHitDelay = 0;
      this._bEvasion  = 10;
      this._bOrbitDir = Math.random() < 0.5 ? 1 : -1;
      // Regenerate orbital plane anchored to current position — no teleport.
      // U = radial direction to beacon right now; V = random perpendicular.
      // Resetting angle to 0 means the update reconstruct exactly this position.
      const _hU = this.mesh.position.clone().normalize();
      let _hRand = new THREE.Vector3(
        Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5
      ).normalize();
      // Ensure _hRand isn't nearly parallel to _hU (cross product would degenerate)
      if (Math.abs(_hU.dot(_hRand)) > 0.95) {
        _hRand = Math.abs(_hU.y) < 0.9
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(1, 0, 0);
      }
      this._orbitU      = _hU;
      this._orbitV      = new THREE.Vector3().crossVectors(_hU, _hRand).normalize();
      this._bOrbitAngle = 0; // beacon is at the U endpoint — position preserved exactly
      if (this._light) {
        this._light.intensity = 5.0;
        setTimeout(() => { if (this._light) this._light.intensity = 3.0; }, 120);
      }
      if (this._hp <= 0) {
        this._dead = true;
        return true;
      }
      return false;
    } else {
      // seeker_tie / seeker_bird: HP pool — takes several hits to destroy
      this._hp = Math.max(0, this._hp - amount);
      // Accumulate into the active maneuver record so scoring reflects damage taken
      if (this._dfManeuver) this._dfManeuver.damageTaken += amount;
      if (this._hp <= 0) {
        this._dead = true;
        // Persist log and weights before this ship is removed from the scene
        this._dfFlushLog?.();
        this._dfSaveWeights?.();
        return true;
      }
      if (this._light) {
        this._light.intensity = 3.0;
        setTimeout(() => { if (this._light) this._light.intensity = 0.5; }, 120);
      }
      return false;
    }
  }

  _takeDamageWarrior(amount) {
    const cfg = GameConfig.zylon;

    if (this._shieldCharge > cfg.warriorShieldZone1) {
      // Zone 1: full absorption
      this._shieldCharge -= amount;
      if (this._shieldCharge < 0) this._shieldCharge = 0;
    } else if (this._shieldCharge > 0) {
      // Zone 2: 75% absorbed, 25% bleeds to generator (or hull if dead)
      const absorbed = amount * (1 - cfg.warriorShieldBleedPct);
      const bleed    = amount * cfg.warriorShieldBleedPct;
      this._shieldCharge = Math.max(0, this._shieldCharge - absorbed);
      if (this._generatorAlive) {
        this._generatorHP -= bleed;
        if (this._generatorHP <= 0) {
          this._generatorHP    = 0;
          this._generatorAlive = false;
          if (this._shieldLight) this._shieldLight.color.setHex(0x440000);
        }
      } else {
        // Generator dead — bleed goes to hull
        this._hullHP -= bleed;
      }
    } else {
      // Shield gone — full damage to hull
      this._hullHP -= amount;
    }

    // Flash
    if (this._light) {
      this._light.intensity = 4.0;
      setTimeout(() => {
        if (this._light) {
          this._light.intensity = this._type === 'warrior'
            ? 0.5 + 1.5 * (this._shieldCharge / this._shieldMax)
            : 0.5;
        }
      }, 120);
    }

    if (this._hullHP <= 0) {
      this._dead = true;
      return true;
    }
    return false;
  }

  // ─────────────────────────────────── seeker guard AI ───────────────────────

  // ─────────────────────────── dogfight brain ──────────────────────────────────

  /**
   * Classify where 'toTargetVec' sits relative to 'forwardVec' along the fore-aft axis.
   * Returns zone index 0–4:
   *   0 HOT_FRONT  dot >  0.8  — inside the forward fire cone
   *   1 FRONT_Q    dot >  0.3  — forward hemisphere, outside cone
   *   2 BEAM       dot > -0.3  — roughly perpendicular (the safe arc)
   *   3 REAR_Q     dot > -0.8  — rear hemisphere, outside aft cone
   *   4 HOT_REAR   dot ≤ -0.8  — inside the aft fire cone
   */
  _classifyZone(forwardVec, toTargetVec) {
    const d = forwardVec.dot(toTargetVec.clone().normalize());
    if (d >  0.8) return 0;
    if (d >  0.3) return 1;
    if (d > -0.3) return 2;
    if (d > -0.8) return 3;
    return 4;
  }

  /** Weighted-random pick of a maneuver index 0–8 for the given 25-cell state index. */
  _dfPickManeuver(stateIdx) {
    const start = stateIdx * 9;
    let total = 0;
    for (let i = 0; i < 9; i++) total += this._dfWeights[start + i];
    let r = Math.random() * total;
    for (let i = 0; i < 9; i++) {
      r -= this._dfWeights[start + i];
      if (r <= 0) return i;
    }
    return 8;
  }

  /**
   * Convert maneuver index 0–8 to { pitchDir, yawDir }.
   *   pitch = floor(idx/3) − 1  →  −1 (nose-down),  0 (level),    +1 (nose-up)
   *   yaw   = (idx % 3) − 1     →  −1 (nose-left),  0 (straight), +1 (nose-right)
   */
  _dfManeuverDirs(idx) {
    return { pitchDir: Math.floor(idx / 3) - 1, yawDir: (idx % 3) - 1 };
  }

  /**
   * Score the just-completed maneuver, update its weight, and push a log record.
   * Scoring signals: zone transition (myZone only), damage taken, shots fired.
   */
  _dfScore(stateIdx, manIdx, endStateIdx, endRange) {
    const lr   = GameConfig.zylon.dogfightLearnRate ?? 0.05;
    const base = stateIdx * 9 + manIdx;
    const m    = this._dfManeuver;

    // Zone transition: reward escaping HOT zones; penalise drifting into them
    const startMyZone = Math.floor(stateIdx    / 5);
    const endMyZone   = Math.floor(endStateIdx / 5);
    const wasHot = (startMyZone === 0 || startMyZone === 4);
    const isHot  = (endMyZone   === 0 || endMyZone   === 4);
    if (wasHot  && !isHot) this._dfWeights[base] += lr;
    if (!wasHot && isHot)  this._dfWeights[base] -= lr * 1.5;

    // Damage taken this maneuver
    if (m.damageTaken > 0) this._dfWeights[base] -= lr * 2;

    // Shots fired (reward using a firing opportunity)
    if (m.frontFired > 0 || m.rearFired > 0) this._dfWeights[base] += lr * 0.5;

    // Clamp
    this._dfWeights[base] = Math.max(0.01, Math.min(5.0, this._dfWeights[base]));

    // Log record — range stored for future analysis, not used in current logic
    this._dfLog.push({
      shipType:    this._type,
      maneuver:    { pitchDir: m.pitchDir, yawDir: m.yawDir, duration: m.duration },
      startState:  stateIdx,
      endState:    endStateIdx,
      startRange:  m.startRange,
      endRange,
      frontFired:  m.frontFired,
      frontHit:    m.frontHit,
      rearFired:   m.rearFired,
      rearHit:     m.rearHit,
      damageTaken: m.damageTaken,
    });
  }

  /** POST buffered maneuver records to the server then clear the local buffer. */
  _dfFlushLog() {
    if (!this._dfLog.length) return;
    const records = this._dfLog.splice(0);
    fetch('/api/zylon-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    }).catch(() => { /* non-critical */ });
  }

  /** POST current weight table to server (server merges with 90/10 smoothing). */
  _dfSaveWeights() {
    if (!this._dfWeights) return;
    fetch('/api/zylon-weights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: this._type, weights: Array.from(this._dfWeights) }),
    }).catch(() => { /* non-critical */ });
  }

  /** Fetch persisted weights from the server and apply them (non-blocking). */
  _dfLoadWeights() {
    fetch(`/api/zylon-weights/${this._type}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (Array.isArray(data) && data.length === 225) {
          this._dfWeights = new Float32Array(data);
        }
      })
      .catch(() => { /* start with equal defaults */ });
  }

  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Three-phase seeker AI:
   *   GUARD  — drift within a 50–150u proximity band around the beacon.
   *            Steer toward it when >150u, away when <50u, free-drift in band.
   *   ATTACK — joystick arc-turn dogfight brain. Fires front + rear cannons.
   *   RETURN — fly back to beacon; re-enter GUARD when within 100u.
   */
  _updateSeeker(dt, playerPos, context) {

    const cfg   = GameConfig.zylon;
    const pos   = this.mesh.position;
    const isBird       = this._type === 'seeker_bird';
    const GUARD_SPEED  = cfg.seekerGuardSpeed ?? 50;   // normal / patrol speed
    const ATTACK_SPEED = isBird ? 65 : 50;             // Bird attacks faster
    // Player-to-beacon engage thresholds (beacon-controlled mode)
    const BEACON_ENG_R = isBird ? 350 : 200;
    const G_IN   = cfg.seekerGuardInner  ?? 50;
    const G_OUT  = cfg.seekerGuardOuter  ?? 150;
    const ENG_R  = cfg.seekerEngageRadius ?? 200;  // autonomous fallback
    const BRK_R  = cfg.seekerBreakRadius  ?? 15;
    const TURN_R = (cfg.seekerTurnRate ?? 120) * Math.PI / 180 * dt;

    // Initialise drift velocity on first frame
    if (this._vel.lengthSq() < 0.001) {
      this._vel.set(Math.random() - 0.5, 0, Math.random() - 0.5)
               .normalize().multiplyScalar(GUARD_SPEED);
    }

    const beaconPos    = context?.beaconPos ?? null;
    const toPlayer     = playerPos.clone().sub(pos);
    const dist         = toPlayer.length();
    const dirToP       = dist > 0.01 ? toPlayer.clone().normalize()
                                     : new THREE.Vector3(0, 0, -1);

    // ── Beacon-dead / new-beacon state corrections ──
    if (!beaconPos) {
      // Beacon destroyed: guards have no post to defend — go right for the player
      if (this._sphase === 'guard' || this._sphase === 'return') {
        this._sphase = 'attack';
        this._phase  = 'pursue';
        this._circleTimer = 0;
      }
    } else {
      // Beacon back: leave patrol and resume guard
      if (this._sphase === 'patrol') this._sphase = 'guard';
    }

    // ── Top-level state transitions ──
    // Engage/disengage: beacon-controlled when beacon alive (player-to-beacon distance),
    // autonomous (player-to-self distance) when beacon is dead.
    const _dFromBeacon   = beaconPos ? pos.distanceTo(beaconPos) : Infinity;
    const _playerInZone  = beaconPos ? _dFromBeacon < BEACON_ENG_R : dist < ENG_R;
    const _playerOutZone = beaconPos ? _dFromBeacon > BEACON_ENG_R : dist > ENG_R;
    if ((this._sphase === 'guard' || this._sphase === 'patrol') && _playerInZone) {
      this._sphase = 'attack';
      this._phase  = 'pursue';
      this._circleTimer = 0;
    } else if (this._sphase === 'attack' && _playerOutZone) {
      this._sphase = beaconPos ? 'return' : 'patrol';
    }

    // ── GUARD ──
    if (this._sphase === 'guard') {
      if (beaconPos) {
        const dB  = pos.distanceTo(beaconPos);
        const toB = beaconPos.clone().sub(pos).normalize();
        if      (dB > G_OUT) this._steer(toB,                  GUARD_SPEED, TURN_R);
        else if (dB < G_IN)  this._steer(toB.clone().negate(), GUARD_SPEED, TURN_R);
        // in band [50–150]: free drift — no steering correction
      }
      // TIE sprints at 65 when more than 100u from beacon; Bird and in-band TIE cruise
      const _gSpd = (!isBird && beaconPos && pos.distanceTo(beaconPos) > 100) ? 65 : GUARD_SPEED;
      this._vel.normalize().multiplyScalar(_gSpd);
      pos.addScaledVector(this._vel, dt);
      const fwd = pos.clone().add(this._vel.clone().normalize());
      this.mesh.lookAt(fwd.x, pos.y, fwd.z);
      return null;
    }

    // ── RETURN ──
    if (this._sphase === 'return') {
      if (beaconPos) {
        if (pos.distanceTo(beaconPos) < 100) {
          this._sphase = 'guard';
        } else {
          const toB = beaconPos.clone().sub(pos).normalize();
          const _rSpd = (!isBird && pos.distanceTo(beaconPos) > 100) ? 65 : GUARD_SPEED;
          this._steer(toB, _rSpd, TURN_R);
          pos.addScaledVector(this._vel, dt);
          this.mesh.lookAt(beaconPos.x, pos.y, beaconPos.z);
        }
      } else {
        this._sphase = 'patrol';
      }
      return null;
    }

    // ── PATROL: orbit sector origin at 700–800u when beacon is dead ──
    if (this._sphase === 'patrol') {
      const PATROL_IN  = 700;
      const PATROL_OUT = 800;
      const dOrigin = Math.sqrt(pos.x * pos.x + pos.z * pos.z); // dist from sector center
      const radial  = new THREE.Vector3(pos.x, 0, pos.z);
      if (dOrigin > 0.1) radial.normalize();
      if (dOrigin > PATROL_OUT) {
        this._steer(radial.clone().negate(), GUARD_SPEED, TURN_R);
      } else if (dOrigin < PATROL_IN) {
        this._steer(radial, GUARD_SPEED, TURN_R);
      } else {
        const tangent = new THREE.Vector3(-radial.z, 0, radial.x).multiplyScalar(this._sguardDir);
        this._steer(tangent, GUARD_SPEED, TURN_R);
      }
      this._vel.normalize().multiplyScalar(GUARD_SPEED);
      pos.addScaledVector(this._vel, dt);
      const fwd = pos.clone().add(this._vel.clone().normalize());
      this.mesh.lookAt(fwd.x, pos.y, fwd.z);
      return null;
    }

    // ── ATTACK: joystick arc-turn dogfight brain ──────────────────────────────
    const myFwd     = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion);
    const playerFwd = context?.playerFwd ?? new THREE.Vector3(0, 0, -1);

    // Mutual zone classification → 25-cell combined state
    const myZone     = this._classifyZone(myFwd, dirToP);
    const playerZone = this._classifyZone(playerFwd, dirToP.clone().negate());
    const stateIdx   = myZone * 5 + playerZone;

    // ── Advance maneuver timer; score + pick when expired ────────────────────
    this._dfManeuver.timer += dt;
    if (this._dfManeuver.timer >= this._dfManeuver.duration) {
      if (this._dfManeuver.startState !== null) {
        this._dfScore(this._dfManeuver.startState, this._dfManeuver.manIdx, stateIdx, dist);
      }
      const newIdx = this._dfPickManeuver(stateIdx);
      const dirs   = this._dfManeuverDirs(newIdx);
      const dur    = (cfg.dogfightManeuverMin ?? 1.2)
                   + Math.random() * ((cfg.dogfightManeuverMax ?? 2.8) - (cfg.dogfightManeuverMin ?? 1.2));
      this._dfManeuver = {
        pitchDir: dirs.pitchDir, yawDir: dirs.yawDir,
        duration: dur, timer: 0,
        manIdx: newIdx, startState: stateIdx, startRange: dist,
        damageTaken: 0, frontFired: 0, frontHit: 0, rearFired: 0, rearHit: 0,
      };
    }

    // ── Execute committed arc turn (fixed-rate joystick, both axes independent) ─
    const turnRad  = (cfg.dogfightTurnRate ?? 45) * Math.PI / 180 * dt;
    const shipRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.mesh.quaternion);
    const shipUp    = new THREE.Vector3(0, 1, 0).applyQuaternion(this.mesh.quaternion);
    const m         = this._dfManeuver;
    if (m.pitchDir !== 0) this._vel.applyAxisAngle(shipRight,  m.pitchDir * turnRad);
    if (m.yawDir   !== 0) this._vel.applyAxisAngle(shipUp,    -m.yawDir   * turnRad);
    this._vel.normalize().multiplyScalar(ATTACK_SPEED);

    // ── Collision avoidance override (always active, overrides committed turn) ─
    const colR = cfg.dogfightColAvoidR ?? 30;
    if (dist < colR) {
      const awayV = dirToP.clone().negate().multiplyScalar(ATTACK_SPEED);
      this._vel.lerp(awayV, Math.min(1, (colR - dist) / colR));
      this._vel.normalize().multiplyScalar(ATTACK_SPEED);
    }

    pos.addScaledVector(this._vel, dt);

    // Ship faces its velocity direction
    const fwdTgt = pos.clone().add(this._vel.clone().normalize());
    if (pos.distanceTo(fwdTgt) > 0.01) this.mesh.lookAt(fwdTgt);

    // ── Front cannon ─────────────────────────────────────────────────────────
    this._frontCooldown -= dt;
    const frontDot = myFwd.dot(dirToP);
    if (this._frontCooldown <= 0 && dist < (cfg.dogfightFrontFireR ?? 500) && frontDot > 0.8) {
      this._frontCooldown = (cfg.dogfightFrontCoolMin ?? 2.0)
        + Math.random() * ((cfg.dogfightFrontCoolMax ?? 4.0) - (cfg.dogfightFrontCoolMin ?? 2.0));
      m.frontFired++;
      const fPos = pos.clone().addScaledVector(myFwd, 5);
      return { pos: fPos, vel: dirToP.clone().multiplyScalar(cfg.zylonTorpedoSpeed ?? 160), isZylon: true };
    }

    // ── Rear cannon ──────────────────────────────────────────────────────────
    this._rearCooldown -= dt;
    const myAft  = myFwd.clone().negate();
    const aftDot = myAft.dot(dirToP);
    if (this._rearCooldown <= 0 && dist < (cfg.dogfightRearFireR ?? 400) && aftDot > 0.8) {
      this._rearCooldown = (cfg.dogfightRearCoolMin ?? 2.5)
        + Math.random() * ((cfg.dogfightRearCoolMax ?? 5.0) - (cfg.dogfightRearCoolMin ?? 2.5));
      m.rearFired++;
      const rPos = pos.clone().addScaledVector(myAft, 5);
      return { pos: rPos, vel: dirToP.clone().multiplyScalar(cfg.zylonTorpedoSpeed ?? 160), isZylon: true };
    }

    return null;
  }

  // ─────────────────────────── steering helper ────────────────────────────────

  /**
   * Rotate this._vel toward targetDir by at most maxRad radians (this frame),
   * then set its magnitude to `speed`.  All seeker states use this so direction
   * changes are rate-limited instead of instant (organic banking turns).
   */
  _steer(targetDir, speed, maxRad) {
    const cur = this._vel.clone().normalize();
    if (cur.lengthSq() < 1e-6) {
      // No current heading — snap immediately
      this._vel.copy(targetDir).normalize().multiplyScalar(speed);
      return;
    }
    const dot   = Math.max(-1, Math.min(1, cur.dot(targetDir)));
    const angle = Math.acos(dot);
    if (angle <= maxRad) {
      // Within tolerance — snap to desired
      this._vel.copy(targetDir).normalize().multiplyScalar(speed);
      return;
    }
    // Rotate cur toward targetDir by maxRad around the perpendicular axis
    const axis = new THREE.Vector3().crossVectors(cur, targetDir);
    if (axis.lengthSq() < 1e-8) {
      // Nearly anti-parallel — pick an arbitrary perpendicular to break the deadlock
      const ref  = Math.abs(cur.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const perp = new THREE.Vector3().crossVectors(ref, cur).normalize();
      this._vel.copy(cur).applyAxisAngle(perp, maxRad).multiplyScalar(speed);
      return;
    }
    axis.normalize();
    this._vel.copy(cur).applyAxisAngle(axis, maxRad).multiplyScalar(speed);
  }

  // ─────────────────────────────────── warrior orbit AI ────────────────────

  /**
   * Two-phase warrior AI:
   *   APPROACH — fly from spawn (near beacon ~750u) straight toward the starbase (origin).
   *   ORBIT    — circle the starbase at _worbitR; fire cannon at the closest target
   *              every warriorFireIntervalSec seconds.
   *
   * Targeting is pure distance — no priority.  Starbase is only considered
   * while its shieldCharge > 0; once shields are down it is ignored.
   *
   * Returns { pos, vel, isWarriorCannon: true } when a shot is fired, else null.
   */
  _updateWarrior(dt, playerPos, context) {
    const cfg = GameConfig.zylon;
    const pos = this.mesh.position;
    const SPEED = cfg.warriorOrbitSpeed ?? 50;

    // ── APPROACH: fly toward the starbase (world origin) ──
    if (this._wphase === 'approach') {
      const distToCenter = pos.length();
      if (distToCenter <= this._worbitR + 1) {
        // Reached orbit radius — lock in angle and switch to orbit mode
        this._worbitAngle = Math.atan2(pos.z, pos.x);
        this._wphase = 'orbit';
      } else {
        // Fly toward origin, face it
        const dir = pos.clone().negate().normalize();
        pos.addScaledVector(dir, SPEED * dt);
        this.mesh.lookAt(0, 0, 0);
        return null; // no firing during approach
      }
    }

    // ── ORBIT: circle the starbase at fixed radius ──
    const omega = SPEED / this._worbitR; // rad/s for 50 u/s tangential
    this._worbitAngle += this._worbitDir * omega * dt;
    pos.set(
      Math.cos(this._worbitAngle) * this._worbitR,
      0,
      Math.sin(this._worbitAngle) * this._worbitR
    );
    // Face toward the starbase while orbiting
    this.mesh.lookAt(0, 0, 0);

    // ── Target selection: find closest entity (pure distance) ──
    let closestDist = Infinity;
    let closestPos  = null;

    // Starbase — only when its shields are still up
    if (context?.starbase && (context.starbase.shieldCharge ?? 0) > 0) {
      const d = pos.distanceTo(context.starbase.pos);
      if (d < closestDist) { closestDist = d; closestPos = context.starbase.pos.clone(); }
    }
    // Cargo ships
    for (const cs of (context?.cargoShips ?? [])) {
      const d = pos.distanceTo(cs.pos);
      if (d < closestDist) { closestDist = d; closestPos = cs.pos.clone(); }
    }
    // Service drones
    for (const dr of (context?.drones ?? [])) {
      const d = pos.distanceTo(dr.pos);
      if (d < closestDist) { closestDist = d; closestPos = dr.pos.clone(); }
    }
    // Player
    {
      const d = pos.distanceTo(playerPos);
      if (d < closestDist) { closestDist = d; closestPos = playerPos.clone(); }
    }

    // ── Fire cannon at closest target ──
    this._cannonCd -= dt;
    if (this._cannonCd <= 0 && closestPos) {
      this._cannonCd = cfg.warriorFireIntervalSec ?? 5;
      const vel = closestPos.clone().sub(pos).normalize()
                    .multiplyScalar(cfg.warriorCannonSpeed ?? 200);
      return { pos: pos.clone(), vel, isWarriorCannon: true };
    }
    return null;
  }

  // ─────────────────────────────────── cleanup ───────────────────────────────

  /** Link this 3D ship to its galaxy-level unit (ZylonWarrior or ZylonSeeker). */
  setGalaxyRef(ref) {
    this._galaxyRef = ref;
  }

  destroy() {
    if (this._scene && this.mesh) this._scene.remove(this.mesh);
    this._dead = true;
    // Notify the galaxy-level unit via the unified onComponentDestroyed pathway
    if (this._galaxyRef) {
      if (typeof this._galaxyRef.onComponentDestroyed === 'function') {
        this._galaxyRef.onComponentDestroyed(this._isBeacon ?? false);
      } else {
        // Fallback for any legacy ref that still has destroy()
        this._galaxyRef.destroy();
      }
      this._galaxyRef = null;
    }
  }

  /**
   * Remove this ship's 3D mesh from the scene WITHOUT notifying the galaxy-level unit.
   * Called when the player warps out — the seeker group stays alive on the galaxy map.
   */
  detach() {
    if (this._scene && this.mesh) this._scene.remove(this.mesh);
    this._dead = true;
    this._galaxyRef = null; // sever link silently
  }

  // ─────────────────────────────────── accessors ─────────────────────────────

  get position() { return this.mesh.position; }
  get dead()     { return this._dead; }
  get type()     { return this._type; }

  /** Shield charge 0–300 (warriors only, else 0) */
  get shieldCharge() {
    return this._type === 'warrior' ? this._shieldCharge : 0;
  }
}
