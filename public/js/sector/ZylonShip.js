/**
 * ZylonShip.js — Sector-level Zylon drone enemy.
 *
 * Milestone-velocity AI (inspired by ROM):
 *  - Always moves toward player (gap close)
 *  - Sinusoidal strafe on X/Y for evasion
 *  - Fires orange torpedo when z-distance < 400 units
 *  - 3 hits to destroy
 */
class ZylonShip {
  constructor(scene, startPos) {
    this._scene  = scene;
    this._hp     = 75; // 3 hits @ 25 dmg each
    this._dead   = false;
    this._fireCd = 1.2 + Math.random() * 0.8; // stagger initial shot
    this._phase  = Math.random() * Math.PI * 2; // strafe phase offset

    // Visual: wireframe octahedron, cyan/teal
    const geo = new THREE.OctahedronGeometry(12, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ffcc, wireframe: true });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.copy(startPos);

    // Inner glow fill (darker, semi-transparent)
    const innerMat = new THREE.MeshBasicMaterial({ color: 0x003322, transparent: true, opacity: 0.35 });
    const inner    = new THREE.Mesh(geo.clone(), innerMat);
    this.mesh.add(inner);

    // Point light for local glow
    this._light = new THREE.PointLight(0x00ffaa, 1.2, 80);
    this.mesh.add(this._light);

    scene.add(this.mesh);

    this._vel = new THREE.Vector3();
  }

  /** @param {number} dt @param {THREE.Vector3} playerPos @returns {{ pos, vel } | null} torpedo if fired */
  update(dt, playerPos) {
    if (this._dead) return null;

    // Rotation (spin for visual interest)
    this.mesh.rotation.y += dt * 1.1;
    this.mesh.rotation.x += dt * 0.6;

    const pos = this.mesh.position;
    const toPlayer = playerPos.clone().sub(pos);
    const dist = toPlayer.length();
    const dir  = toPlayer.clone().normalize();

    // Gap-close: always move toward player
    const SPEED = 55; // units/sec
    this._vel.copy(dir).multiplyScalar(SPEED);

    // Sinusoidal strafe (X and Y axes)
    const t = Date.now() * 0.001;
    const strafeAmp = this._hp < 25 ? 48 : 30; // more evasive when damaged
    this._vel.x += Math.sin(t * 1.8 + this._phase) * strafeAmp;
    this._vel.y += Math.cos(t * 1.3 + this._phase + 1.0) * strafeAmp;

    pos.addScaledVector(this._vel, dt);

    // Fire
    this._fireCd -= dt;
    if (this._fireCd <= 0 && toPlayer.z < 0 && Math.abs(toPlayer.z) < 400) {
      this._fireCd = 1.8 + Math.random() * 1.2;
      // Return torpedo data for SectorView to spawn
      const torpDir = dir.clone();
      return { pos: pos.clone(), vel: torpDir.multiplyScalar(480), isZylon: true };
    }
    return null;
  }

  /** @returns {boolean} true if destroyed */
  takeDamage(amount) {
    this._hp -= amount;
    if (this._hp <= 0) {
      this._dead = true;
      return true;
    }
    // Hit flash: brighten glow
    this._light.intensity = 3.5;
    setTimeout(() => { if (this._light) this._light.intensity = 1.2; }, 120);
    return false;
  }

  destroy() {
    if (this._scene && this.mesh) this._scene.remove(this.mesh);
    this._dead = true;
  }

  get position() { return this.mesh.position; }
  get dead()     { return this._dead; }
}
