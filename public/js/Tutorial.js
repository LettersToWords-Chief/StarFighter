/**
 * Tutorial.js — Guided tutorial overlay for Star Fighter.
 * 23 slides with canvas-relative highlight boxes and audio voiceover.
 * Call Tutorial.start(opts) after _beginGame() to activate.
 *
 * opts = {
 *   onStart()          — called when tutorial begins (freeze galaxy, etc.)
 *   onExit()           — called when tutorial ends (unfreeze galaxy, etc.)
 *   onSlideChange(idx) — called on every slide change (inject demo content)
 * }
 */
const Tutorial = (() => {
  'use strict';

  // ── Slide definitions ──────────────────────────────────────────────────────
  // highlight: 'zone1'=Energy  'zone2'=Cannons/Ammo  'zone3'=Velocity
  //            'zone4'=Hull/Shields  'scope'=Scope circle  'aftpip'=Aft cam
  //            'crosshair'=Crosshair  'ticker'=Subspace band  'banner'=Alert bar
  //            'map'=Galaxy map overlay  null=no highlight
  // position: 'left'(default) | 'right' (map slides — avoids blocking subspace log)
  const SLIDES = [
    { title: 'ENERGY',                   highlight: 'zone1',     audio: 1                  },
    { title: 'AMMO',                     highlight: 'zone2',     audio: 2                  },
    { title: 'CANNONS',                  highlight: 'zone2',     audio: 3                  },
    { title: 'VELOCITY',                 highlight: 'zone3',     audio: 4                  },
    { title: 'HULL \u0026 SHIELDS',      highlight: 'zone4',     audio: 5                  },
    { title: 'TRACKING COMPUTER',        highlight: 'scope',     audio: 6,
      keyHint: 'Press C to activate the tracking computer.'                                 },
    { title: 'AFT VIEW',                 highlight: 'aftpip',    audio: 7,
      keyHint: 'Press A to turn on the aft view camera.'                                    },
    { title: 'STEERING',                 highlight: 'crosshair', audio: 8                  },
    { title: 'SUBSPACE MESSAGES',        highlight: 'ticker',    audio: 9                  },
    { title: 'URGENT ALERTS',            highlight: 'banner',    audio: 10                 },
    { title: 'GALACTIC MAP',             highlight: 'map',       audio: 11, position:'right',
      keyHint: 'Press G to open your galactic map.'                                         },
    { title: 'SECTORS \u0026 RESOURCES', highlight: 'map',       audio: 12, position:'right'},
    { title: 'SUPPLY LINES',             highlight: 'map',       audio: 13, position:'right'},
    { title: 'MAP NAVIGATION',           highlight: 'map',       audio: 14, position:'right',
      keyHint: 'Press G again to close the map when ready.'                                 },
    { title: 'WARP DRIVE',               highlight: null,        audio: 15                 },
    { title: 'DOCKING',                  highlight: null,        audio: 16                 },
    { title: 'ZYLONS: SPAWNERS',         highlight: null,        audio: 17                 },
    { title: 'ZYLONS: SEEKERS',          highlight: null,        audio: 18                 },
    { title: 'ZYLONS: BIRDS \u0026 TIES',highlight: null,        audio: 19                 },
    { title: 'ZYLONS: WARRIORS',         highlight: null,        audio: 20                 },
    { title: 'HOW YOU LOSE',             highlight: null,        audio: 21                 },
    { title: 'HOW YOU WIN',              highlight: null,        audio: 22                 },
    { title: 'SADDLE UP, STAR FIGHTER!', highlight: null,        audio: 23, isLast: true   },
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  let _idx      = 0;
  let _panelEl  = null;
  let _hlEl     = null;
  let _audioEl  = null;
  let _rafId    = null;
  let _active   = false;
  let _opts     = {};

  // ── Highlight bounds ───────────────────────────────────────────────────────
  // Mirrors the exact geometry from SectorView._drawHUD so boxes align perfectly.
  function _bounds(hlKey) {
    if (!hlKey) return null;

    if (hlKey === 'map') {
      // Try canvas overlay first; fall back to the map wrapper div
      const mc = document.getElementById('galaxy-canvas') ||
                 document.getElementById('map-canvas')    ||
                 document.getElementById('galaxy-view');
      if (!mc) return null;
      const mr = mc.getBoundingClientRect();
      if (mr.width === 0) return null; // map not open
      return mr;
    }

    const canvas = document.getElementById('combat-canvas');
    if (!canvas) return null;
    const r  = canvas.getBoundingClientRect();
    const W  = r.width,  H = r.height;
    const DH = 130,      DY = H - DH;

    // Dashboard zone geometry (matches SectorView exactly)
    const rightMargin = 8, colW = 95, colGap = 8;
    const col2X  = W - rightMargin - colW;
    const col1X  = col2X - colGap - colW;
    const indicW = col1X - 4;

    const Z1W = Math.floor(indicW * 0.28);
    const Z2W = Math.floor(indicW * 0.40);
    const Z3W = Math.floor(indicW * 0.21);
    const Z4W = Math.floor(indicW * 0.11);
    const Z2X = Z1W + 1, Z3X = Z2X + Z2W + 1, Z4X = Z3X + Z3W + 1;

    // Scope geometry (matches SectorView exactly)
    const scopeW = 180, scopeH = 140;
    const scopeX = Math.round(col1X + colW / 2 - scopeW / 2);
    const scopeY = DY - scopeH - Math.round(scopeH / 2);

    const PAD = 4;
    function zone(x, w, yTop, h) {
      const top  = yTop !== undefined ? yTop  : DY;
      const ht   = h    !== undefined ? h     : DH;
      return { left: r.left + x - PAD, top: r.top + top - PAD,
               width: w + PAD * 2,     height: ht + PAD * 2 };
    }

    switch (hlKey) {
      case 'zone1':    return zone(0,       Z1W);
      case 'zone2':    return zone(Z2X,     Z2W);
      case 'zone3':    return zone(Z3X,     Z3W);
      case 'zone4':    return zone(Z4X,     Z4W);
      case 'full':     return zone(0,       W);

      // Tracking scope circle — positioned ABOVE the dashboard
      case 'scope':
        return zone(scopeX, scopeW, scopeY, scopeH);

      // Aft view picture-in-picture — upper-left area above dashboard
      case 'aftpip': {
        const pipW = Math.floor(W / 4), pipH = Math.floor(DY / 4);
        return { left: r.left + 8 - PAD, top: r.top + DY - pipH - PAD,
                 width: pipW + PAD * 2,  height: pipH + PAD * 2 };
      }

      // Crosshair — true center of the full canvas (cy = H/2 in SectorView)
      case 'crosshair': {
        const sz = 130;
        return { left: r.left + W / 2 - sz / 2, top: r.top + H / 2 - sz / 2,
                 width: sz, height: sz };
      }

      // Subspace ticker strip — the narrow scroll-text band near top of viewport
      case 'ticker':
        return { left: r.left, top: r.top + 30, width: W, height: 52 };

      // Urgent alert banner — very top strip above the ticker
      case 'banner':
        return { left: r.left, top: r.top, width: W, height: 34 };

      default: return null;
    }
  }

  // ── Highlight DOM update (every rAF) ───────────────────────────────────────
  function _updateHL() {
    if (!_hlEl) return;
    const b = _bounds(SLIDES[_idx].highlight);
    if (b && b.width > 0) {
      Object.assign(_hlEl.style, {
        display: 'block',
        left:   b.left   + 'px',
        top:    b.top    + 'px',
        width:  b.width  + 'px',
        height: b.height + 'px',
      });
    } else {
      _hlEl.style.display = 'none';
    }
  }

  function _loop() {
    if (!_active) return;
    _updateHL();
    _rafId = requestAnimationFrame(_loop);
  }

  // ── Audio ──────────────────────────────────────────────────────────────────
  function _playAudio(n) {
    if (_audioEl) { _audioEl.pause(); _audioEl.src = ''; }
    _audioEl = new Audio(`/audio/tutorial/tut_01 (${n}).mp3`);
    _audioEl.volume = 0.9;
    _audioEl.play().catch(() => {});
  }

  // ── Panel position ─────────────────────────────────────────────────────────
  function _positionPanel(slide) {
    if (!_panelEl) return;
    if (slide.position === 'right') {
      _panelEl.style.left  = 'auto';
      _panelEl.style.right = '18px';
    } else {
      _panelEl.style.left  = '18px';
      _panelEl.style.right = 'auto';
    }
  }

  // ── Panel render ───────────────────────────────────────────────────────────
  function _render() {
    if (!_panelEl) return;
    const slide  = SLIDES[_idx];
    const total  = SLIDES.length;
    const isLast = !!slide.isLast;

    _panelEl.innerHTML = `
      <div class="tut-header">
        <span class="tut-counter">Step ${_idx + 1} of ${total}</span>
        <span class="tut-title">${slide.title}</span>
        <button class="tut-x" id="tut-exit-btn" title="Exit Tutorial">✕</button>
      </div>
      ${slide.keyHint ? `<div class="tut-keyhint">⌨ ${slide.keyHint}</div>` : ''}
      <div class="tut-body" id="tut-body-text"></div>
      <div class="tut-footer">
        <button class="tut-btn tut-prev" id="tut-prev-btn" ${_idx === 0 ? 'disabled' : ''}>◀ PREV</button>
        <button class="tut-btn tut-next" id="tut-next-btn">
          ${isLast ? 'BEGIN GAME ▶' : 'NEXT ▶'}
        </button>
      </div>`;

    document.getElementById('tut-body-text').textContent = _getText(_idx);
    document.getElementById('tut-prev-btn')?.addEventListener('click', prev);
    document.getElementById('tut-next-btn')?.addEventListener('click', isLast ? exit : next);
    document.getElementById('tut-exit-btn')?.addEventListener('click', exit);

    _positionPanel(slide);

    // Notify host so it can inject demo content for this slide
    _opts.onSlideChange?.(_idx);
  }

  // ── Slide text ─────────────────────────────────────────────────────────────
  function _getText(i) {
    const t = [
      'The most important thing on your ship is energy. Everything runs on energy — your engines, your weapons, your shields, your computer. If you run out of energy, your ship goes dark and you die. The long bar shows how much energy you have left, along with a number. Below that you can see how fast you\'re using your energy. Always keep an eye on your energy. When it gets low, find a starbase and dock.',
      'To destroy the Zylons you fire torpedoes. Your ship can carry up to two hundred at a time. When you dock at a starbase you\'ll be resupplied, as long as the starbase has them in stock. Don\'t waste your shots — supplies are not unlimited. Keeping the supply lines open is critical to making sure there are always torpedoes waiting for you when you need them.',
      'You have three torpedo cannons — two facing forward and one facing backward. Each time you fire, the cannon heats up. They cool down as fuel flows to your engines, so the faster you\'re flying, the cooler they stay. If you overheat a cannon it will take damage and eventually destroy itself. Watch the three indicators: charge, temperature, and health. A damaged cannon still fires, but cools down much more slowly.',
      'Your ship has four engines. When they\'re all healthy, you can reach a top speed of sixty-four. As your engines take damage, your maximum speed drops — and a slower ship is a more dangerous ship. Speed helps keep your cannons cool and makes you harder to hit. You\'ll need to slow down to line up shots, but don\'t stay slow for long.',
      'Your shields protect your ship by absorbing hits. After taking damage, they automatically recharge. But recharging uses energy, so a ship under heavy fire drains fast. When your shields are low, the next hit will start damaging your systems — engines, cannons, and computers. When your hull is destroyed, you\'re dead. Fight hard, but don\'t be reckless.',
      'Press C to turn on your tracking computer. This is one of your most important tools. It shows every ship in your sector as a circle on the scope. A filled circle means the ship is in front of you. A hollow circle means it\'s behind you. Blue circles are starbases. Green are cargo ships. Orange are docking drones. Red are Zylons. On the right you\'ll see a list of nearby targets sorted by range, with enemies always listed first. Keep this on at all times.',
      'Press A to turn on your rear camera. This small window shows you what\'s happening behind your ship. Zylons love to attack from behind, and skilled pilots use the rear camera to shoot enemies sneaking up on them. The aft cannon can fire at anything you see in this view.',
      'Look at the center of your screen — that\'s your targeting crosshair. If it turns orange, your keyboard has lost focus. Just click anywhere on the screen to get it back. To steer, move your mouse cursor toward where you want to go. The farther your cursor is from the crosshair, the faster you\'ll turn. Move it inside the crosshair to hold steady. Try it now.',
      'Near the top of your screen you\'ll receive subspace messages. These tell you what\'s happening across the galaxy — enemy movements, starbase status, and other important events. A three-note signal plays when a new message arrives. Pay attention to these. They\'re your early warning system.',
      'At the very top of your screen you\'ll sometimes see an urgent announcement scrolling from right to left. These include critical warnings like ship damage and system failures. If something is scrolling across the top, stop what you\'re doing and read it.',
      'Press G to open your galactic map. This is your view of the entire battle. On the left side is a log of all the subspace messages you\'ve received, each one stamped with the time. The sector you\'re currently in always has a moving border around it. Many sectors are hidden because you don\'t have ships there to report conditions. Your ship can see the six sectors surrounding the one you\'re in.',
      'Some sectors contain valuable resources — these are the sectors the Zylons are searching for. You start the game with four starbases already built in resource-rich sectors. Your central starbase in the middle is called the Capital. If the Capital falls to the Zylons, you lose the game. The Capital is where all your supplies are made. Protect it above everything else.',
      'You can see cargo ships moving along supply routes between your starbases. The outlying starbases gather resources and send them to the Capital. The Capital sends back manufactured supplies — energy, torpedoes, and spare parts. If the Zylons attack these cargo ships, your starbases will start to run low. The Capital will build replacement ships, but it takes time and uses the same parts you need.',
      'Use the scroll wheel to zoom in and out on the map. Click and drag to move it around. Click on a sector that has a starbase to see its current supply levels. If you see a pulsing red dot inside a starbase, Zylons are there and it needs your immediate attention. Press G again to close the map when you are ready.',
      'To travel between sectors you use your warp drive. Step 1: Open the map with G. Step 2: Click your destination — you\'ll see the energy cost. Step 3: Press H to close the map. Step 4: Steer your crosshair onto the warp target. Step 5: Press E to engage — you have 30 seconds. Step 6: Keep the crosshair on the target as you jump. If you fly through a solid object you will abort and take heavy damage.',
      'You\'ll need to dock regularly for energy, torpedoes, and repairs. Warp into a sector with a starbase, fly close to it, and slow your speed to zero. When your computer is on, you\'ll see a docking message on the scope. Press D to open the starbase controls. Choose which systems to repair, then press Repair and Refuel. A docking drone will fly out and do the work. Wait for it to return before flying away, or you\'ll abort the process.',
      'The most dangerous enemy is the Spawner. Spawners create all the other Zylons. They settle in resource sectors and build up their forces. Destroying all the Spawners is how you win the game. Spawners have crude shields, so you\'ll need to hit them multiple times. When attacked, a Spawner will try to flee — but it cannot fight back directly. It relies on warriors and fighters to defend it.',
      'Seekers are the Zylon scouts. A Spawner creates copies of itself — called Seekers — and sends them out to find new resource sectors. When a Seeker finds one, it transforms into a new Spawner and starts a new hive. If you find a Seeker in a sector with no resources, kill it fast. It will warp away to keep searching even while you\'re attacking it.',
      'When a Spawner starts a new colony, it first builds personal defenders — fighters called Birds and Ties. Each type has a different attack style. They are fast and aggressive, and their job is to protect the Spawner while it builds up its forces. Take them out early before the colony grows stronger.',
      'Warriors are the Zylon heavy weapons. Their job is to bombard your starbases until the shields fail. Once the shields are gone, they hold position and destroy any ships that try to resupply the base. In sectors without a starbase, warriors defend the Spawner that created them. Warriors have shields and will take several hits to destroy.',
      'There are two ways to lose. One — your ship is destroyed. Two — your Capital starbase falls to the Zylons. If the Capital is lost, all resistance collapses. Everything you need to fight comes from the Capital. Protect it.',
      'To win, you must destroy every Seeker and every Spawner on the map. But that\'s not the end. Once they\'re all gone, any remaining Zylon fighters are still out there. Survive them, fly to an active starbase, and dock. That final docking triggers your victory debriefing.',
      'That\'s everything you need to know to start the fight. The galaxy is counting on you, Star Fighter. Watch your energy. Protect the Capital. Destroy the Spawners. Good hunting.',
    ];
    return t[i] ?? '';
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  function next() {
    if (_idx < SLIDES.length - 1) { _idx++; _render(); _playAudio(SLIDES[_idx].audio); }
  }
  function prev() {
    if (_idx > 0) { _idx--; _render(); _playAudio(SLIDES[_idx].audio); }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function start(opts = {}) {
    if (_active) return;
    _active = true;
    _opts   = opts;
    _idx    = 0;

    _hlEl = document.createElement('div');
    _hlEl.id = 'tut-highlight';
    document.body.appendChild(_hlEl);

    _panelEl = document.createElement('div');
    _panelEl.id = 'tut-panel';
    document.body.appendChild(_panelEl);

    _opts.onStart?.();
    _render();
    _playAudio(SLIDES[0].audio);
    _rafId = requestAnimationFrame(_loop);
  }

  function exit() {
    _active = false;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_audioEl) { _audioEl.pause(); _audioEl = null; }
    _hlEl?.remove();    _hlEl    = null;
    _panelEl?.remove(); _panelEl = null;
    _opts.onExit?.();
    _opts = {};
  }

  return { start, exit, get isActive() { return _active; } };
})();
