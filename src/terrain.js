import { BufferGeometry, BufferAttribute } from 'three';

/**
 * Deterministic layered terrain for the infinite-world prototype.
 *
 * All heights are in meters. World coordinates are absolute (meters).
 * buildTileGeometry returns tile-local geometry (centered on 0,0 in XZ);
 * the caller positions the mesh at (tileX, 0, tileZ).
 *
 * No Math.random, time, or frame-dependent input is used anywhere in this file.
 */

export const LAYERS = Object.freeze({
  continental: {
    wavelengthM: 235000,      // continental / basin distribution
    amplitudeM: 3400,
    octaves: 5,
    lacunarity: 2.13,
    gain: 0.52,
  },
  continentalDetail: {
    wavelengthM: 82000,       // broad highland / lowland modulation
    amplitudeM: 1200,
    octaves: 3,
    lacunarity: 2.0,
    gain: 0.5,
  },
  plateau: {
    centerXM: 118000,
    centerZM: -138000,
    radiusXM: 120000,         // ~240 km across at the outer edge
    radiusZM: 105000,         // ~210 km across at the outer edge
    topHeightM: 8800,
  },
  ridge: {
    wavelengthM: 42000,       // primary ridged-multifractal scale along the belt
    amplitudeM: 19000,
    octaves: 5,
    lacunarity: 2.05,
    gain: 0.52,
    ridgePower: 2.15,
    beltHalfWidthM: 52000,    // belt is > 100 km wide with secondary ranges
    centerXM: -105000,        // the great range runs roughly north-south
    strikeEnvelopeM: 260000,  // > 300 km of continuous range
  },
  erosion: {
    wavelengthM: 5200,        // gully scale, stretched along fall line
    amplitudeM: 820,
    slopeStepM: 1100,
    canyonDepthM: 9300,       // super-canyon floor vs rim relief
    canyonFloorHalfWidthM: 2600,
    canyonWallHalfWidthM: 8800,
  },
  detail: {
    wavelengthM: 170,         // near-field detail, resolved only by fine LODs
    amplitudeM: 62,
  },
});

const FNV_PRIME_1 = 0x8DA6B343;
const FNV_PRIME_2 = 0xD8163841;

function hash2i(x, z, seed) {
  let h = (seed | 0) ^ Math.imul(x | 0, FNV_PRIME_1) ^ Math.imul(z | 0, FNV_PRIME_2);
  h = Math.imul(h ^ (h >>> 15), 0x9E3779B1);
  h = Math.imul(h ^ (h >>> 13), 0x85EBCA6B);
  return (h ^ (h >>> 16)) | 0;
}

