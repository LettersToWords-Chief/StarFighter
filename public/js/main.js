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
  let _warping    = false;  // true during warp transition — suppresses onExit map open
  let _warpReady      = false;   // true while warp mode is armed (pre-engagement alignment)
  let _warpReadyTarget = null;   // target {q, r} locked in warp mode
  let _warpReadyInterval = null; // setInterval handle for 30s countdown
  const currentDifficulty = 'cadet';
  let _gameLost       = false;
  let _gameWon        = false;
  let _sectorsVisited = 0;
  // Set by init() when fast-forward has placed Zylons at a starbase before gameplay starts.
  // Consumed on the first keypress so the 3-tone subspace alert plays once audio is live.
  let _pendingStartupAlert = null;
  let _powerScanUnlocked = false;  // unlocked after first sector clear
  window._powerScanUnlocked = false; // mirrored on window so SectorView HUD can read it

  // ---- Subspace message log ----
  const SubspaceComm = window.SubspaceComm = (() => {
    const _log = [];

    function _clockStr() {
      const tc = _sectorLive ? Math.floor(SectorView.galacticClock || 0) : _stardate;
      const hh = Math.floor(tc / 3600);
      const mm = Math.floor((tc % 3600) / 60);
      const ss = tc % 60;
      return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
    }

    function send(from, stardate, text, opts = {}) {
      const entry = { from, clock: stardate, text };
      _log.unshift(entry);
      _renderLog();
      if (_sectorLive && SectorView.showMessage) SectorView.showMessage(from, stardate, text);
      // Play the 3-tone subspace chime — suppressed for silent messages (e.g. power scan).
      if (!opts.silent && typeof SoundManager !== 'undefined') SoundManager.starbsMessage();
      // Milestone: first sector clear → unlock Power Scan technology
      if (!_powerScanUnlocked && text.includes('ALL ZYLON FORCES ELIMINATED')) {
        _powerScanUnlocked = true;
        window._powerScanUnlocked = true;
        setTimeout(() => {
          const clk = SubspaceComm.clockStr();
          SubspaceComm.send('CENTRAL COMMAND', clk,
            'NEW TECHNOLOGY ONLINE — POWER SCAN ARRAY — DOCK AT ANY STARBASE AND PRESS P');
        }, 3000);
      }
    }
    function getLog() { return [..._log]; }
    function _renderLog() {
      const el = document.getElementById('subspace-log');
      if (!el) return;
      el.innerHTML = _log.length === 0
        ? '<div class="ssm-empty">NO MESSAGES</div>'
        : _log.map(m =>
            `<div class="ssm-entry">
               <span class="ssm-from">${m.from}: <span class="ssm-time">(${m.clock})</span></span>
               <span class="ssm-text">${m.text}</span>
             </div>`
          ).join('');
    }
    return { send, getLog, _renderLog, clockStr: _clockStr };
  })();

  // Stardate — started by _beginGame when the player clicks BEGIN MISSION
  let _stardate = 0;
  let _stardateInterval = null;

  // ---- DOM refs ----
  const $galaxy  = () => document.getElementById('galaxy-view');
  const $combat  = () => document.getElementById('combat-view');

  // ---- Map overlay ----
  function openMap() {
    _cancelWarpReadyMode();  // opening the map cancels armed warp
    _mapOpen = true;
    $galaxy().classList.add('map-open');
    SubspaceComm._renderLog();
    if (_sectorLive) SectorView.suspendInput();
  }

  function closeMap(mode) {
    _mapOpen = false;
    $galaxy().classList.remove('map-open');
    if (_sectorLive) SectorView.showView(mode); // rebind controls, set view direction
  }

  // ---- Warp Ready Mode ----
  // Arms the warp drive: shows the destination diamond in the cockpit and starts the 30s
  // countdown. Player must align their ship to the diamond and press E to engage.
  // Returns true if warp mode was armed, false if rejected (e.g. insufficient fuel).
  // Callers that open the map should check the return value before closing it,
  // so the player can read the rejection alert without losing context.
  function _beginWarpReadyMode(t) {
    _cancelWarpReadyMode();
    const from = galaxyMap.playerPos;
    const fc   = HexMath.fuelCost(from, t);
    if (playerFuel < fc) { showAlert('INSUFFICIENT FUEL'); return false; }
    _warpReady       = true;
    _warpReadyTarget = t;
    // Compute 3D direction from player hex to destination hex (XZ plane)
    const fromPx = HexMath.axialToPixel(from.q, from.r, 1);
    const toPx   = HexMath.axialToPixel(t.q, t.r, 1);
    const dx = toPx.x - fromPx.x, dy = toPx.y - fromPx.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const dir3D = new THREE.Vector3(dx / len, 0, dy / len);
    let countdown = GameConfig.player.warpArmTimeout ?? 30;
    if (_sectorLive) SectorView.enterWarpMode(dir3D, countdown);
    _warpReadyInterval = setInterval(() => {
      countdown--;
      if (_sectorLive) SectorView.updateWarpModeTimer(countdown);
      if (countdown <= 0) _cancelWarpReadyMode();
    }, 1000);
    return true;
  }

  function _cancelWarpReadyMode() {
    _warpReady       = false;
    _warpReadyTarget = null;
    if (_warpReadyInterval) { clearInterval(_warpReadyInterval); _warpReadyInterval = null; }
    if (_sectorLive) SectorView.cancelWarpMode();
  }

  // ---- Init ----
  function init() {
    const canvas = document.getElementById('galaxy-canvas');
    galaxyMap = new GalaxyMap(canvas, { difficulty: currentDifficulty });
    window.GalaxyRef = galaxyMap;   // exposes live Zylon count to SectorView fog-intelligence
    galaxyMap.getStardate = () => _stardate;

    // Freeze simulation until the player clicks BEGIN MISSION.
    // Fast-forward runs at that point, not here.
    galaxyMap.frozen = true;

    let _startupAlertText = '';

    // Start Three.js glass-sheet crawl (defer so flexbox layout has real dimensions)
    const crawlWrap = document.getElementById('intro-crawl-wrap');
    if (crawlWrap && typeof IntroCrawl !== 'undefined') {
      setTimeout(() => IntroCrawl.start(crawlWrap, _startupAlertText), 100);
    }

    // When a Seeker steps into the player's current sector, spawn its icosahedron.
    // The Seeker travels alone — no TIE/Bird escort.
    galaxyMap.onSeekerArrived = (seeker) => {
      if (!_sectorLive) return;
      const pos = galaxyMap.playerPos;
      if (seeker.q !== pos.q || seeker.r !== pos.r) return;
      SectorView.spawnZylons(1, 'seeker_beacon', seeker);  // solo icosahedron
    };

    // When a Seeker evolves into a Spawner in the player's current sector,
    // wire the new Spawner into SectorView and spawn its fleet.
    galaxyMap.onSpawnerEvolved = (spawner) => {
      if (!_sectorLive) return;
      const pos = galaxyMap.playerPos;
      if (spawner.q !== pos.q || spawner.r !== pos.r) return;
      SectorView.notifySpawnerEvolved(spawner);
    };

    galaxyMap.onVictory = () => _triggerWin();

    // Loss condition callbacks
    SectorView.onLoss       = (reason) => _triggerLoss(reason);
    // Keep playerFuel in sync whenever docking restores energy in SectorView.
    // Without this, _energy (the E-bar) refills but playerFuel (the warp check) stays depleted.
    SectorView.onRefuel     = (fuel)   => { playerFuel = fuel; updateHUD(); };
    galaxyMap.onCapitalLost = ()       => _triggerLoss('CAPITAL_LOST');

    galaxyMap.onWarpSelected = ({ from, to, fuelCost }) => {
      if (playerFuel < fuelCost) { showAlert('INSUFFICIENT FUEL'); return; }
      // Fuel is NOT deducted yet — deduction happens during hyperspace (3 beeps at burst end)
      _beginWarp(from, to, fuelCost);
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
        // H from map = arm warp mode, return to cockpit
        if (e.code === 'KeyH') {
          const t = galaxyMap.getTarget();
          if (!t) { showAlert('SELECT A WARP TARGET FIRST'); return; }
          // Only close the map if the warp was actually armed — keeps the
          // map open (and the rejection alert readable) if fuel is too low.
          if (_beginWarpReadyMode(t)) closeMap('front');
          return;
        }
      } else {
        // Cockpit is visible
        if (e.code === 'KeyG') { openMap(); return; }
        if (e.code === 'KeyH') {
          if (_warpReady) { showAlert('WARP ALREADY ARMED — PRESS E TO ENGAGE'); return; }
          const t = galaxyMap.getTarget();
          if (!t) { showAlert('NO WARP TARGET — PRESS G TO SET ONE'); return; }
          _beginWarpReadyMode(t);
          return;
        }
        if (e.code === 'KeyE') {
          if (_warpReady && _warpReadyTarget) {
            const t = _warpReadyTarget;
            _cancelWarpReadyMode();
            galaxyMap._warpTo(t);
          }
          return;
        }
        // P key — Power Scan
        // stopImmediatePropagation prevents SectorView's own keydown listener from
        // also receiving this event (it previously had P = pause).
        if (e.code === 'KeyP') {
          e.stopImmediatePropagation();
          if (!_powerScanUnlocked) return; // tech not yet unlocked
          if (!_sectorLive) return;

          if (!SectorView.atDockPosition) { showAlert('DOCK AT A STARBASE TO INITIATE POWER SCAN'); return; }
          const sb = SectorView.currentStarbase;
          if (!sb || sb.state !== 'active') { showAlert('STARBASE OFFLINE'); return; }
          if (sb.underAttack) { showAlert('STARBASE UNDER ATTACK — SCAN UNAVAILABLE'); return; }
          // Check for Zylon presence in this galaxy sector
          const { q, r } = galaxyMap.playerPos;
          const hasZylons =
            galaxyMap.zylonSeekers.some(s  => s.alive && s.q === q && s.r === r) ||
            galaxyMap.zylonSpawners.some(sp => sp.alive && sp.q === q && sp.r === r);
          if (hasZylons) { showAlert('ZYLON PRESENCE DETECTED — SCAN UNAVAILABLE'); return; }
          if ((sb.inventory?.energy ?? 0) < GameConfig.powerScan.energyCost) {
            showAlert('INSUFFICIENT STARBASE ENERGY FOR POWER SCAN'); return;
          }
          if (galaxyMap.activePowerScans?.some(s => s.starbase === sb)) {
            showAlert('POWER SCAN ALREADY IN PROGRESS'); return;
          }
          // All conditions met — initiate scan
          galaxyMap.initiatePowerScan(sb);
          const clk = SubspaceComm.clockStr();
          SubspaceComm.send(sb.name.toUpperCase(), clk,
            'INITIATING POWER SCAN — MONITORING FOR ZYLON SIGNATURES', { silent: true });
          return;
        }
      }
    });

    updateHUD();

    // Show combat canvas (always underneath) but DON'T enter the sector yet.
    // _beginGame() does that once the player clicks BEGIN MISSION.
    $combat().style.display = 'block';

    // Wire the BEGIN MISSION button — this click is the user gesture for AudioContext
    document.getElementById('intro-begin').addEventListener('click', _beginGame, { once: true });
  }

  // ---- Begin the game (called by the intro BEGIN MISSION button click) ----
  function _beginGame() {
    if (typeof IntroCrawl !== 'undefined') IntroCrawl.stop();
    const intro = document.getElementById('intro-overlay');
    if (intro) intro.style.display = 'none';

    // Initialize audio — the click is the required user gesture
    if (typeof SoundManager !== 'undefined') SoundManager.init();

    // Run fast-forward NOW — after the player clicks Begin Mission.
    // This keeps the galactic clock honest: no Zylon activity before game start.
    galaxyMap._fastForwardZylons();

    // Detect any Spawner placed by fast-forward at a starbase and queue the startup alert
    if (galaxyMap.redAlert) {
      const sp = galaxyMap.zylonSpawners.find(s =>
        s.alive && galaxyMap.starbases.some(sb => sb.q === s.q && sb.r === s.r)
      );
      if (sp) {
        const sb   = galaxyMap.starbases.find(s => s.q === sp.q && s.r === sp.r);
        const name = (sb?.name ?? `SECTOR ${sp.q},${sp.r}`).toUpperCase();
        _pendingStartupAlert = { q: sp.q, r: sp.r, name };
        SubspaceComm.send(
          'CENTRAL COMMAND',
          SubspaceComm.clockStr(),
          `ZYLON INCURSION DETECTED — ${name} UNDER ATTACK`);
      }
    }

    // Unfreeze simulation and start the stardate clock
    galaxyMap.frozen = false;
    _stardateInterval = setInterval(() => { _stardate++; }, 1000);

    // Enter the cockpit
    _enterSector({ q: 0, r: 0 });
  }

  // ---- Enter a sector without the warp tunnel ----
  function _enterSector(pos) {
    const destKey  = HexMath.key(pos.q, pos.r);
    const hexData  = galaxyMap.hexes.get(destKey);
    const starbase = galaxyMap.starbases.find(s => s.q === pos.q && s.r === pos.r);
    const seekerCount  = galaxyMap.zylonSeekers?.filter(s => s.alive && s.q === pos.q && s.r === pos.r).length ?? 0;
    const spawnerCount = galaxyMap.zylonSpawners?.filter(s => s.alive && s.q === pos.q && s.r === pos.r).length ?? 0;
    const sector   = {
      q:           pos.q,
      r:           pos.r,
      type:        hexData?.type || 'nebula',
      name:        starbase
                     ? starbase.name.toUpperCase()
                     : `SECTOR ${pos.q},${pos.r}`,
      hasStarbase:   !!starbase,
      starbase:      starbase || null,
      supplyShips:    galaxyMap.shipsInSector(pos.q, pos.r),
      allSupplyShips: galaxyMap.supplyShips,
      seekerCount,
      zylons:         seekerCount + spawnerCount,
    };

    _sectorLive = true;
    _sectorsVisited++;
    SectorView.setFuel(playerFuel);
    // Link each 3D ship to its galaxy-level unit so kills propagate to the map
    const seekers  = galaxyMap.zylonSeekers?.filter(s => s.alive && s.q === pos.q && s.r === pos.r) ?? [];
    const spawner  = galaxyMap.zylonSpawners?.find(sp => sp.alive && sp.q === pos.q && sp.r === pos.r) ?? null;
    SectorView.enter({
      canvas:      document.getElementById('combat-canvas'),
      sector,
      arrivalOffset: 0,
      onMapToggle: openMap,
      onExit:      () => { _sectorLive = false; if (!_warping) openMap(); },
      seekerGalaxyRefs:  seekers,
      spawnerGalaxyRef:  spawner,
    });
    // If fast-forward placed Zylons at a starbase before gameplay started,
    // show the alert in the cockpit HUD and play the 3-tone subspace alert.
    // Runs at sector entry — no keypress needed.
    if (_pendingStartupAlert) {
      SectorView.showMessage(
        'CENTRAL COMMAND',
        SubspaceComm.clockStr(),
        `ZYLON INCURSION — ${_pendingStartupAlert.name} UNDER ATTACK`);
      if (typeof SoundManager !== 'undefined') SoundManager.starbsMessage();
    }
  }

  // ---- Hyperspace beep (electronic tonal blip) ----
  function _beep(freq) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
      osc.start(); osc.stop(ctx.currentTime + 0.14);
    } catch(e) {}
  }

  // ---- Warp sequence ----
  function _beginWarp(from, to, fuelCost = 0) {
    const departureSpeed = _sectorLive ? Math.min(SectorView.speed, 9) : 0;
    const diffCfg = GameConfig.difficulty[currentDifficulty];
    const warpDrift = diffCfg.warpDrift ?? 0;

    // Close map immediately so the player sees the warp charge in the sector view
    closeMap('front');

    if (_sectorLive) {
      const sameSector = (from.q === to.q && from.r === to.r);
      SectorView.beginWarpCharge(warpDrift, ({ rx = 0, uy = 0 } = {}) => {
        if (sameSector) return; // overdrive — just decelerate, no burst

        // Accuracy captured — now slam 99 → 99999 before jumping
        SectorView.beginWarpBurst(() => {
          _warping = true; _sectorLive = false; SectorView.exit();

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

          // Three beeps during hyperspace — deduct 1/3 of fuel cost with each
          const share = Math.ceil(fuelCost / 3);
          const deductShare = () => {
            playerFuel = Math.max(0, playerFuel - share);
            SectorView.drainEnergy(share); // _energy persists across exit/enter
            SectorView.setFuel(playerFuel);
            updateHUD();
          };
          if (typeof SoundManager !== 'undefined') SoundManager.warpTransit();
          _beep(1200); deductShare();
          setTimeout(() => { _beep(1200); deductShare(); }, 120);
          setTimeout(() => {
            _beep(1200); deductShare();
            setTimeout(() => _arriveFromWarp(to, onTarget, driftVec, arrivalOffset, departureSpeed), 200);
          }, 240);
        });
      });
    } else {
      _arriveFromWarp(to, true, { x: 0, y: 0 }, 0, departureSpeed);
    }
  }

  function _arriveFromWarp(intendedTarget, onTarget, driftVec, arrivalOffset, departureSpeed = 0) {
    _warping = false;
    let destination = intendedTarget;
    if (!onTarget) destination = _deflectedSector(intendedTarget, driftVec);

    galaxyMap.teleportPlayer(destination);
    updateHUD();
    showAlert(onTarget ? 'ON COURSE' : 'NAVIGATION ERROR — DIVERTED');

    const destKey  = HexMath.key(destination.q, destination.r);
    const hexData  = galaxyMap.hexes.get(destKey);
    const starbase = galaxyMap.starbases.find(s => s.q === destination.q && s.r === destination.r);
    const seekerCount  = galaxyMap.zylonSeekers?.filter(s => s.alive && s.q === destination.q && s.r === destination.r).length ?? 0;
    const spawnerCount = galaxyMap.zylonSpawners?.filter(s => s.alive && s.q === destination.q && s.r === destination.r).length ?? 0;
    const sector   = {
      q:           destination.q,
      r:           destination.r,
      type:        hexData?.type || 'void',
      name:        starbase
                     ? starbase.name.toUpperCase()
                     : `SECTOR ${destination.q},${destination.r}`,
      hasStarbase:   !!starbase,
      starbase:      starbase || null,
      supplyShips:    galaxyMap.shipsInSector(destination.q, destination.r),
      allSupplyShips: galaxyMap.supplyShips,
      seekerCount,
      zylons:         seekerCount + spawnerCount,
    };

    _sectorLive = true;
    _sectorsVisited++;
    SectorView.setFuel(playerFuel);
    // Link each 3D ship to its galaxy-level unit so kills propagate to the map
    const arrSeekers  = galaxyMap.zylonSeekers?.filter(s => s.alive && s.q === destination.q && s.r === destination.r) ?? [];
    const arrSpawner  = galaxyMap.zylonSpawners?.find(sp => sp.alive && sp.q === destination.q && sp.r === destination.r) ?? null;
    SectorView.enter({
      canvas:          document.getElementById('combat-canvas'),
      sector,
      arrivalOffset:   arrivalOffset || 0,
      arrivalVelocity: 99999,
      throttleSpeed:   departureSpeed,
      onMapToggle:     openMap,
      onExit:          () => { _sectorLive = false; if (!_warping) openMap(); },
      seekerGalaxyRefs:  arrSeekers,
      spawnerGalaxyRef:  arrSpawner,
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

  // ---- Victory ----
  function _triggerWin() {
    if (_gameWon) return;
    _gameWon = true;
    if (_sectorLive) SectorView.pause();
    if (galaxyMap)   galaxyMap.frozen = true;
    if (typeof SoundManager !== 'undefined') SoundManager.stopRedAlert();

    const kills       = SectorView.kills     || 0;
    const docks       = SectorView.dockCount || 0;
    const sectors     = _sectorsVisited      || 1;
    const tc          = Math.floor(SectorView.galacticClock || 0);
    const timeMinutes = tc / 60;
    const hull        = Math.max(0, Math.min(600, SectorView.hullHP || 600));
    const hullPct     = (hull / 600) * 100;
    const sbPreserved = (galaxyMap?.starbases || []).filter(s => s.state === 'active').length;

    let score = kills       * 20
              + sbPreserved * 50
              + Math.floor(hullPct * 0.5)
              - docks       * 30
              - Math.max(0, sectors - kills) * 3
              - Math.floor(timeMinutes * 3);
    score = Math.max(0, Math.min(1000, score));

    const RANKS = [
      { min: 900, name: 'STAR COMMANDER' },
      { min: 800, name: 'COMMANDER'      },
      { min: 700, name: 'CAPTAIN'        },
      { min: 600, name: 'WARRIOR'        },
      { min: 500, name: 'LIEUTENANT'     },
      { min: 400, name: 'ACE'            },
      { min: 300, name: 'PILOT'          },
      { min: 200, name: 'ENSIGN'         },
      { min: 100, name: 'NOVICE'         },
      { min:  50, name: 'ROOKIE'         },
      { min:   0, name: 'GARBAGE SCOW CAPTAIN' },
    ];
    const rankEntry   = RANKS.find(r => score >= r.min) || RANKS[RANKS.length - 1];
    const nextMin     = RANKS[RANKS.indexOf(rankEntry) - 1]?.min ?? (rankEntry.min + 100);
    const span        = nextMin - rankEntry.min;
    const scoreInRank = score - rankEntry.min;
    const classNum    = Math.max(1, 5 - Math.floor((scoreInRank / span) * 5));

    const hh = String(Math.floor(tc / 3600)).padStart(2, '0');
    const mm = String(Math.floor((tc % 3600) / 60)).padStart(2, '0');
    const ss = String(tc % 60).padStart(2, '0');

    _showVictory(score, rankEntry.name, classNum, {
      kills, sectors, docks, starbases: sbPreserved,
      time: `${hh}:${mm}:${ss}`,
      hull: Math.floor(hullPct),
    });
  }

  function _showVictory(score, rank, cls, stats) {
    document.getElementById('vc-kills').textContent     = stats.kills;
    document.getElementById('vc-sectors').textContent   = stats.sectors;
    document.getElementById('vc-time').textContent      = stats.time;
    document.getElementById('vc-docks').textContent     = stats.docks;
    document.getElementById('vc-starbases').textContent = stats.starbases;
    document.getElementById('vc-hull').textContent      = stats.hull + '%';
    document.getElementById('vc-score').textContent     = score;
    document.getElementById('vc-rank').textContent      = `${rank}  CLASS ${cls}`;
    const overlay = document.getElementById('victory');
    overlay.style.display = 'flex';
    document.getElementById('vc-retry').addEventListener('click', () => location.reload());
  }

  // ---- Loss conditions ----
  function _triggerLoss(reason) {
    if (_gameLost) return;
    _gameLost = true;
    // Halt both simulation loops so nothing continues behind the postmortem screen
    if (_sectorLive) SectorView.pause();
    if (galaxyMap) galaxyMap.frozen = true;
    if (typeof SoundManager !== 'undefined') SoundManager.stopRedAlert();
    const tc = Math.floor(SectorView.galacticClock || 0);
    const hh = String(Math.floor(tc / 3600)).padStart(2,'0');
    const mm = String(Math.floor((tc % 3600) / 60)).padStart(2,'0');
    const ss = String(tc % 60).padStart(2,'0');
    _showPostmortem(reason, {
      kills:   SectorView.kills   || 0,
      sectors: _sectorsVisited,
      time:    `${hh}:${mm}:${ss}`,
    });
  }

  function _showPostmortem(reason, stats) {
    const MESSAGES = {
      SHIP_DESTROYED:  {
        header: 'SHIP DESTROYED',
        flavor: 'Your vessel was torn apart by Zylon fire. The galaxy grows darker.',
      },
      ENERGY_STRANDED: {
        header: 'ADRIFT IN DEEP SPACE',
        flavor: 'With no power and no way home, your ship drifts silently into the void.',
      },
      CAPITAL_LOST: {
        header: 'THE CAPITAL HAS FALLEN',
        flavor: 'Without the Capital, all resistance collapses. The Zylons claim another corner of the galaxy.',
      },
    };
    const msg = MESSAGES[reason] || MESSAGES.SHIP_DESTROYED;
    document.getElementById('pm-header').textContent  = msg.header;
    document.getElementById('pm-flavor').textContent  = msg.flavor;
    document.getElementById('pm-kills').textContent   = stats.kills;
    document.getElementById('pm-sectors').textContent = stats.sectors;
    document.getElementById('pm-time').textContent    = stats.time;
    const overlay = document.getElementById('postmortem');
    overlay.style.display = 'flex';
    document.getElementById('pm-retry').addEventListener('click', () => location.reload());
  }

  // ---- HUD ----
  function updateHUD() {
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
