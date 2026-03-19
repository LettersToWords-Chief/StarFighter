/**
 * main.js — Star Fighter entry point
 *
 * The game STARTS in the cockpit at the capital sector.
 * The galaxy map is an OVERLAY toggled with G.
 * F/A always close the map and return to front/aft view.
 * H warps to the locked target (or alerts if none set).
 */

(function () {
  'use strict';

  // ---- State ----
  let galaxyMap   = null;
  let playerFuel  = GameConfig.player.maxFuel;
  let _mapOpen    = false;  // map overlay hidden at startup
  let _sectorLive = false;
  const currentDifficulty = 'cadet';

  // Stardate
  let _stardate = 0;
  setInterval(() => { _stardate++; }, 1000);

  // ---- DOM refs ----
  const $galaxy  = () => document.getElementById('galaxy-view');
  const $combat  = () => document.getElementById('combat-view');

  // ---- Map overlay ----
  function openMap() {
    _mapOpen = true;
    $galaxy().classList.add('map-open');
    if (_sectorLive) SectorView.suspendInput(); // freeze ship controls, canvases stay visible
  }

  function closeMap(mode) {
    _mapOpen = false;
    $galaxy().classList.remove('map-open');
    if (_sectorLive) SectorView.showView(mode); // rebind controls, set view direction
  }

  // ---- Init ----
  function init() {
    const canvas = document.getElementById('galaxy-canvas');
    galaxyMap = new GalaxyMap(canvas, { difficulty: currentDifficulty });
    galaxyMap.getStardate = () => _stardate;

    galaxyMap.onWarpSelected = ({ from, to, fuelCost }) => {
      if (playerFuel < fuelCost) { showAlert('INSUFFICIENT FUEL'); return; }
      playerFuel = Math.max(0, playerFuel - fuelCost);
      updateHUD();
      _beginWarp(from, to);
    };

    // "◀ GALAXY MAP" button — exits the sector back to map-only mode
    document.getElementById('exit-combat').addEventListener('click', () => {
      if (_sectorLive) { _sectorLive = false; SectorView.exit(); }
      openMap();   // show map; combat-view stays display:block but sector stopped
    });

    // ---- Key handler ----
    window.addEventListener('keydown', (e) => {
      if (_mapOpen) {
        // Map is visible — F/A/G close it
        if (e.code === 'KeyF')      { closeMap('front'); return; }
        if (e.code === 'KeyA')      { closeMap('aft');   return; }
        if (e.code === 'KeyG' || e.code === 'Escape') { closeMap(); return; }
        // H from map = warp
        if (e.code === 'KeyH') {
          const t = galaxyMap.getTarget();
          if (!t) { showAlert('SELECT A WARP TARGET FIRST'); return; }
          galaxyMap._warpTo(t);
          return;
        }
      } else {
        // Cockpit is visible
        if (e.code === 'KeyG') { openMap(); return; }
        if (e.code === 'KeyH') {
          const t = galaxyMap.getTarget();
          if (!t) { showAlert('NO WARP TARGET — PRESS G TO SET ONE'); return; }
          galaxyMap._warpTo(t);
          return;
        }
      }
    });

    updateHUD();

    // Show combat canvas from the start so 3D view is always underneath
    $combat().style.display = 'block';
    // Start in cockpit at capital sector
    _enterSector({ q: 0, r: 0 });
  }

  // ---- Enter a sector without the warp tunnel ----
  function _enterSector(pos) {
    const destKey  = HexMath.key(pos.q, pos.r);
    const hexData  = galaxyMap.hexes.get(destKey);
    const starbase = galaxyMap.starbases.find(s => s.q === pos.q && s.r === pos.r);
    const sector   = {
      q:           pos.q,
      r:           pos.r,
      type:        hexData?.type || 'nebula',
      name:        starbase
                     ? starbase.name.toUpperCase()
                     : `SECTOR ${pos.q},${pos.r}`,
      hasStarbase: !!starbase,
    };

    _sectorLive = true;
    SectorView.enter({
      canvas:      document.getElementById('combat-canvas'),
      sector,
      arrivalOffset: 0,
      onMapToggle: openMap,
      onExit:      () => { _sectorLive = false; openMap(); },
    });
  }

  // ---- Warp sequence ----
  function _beginWarp(from, to) {
    const departureSpeed = _sectorLive ? Math.min(SectorView.speed, 9) : 0;
    const diffCfg = GameConfig.difficulty[currentDifficulty];
    const warpDrift = diffCfg.warpDrift ?? 0;

    // Close map immediately so the player sees the warp charge in the sector view
    closeMap('front');

    if (_sectorLive) {
      const sameSector = (from.q === to.q && from.r === to.r);
      SectorView.beginWarpCharge(warpDrift, ({ rx = 0, uy = 0 } = {}) => {
        if (sameSector) return; // overdrive — just decelerate, no burst

        // Accuracy captured — now slam 99 → 999 before jumping
        SectorView.beginWarpBurst(() => {
          _sectorLive = false; SectorView.exit();

          const TOL = 0.04;
          const onTarget = Math.abs(rx) < TOL && Math.abs(uy) < TOL;
          const driftVec = { x: rx / (TOL * 2), y: uy / (TOL * 2) };

          let arrivalOffset = null;
          if (onTarget) {
            const magErr  = Math.sqrt(rx * rx + uy * uy);
            const offDist = Math.min(5000, (magErr / TOL) * 5000);
            const scatter = 50;
            const angle   = magErr > 0.001 ? Math.atan2(uy, rx) : Math.random() * Math.PI * 2;
            arrivalOffset = {
              x: Math.cos(angle) * offDist + (Math.random() - 0.5) * scatter,
              z: Math.sin(angle) * offDist + (Math.random() - 0.5) * scatter,
            };
          }
          _arriveFromWarp(to, onTarget, driftVec, arrivalOffset, departureSpeed);
        });
      });
    } else {
      _arriveFromWarp(to, true, { x: 0, y: 0 }, 0, departureSpeed);
    }
  }

  function _arriveFromWarp(intendedTarget, onTarget, driftVec, arrivalOffset, departureSpeed = 0) {
    let destination = intendedTarget;
    if (!onTarget) destination = _deflectedSector(intendedTarget, driftVec);

    galaxyMap.teleportPlayer(destination);
    updateHUD();
    showAlert(onTarget ? 'ON COURSE' : 'NAVIGATION ERROR — DIVERTED');

    const destKey  = HexMath.key(destination.q, destination.r);
    const hexData  = galaxyMap.hexes.get(destKey);
    const starbase = galaxyMap.starbases.find(s => s.q === destination.q && s.r === destination.r);
    const sector   = {
      q:           destination.q,
      r:           destination.r,
      type:        hexData?.type || 'void',
      name:        starbase
                     ? starbase.name.toUpperCase()
                     : `SECTOR ${destination.q},${destination.r}`,
      hasStarbase: !!starbase,
    };

    _sectorLive = true;
    SectorView.enter({
      canvas:          document.getElementById('combat-canvas'),
      sector,
      arrivalOffset:   arrivalOffset || 0,
      arrivalVelocity: 99999,           // arrive at burst peak, deburst to WARP_VELOCITY
      throttleSpeed:   departureSpeed,  // target throttle to settle at
      onMapToggle:     openMap,
      onExit:          () => { _sectorLive = false; openMap(); },
    });
    // Arrive looking forward
    closeMap('front');
  }

  function _deflectedSector(target, driftVec) {
    const dq = Math.round(driftVec.x * 2);
    const dr = Math.round(driftVec.y * 2);
    const candidates = [
      { q: target.q + dq, r: target.r + dr },
      ...HexMath.hexNeighbors(target.q, target.r),
    ];
    for (const pos of candidates) {
      const key = HexMath.key(pos.q, pos.r);
      if (galaxyMap.hexes.has(key) && !(pos.q === target.q && pos.r === target.r)) return pos;
    }
    return target;
  }

  // ---- HUD ----
  function updateHUD() {
    const pct = (playerFuel / GameConfig.player.maxFuel) * 100;
    document.getElementById('hud-fuel').textContent = Math.round(pct) + '%';
    document.getElementById('fuel-bar').style.width = pct + '%';
    const fb = document.getElementById('fuel-bar');
    fb.style.background = pct < 25 ? '#ff3a3a' : pct < 50 ? '#ffaa00' : '';
    const pos = galaxyMap ? galaxyMap.playerPos : { q: 0, r: 0 };
    document.getElementById('hud-sector').textContent = `${pos.q},${pos.r}`;
  }

  // ---- Alert ----
  let _alertTimer = null;
  function showAlert(msg) {
    const box = document.getElementById('alert-box');
    box.textContent = msg;
    box.classList.remove('hidden');
    clearTimeout(_alertTimer);
    _alertTimer = setTimeout(() => box.classList.add('hidden'), 3000);
  }

  // ---- Boot ----
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
