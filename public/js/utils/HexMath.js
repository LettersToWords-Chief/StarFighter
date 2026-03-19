/**
 * HexMath.js — Axial coordinate system for hexagonal grid
 *
 * Uses "pointy-top" hexagons with axial coordinates (q, r).
 * Cube coordinates (x, y, z) are used for distance math where needed.
 *
 * Reference: https://www.redblobgames.com/grids/hexagons/
 */

const HexMath = (() => {

  // --- Axial directions (6 neighbors) ---
  const DIRECTIONS = [
    { q:  1, r:  0 }, { q:  1, r: -1 }, { q:  0, r: -1 },
    { q: -1, r:  0 }, { q: -1, r:  1 }, { q:  0, r:  1 },
  ];

  /**
   * Convert axial (q,r) to pixel center (x,y) for a pointy-top hex.
   * @param {number} q
   * @param {number} r
   * @param {number} size  — hex circumradius in pixels
   * @returns {{ x: number, y: number }}
   */
  function axialToPixel(q, r, size) {
    const x = size * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r);
    const y = size * (3 / 2 * r);
    return { x, y };
  }

  /**
   * Convert pixel (x,y) to fractional axial (q,r).
   * Requires rounding via hexRound.
   */
  function pixelToAxial(x, y, size) {
    const q = (Math.sqrt(3) / 3 * x - 1 / 3 * y) / size;
    const r = (2 / 3 * y) / size;
    return hexRound(q, r);
  }

  /**
   * Convert axial to cube coordinates.
   */
  function axialToCube(q, r) {
    return { x: q, z: r, y: -q - r };
  }

  /**
   * Round fractional cube/axial coords to nearest hex.
   */
  function hexRound(q, r) {
    const x = q, z = r, y = -q - r;
    let rx = Math.round(x);
    let ry = Math.round(y);
    let rz = Math.round(z);
    const dx = Math.abs(rx - x);
    const dy = Math.abs(ry - y);
    const dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    return { q: rx, r: rz };
  }

  /**
   * Axial distance between two hexes.
   */
  function distance(a, b) {
    const ac = axialToCube(a.q, a.r);
    const bc = axialToCube(b.q, b.r);
    return Math.max(
      Math.abs(ac.x - bc.x),
      Math.abs(ac.y - bc.y),
      Math.abs(ac.z - bc.z)
    );
  }

  /**
   * Get the 6 neighbor hexes of (q, r).
   */
  function neighbors(q, r) {
    return DIRECTIONS.map(d => ({ q: q + d.q, r: r + d.r }));
  }

  /**
   * Get all hexes within `radius` rings of center (q, r).
   */
  function hexesInRange(q, r, radius) {
    const results = [];
    for (let dq = -radius; dq <= radius; dq++) {
      const rMin = Math.max(-radius, -dq - radius);
      const rMax = Math.min(radius, -dq + radius);
      for (let dr = rMin; dr <= rMax; dr++) {
        results.push({ q: q + dq, r: r + dr });
      }
    }
    return results;
  }

  /**
   * Generate the corners of a pointy-top hexagon centered at (cx, cy).
   */
  function hexCorners(cx, cy, size) {
    const corners = [];
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 180 * (60 * i + 30); // pointy-top
      corners.push({
        x: cx + size * Math.cos(angle),
        y: cy + size * Math.sin(angle),
      });
    }
    return corners;
  }

  /**
   * Hex key string for use as Map/object keys.
   */
  function key(q, r) { return `${q},${r}`; }

  /**
   * Parse a key back to {q, r}.
   */
  function parseKey(k) {
    const [q, r] = k.split(',').map(Number);
    return { q, r };
  }

  /**
   * Euclidean center-to-center distance in normalized hex units.
   * Derived from pointy-top axial→pixel conversion: d = sqrt(dq²+dq·dr+dr²).
   * Adjacent hexes = 1.0; straight-2 hop = 2.0; diagonal (2,-1) = sqrt(3) ≈ 1.73.
   */
  function euclideanDist(a, b) {
    const dq = b.q - a.q;
    const dr = b.r - a.r;
    return Math.sqrt(dq * dq + dq * dr + dr * dr);
  }

  // ROM warp energy table (WARPENERGYTAB × 10).
  // Distance 6 is a deliberate inflection — 1-5 affordable, 6+ expensive.
  const WARPENERGYTAB = [
    100,   // ~1.0
    130,   // ~2.0
    160,   // ~3.0
    200,   // ~4.0
    230,   // ~5.0
    500,   // ~6.0  ← tier break
    700,   // ~7.0
    800,   // ~8.0
    900,   // ~9.0
    1200,  // ~10.0
    1250,  // ~11.0
    1300,  // ~12.0
    1350,  // ~13.0
    1400,  // ~14.0
    1550,  // ~15.0
    1700,  // ~16.0
    1840,  // ~17.0
    2000,  // ~18.0
    2080,  // ~19.0
    2160,  // ~20.0
    2230,  // ~21.0
    2320,  // ~22.0
    2410,  // ~23.0
    2500,  // ~24.0+
  ];

  /**
   * Warp fuel cost using Euclidean center-to-center distance.
   * Angled jumps that are geometrically shorter cost less than straight-line
   * jumps of the same hex-count — player must find creative short-distance routes.
   * e.g. (4,-2) = Euclidean ≈3.46 → tier 3 = 160E  (vs straight (4,0) = 200E)
   */
  function fuelCost(from, to) {
    const d = euclideanDist(from, to);
    if (d < 0.01) return 0;
    // Round to nearest integer tier (0.5 rounds up)
    const tier = Math.min(Math.round(d), WARPENERGYTAB.length);
    return WARPENERGYTAB[Math.max(0, tier - 1)];
  }

  /**
   * Compute the hex-by-hex path from hex a to hex b using linear interpolation.
   * Returns an array of {q, r} including start and end.
   */
  function hexLine(a, b) {
    const d = distance(a, b);
    if (d === 0) return [{ q: a.q, r: a.r }];
    const results = [];
    for (let i = 0; i <= d; i++) {
      const t = i / d;
      const x = a.q + (b.q - a.q) * t;
      const z = a.r + (b.r - a.r) * t;
      const y = -x - z;
      results.push(hexRound(x, z));
    }
    return results;
  }

  /**
   * Generate one random shortest path from a to b.
   * At each step, picks randomly among all neighbors that reduce distance by 1.
   * This creates natural-looking routes that vary from the straight interpolation.
   */
  function hexRandomPath(a, b) {
    const path = [{ q: a.q, r: a.r }];
    let cur = { q: a.q, r: a.r };
    while (distance(cur, b) > 0) {
      const d = distance(cur, b);
      const nexts = neighbors(cur.q, cur.r).filter(n => distance(n, b) === d - 1);
      const next  = nexts[Math.floor(Math.random() * nexts.length)];
      path.push(next);
      cur = next;
    }
    return path;
  }

  /**
   * Generate up to `count` distinct shortest paths from a to b.
   * Distributes supply ship pipelines across all available route variations.
   * Always returns at least one path (the direct hexLine).
   */
  function hexAlternatePaths(a, b, count = 4) {
    const paths   = [];
    const seen    = new Set();
    const MAX_TRY = count * 12;

    for (let attempt = 0; attempt < MAX_TRY && paths.length < count; attempt++) {
      const path    = hexRandomPath(a, b);
      const pathKey = path.map(h => `${h.q},${h.r}`).join('|');
      if (!seen.has(pathKey)) {
        seen.add(pathKey);
        paths.push(path);
      }
    }

    // Fallback: always have at least the direct interpolation
    if (paths.length === 0) paths.push(hexLine(a, b));
    return paths;
  }

  return {
    axialToPixel,
    pixelToAxial,
    hexRound,
    distance,
    euclideanDist,
    neighbors,
    hexNeighbors: neighbors,
    hexesInRange,
    hexCorners,
    key,
    parseKey,
    fuelCost,
    hexLine,
    hexAlternatePaths,
    DIRECTIONS,
  };

})();