function hash01(x, z, seed) {
  return (hash2i(x, z, seed) >>> 0) / 4294967295;
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function smoothstep(edge0, edge1, x) {
  if (x <= edge0) return 0;
  if (x >= edge1) return 1;
  const t = (x - edge0) / (edge1 - edge0);
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(x, a, b) {
  return x < a ? a : (x > b ? b : x);
}

/**
 * Integer-lattice value noise, range [0, 1].
 */
function valueNoise2(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const u = fade(fx);
  const v = fade(fz);

  const v00 = hash01(x0, z0, seed);
  const v10 = hash01(x0 + 1, z0, seed);
  const v01 = hash01(x0, z0 + 1, seed);
  const v11 = hash01(x0 + 1, z0 + 1, seed);

  return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
}

/**
 * Integer-lattice gradient noise, approximate range [-1, 1].
 */
function gradientNoise2(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const u = fade(fx);
  const v = fade(fz);

  const n00 = gradientDot(hash2i(x0, z0, seed), fx, fz);
  const n10 = gradientDot(hash2i(x0 + 1, z0, seed), fx - 1, fz);
  const n01 = gradientDot(hash2i(x0, z0 + 1, seed), fx, fz - 1);
  const n11 = gradientDot(hash2i(x0 + 1, z0 + 1, seed), fx - 1, fz - 1);

  const nx0 = lerp(n00, n10, u);
  const nx1 = lerp(n01, n11, u);
  return lerp(nx0, nx1, v);
}

function gradientDot(h, dx, dz) {
  switch (h & 7) {
    case 0: return dx + dz;
    case 1: return -dx + dz;
    case 2: return dx - dz;
    case 3: return -dx - dz;
    case 4: return dx;
    case 5: return -dx;
    case 6: return dz;
    default: return -dz;
  }
}

function fbmValue(x, z, octaves, lacunarity, gain, seed) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += amp * valueNoise2(x * freq + i * 17.31, z * freq - i * 11.17, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal built from gradient noise:
 *   r = 1 - abs(n); r = pow(r, ridgePower); sum amp * r
 * with per-octave gain decay. This creates connected ridge networks with
 * primary and secondary crest lines, not isolated peaks.
 */
function ridgedGradient(x, z, octaves, lacunarity, gain, ridgePower, seed) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    const n = gradientNoise2(
      x * freq + seed * 0.131 + i * 29.7,
      z * freq - seed * 0.073 + i * 19.3,
      seed + i * 131
    );
    let r = 1 - Math.abs(n);
    r = Math.pow(r, ridgePower);
    sum += amp * r;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function createTerrain(worldSeed) {
  const seed = worldSeed === undefined ? 20240819 : (worldSeed | 0);
  const seedContinental = seed ^ 0x0d1ce5a1;
  const seedContinentalDetail = seed ^ 0x3c6ef372;
  const seedRidge = seed ^ 0x51ab3d97;
  const seedRidgeWarp = seed ^ 0x1f9e6c4d;
  const seedErosion = seed ^ 0x27d4eb2f;
  const seedErosionFill = seed ^ 0x63f08b19;
  const seedDetail = seed ^ 0x7a41c9d3;

  function sampleContinental(x, z) {
    const a = fbmValue(
      x / LAYERS.continental.wavelengthM + 13.7,
      z / LAYERS.continental.wavelengthM - 7.3,
      LAYERS.continental.octaves,
      LAYERS.continental.lacunarity,
      LAYERS.continental.gain,
      seedContinental
    ) * 2 - 1;
    const b = fbmValue(
      x / LAYERS.continentalDetail.wavelengthM - 4.2,
      z / LAYERS.continentalDetail.wavelengthM + 9.1,
      LAYERS.continentalDetail.octaves,
      LAYERS.continentalDetail.lacunarity,
      LAYERS.continentalDetail.gain,
      seedContinentalDetail
    ) * 2 - 1;
    return a * LAYERS.continental.amplitudeM + b * LAYERS.continentalDetail.amplitudeM;
  }

  function samplePlateau(x, z) {
    const p = LAYERS.plateau;
    const dx = (x - p.centerXM) / p.radiusXM;
    const dz = (z - p.centerZM) / p.radiusZM;
    const r = Math.sqrt(dx * dx + dz * dz);
    const top = 1 - smoothstep(0.46, 0.95, r);
    if (top <= 0) return 0;
    const texture = valueNoise2(x / 16000 + 4.4, z / 16000 - 3.1, seedContinentalDetail);
    return top * (p.topHeightM + (texture - 0.5) * 520);
  }

  /**
   * A deterministic great mountain belt, more than 300 km long along Z.
   * A continuous crest profile is modulated and branched by ridged
   * multifractal noise in a stretched/warped domain.
   */
  function sampleRidge(x, z, octaves = LAYERS.ridge.octaves) {
    const rl = LAYERS.ridge;
    const u = z;
    const strikeEnv = 1 - smoothstep(170000, rl.strikeEnvelopeM, Math.abs(u));
    if (strikeEnv <= 0) return 0;

    const crestWarp =
      24000 * Math.sin(u * 0.0000175 + 1.2) +
      14000 * Math.sin(u * 0.000041 + 4.4);
    const v = x - (rl.centerXM + crestWarp);
    const vNorm = v / rl.beltHalfWidthM;
    const profile = Math.pow(Math.max(0, 1 - Math.abs(vNorm)), 2.0);

    const warpU = (fbmValue(
      u / 170000 + 21.3,
      v / 65000 - 8.7,
      3, 2.0, 0.5,
      seedRidgeWarp
    ) * 2 - 1) * 22000;
    const warpV = (fbmValue(
      u / 120000 - 31.7,
      v / 54000 + 17.2,
      3, 2.0, 0.5,
      seedRidgeWarp ^ 0x2f1a
    ) * 2 - 1) * 9500;

    const n = ridgedGradient(
      (u + warpU) / rl.wavelengthM,
      (v + warpV) / 12500,
      octaves,
      rl.lacunarity,
      rl.gain,
      rl.ridgePower,
      seedRidge
    );

    const edgeWeights = 0.3 + 0.7 * profile;
    const field = profile * (0.5 + n * 0.55 * edgeWeights);
    return rl.amplitudeM * strikeEnv * field;
  }

  /**
   * Low-frequency base: continental + continentalDetail + plateau + ridge.
   * This is the shared low-frequency part that every LOD samples with an
   * identical formula, so adjacent LOD levels agree wherever their layer
   * sets overlap. ridgeOctaves is reduced only for lodLevel >= 4.
   */
  function sampleBase(x, z, ridgeOctaves = LAYERS.ridge.octaves) {
    return sampleContinental(x, z) + samplePlateau(x, z) + sampleRidge(x, z, ridgeOctaves);
  }

  /**
   * Erosion approximation:
   *  - the super-canyon is carved as a deep, winding gorge;
   *  - gully noise is stretched along the local downhill direction;
   *  - on steep slopes high-frequency gullies fade out, while gentle
   *    slopes keep oriented drainage detail.
   *
   * The slope is estimated ONLY from the three low-frequency layers above
   * (continental + plateau + ridge). It never recurses into sampleHeight,
   * so erosion never triggers the detail layer or another erosion pass.
   */
  function sampleErosion(x, z, baseHeight, slopeWeighted) {
    const e = LAYERS.erosion;
    const canyonCenter = 46000 +
      15000 * Math.sin(z / 52000 + 0.8) +
      7000 * Math.sin(z / 17000 + 2.3);
    const canyonD = Math.abs(x - canyonCenter);
    const canyonEnv = 1 - smoothstep(190000, 270000, Math.abs(z));
    const canyonProfile = 1 - smoothstep(e.canyonFloorHalfWidthM, e.canyonWallHalfWidthM, canyonD);
    let height = -e.canyonDepthM * canyonProfile * canyonEnv;

    // Low-frequency finite-difference gradient. Two extra sampleBase calls
    // replace the old recursive height-function sampling.
    const step = e.slopeStepM;
    const hx = sampleBase(x + step, z);
    const hz = sampleBase(x, z + step);
    const gx = (hx - baseHeight) / step;
    const gz = (hz - baseHeight) / step;
    const gradientSq = gx * gx + gz * gz;
    const slope = slopeWeighted ? Math.sqrt(gradientSq) : 0;

    // Mid LODs keep the oriented low-frequency valley pattern but skip the
    // slope-dependent gully amplitude weighting.
    const steep = slopeWeighted ? smoothstep(0.16, 0.9, slope) : 0;
    const amp = e.amplitudeM * (1 - 0.86 * steep);

    const len = slope > 0 ? slope : Math.sqrt(gradientSq);
    let fx = 0.62;
    let fz = 0.78;
    if (len > 1e-5) {
      fx = -gx / len;
      fz = -gz / len;
    }

    const along = x * fx + z * fz;
    const cross = -x * fz + z * fx;
    const valley = valueNoise2(
      along / (e.wavelengthM * 1.65) + 2.1,
      cross / (e.wavelengthM * 0.34) - 1.4,
      seedErosion
    );
    const gully = -Math.abs(valley) * amp * 0.85;
    const fill = valueNoise2(
      x / (e.wavelengthM * 1.2) + 8.8,
      z / (e.wavelengthM * 1.2) - 5.5,
      seedErosionFill
    ) * amp * 0.22;

    return height + gully + fill;
  }

  function sampleDetail(x, z) {
    const d = LAYERS.detail;
    const a = gradientNoise2(
      x / d.wavelengthM + 0.7,
      z / d.wavelengthM - 0.3,
      seedDetail
    ) * d.amplitudeM * 0.52;
    const b = valueNoise2(
      x / (d.wavelengthM * 0.31) + 3.9,
      z / (d.wavelengthM * 0.31) - 2.6,
      seedDetail ^ 0x11
    ) * d.amplitudeM * 0.28;
    const c = gradientNoise2(
      x / (d.wavelengthM * 3.1) - 8.2,
      z / (d.wavelengthM * 3.1) + 6.4,
      seedDetail ^ 0x22
    ) * d.amplitudeM * 0.20;
    return a + b + c;
  }

  /**
   * LOD-aware height sampling.
   *
   * - lodLevel >= 4: continental + continentalDetail + plateau + ridge,
   *   with ridge octaves reduced to 3. erosion and detail are skipped.
   * - lodLevel 2-3: detail is skipped; erosion keeps its oriented
   *   low-frequency valley pattern but skips slope-weighted amplitude.
   * - lodLevel 0-1: all layers.
   *
   * Every layer uses the exact same deterministic formula at every LOD,
   * so repeated calls for the same (worldX, worldZ, lodLevel) are constant
   * and overlapping low-frequency parts match across adjacent levels.
   */
  function sampleHeight(worldX, worldZ, lodLevel = 0) {
    const coarse = lodLevel >= 4;
    const mid = !coarse && lodLevel >= 2;
    const ridgeOctaves = coarse ? 3 : LAYERS.ridge.octaves;
    const base = sampleBase(worldX, worldZ, ridgeOctaves);

    let height = base;
    if (!coarse) {
      height += sampleErosion(worldX, worldZ, base, !mid);
      if (!mid) {
        height += sampleDetail(worldX, worldZ);
      }
    }
    return height;
  }

  function sampleNormal(worldX, worldZ, step = 30) {
    const e = Math.max(1, step);
    const hL = sampleHeight(worldX - e, worldZ);
    const hR = sampleHeight(worldX + e, worldZ);
    const hD = sampleHeight(worldX, worldZ - e);
    const hU = sampleHeight(worldX, worldZ + e);
    let nx = (hL - hR) / (2 * e);
    let ny = 1;
    let nz = (hD - hU) / (2 * e);
    const len = Math.sqrt(nx * nx + 1 + nz * nz);
    return { x: nx / len, y: 1 / len, z: nz / len };
  }

  // ---- surface color (used by tile generation) -------------------------

  const DEEP_ROCK = [0.11, 0.09, 0.08];
  const DEEP_ROCK_B = [0.24, 0.17, 0.13];
  const LOW_EARTH = [0.42, 0.31, 0.19];
  const LOW_EARTH_B = [0.55, 0.44, 0.27];
  const FOREST = [0.18, 0.34, 0.17];
  const FOREST_B = [0.30, 0.43, 0.21];
  const MEADOW = [0.49, 0.47, 0.24];
  const MEADOW_B = [0.62, 0.57, 0.30];
  const ROCK = [0.50, 0.49, 0.48];
  const ROCK_B = [0.62, 0.62, 0.63];
  const SNOW = [0.88, 0.91, 0.94];
  const GLACIER = [0.67, 0.77, 0.88];

  function mix3(a, b, t) {
    return [
      lerp(a[0], b[0], t),
      lerp(a[1], b[1], t),
      lerp(a[2], b[2], t),
    ];
  }

  /**
   * Vertical biome zoning. Bands are ordered from deep canyon to summit:
   * dark rock -> lowland earth -> forest -> alpine meadow -> bare rock ->
   * snow -> glacial blue-white. Transitions overlap and use smoothstep, so
   * the bands stay readable while remaining continuous.
   *
   * The base snowline is ~6500 m. Steeper faces shed snow, which exposes
   * rock and pushes the visible snow transition higher.
   */
  function terrainColor(worldX, worldZ, height, slope) {
    let c = mix3(DEEP_ROCK, DEEP_ROCK_B, clamp((height + 9500) / 5200, 0, 1));
    c = mix3(c, LOW_EARTH, smoothstep(-5200, -2400, height));
    c = mix3(c, LOW_EARTH_B, smoothstep(-1400, 300, height));
    c = mix3(c, FOREST, smoothstep(0, 1400, height));
    c = mix3(c, FOREST_B, smoothstep(1200, 2600, height));
    c = mix3(c, MEADOW, smoothstep(2400, 4000, height));
    c = mix3(c, MEADOW_B, smoothstep(3800, 5200, height));
    c = mix3(c, ROCK, smoothstep(4800, 6400, height));

    // Steep faces expose raw rock regardless of elevation.
    const rockMask = smoothstep(0.55, 1.05, slope);
    c = mix3(c, ROCK_B, rockMask * 0.7);

    // Slope-aware snowline at ~6500 m on gentle ground.
    const steepness = smoothstep(0.35, 1.15, slope);
    const snowLine = 6500 + 2800 * steepness;
    const snowMask = smoothstep(snowLine, snowLine + 2300, height);
    c = mix3(c, SNOW, snowMask);

    // High, gentle accumulation zones shift toward glacial blue-white.
    const glacierMask = smoothstep(10800, 13400, height) * (1 - 0.62 * steepness);
    c = mix3(c, GLACIER, glacierMask);

    // Deterministic micro-variation so large triangles do not look flat.
    const variation = hash01(Math.floor(worldX / 48), Math.floor(worldZ / 48), seedDetail ^ 0x77);
    const v = (variation - 0.5) * 0.055;
    return [clamp(c[0] + v, 0, 1), clamp(c[1] + v, 0, 1), clamp(c[2] + v, 0, 1)];
  }

  // ---- tile geometry ----------------------------------------------------

  /**
   * Builds a tile-local BufferGeometry. tileX/tileZ are the world-space
   * center of the tile; the returned positions are centered around 0,0.
   * A vertical skirt is added on all four sides so adjacent LOD rings
   * never expose a gap, even where coarse and fine edge tessellation differ.
   */
  function buildTileGeometry(tileX, tileZ, tileSize, segments, options = {}) {
    const seg = Math.max(2, Math.floor(segments));
    const step = tileSize / seg;
    const n = seg + 1;
    const half = tileSize * 0.5;
    const skirtDepth = options.skirtDepth !== undefined
      ? options.skirtDepth
      : Math.max(1200, tileSize * 0.28);
    const lodLevel = options.lodLevel !== undefined ? options.lodLevel : 0;

    const heights = new Float32Array(n * n);
    for (let j = 0; j < n; j += 1) {
      const wz = tileZ - half + j * step;
      for (let i = 0; i < n; i += 1) {
        const wx = tileX - half + i * step;
        heights[j * n + i] = sampleHeight(wx, wz, lodLevel);
      }
    }

    const perim = (seg + 1) * 4;
    const vertexCount = n * n + perim;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);

    // Top grid vertices and per-vertex normals from height differences.
    for (let j = 0; j < n; j += 1) {
      const wz = tileZ - half + j * step;
      for (let i = 0; i < n; i += 1) {
        const wx = tileX - half + i * step;
        const idx = j * n + i;
        const h = heights[idx];
        positions[idx * 3] = -half + i * step;
        positions[idx * 3 + 1] = h;
        positions[idx * 3 + 2] = -half + j * step;

        let dhdx;
        if (i === 0) dhdx = (heights[idx + 1] - h) / step;
        else if (i === seg) dhdx = (h - heights[idx - 1]) / step;
        else dhdx = (heights[idx + 1] - heights[idx - 1]) / (2 * step);

        let dhdz;
        if (j === 0) dhdz = (heights[idx + n] - h) / step;
        else if (j === seg) dhdz = (h - heights[idx - n]) / step;
        else dhdz = (heights[idx + n] - heights[idx - n]) / (2 * step);

        let nx = -dhdx;
        let ny = 1;
        let nz = -dhdz;
        const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        normals[idx * 3] = nx * inv;
        normals[idx * 3 + 1] = inv;
        normals[idx * 3 + 2] = nz * inv;

        const slope = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
        const col = terrainColor(wx, wz, h, slope);
        colors[idx * 3] = col[0];
        colors[idx * 3 + 1] = col[1];
        colors[idx * 3 + 2] = col[2];
      }
    }

    // Edge bottom y per side, far enough below the whole edge to hide any
    // coarse/fine tessellation mismatch at LOD transitions.
    const edgeMin = [Infinity, Infinity, Infinity, Infinity];
    for (let k = 0; k <= seg; k += 1) {
      edgeMin[0] = Math.min(edgeMin[0], heights[k]);
      edgeMin[1] = Math.min(edgeMin[1], heights[seg * n + k]);
      edgeMin[2] = Math.min(edgeMin[2], heights[k * n]);
      edgeMin[3] = Math.min(edgeMin[3], heights[seg + k * n]);
    }

    const topEdgeStart = [
      (j) => j,
      (j) => seg * n + j,
      (j) => j * n,
      (j) => seg + j * n,
    ];
    const edgeNormal = [
      [0, -1, 0],
      [0, -1, 0],
      [0, -1, 0],
      [0, -1, 0],
    ];
    const edgeWallNormal = [
      [0, 0, -1],
      [0, 0, 1],
      [-1, 0, 0],
      [1, 0, 0],
    ];

    for (let e = 0; e < 4; e += 1) {
      const baseIdx = n * n + e * (seg + 1);
      const bottomY = edgeMin[e] - skirtDepth;
      for (let k = 0; k <= seg; k += 1) {
        const tx = -half + k * step;
        const tz = e === 0 ? -half : (e === 1 ? half : -half + k * step);
        const px = e >= 2 ? (e === 2 ? -half : half) : tx;
        const pz = e <= 1 ? tz : (e === 2 ? -half + k * step : -half + k * step);
        const vi = baseIdx + k;
        positions[vi * 3] = px;
        positions[vi * 3 + 1] = bottomY;
        positions[vi * 3 + 2] = pz;

        const topIdx = topEdgeStart[e](k);
        const topCol = [
          colors[topIdx * 3],
          colors[topIdx * 3 + 1],
          colors[topIdx * 3 + 2],
        ];
        const wallCol = terrainColor(
          tileX + px, tileZ + pz, bottomY,
          1
        );
        colors[vi * 3] = wallCol[0] * 0.35 + topCol[0] * 0.65;
        colors[vi * 3 + 1] = wallCol[1] * 0.35 + topCol[1] * 0.65;
        colors[vi * 3 + 2] = wallCol[2] * 0.35 + topCol[2] * 0.65;

        normals[vi * 3] = edgeWallNormal[e][0];
        normals[vi * 3 + 1] = edgeNormal[e][1];
        normals[vi * 3 + 2] = edgeWallNormal[e][2];
      }
    }

    const topTriangles = seg * seg * 2;
    const wallTriangles = seg * 4 * 2;
    const index = new Uint32Array((topTriangles + wallTriangles) * 3);
    let cursor = 0;

    for (let j = 0; j < seg; j += 1) {
      for (let i = 0; i < seg; i += 1) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        index[cursor++] = a;
        index[cursor++] = c;
        index[cursor++] = b;
        index[cursor++] = b;
        index[cursor++] = c;
        index[cursor++] = d;
      }
    }

    for (let e = 0; e < 4; e += 1) {
      const baseIdx = n * n + e * (seg + 1);
      for (let k = 0; k < seg; k += 1) {
        const t0 = topEdgeStart[e](k);
        const t1 = topEdgeStart[e](k + 1);
        const s0 = baseIdx + k;
        const s1 = baseIdx + k + 1;
        index[cursor++] = t0;
        index[cursor++] = s0;
        index[cursor++] = t1;
        index[cursor++] = t1;
        index[cursor++] = s0;
        index[cursor++] = s1;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.computeBoundingSphere();
    return geometry;
  }

  return {
    sampleHeight,
    sampleNormal,
    buildTileGeometry,
    LAYERS,
  };
}
