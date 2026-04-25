/**
 * IntroCrawlMusic.js — Procedural symphonic score for the intro crawl.
 *
 * Key: D minor  |  BPM: 52  |  ~140 seconds
 * Instruments: brass (sawtooth + bandpass), strings (5-voice detuned pad + reverb),
 *              bass (sine), timpani (pitch-drop sine + noise punch)
 */
const IntroCrawlMusic = (() => {
  'use strict';

  let _ctx = null, _masterGain = null;

  const BPM   = 52;
  const BEAT  = 60 / BPM;
  const HALF  = BEAT * 2;
  const WHOLE = BEAT * 4;
  const QTR   = BEAT;

  // Frequencies (Hz)
  const F = {
    C2:  65.41, D2:  73.42, E2:  82.41, F2:  87.31,
    G2:  98.00, A2: 110.00, Bb2: 116.54,
    C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61,
    G3: 196.00, A3: 220.00, Bb3: 233.08,
    C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23,
    G4: 392.00, A4: 440.00, Bb4: 466.16,
  };

  /* ------------------------------------------------------------------ */
  /* Reverb (impulse response from decaying noise)                       */
  /* ------------------------------------------------------------------ */
  function _makeReverb() {
    const conv = _ctx.createConvolver();
    const sr   = _ctx.sampleRate;
    const len  = Math.floor(sr * 3.2);
    const buf  = _ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.5);
      }
    }
    conv.buffer = buf;
    return conv;
  }

  /* ------------------------------------------------------------------ */
  /* Instruments                                                          */
  /* ------------------------------------------------------------------ */

  function _brass(rev, freq, t, dur, gain = 0.35) {
    const osc  = _ctx.createOscillator();
    const env  = _ctx.createGain();
    const filt = _ctx.createBiquadFilter();
    const wet  = _ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.value = freq;

    filt.type = 'bandpass';
    filt.frequency.value = freq * 2.5;
    filt.Q.value = 1.2;

    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain,        t + 0.12);
    env.gain.linearRampToValueAtTime(gain * 0.75, t + 0.40);
    env.gain.setValueAtTime(gain * 0.75,          t + dur - 0.25);
    env.gain.linearRampToValueAtTime(0,           t + dur);

    wet.gain.value = 0.22;

    osc.connect(filt);   filt.connect(env);
    env.connect(_masterGain);
    env.connect(wet);    wet.connect(rev);

    osc.start(t);  osc.stop(t + dur + 0.1);
  }

  function _strings(rev, freq, t, dur, gain = 0.10) {
    for (let i = 0; i < 5; i++) {
      const osc  = _ctx.createOscillator();
      const env  = _ctx.createGain();
      const filt = _ctx.createBiquadFilter();
      const wet  = _ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.value = freq * (1 + (i - 2) * 0.0025);

      filt.type = 'lowpass';
      filt.frequency.value = freq * 3.5;

      const g = gain / 5;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(g, t + 1.2);   // slow bow attack
      env.gain.setValueAtTime(g,          t + dur - 1.0);
      env.gain.linearRampToValueAtTime(0, t + dur);

      wet.gain.value = 0.65;

      osc.connect(filt);  filt.connect(env);
      env.connect(_masterGain);
      env.connect(wet);   wet.connect(rev);

      osc.start(t);  osc.stop(t + dur + 0.1);
    }
  }

  function _bass(rev, freq, t, dur, gain = 0.45) {
    const osc  = _ctx.createOscillator();
    const env  = _ctx.createGain();
    const filt = _ctx.createBiquadFilter();

    osc.type = 'sine';
    osc.frequency.value = freq;

    filt.type = 'lowpass';
    filt.frequency.value = 280;

    env.gain.setValueAtTime(0,           t);
    env.gain.linearRampToValueAtTime(gain, t + 0.25);
    env.gain.setValueAtTime(gain * 0.8,  t + dur - 0.4);
    env.gain.linearRampToValueAtTime(0,  t + dur);

    osc.connect(filt);  filt.connect(env);  env.connect(_masterGain);

    osc.start(t);  osc.stop(t + dur + 0.1);
  }

  function _timpani(rev, freq, t, gain = 0.50) {
    // Sine with fast pitch drop
    const osc = _ctx.createOscillator();
    const env = _ctx.createGain();
    const wet = _ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 1.6, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.07);

    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 2.8);

    wet.gain.value = 0.35;

    osc.connect(env);
    env.connect(_masterGain);
    env.connect(wet);  wet.connect(rev);

    osc.start(t);  osc.stop(t + 3.0);

    // Noise attack punch
    const bufLen = Math.floor(_ctx.sampleRate * 0.12);
    const nbuf   = _ctx.createBuffer(1, bufLen, _ctx.sampleRate);
    const nd     = nbuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) nd[i] = Math.random() * 2 - 1;

    const src  = _ctx.createBufferSource();
    const nEnv = _ctx.createGain();
    const nFil = _ctx.createBiquadFilter();
    src.buffer     = nbuf;
    nFil.type      = 'bandpass';
    nFil.frequency.value = 180;
    nFil.Q.value   = 0.6;
    nEnv.gain.setValueAtTime(gain * 0.45, t);
    nEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.10);

    src.connect(nFil);  nFil.connect(nEnv);  nEnv.connect(_masterGain);
    src.start(t);
  }

  /* ------------------------------------------------------------------ */
  /* Score                                                                */
  /* ------------------------------------------------------------------ */

  function _compose() {
    const rev = _makeReverb();
    rev.connect(_masterGain);
    const now = _ctx.currentTime + 0.3;

    /* ======================================================
       INTRO: Low string swell (0 – 11s)
       ====================================================== */
    _strings(rev, F.D3, now,        11, 0.22);
    _strings(rev, F.F3, now + 2,     9, 0.18);
    _strings(rev, F.A3, now + 4,     7, 0.14);
    _bass   (rev, F.D2, now,        11, 0.32);

    /* ======================================================
       SECTION A: Main brass theme  (bars 1–8)
       Theme: D4 F4 E4 D4 | C4– | A3 Bb3 A3 | G3–
       ====================================================== */
    const A = now + 11;

    // Bars 1-2
    _brass(rev, F.D4, A,                  HALF, 0.36);
    _brass(rev, F.F4, A + HALF,            QTR, 0.34);
    _brass(rev, F.E4, A + HALF + QTR,      QTR, 0.32);
    _brass(rev, F.D4, A + WHOLE,          HALF, 0.36);
    _brass(rev, F.C4, A + WHOLE + HALF,   HALF, 0.34);

    // Bars 3-4
    _brass(rev, F.A3,  A + WHOLE * 2,                HALF, 0.34);
    _brass(rev, F.Bb3, A + WHOLE * 2 + HALF,          QTR, 0.32);
    _brass(rev, F.A3,  A + WHOLE * 2 + HALF + QTR,    QTR, 0.30);
    _brass(rev, F.G3,  A + WHOLE * 3,               WHOLE, 0.35);

    // String harmony
    _strings(rev, F.D3, A, WHOLE * 4, 0.20);
    _strings(rev, F.F3, A, WHOLE * 4, 0.16);
    _strings(rev, F.A3, A, WHOLE * 4, 0.13);

    // Bass
    _bass(rev, F.D2, A,             WHOLE, 0.48);
    _bass(rev, F.D2, A + WHOLE,     WHOLE, 0.46);
    _bass(rev, F.A2, A + WHOLE * 2, WHOLE, 0.48);
    _bass(rev, F.G2, A + WHOLE * 3, WHOLE, 0.46);

    // Timpani — downbeats
    _timpani(rev, F.D2, A,              0.52);
    _timpani(rev, F.D2, A + WHOLE,      0.44);
    _timpani(rev, F.A2, A + WHOLE * 2,  0.52);
    _timpani(rev, F.G2, A + WHOLE * 3,  0.48);

    /* ======================================================
       SECTION B: Continuation (bars 9–16)
       A3 C4 Bb3 | A3– | G3 A3 Bb3 | D4–
       ====================================================== */
    const B = A + WHOLE * 4;

    _brass(rev, F.A3,  B,                  HALF, 0.34);
    _brass(rev, F.C4,  B + HALF,            QTR, 0.32);
    _brass(rev, F.Bb3, B + HALF + QTR,      QTR, 0.30);
    _brass(rev, F.A3,  B + WHOLE,          WHOLE, 0.36);

    _brass(rev, F.G3,  B + WHOLE * 2,             HALF, 0.34);
    _brass(rev, F.A3,  B + WHOLE * 2 + HALF,        QTR, 0.32);
    _brass(rev, F.Bb3, B + WHOLE * 2 + HALF + QTR,  QTR, 0.30);
    _brass(rev, F.D4,  B + WHOLE * 3,             WHOLE, 0.38);

    _strings(rev, F.A3, B,             WHOLE * 2, 0.20);
    _strings(rev, F.C4, B,             WHOLE * 2, 0.16);
    _strings(rev, F.E3, B,             WHOLE * 2, 0.13);
    _strings(rev, F.Bb3, B + WHOLE*2,  WHOLE * 2, 0.20);
    _strings(rev, F.D3,  B + WHOLE*2,  WHOLE * 2, 0.16);
    _strings(rev, F.F3,  B + WHOLE*2,  WHOLE * 2, 0.13);

    _bass(rev, F.A2,  B,              WHOLE, 0.48);
    _bass(rev, F.A2,  B + WHOLE,      WHOLE, 0.46);
    _bass(rev, F.Bb2, B + WHOLE * 2,  WHOLE, 0.48);
    _bass(rev, F.D2,  B + WHOLE * 3,  WHOLE, 0.52);

    _timpani(rev, F.A2,  B,              0.48);
    _timpani(rev, F.A2,  B + HALF,       0.32);
    _timpani(rev, F.A2,  B + WHOLE,      0.44);
    _timpani(rev, F.Bb2, B + WHOLE * 2,  0.50);
    _timpani(rev, F.D2,  B + WHOLE * 3,  0.58);

    /* ======================================================
       SECTION C: Da capo — louder, higher voicing (bars 17–24)
       ====================================================== */
    const C = B + WHOLE * 4;

    _brass(rev, F.D4, C,                  HALF, 0.46);
    _brass(rev, F.F4, C + HALF,            QTR, 0.42);
    _brass(rev, F.A4, C + HALF + QTR,      QTR, 0.42);
    _brass(rev, F.G4, C + WHOLE,          HALF, 0.44);
    _brass(rev, F.E4, C + WHOLE + HALF,   HALF, 0.40);

    _brass(rev, F.F4, C + WHOLE * 2,                HALF, 0.44);
    _brass(rev, F.E4, C + WHOLE * 2 + HALF,          QTR, 0.40);
    _brass(rev, F.D4, C + WHOLE * 2 + HALF + QTR,    QTR, 0.38);
    _brass(rev, F.D4, C + WHOLE * 3,               WHOLE, 0.44);

    // Bigger strings
    _strings(rev, F.D3, C, WHOLE * 4, 0.24);
    _strings(rev, F.F3, C, WHOLE * 4, 0.20);
    _strings(rev, F.A3, C, WHOLE * 4, 0.17);
    _strings(rev, F.D4, C, WHOLE * 4, 0.11);

    _bass(rev, F.D2, C,             WHOLE, 0.52);
    _bass(rev, F.D2, C + WHOLE,     WHOLE, 0.50);
    _bass(rev, F.F2, C + WHOLE * 2, WHOLE, 0.52);
    _bass(rev, F.D2, C + WHOLE * 3, WHOLE, 0.54);

    // Driving timpani
    _timpani(rev, F.D2, C,                  0.68);
    _timpani(rev, F.D2, C + QTR * 3,        0.50);
    _timpani(rev, F.D2, C + WHOLE,          0.62);
    _timpani(rev, F.D2, C + WHOLE+QTR*3,   0.50);
    _timpani(rev, F.F2, C + WHOLE * 2,      0.68);
    _timpani(rev, F.F2, C + WHOLE*2+QTR*3, 0.50);
    _timpani(rev, F.D2, C + WHOLE * 3,      0.75);

    /* ======================================================
       CLIMAX: Big D minor chord + resolution
       ====================================================== */
    const R = C + WHOLE * 4;

    _brass(rev, F.D4, R, WHOLE * 3, 0.52);
    _brass(rev, F.F4, R, WHOLE * 3, 0.32);
    _brass(rev, F.A4, R, WHOLE * 3, 0.22);

    _strings(rev, F.D3, R, WHOLE * 4 + 4, 0.26);
    _strings(rev, F.F3, R, WHOLE * 4 + 4, 0.22);
    _strings(rev, F.A3, R, WHOLE * 4 + 4, 0.18);
    _strings(rev, F.D4, R, WHOLE * 4 + 4, 0.12);

    _bass(rev, F.D2, R,             WHOLE * 2, 0.58);
    _bass(rev, F.D2, R + WHOLE * 2, WHOLE * 2, 0.40);

    _timpani(rev, F.D2, R,            0.78);
    _timpani(rev, F.D2, R + BEAT,     0.58);
    _timpani(rev, F.D2, R + BEAT * 2, 0.44);

    // Graceful fade out
    const fadeStart = R + WHOLE * 2;
    const fadeEnd   = R + WHOLE * 4 + 5;
    _masterGain.gain.setValueAtTime(0.65, fadeStart);
    _masterGain.gain.linearRampToValueAtTime(0.0, fadeEnd);
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                           */
  /* ------------------------------------------------------------------ */

  function start() {
    try {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
      _masterGain = _ctx.createGain();
      _masterGain.gain.value = 0.65;
      _masterGain.connect(_ctx.destination);

      function _tryCompose() {
        _ctx.resume().then(() => _compose()).catch(e => console.warn('Music resume failed', e));
      }

      if (_ctx.state === 'running') {
        _compose();
      } else {
        // Wait for first gesture — resume on click, keydown, or touch
        const _onGesture = () => {
          document.removeEventListener('click',      _onGesture);
          document.removeEventListener('keydown',    _onGesture);
          document.removeEventListener('touchstart', _onGesture);
          _tryCompose();
        };
        document.addEventListener('click',      _onGesture, { once: true });
        document.addEventListener('keydown',    _onGesture, { once: true });
        document.addEventListener('touchstart', _onGesture, { once: true });
      }
    } catch (e) {
      console.warn('IntroCrawlMusic: Web Audio not available', e);
    }
  }

  function stop() {
    if (_masterGain && _ctx) {
      _masterGain.gain.setTargetAtTime(0, _ctx.currentTime, 0.8);
      setTimeout(() => {
        try { _ctx.close(); } catch (_) {}
        _ctx = null;
        _masterGain = null;
      }, 4000);
    }
  }

  return { start, stop };
})();
