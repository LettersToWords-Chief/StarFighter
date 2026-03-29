/**
 * ZylonShip.js — Sector-level Zylon enemy ships.
 *
 * Three types:
 *   seeker_tie  — TIE-fighter silhouette, no shields, 1-hit kill
 *   seeker_bird — Horseshoe / bird silhouette, no shields, 1-hit kill
 *   warrior     — Flying saucer, shield + generator + hull model
 *
 * Warrior shield model (all values from GameConfig.zylon):
 *   shieldCharge 300 → 150 : absorbs 100% of incoming damage
 *   shieldCharge 150 → 0   : absorbs 75%, 25% bleeds to generatorHP
 *   generatorHP 100 → 0    : once depleted, regen stops permanently
 *   hullHP 185             : after shield=0 w/ no generator, 1 shot kills
 *
 * AI (Phase 1):
 *   PURSUE  — fly straight at player
 *   BREAK   — veer hard when within passRange
 *   CIRCLE  — arc around to re-enter from behind
 */
class ZylonShip {

  // ─────────────────────────────────── constructor ───────────────────────────

  constructor(scene, startPos, type) {
    this._scene      = scene;
    this._type       = type || 'seeker_tie';
    this._dead       = false;
    this._galaxyRef  = null;  // galaxy-level ZylonWarrior or ZylonSeeker

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
    } else {
      // Seeker: HP pool (takes ~3 hits) + guard AI state
      this._hp       = cfg.seekerHP ?? 400;
      this._sphase   = 'guard';  // 'guard' | 'attack' | 'return' | 'patrol'
      this._sguardDir = Math.random() < 0.5 ? 1 : -1;  // orbit direction
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

    g.scale.set(0.5, 0.5, 0.5);  // scale down to fit 10u hitbox
    return g;
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

    // ── Warrior: orbit & fire (separate state machine from seekers) ──
    if (this._type === 'warrior') return this._updateWarrior(dt, playerPos, context);

    // ── Seeker: guard / attack / return AI ──
    return this._updateSeeker(dt, playerPos, context);
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
    } else {
      // Seeker: HP pool — takes several hits to destroy
      this._hp = Math.max(0, this._hp - amount);
      if (this._hp <= 0) {
        this._dead = true;
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

  /**
   * Three-phase seeker AI:
   *   GUARD  — drift within a 50–150u proximity band around the beacon.
   *            Steer toward it when >150u, away when <50u, free-drift in band.
   *   ATTACK — fly at player; break at 15u; circle back. Fires when aligned.
   *   RETURN — fly back to beacon; re-enter GUARD when within 100u.
   */
  _updateSeeker(dt, playerPos, context) {
    const cfg   = GameConfig.zylon;
    const pos   = this.mesh.position;
    const SPEED  = cfg.seekerGuardSpeed ?? 50;
    const G_IN   = cfg.seekerGuardInner  ?? 50;
    const G_OUT  = cfg.seekerGuardOuter  ?? 150;
    const ENG_R  = cfg.seekerEngageRadius ?? 200;
    const BRK_R  = cfg.seekerBreakRadius  ?? 15;
    const TURN_R = (cfg.seekerTurnRate ?? 120) * Math.PI / 180 * dt; // max radians this frame

    // Initialise drift velocity on first frame
    if (this._vel.lengthSq() < 0.001) {
      this._vel.set(Math.random() - 0.5, 0, Math.random() - 0.5)
               .normalize().multiplyScalar(SPEED);
    }

    const beaconPos    = context?.beaconPos ?? null;
    const toPlayer     = playerPos.clone().sub(pos);
    const dist         = toPlayer.length();
    const dirToP       = dist > 0.01 ? toPlayer.clone().normalize()
                                     : new THREE.Vector3(0, 0, -1);

    // ── Beacon-dead / new-beacon state corrections ──
    if (!beaconPos) {
      // Beacon gone: guard/return have nowhere to go — enter patrol orbit
      if (this._sphase === 'guard' || this._sphase === 'return') {
        this._sphase = 'patrol';
      }
    } else {
      // New beacon arrived: leave patrol and resume guard
      if (this._sphase === 'patrol') this._sphase = 'guard';
    }

    // ── Top-level state transitions ──
    if ((this._sphase === 'guard' || this._sphase === 'patrol') && dist < ENG_R) {
      this._sphase = 'attack';
      this._phase  = 'pursue';
      this._circleTimer = 0;
    } else if (this._sphase === 'attack' && dist > ENG_R) {
      this._sphase = beaconPos ? 'return' : 'patrol';
    }

    // ── GUARD ──
    if (this._sphase === 'guard') {
      if (beaconPos) {
        const dB  = pos.distanceTo(beaconPos);
        const toB = beaconPos.clone().sub(pos).normalize();
        if      (dB > G_OUT) this._steer(toB,                  SPEED, TURN_R);
        else if (dB < G_IN)  this._steer(toB.clone().negate(), SPEED, TURN_R);
        // in band [50–150]: free drift — no steering correction
      }
      this._vel.normalize().multiplyScalar(SPEED);
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
          this._steer(toB, SPEED, TURN_R);
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
        this._steer(radial.clone().negate(), SPEED, TURN_R);
      } else if (dOrigin < PATROL_IN) {
        this._steer(radial, SPEED, TURN_R);
      } else {
        const tangent = new THREE.Vector3(-radial.z, 0, radial.x).multiplyScalar(this._sguardDir);
        this._steer(tangent, SPEED, TURN_R);
      }
      this._vel.normalize().multiplyScalar(SPEED);
      pos.addScaledVector(this._vel, dt);
      const fwd = pos.clone().add(this._vel.clone().normalize());
      this.mesh.lookAt(fwd.x, pos.y, fwd.z);
      return null;
    }

    // ── ATTACK: PURSUE → BREAK → CIRCLE ──
    if (this._phase === 'pursue') {
      this._steer(dirToP, SPEED, TURN_R);
      if (dist < BRK_R) {
        this._phase = 'break';
        const perp = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5)
          .cross(dirToP).normalize();
        this._circleAxis.copy(perp.length() > 0.01 ? perp : new THREE.Vector3(0, 1, 0));
        this._circleTimer = 0;
      }
    } else if (this._phase === 'break') {
      const away     = dirToP.clone().negate();
      const side     = this._circleAxis.clone().cross(dirToP).normalize();
      const breakDir = away.addScaledVector(side, 1.4).normalize();
      this._steer(breakDir, SPEED * 1.6, TURN_R * 2); // sharper break allowed
      this._circleTimer += dt;
      if (this._circleTimer > 1.2) { this._circleTimer = 0; this._phase = 'circle'; }
    } else if (this._phase === 'circle') {
      this._circleTimer += dt;
      this._vel.applyAxisAngle(this._circleAxis, (Math.PI * 2 / 3.5) * dt);
      if (this._vel.lengthSq() < 0.1) this._vel.set(0, 0, SPEED);
      this._vel.normalize().multiplyScalar(SPEED);
      if (this._circleTimer > 3.5) { this._circleTimer = 0; this._phase = 'pursue'; }
    }

    pos.addScaledVector(this._vel, dt);
    const lookAt = playerPos.clone(); lookAt.y = pos.y;
    if (pos.distanceTo(lookAt) > 0.1) this.mesh.lookAt(lookAt);

    // Fire when aligned
    this._fireCd -= dt;
    const dot = dirToP.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion));
    if (this._fireCd <= 0 && dist < 500 && dot > 0.8) {
      this._fireCd = (cfg.zylonFireCooldownMin ?? 1.5) +
        Math.random() * ((cfg.zylonFireCooldownMax ?? 3.0) - (cfg.zylonFireCooldownMin ?? 1.5));
      return { pos: pos.clone(), vel: dirToP.clone().multiplyScalar(cfg.zylonTorpedoSpeed ?? 160), isZylon: true };
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
    // Mark the galaxy-level unit dead so it disappears from the map
    if (this._galaxyRef) {
      this._galaxyRef.destroy();
      this._galaxyRef = null;
    }
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
