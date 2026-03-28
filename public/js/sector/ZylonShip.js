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
    this._scene = scene;
    this._type  = type || 'seeker_tie';
    this._dead  = false;

    const cfg = GameConfig.zylon;

    // ── Health / shields ──
    if (this._type === 'warrior') {
      this._shieldCharge   = cfg.warriorShieldMax;
      this._shieldMax      = cfg.warriorShieldMax;
      this._shieldRegen    = cfg.warriorShieldRegenPerSec;
      this._generatorHP    = cfg.warriorGeneratorHP;
      this._generatorAlive = true;
      this._hullHP         = cfg.warriorHullHP;
    } else {
      this._hp = cfg.seekerHP;
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
    return g;
  }

  /**
   * Bird / Horseshoe: two swept arms in a V-shape with an open front,
   * inspired by the USAF eagle / Star Raiders "bird" ship.
   */
  _build_seeker_bird() {
    const g     = new THREE.Group();
    const steel = new THREE.MeshBasicMaterial({ color: 0x1a1a22 });
    const redWF = new THREE.MeshBasicMaterial({ color: 0xff2200, wireframe: true });

    // Center spine (short rod pointing forward)
    const spine = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.8, 5),
      new THREE.MeshBasicMaterial({ color: 0x222233 }));
    spine.position.set(0, 0, 2);
    g.add(spine);

    // Two swept arms radiating outward-back from centre
    const armGeo = new THREE.BoxGeometry(1, 0.7, 7);
    const angles = [-38, 38]; // degrees from forward axis
    angles.forEach(deg => {
      const rad = THREE.MathUtils.degToRad(deg);
      const arm = new THREE.Mesh(armGeo, steel.clone());
      arm.rotation.y = -rad;
      // Offset so arm root is near the centre
      arm.position.set(Math.sin(rad) * 3.5, 0, Math.cos(rad) * 3.5 - 1);
      g.add(arm);

      // Red wireframe on each arm
      const wf = new THREE.Mesh(
        new THREE.BoxGeometry(1.05, 0.75, 7.05), redWF);
      wf.rotation.copy(arm.rotation);
      wf.position.copy(arm.position);
      g.add(wf);

      // Wingtip glow
      const tipX = Math.sin(rad) * 8;
      const tipZ = Math.cos(rad) * 8 - 1;
      const l = new THREE.PointLight(0xff2200, 0.7, 20);
      l.position.set(tipX, 0, tipZ);
      g.add(l);
    });

    this._light = new THREE.PointLight(0xff2200, 0.5, 40);
    g.add(this._light);
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

    return g;
  }

  // ─────────────────────────────────── update ────────────────────────────────

  /**
   * @param {number}           dt
   * @param {THREE.Vector3}    playerPos   camera position
   * @param {number}           playerSpeed current player speed in u/s
   * @returns {{ pos, vel, isZylon } | null}  fired torpedo, or null
   */
  update(dt, playerPos, playerSpeed) {
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

    // ── Flight AI ──
    const SPEED     = cfg.zylonBaseSpeed;
    const PASS_R    = cfg.zylonPassRange;
    const CIRCLE_T  = 3.5;  // seconds to complete arc-around

    if (this._phase === 'pursue') {
      // Fly straight at player
      this._vel.copy(dirToP).multiplyScalar(SPEED);
      if (dist < PASS_R) {
        // Too close — initiate break
        this._phase = 'break';
        // Pick a random perpendicular axis to orbit around
        const perp = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5)
          .cross(dirToP).normalize();
        this._circleAxis.copy(perp.length() > 0.01 ? perp : new THREE.Vector3(0, 1, 0));
      }

    } else if (this._phase === 'break') {
      // Veer away hard, then transition to circle
      const away = dirToP.clone().negate();
      const side = this._circleAxis.clone().cross(dirToP).normalize();
      this._vel.copy(away).addScaledVector(side, 1.4).normalize().multiplyScalar(SPEED * 1.6);
      this._circleTimer += dt;
      if (this._circleTimer > 1.2) {
        this._circleTimer = 0;
        this._phase = 'circle';
      }

    } else if (this._phase === 'circle') {
      // Arc around in a wide sweep to re-approach from behind player
      this._circleTimer += dt;
      // Rotate velocity direction around circleAxis
      const angle = (Math.PI * 2 / CIRCLE_T) * dt;
      this._vel.applyAxisAngle(this._circleAxis, angle);
      if (this._vel.lengthSq() < 0.1) this._vel.set(0, 0, SPEED);
      this._vel.normalize().multiplyScalar(SPEED);
      if (this._circleTimer > CIRCLE_T) {
        this._circleTimer = 0;
        this._phase = 'pursue';
      }
    }

    pos.addScaledVector(this._vel, dt);

    // Face player
    const target = playerPos.clone();
    target.y = pos.y; // keep level for cleaner look
    if (pos.distanceTo(target) > 0.1) {
      this.mesh.lookAt(target);
    }

    // ── Firing ──
    this._fireCd -= dt;
    // Fire when facing player (within ~35° cone) and within range
    const dot = dirToP.dot(
      new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion)
    );
    if (this._fireCd <= 0 && dist < 500 && dot > 0.8) {
      this._fireCd = cfg.zylonFireCooldownMin +
        Math.random() * (cfg.zylonFireCooldownMax - cfg.zylonFireCooldownMin);
      const vel = dirToP.clone().multiplyScalar(cfg.zylonTorpedoSpeed);
      return { pos: pos.clone(), vel, isZylon: true };
    }
    return null;
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
      // Seeker: no shields — one hit kills
      this._hp = 0;
      this._dead = true;
      return true;
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

  // ─────────────────────────────────── cleanup ───────────────────────────────

  destroy() {
    if (this._scene && this.mesh) this._scene.remove(this.mesh);
    this._dead = true;
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
