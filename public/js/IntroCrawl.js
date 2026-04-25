/**
 * IntroCrawl.js — Three.js glass-sheet crawl for the intro overlay.
 */
const IntroCrawl = (() => {
  'use strict';

  const STORY = [
    'For generations mankind has expanded into the vast expanse of space, searching for resources. We found ourselves alone in the galaxy. We were our only adversary, and we had found a sustained peace. Weapons of war were lost to history.',
    '',
    'Until....',
    '',
    'Without warning we were swarmed by a ruthless enemy. An enemy without mercy. An enemy that refused to communicate.',
    '',
    'The Zylons.',
    '',
    'Outposts in the far reaches of space began to fall to the Zylons as they spread out in search of the same precious resources that we need to sustain our civilization.',
    '',
    'A desperate effort has been made to defend our starbases from the Zylons, but it is not enough. Ancient technology has been restored to go on the offensive. You are in command of that technology.',
    '',
    'You are the Star Fighter.',
  ];

  const PLANE_WIDTH  = 10;
  const PLANE_LENGTH = 100;
  const SPEED        = 0.8;  // units per second

  let _renderer = null, _scene = null, _camera = null, _plane = null, _animId = null;
  let _alertText = '';

  function _makeTexture() {
    const canvas = document.createElement('canvas');
    canvas.width  = 1024;
    canvas.height = 4096;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle    = 'rgba(220, 200, 120, 1.0)';
    ctx.font         = '52px "Share Tech Mono", monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';

    // Word-wrap all story lines to fit the canvas width
    function wrapLines(text, maxWidth) {
      const words = text.split(' ');
      const lines = [];
      let current = '';
      for (const word of words) {
        const test = current ? current + ' ' + word : word;
        if (ctx.measureText(test).width > maxWidth && current) {
          lines.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) lines.push(current);
      return lines;
    }

    const lineH = 80;
    let y = 60;
    for (const line of STORY) {
      if (!line) { y += lineH; continue; }
      const wrapped = wrapLines(line, 900);
      for (const wl of wrapped) {
        ctx.fillText(wl, canvas.width / 2, y);
        y += lineH;
      }
    }

    return new THREE.CanvasTexture(canvas);
  }

  function start(container, alertText) {
    _alertText = alertText || '';
    const w = container.clientWidth  || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;

    _scene  = new THREE.Scene();

    // Camera at ship level: 1 unit high, looking forward
    _camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 5000);
    _camera.position.set(0, 1, 0);
    _camera.lookAt(0, -56.7, -100);   // 30° down from horizontal

    const canvas = document.getElementById('intro-crawl-canvas');
    _renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    _renderer.setSize(w, h);
    _renderer.setClearColor(0x000000, 0);

    // Wait for Orbitron to be available in the canvas context before drawing
    document.fonts.load('52px "Share Tech Mono"').then(() => {
      const geo = new THREE.PlaneGeometry(PLANE_WIDTH, PLANE_LENGTH);
      const tex = _makeTexture();
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
      _plane = new THREE.Mesh(geo, mat);
      _plane.rotation.x = -Math.PI / 2;
      _plane.position.set(0, -2, 48);    // start 2 units advanced

      _scene.add(_plane);

      let _last = performance.now();
      function loop(now) {
        _animId = requestAnimationFrame(loop);
        const dt = (now - _last) / 1000;
        _last = now;
        _plane.position.z -= SPEED * dt;
        _renderer.render(_scene, _camera);
      }
      loop(performance.now());
    });
  }

  function stop() {
    if (_animId) { cancelAnimationFrame(_animId); _animId = null; }
    if (_renderer) { _renderer.dispose(); _renderer = null; }
    _scene = null; _camera = null; _plane = null;
  }

  return { start, stop };
})();
