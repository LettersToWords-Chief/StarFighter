/**
 * SoundManager.js — Star Raiders POKEY-Inspired Procedural Audio
 *
 * Faithfully recreated from the original POKEY chip data:
 *   NOISEPATTAB, BEEPPATTAB, BEEPFRQTAB, NOISETORPVOLTAB, NOISETORPFRQTAB
 *
 * POKEY constants:
 *   BASE_CLK = 63,920 Hz  (1.7897 MHz / 28) — channel 4 beeper clock
 *   HI_CLK   = 1,789,790 Hz                 — 1.79 MHz for channels 1–3
 *   TICK     = 1/60 s (NTSC VBI interrupt)
 */
const SoundManager = (() => {
  'use strict';

  const TICK     = 1 / 60;
  const BASE_CLK = 63920;
  const HI_CLK   = 1789790;

  let _ctx    = null;   // AudioContext
  let _master = null;   // master GainNode (volume headroom)
  let _noiseBuf = null; // shared 2-s white noise buffer

  // Engine persistent nodes
  let _engRunning     = false;
  let _engNoiseSrc    = null;
  let _engWallFilter  = null;
  let _engResFilter   = null;   // alias to _engWallFilter
  let _engNoiseGain   = null;
  let _engSubOsc      = null;   // sub-bass sine (hull vibration, 40–80 Hz)
  let _engSubGain     = null;
  let _engNorm        = 0;      // RC-filtered velocity 0–64 (avoids automation pile-up)

  // Red-alert looping state
  let _alertActive = false;
  let _alertOsc    = null;
  let _alertGain   = null;
  let _alertTimer  = null;

  // Damage-report one-shot guard (ms timestamp — silent until this time)
  let _dmgReportSilentUntil = 0;

  // ── AudioContext ──────────────────────────────────────────────────────────
  function _getCtx() {
    if (!_ctx) {
      _ctx    = new (window.AudioContext || window.webkitAudioContext)();
      _master = _ctx.createGain();
      _master.gain.value = 0.70;
      _master.connect(_ctx.destination);
      _buildNoiseBuf();
    }
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  function _buildNoiseBuf() {
    const sr  = _ctx.sampleRate;
    _noiseBuf = _ctx.createBuffer(1, sr * 2, sr);
    const d   = _noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  // POKEY CH4 beeper: Hz = BASE_CLK / (2*(AUDF4+1))
  function _bHz(audf) { return BASE_CLK / (2 * (audf + 1)); }

  // POKEY vol 0..15 → Web Audio 0..1
  function _vol(v)  { return (v / 15) * 0.85; }

  // Make a looping noise BufferSource connected to a target node
  function _makeNoiseSrc(ctx, target, startNow = true) {
    const src = ctx.createBufferSource();
    src.buffer = _noiseBuf;
    src.loop   = true;
    src.connect(target);
    if (startNow) src.start();
    return src;
  }

  // ── Beeper scheduler (CH4) ────────────────────────────────────────────────
  // freqs        : array of AUDF4 hex values (no $FF terminator)
  // toneLifeTicks: BEEPTONELIFE register value (plays toneLifeTicks+1 ticks)
  // pauseLifeTicks: BEEPPAUSELIFE ($FF = no pause)
  // beepRepeat   : BEEPREPEAT (plays sequence beepRepeat+1 times)
  // vol          : POKEY volume (0-15), AUDC4=$A8 → vol=8
  function _beeper(freqs, toneLifeTicks, pauseLifeTicks, beepRepeat, vol = 8) {
    const ctx     = _getCtx();
    const toneDur = (toneLifeTicks  + 1) * TICK;
    const pauDur  = (pauseLifeTicks === 0xFF) ? 0 : (pauseLifeTicks + 1) * TICK;
    const osc     = ctx.createOscillator();
    const gn      = ctx.createGain();
    osc.type = 'square';
    gn.gain.setValueAtTime(0, ctx.currentTime);
    osc.connect(gn);
    gn.connect(_master);
    const t0 = ctx.currentTime + 0.015;
    osc.start(t0);
    let t = t0;
    for (let rep = 0; rep <= beepRepeat; rep++) {
      for (const audf of freqs) {
        osc.frequency.setValueAtTime(_bHz(audf), t);
        gn.gain.setValueAtTime(_vol(vol), t);
        t += toneDur;
        gn.gain.setValueAtTime(0, t);
        if (pauDur > 0) t += pauDur;
      }
    }
    osc.stop(t + 0.05);
  }

  // ── Noise burst (explosions, torpedo tail) ────────────────────────────────
  // lifetime      : NOISELIFE (TICKs)
  // initPeriod    : initial 16-bit period counter (NOISEAUDF1 + NOISEAUDF2*256)
  // freqInc       : NOISEFRQINC (added to period each tick → pitch falls)
  // initVol       : POKEY vol 0..15
  // startDelay    : seconds before burst
  // muteAfterTick : tick at which gradual mute begins (default = lifetime-16)
  function _noiseBurst({ lifetime, initPeriod, freqInc = 0, initVol = 15,
                          startDelay = 0 }) {
    const ctx   = _getCtx();
    const now   = ctx.currentTime + startDelay + 0.015;
    const lifes = lifetime * TICK;
    const muteAt = Math.max(0, lifetime - 16) * TICK;

    const filter = ctx.createBiquadFilter();
    filter.type  = 'lowpass';
    filter.Q.value = 0.5;

    const gn = ctx.createGain();
    gn.gain.setValueAtTime(_vol(initVol), now);
    if (muteAt < lifes) {
      gn.gain.setValueAtTime(_vol(initVol), now + muteAt);
      gn.gain.linearRampToValueAtTime(0, now + lifes);
    }

    // Map 16-bit POKEY period to Web Audio filter frequency
    const periodToHz = p => Math.min(20000, Math.max(60, HI_CLK / Math.max(1, p)));
    filter.frequency.setValueAtTime(periodToHz(initPeriod), now);
    if (freqInc > 0) {
      for (let i = 1; i <= lifetime; i++) {
        filter.frequency.setValueAtTime(periodToHz(initPeriod + freqInc * i), now + i * TICK);
      }
    }

    const src = _makeNoiseSrc(ctx, filter, false);
    filter.connect(gn);
    gn.connect(_master);
    src.start(now);
    src.stop(now + lifes + 0.1);
  }

  // ── Torpedo fire (PHOTON TORPEDO LAUNCHED) ────────────────────────────────
  // Phase 1 (8 ticks): CH3 noise, volume envelope from NOISETORPVOLTAB
  //   volume table (indices 1..8, stored reversed): $8A,$8F,$8D,$8B,$89,$87,$85,$83
  //   freq table alternates $04,$01 on CH3 (NOISETORPFRQTAB)
  // Phase 2 (remaining 16 ticks): CH1/2 tone at ~3474 Hz, rapidly falling pitch
  function _torpedoFire() {
    const ctx = _getCtx();
    const now = ctx.currentTime + 0.015;

    // ── Phase 1: noise burst (8 ticks) ──
    const volTab = [10, 15, 13, 11, 9, 7, 5, 3]; // POKEY vol 0..15
    const frqTab = [0x00, 0x04, 0x01, 0x04, 0x01, 0x04, 0x01, 0x04]; // CH3 freq

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type  = 'bandpass';
    noiseFilter.Q.value = 0.3;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0, now);

    const nSrc = _makeNoiseSrc(ctx, noiseFilter, false);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(_master);
    nSrc.start(now);
    nSrc.stop(now + 8 * TICK + 0.05);

    for (let i = 0; i < 8; i++) {
      const t     = now + i * TICK;
      const fHz   = frqTab[i] === 0 ? 80 : HI_CLK / (frqTab[i] + 1);
      noiseFilter.frequency.setValueAtTime(fHz, t);
      noiseGain.gain.setValueAtTime(_vol(volTab[i]), t);
    }
    noiseGain.gain.setValueAtTime(0, now + 8 * TICK);

    // ── Phase 2: falling-pitch tone (16 ticks) ──
    const phase2Start = now + 8 * TICK;
    const osc  = ctx.createOscillator();
    const oGain = ctx.createGain();
    osc.type = 'sawtooth';

    // Initial freq: HI_CLK / ($0202 + 1) ≈ 3474 Hz
    // Each tick: period += $FF (255) → frequency falls fast
    const initPeriod = 0x0202;
    osc.frequency.setValueAtTime(HI_CLK / (initPeriod + 1), phase2Start);
    for (let i = 1; i <= 16; i++) {
      const period = initPeriod + 0xFF * i;
      osc.frequency.setValueAtTime(Math.max(60, HI_CLK / (period + 1)), phase2Start + i * TICK);
    }

    oGain.gain.setValueAtTime(0.5, phase2Start);
    oGain.gain.linearRampToValueAtTime(0, phase2Start + 16 * TICK);

    osc.connect(oGain);
    oGain.connect(_master);
    osc.start(phase2Start);
    osc.stop(phase2Start + 16 * TICK + 0.05);
  }

  // ── Zylon explosion ───────────────────────────────────────────────────────
  // NOISEPATTAB: NOISELIFE=$30, NOISEFRQINC=$40, initPeriod=$0103=259, initVol=$8A→vol10,
  //              NOISEAUDC2=$A8→vol8, NOISEEXPLTIM=$04 (burst after 4 ticks)
  function _zylonExplosion() {
    // Ch1/2 noise burst (high-pitched, falling, 48 ticks)
    _noiseBurst({ lifetime: 48, initPeriod: 259, freqInc: 64, initVol: 10 });
    // Delayed noise flash at 4 ticks (NOISEEXPLTIM)
    _noiseBurst({ lifetime: 10, initPeriod: 60,  freqInc: 0,  initVol: 15, startDelay: 4 * TICK });
  }

  // ── Shield explosion (player hit) ─────────────────────────────────────────
  // NOISEPATTAB: NOISELIFE=$40 (64), NOISEFRQINC=$40, initPeriod=259, initVol=15,
  //              NOISEEXPLTIM=$08 (burst after 8 ticks)
  function _shieldHit() {
    _noiseBurst({ lifetime: 64, initPeriod: 259, freqInc: 64, initVol: 15 });
    _noiseBurst({ lifetime: 10, initPeriod: 50,  freqInc: 0,  initVol: 15, startDelay: 8 * TICK });
  }

  // ── Red Alert (looping) ───────────────────────────────────────────────────
  // BEEPFRQTAB: [$40,$60] → 491 Hz / 330 Hz, 17 ticks each (no pause), loop
  function _startRedAlert() {
    if (_alertActive) return;
    _alertActive = true;
    const ctx   = _getCtx();
    const osc   = ctx.createOscillator();
    const gn    = ctx.createGain();
    osc.type    = 'square';
    gn.gain.setValueAtTime(0, ctx.currentTime);
    osc.connect(gn);
    gn.connect(_master);
    osc.start();
    _alertOsc  = osc;
    _alertGain = gn;

    const f1  = _bHz(0x40); // 491 Hz
    const f2  = _bHz(0x60); // 330 Hz
    const dur = 17 * TICK;
    const ALERT_DURATION_MS = 5000;
    const startedAt = Date.now();
    let phase = 0;

    function _kick() {
      if (!_alertActive) return;
      if (Date.now() - startedAt >= ALERT_DURATION_MS) {
        _stopRedAlert();
        return;
      }
      const now = _ctx.currentTime;
      _alertOsc.frequency.setValueAtTime(phase === 0 ? f1 : f2, now);
      _alertGain.gain.setValueAtTime(0.20, now);
      _alertGain.gain.setValueAtTime(0,    now + dur * 0.9);
      phase ^= 1;
      _alertTimer = setTimeout(_kick, dur * 1000);
    }
    _kick();
  }

  function _stopRedAlert() {
    _alertActive = false;
    clearTimeout(_alertTimer);
    if (_alertGain) {
      try { _alertGain.gain.linearRampToValueAtTime(0, _ctx.currentTime + 0.05); } catch(e){}
    }
    setTimeout(() => {
      try { _alertOsc?.stop(); } catch(e) {}
      _alertOsc = _alertGain = null;
    }, 100);
  }

  // ── Engine + warp sound ─────────────────────────────────────────────────────
  //
  // Unified engine/warp sound driven by raw velocity (0–64 u/s).
  // Frequency scale matches SPD_VALS exactly:
  //   v = 2  → 40 Hz (throttle 1, barely moving)
  //   v = 64 → 80 Hz (throttle 9 / warp peak)
  // Values above 64 are capped — so the burst phase (99999 u/s) sounds at 80 Hz.
  // The RC filter (alpha=0.04, TC~400 ms) makes all ramps feel physical.
  //
  // WARP SEQUENCE (no separate crescendo nodes needed):
  //   Charge  4 s: _currentVelocity ramps 5× normal → freq climbs 40→80 Hz
  //   Burst   1 s: velocity = 99999, capped at 64 → freq holds at 80 Hz
  //   Deburst 1 s: same cap → freq holds
  //   Decel   4 s: mirror ramp down → freq falls back to pre-warp value
  function _startEngine() {
    const ctx = _getCtx();

    // Sub-bass: hull vibration (40–80 Hz — matches the velocity scale)
    _engSubOsc  = ctx.createOscillator();
    _engSubOsc.type = 'sine';
    _engSubOsc.frequency.value = 40;
    _engSubGain = ctx.createGain();
    _engSubGain.gain.value = 0;
    _engSubOsc.connect(_engSubGain);
    _engSubGain.connect(_master);
    _engSubOsc.start();

    // Muffled noise: single lowpass, cutoff 200–450 Hz (muffled but audible)
    _engNoiseSrc = ctx.createBufferSource();
    _engNoiseSrc.buffer = _noiseBuf;
    _engNoiseSrc.loop   = true;

    _engWallFilter = ctx.createBiquadFilter();
    _engWallFilter.type = 'lowpass';
    _engWallFilter.frequency.value = 200;
    _engWallFilter.Q.value = 1.5;
    _engResFilter = _engWallFilter;   // alias

    _engNoiseGain = ctx.createGain();
    _engNoiseGain.gain.value = 0;

    _engNoiseSrc.connect(_engWallFilter);
    _engWallFilter.connect(_engNoiseGain);
    _engNoiseGain.connect(_master);
    _engNoiseSrc.start();

    _engRunning = true;
  }

  // vel: raw velocity in u/s — full range, no cap.
  // Linear extrapolation of the user-defined scale:
  //   v=2  → 40 Hz,  v=64 → 80 Hz,  slope = 40/62 Hz per u/s
  //   v=513 → ~370 Hz (end of 4-s warp charge)
  //   v=99999 → ~64 kHz (ultrasonic shriek at burst peak — by design)
  function _setEngineVelocity(vel) {
    const ctx = _getCtx();
    if (!_engRunning) _startEngine();

    // Asymmetric RC filter:
    //   Rising  (accel): alpha=0.04  → TC ~400 ms — weighty, inertial feel
    //   Falling (decel): alpha=0.25  → TC ~67 ms  — tracks deceleration immediately
    const target = Math.max(0, vel);
    const alpha  = target > _engNorm ? 0.04 : 0.25;
    _engNorm    += (target - _engNorm) * alpha;
    const v   = _engNorm;
    const now = ctx.currentTime;

    // Linear scale: 40 Hz at v=2, 80 Hz at v=64
    const slope  = 40 / 62;
    const subHz  = Math.max(20, 40 + (v - 2) * slope);

    // Gain: full at throttle 9 and above
    const norm   = Math.max(0, Math.min(1, (v - 2) / 62));
    const lfo    = Math.sin(now * Math.PI * 2 * 4.5) * norm * 0.15;

    _engSubOsc.frequency.setValueAtTime(subHz, now);
    _engSubGain.gain.setValueAtTime(Math.max(0, norm * 0.55 + lfo), now);

    // Noise cutoff scales proportionally (200-450 Hz over normal range, beyond that stays open)
    const cutHz = Math.max(200, 200 + (v - 2) * (250 / 62));
    _engWallFilter.frequency.setValueAtTime(cutHz, now);
    _engNoiseGain.gain.setValueAtTime(Math.max(0, norm * 0.60 + lfo * 0.4), now);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    // Initialise AudioContext from a user-gesture handler (MUST be called early)
    init() { _getCtx(); },

    // BEEPER PATTERNS (CH4) — exact POKEY data
    // (1) HYPERWARP TRANSIT: $18 → 1278 Hz, 4-tick tone, 3-tick pause, 13×
    warpTransit()    { _beeper([0x18], 0x03, 0.02, 12, 8); },

    // (2) RED ALERT: looping 491 Hz ↔ 330 Hz, 17-tick each, no pause
    redAlert()       { _startRedAlert(); },
    stopRedAlert()   { _stopRedAlert(); },

    // (3) ACKNOWLEDGE: 1880 Hz × 3 quick blips, 3-tick each, 3-tick pause, 1×
    acknowledge()    { _beeper([0x10, 0x10, 0x10], 0x02, 0x02, 0, 8); },

    // (4) DAMAGE REPORT: 491 → 969 Hz, 33-tick each, no pause, 3×
    //     Plays once, then silences itself until the full sequence finishes.
    damageReport() {
      const now = Date.now();
      if (now < _dmgReportSilentUntil) return;
      _dmgReportSilentUntil = now + 3500;
      _beeper([0x40, 0x20], 0x20, 0xFF, 2, 10);
    },

    // (5) MESSAGE FROM STARBASE: 438 → 491 → 390 Hz, 33-tick, 9-tick pause, 1×
    starbsMessage()  { _beeper([0x48, 0x40, 0x51], 0x20, 0x08, 0, 9); },

    // NOISE EFFECTS
    torpedoFire()    { _torpedoFire(); },
    zylonExplosion() { _zylonExplosion(); },
    shieldHit()      { _shieldHit(); },

    // ENGINE — call every frame with raw velocity in u/s.
    // Drives both normal flight and the warp sequence automatically.
    setEngineVelocity(v) { _setEngineVelocity(v); },

    // Bypass RC filter — snap to velocity immediately (no lag).
    // Call this at warp arrival to avoid the 99999-unit lag on decel start.
    snapEngineVelocity(v) { _engNorm = Math.max(0, v); },

    // MASTER VOLUME
    setVolume(v) {
      const ctx = _getCtx();
      _master.gain.setValueAtTime(Math.max(0, Math.min(1, v)), ctx.currentTime);
    },
  };
})();
