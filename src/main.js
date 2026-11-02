import * as THREE from 'three';
import { createTerrain } from './terrain.js';

// ---------------------------------------------------------------------------
// Core setup
// ---------------------------------------------------------------------------

const WORLD_SEED = (() => {
  const q = new URLSearchParams(window.location.search).get('seed');
  return q ? (Number(q) || 20240819) : 20240819;
})();

const terrain = createTerrain(WORLD_SEED);

const canvas = document.createElement('canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(canvas);

const scene = new THREE.Scene();
const HORIZON_COLOR = new THREE.Color(0xa9c2d6);
scene.background = HORIZON_COLOR;

const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.6,
  2200000
);
camera.rotation.order = 'YXZ';
camera.rotation.set(-0.08, Math.PI * 0.5, 0);

const hemiLight = new THREE.HemisphereLight(0xcfe2ff, 0x6a5945, 1.1);
scene.add(hemiLight);

const sun = new THREE.DirectionalLight(0xfff0d2, 2.4);
sun.position.set(32000, 52000, 22000);
scene.add(sun);
scene.add(sun.target);

const SUN_OFFSET = new THREE.Vector3(0.55, 0.82, 0.34).multiplyScalar(90000);

// Distant sky dome: zenith-to-horizon gradient + a soft sun, always centered
// on the camera so the horizon stays at the expected angular height.
const skyUniforms = {
  topColor: { value: new THREE.Color(0x2e5d9e) },
  horizonColor: { value: new THREE.Color(0xa9c2d6) },
  sunDirection: { value: new THREE.Vector3(0.45, 0.35, 0.82).normalize() },
};
const skyMaterial = new THREE.ShaderMaterial({
  uniforms: skyUniforms,
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  vertexShader: `
    varying vec3 vWorldPosition;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPosition = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    varying vec3 vWorldPosition;
    uniform vec3 topColor;
    uniform vec3 horizonColor;
    uniform vec3 sunDirection;
    void main() {
      vec3 dir = normalize(vWorldPosition);
      float h = clamp(dir.y, -0.08, 1.0);
      float t = pow(clamp(h * 1.9 + 0.04, 0.0, 1.0), 0.62);
      vec3 col = mix(horizonColor, topColor, t);
      float sunAmt = pow(max(dot(dir, normalize(sunDirection)), 0.0), 14.0);
      col += vec3(1.0, 0.92, 0.72) * sunAmt * 0.38;
      col += vec3(0.92, 0.82, 0.68) * pow(max(dot(dir, normalize(sunDirection)), 0.0), 140.0) * 0.5;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1500000, 40, 18), skyMaterial);
skyMesh.renderOrder = -100;
skyMesh.frustumCulled = false;
scene.add(skyMesh);

// Terrain surface with vertex colors and a multi-band atmospheric falloff.
// The shader injection below replaces Three.js' single fog term entirely:
// near terrain keeps its original color, then successive distance bands cool
// it toward blue, desaturate it, and finally merge it into the sky color.
const atmosphereUniforms = {
  midColor: { value: new THREE.Color(0xa8bcd1) },
  farColor: { value: new THREE.Color(0x86a2bd) },
  skyColor: { value: HORIZON_COLOR.clone() },
  density: { value: 1.0 },
  planetRadius: { value: 2000000.0 },
};

const terrainMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.94,
  metalness: 0.0,
  side: THREE.DoubleSide,
});

terrainMaterial.onBeforeCompile = (shader) => {
  shader.uniforms = { ...shader.uniforms, ...atmosphereUniforms };

  shader.vertexShader = shader.vertexShader
    .replace('#include <fog_pars_vertex>', `
      varying float vAtmoDist;
      uniform float planetRadius;
    `)
    .replace('#include <project_vertex>', `
      {
        // Planet-curvature hint: sink distant terrain quadratically, as if
        // it followed a sphere with a 2000 km radius. Applied per-vertex so
        // the horizon bends downward while collision geometry stays cheap.
        vec4 planetWorld = modelMatrix * vec4(transformed, 1.0);
        vec3 planetRel = planetWorld.xyz - cameraPosition;
        float planetDrop = (planetRel.x * planetRel.x + planetRel.z * planetRel.z) /
          (2.0 * planetRadius);
        transformed.y -= planetDrop;
      }
      #include <project_vertex>
    `)
    .replace('#include <fog_vertex>', `
      vAtmoDist = length(mvPosition.xyz);
    `);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <fog_pars_fragment>', `
      uniform vec3 midColor;
      uniform vec3 farColor;
      uniform vec3 skyColor;
      uniform float density;
      varying float vAtmoDist;
    `)
    .replace('#include <fog_fragment>', `
      {
        float atmoDist = max(vAtmoDist, 0.0) * density;
        float midT = smoothstep(3500.0, 15000.0, atmoDist);
        float farT = smoothstep(13000.0, 75000.0, atmoDist);
        float deepT = smoothstep(65000.0, 230000.0, atmoDist);
        float skyT = smoothstep(190000.0, 500000.0, atmoDist);

        vec3 atmoCol = gl_FragColor.rgb;
        atmoCol = mix(atmoCol, midColor, midT * 0.38);
        float atmoLuma = dot(atmoCol, vec3(0.299, 0.587, 0.114));
        vec3 atmoFar = mix(vec3(atmoLuma), farColor, 0.58);
        atmoCol = mix(atmoCol, atmoFar, farT * 0.86);
        atmoCol = mix(atmoCol, skyColor, deepT * 0.55);
        atmoCol = mix(atmoCol, skyColor, skyT);
        gl_FragColor.rgb = atmoCol;
      }
    `);
};

// Three noise-shaped horizontal cloud decks at fixed world altitudes. They
// follow the player in XZ while sampling world-space noise, so the pattern is
// deterministic and effectively infinite. Holes are cut by a second noise
// field; mountains taller than a deck simply render in front of it.
const CLOUD_ALTITUDES = [2500, 4000, 5500];
const CLOUD_RADIUS_M = 110000;
const cloudLayers = [];

for (let c = 0; c < CLOUD_ALTITUDES.length; c += 1) {
  const cloudUniforms = {
    uWorldOrigin: { value: new THREE.Vector2() },
    uLayerSeed: { value: 11.3 + c * 17.7 },
    uOpacity: { value: 0.6 - c * 0.07 },
    uRadius: { value: CLOUD_RADIUS_M },
  };
  const cloudMaterial = new THREE.ShaderMaterial({
    uniforms: cloudUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: `
      varying vec2 vCloudWorld;
      varying float vCloudLocalDist;
      uniform vec2 uWorldOrigin;
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vCloudWorld = worldPos.xz + uWorldOrigin;
        vCloudLocalDist = length(position.xy);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      varying vec2 vCloudWorld;
      varying float vCloudLocalDist;
      uniform float uLayerSeed;
      uniform float uOpacity;
      uniform float uRadius;
      #include <logdepthbuf_pars_fragment>

      float hash21(vec2 p) {
        p = fract(p * vec2(0.1031, 0.1030));
        p += dot(p, p.yx + 33.33);
        return fract((p.x + p.y) * p.x);
      }

      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      float fbm(vec2 p) {
        float value = 0.0;
        float amp = 0.5;
        for (int i = 0; i < 4; i += 1) {
          value += amp * vnoise(p);
          p = p * 2.13 + vec2(17.7, 9.3);
          amp *= 0.52;
        }
        return value;
      }

      void main() {
        vec2 p = vCloudWorld;
        float field = fbm(p * 0.000055 + uLayerSeed * 3.17);
        float shape = fbm(p * 0.00022 + uLayerSeed * 9.11);
        float puffs = fbm(p * 0.0009 + uLayerSeed * 4.73);

        float cover = smoothstep(0.44, 0.72, field * 0.62 + puffs * 0.38);
        float holes = smoothstep(0.22, 0.68, shape);
        float density = cover * holes;

        float edge = 1.0 - smoothstep(uRadius * 0.68, uRadius, vCloudLocalDist);
        float shade = 0.86 + 0.14 * clamp((puffs - 0.5) * 1.6 + 0.5, 0.0, 1.0);
        vec3 col = vec3(1.0, 0.992, 0.975) * shade;

        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(col, density * uOpacity * edge);
      }
    `,
  });

  const cloudGeometry = new THREE.PlaneGeometry(CLOUD_RADIUS_M * 2, CLOUD_RADIUS_M * 2, 24, 24);
  const cloudMesh = new THREE.Mesh(cloudGeometry, cloudMaterial);
  cloudMesh.rotation.x = -Math.PI * 0.5;
  cloudMesh.renderOrder = 20 + c;
  cloudMesh.frustumCulled = false;
  scene.add(cloudMesh);
  cloudLayers.push({ mesh: cloudMesh, material: cloudMaterial, altitude: CLOUD_ALTITUDES[c] });
}

// ---------------------------------------------------------------------------
// LOD configuration
// ---------------------------------------------------------------------------

const BASE_TILE_SIZE = 500;
const LEVEL_COUNT = 9;
const SEGMENTS = [32, 28, 24, 20, 16, 14, 12, 10, 8];
const LEVELS = [];
const RING_RADII = [];

for (let l = 0; l < LEVEL_COUNT; l += 1) {
  const tileSize = BASE_TILE_SIZE * (2 ** l);
  LEVELS.push({ tileSize, segments: SEGMENTS[l] });
  // Ring boundary between level l and l+1. Level 0 fills a 2 km square;
  // the outermost boundary is 512 km, so visibility is in the 500 km class.
  RING_RADII.push(2000 * (2 ** l));
}

const MAX_LOADED_TILES = 620;
const BUILD_BUDGET_MS = 12;
const MAX_BUILDS_PER_FRAME = 4;
const MAX_PREVIEW_BUILDS_PER_FRAME = 24;

// Stage A builds a very cheap coarse preview for every desired tile so the
// whole visible horizon exists immediately. Stage B replaces those previews
// with the tile's real LOD in far-to-near, feet-first, near-detail order.
const PREVIEW_SEGMENTS = 6;
const PREVIEW_LOD_LEVEL = LEVEL_COUNT - 1;
const OUTLINE_MIN_LEVEL = 4;

// ---------------------------------------------------------------------------
// Flight state
// ---------------------------------------------------------------------------

const keys = new Set();
let isLocked = false;
let throttle = 0.02;
let speed = 100;
let yaw = Math.PI * 0.5;
let pitch = -0.08;

const MIN_SPEED = 100;
const MAX_SPEED = 3000;

// Absolute world position of the aircraft (HUD uses this).
const playerPos = new THREE.Vector3(-35000, 8200, -42000);

// Scene origin in world coordinates (XZ only; world Y is kept absolute).
// Rebased while flying so GPU float precision never degrades even after
// thousands of kilometers.
let renderOrigin = new THREE.Vector3(playerPos.x, 0, playerPos.z);
const REBASE_DISTANCE = 6000;

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const flightVelocity = new THREE.Vector3();

// ---------------------------------------------------------------------------
// LOD scheduler
// ---------------------------------------------------------------------------

const loadedTiles = new Map();   // key -> { mesh, geometry, level, tileX, tileZ }
const buildTasks = new Map();    // key -> tile descriptor

function computeSquareBounds(center, radius, snapSize) {
  const x0 = Math.floor((center.x - radius) / snapSize) * snapSize;
  const x1 = Math.ceil((center.x + radius) / snapSize) * snapSize;
  const z0 = Math.floor((center.z - radius) / snapSize) * snapSize;
  const z1 = Math.ceil((center.z + radius) / snapSize) * snapSize;
  return { x0, x1, z0, z1 };
}

function pointSegmentDistanceXZ(p, a, b) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  let t = 0;
  if (len2 > 1e-12) {
    t = ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2;
    t = THREE.MathUtils.clamp(t, 0, 1);
  }
  const dx = p.x - (a.x + t * abx);
  const dz = p.z - (a.z + t * abz);
  return Math.sqrt(dx * dx + dz * dz);
}

function tilePriority(descriptor, velocity) {
  const groundSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
  const lookAhead = THREE.MathUtils.clamp(groundSpeed * 2.5, 4000, 100000);
  let dirX = 0;
  let dirZ = -1;
  if (groundSpeed > 0.5) {
    dirX = velocity.x / groundSpeed;
    dirZ = velocity.z / groundSpeed;
  }
  const endX = playerPos.x + dirX * lookAhead;
  const endZ = playerPos.z + dirZ * lookAhead;
  const end = _priorityEnd.set(endX, endZ);
  const pathDist = pointSegmentDistanceXZ(descriptor.center, playerPos, end);
  // Nearer LOD levels are more urgent, but inside each level the queue is
  // ordered by distance to the predicted flight path (prefetching ahead).
  return pathDist + descriptor.level * 2300;
}

const _priorityEnd = new THREE.Vector3();

function distanceToPlayer(descriptor) {
  const dx = descriptor.tileX - playerPos.x;
  const dz = descriptor.tileZ - playerPos.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// Stage A priority: every preview has roughly equal cost, so build from the
// far horizon inward. The first visible thing is a complete world silhouette.
function previewPriority(descriptor) {
  return -distanceToPlayer(descriptor);
}

function playerTileIndex() {
  const S = LEVELS[0].tileSize;
  return {
    i: Math.floor(playerPos.x / S),
    j: Math.floor(playerPos.z / S),
  };
}

// Stage B priority, in order:
//   1. far-to-near coarse outlines (cheap LOD first);
//   2. the tile under the player's feet;
//   3. remaining near tiles, closest and finest first.
function finalTilePriority(descriptor) {
  const dist = distanceToPlayer(descriptor);
  if (descriptor.level >= OUTLINE_MIN_LEVEL) return -dist;

  const feet = playerTileIndex();
  if (descriptor.level === 0 && descriptor.i === feet.i && descriptor.j === feet.j) {
    return 1e9;
  }
  return 2e9 + descriptor.level * 100000 + dist;
}

function computeDesiredTiles(velocity) {
  const desired = new Map();

  // Boundary squares are snapped to the coarser adjacent LOD grid. This makes
  // neighboring level boundaries coincide on the same world coordinates, so
  // rings never overlap horizontally and never leave an unsampled gap.
  const boundaries = [];
  for (let b = 0; b < LEVEL_COUNT; b += 1) {
    const snapLevel = Math.min(b + 1, LEVEL_COUNT - 1);
    boundaries.push(computeSquareBounds(playerPos, RING_RADII[b], LEVELS[snapLevel].tileSize));
  }

  for (let l = 0; l < LEVEL_COUNT; l += 1) {
    const lv = LEVELS[l];
    const S = lv.tileSize;
    const outer = boundaries[l];
    const iMin = Math.round(outer.x0 / S);
    const iMax = Math.round(outer.x1 / S) - 1;
    const jMin = Math.round(outer.z0 / S);
    const jMax = Math.round(outer.z1 / S) - 1;

    let innerI0 = Infinity;
    let innerI1 = -Infinity;
    let innerJ0 = Infinity;
    let innerJ1 = -Infinity;
    if (l > 0) {
      const inner = boundaries[l - 1];
      innerI0 = Math.round(inner.x0 / S);
      innerI1 = Math.round(inner.x1 / S) - 1;
      innerJ0 = Math.round(inner.z0 / S);
      innerJ1 = Math.round(inner.z1 / S) - 1;
    }

    for (let i = iMin; i <= iMax; i += 1) {
      for (let j = jMin; j <= jMax; j += 1) {
        if (l > 0 && i >= innerI0 && i <= innerI1 && j >= innerJ0 && j <= innerJ1) continue;
        const tileX = (i + 0.5) * S;
        const tileZ = (j + 0.5) * S;
        const key = `${l}:${i}:${j}`;
        desired.set(key, {
          key,
          level: l,
          i,
          j,
          tileSize: S,
          segments: lv.segments,
          tileX,
          tileZ,
          center: new THREE.Vector3(tileX, 0, tileZ),
          priority: 0,
        });
      }
    }
  }

  // Hard upper bound. If the square rings ever exceed the cap, keep the
  // tiles closest to the predicted flight path and drop the least useful.
  if (desired.size > MAX_LOADED_TILES) {
    const arr = [...desired.values()];
    for (const d of arr) d.priority = tilePriority(d, velocity);
    arr.sort((a, b) => a.priority - b.priority);
    const keep = new Map();
    for (let k = 0; k < MAX_LOADED_TILES; k += 1) keep.set(arr[k].key, arr[k]);
    return keep;
  }

  return desired;
}

function disposeTile(entry) {
  scene.remove(entry.mesh);
  entry.geometry.dispose();
}

function updateLOD(velocity) {
  const desired = computeDesiredTiles(velocity);

  // Unload everything that left the desired set.
  for (const [key, entry] of loadedTiles) {
    if (!desired.has(key)) {
      disposeTile(entry);
      loadedTiles.delete(key);
    }
  }

  // Drop queued work that is no longer wanted.
  for (const [key] of buildTasks) {
    if (!desired.has(key)) buildTasks.delete(key);
  }

  // Progressive refinement:
  //  - while any tile lacks its cheap coarse preview, only previews queue;
  //  - after the preview field is complete, real LOD builds queue in the
  //    far-to-near outline -> player feet -> near detail order.
  const missingPreviews = [];
  const missingFinals = [];
  for (const d of desired.values()) {
    const entry = loadedTiles.get(d.key);
    if (!entry) {
      if (!buildTasks.has(d.key)) {
        missingPreviews.push({ ...d, isPreview: true });
      }
    } else if (!entry.refined && !buildTasks.has(d.key)) {
      missingFinals.push({ ...d, isPreview: false });
    }
  }

  const space = MAX_LOADED_TILES - loadedTiles.size - buildTasks.size;
  if (space > 0) {
    const pending = missingPreviews.length > 0 ? missingPreviews : missingFinals;
    for (const task of pending) {
      task.priority = task.isPreview
        ? previewPriority(task)
        : finalTilePriority(task, velocity);
    }
    pending.sort((a, b) => a.priority - b.priority);
    for (let k = 0; k < pending.length && k < space; k += 1) {
      buildTasks.set(pending[k].key, pending[k]);
    }
  }

  // Re-evaluate priorities every frame: coarse/far work is always cheap and
  // goes out first, expensive near-detail geometry waits for the budget.
  const queue = [...buildTasks.values()];
  for (const task of queue) {
    task.priority = task.isPreview
      ? previewPriority(task)
      : finalTilePriority(task, velocity);
  }
  queue.sort((a, b) => a.priority - b.priority);

  const frameStart = performance.now();
  let builtThisFrame = 0;

  while (queue.length > 0 && builtThisFrame < MAX_PREVIEW_BUILDS_PER_FRAME) {
    const task = queue.shift();
    if (!desired.has(task.key)) {
      buildTasks.delete(task.key);
      continue;
    }

    const isPreview = task.isPreview;
    const buildLimit = isPreview
      ? MAX_PREVIEW_BUILDS_PER_FRAME
      : MAX_BUILDS_PER_FRAME;
    if (builtThisFrame >= buildLimit) break;

    const overBudget = performance.now() - frameStart > BUILD_BUDGET_MS;
    if (builtThisFrame > 0 && overBudget) break;

    const buildSegments = isPreview ? PREVIEW_SEGMENTS : task.segments;
    const buildLodLevel = isPreview ? PREVIEW_LOD_LEVEL : task.level;

    let geometry = null;
    try {
      geometry = terrain.buildTileGeometry(
        task.tileX,
        task.tileZ,
        task.tileSize,
        buildSegments,
        {
          skirtDepth: Math.max(1500, task.tileSize * 0.3),
          lodLevel: buildLodLevel,
        }
      );
    } catch (error) {
      console.error('tile build failed', task.key, error);
      buildTasks.delete(task.key);
      continue;
    }

    buildTasks.delete(task.key);
    if (!desired.has(task.key)) {
      geometry.dispose();
      continue;
    }

    const existing = loadedTiles.get(task.key);
    if (existing) {
      // Replace the coarse preview with the final geometry in place.
      existing.geometry.dispose();
      existing.mesh.geometry = geometry;
      existing.geometry = geometry;
      existing.refined = true;
    } else {
      const mesh = new THREE.Mesh(geometry, terrainMaterial);
      mesh.position.set(
        task.tileX - renderOrigin.x,
        0,
        task.tileZ - renderOrigin.z
      );
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      // The vertex shader bends far terrain downward for the curvature
      // hint, so a static CPU bounding sphere can no longer be conservative.
      mesh.frustumCulled = false;
      scene.add(mesh);
      loadedTiles.set(task.key, {
        mesh,
        geometry,
        level: task.level,
        tileX: task.tileX,
        tileZ: task.tileZ,
        refined: !isPreview,
      });
    }
    builtThisFrame += 1;
  }
}

// ---------------------------------------------------------------------------
// Flight controls
// ---------------------------------------------------------------------------

function speedForThrottle(t) {
  return MIN_SPEED + Math.pow(t, 1.55) * (MAX_SPEED - MIN_SPEED);
}

function updateFlight(dt) {
  forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  right.set(1, 0, 0).applyQuaternion(camera.quaternion);

  const boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const upRate = boost ? 0.85 : 0.12;
  const downRate = boost ? 0.85 : 0.22;

  if (keys.has('KeyW')) throttle += upRate * dt;
  if (keys.has('KeyS')) throttle -= downRate * dt;
  throttle = THREE.MathUtils.clamp(throttle, 0, 1);

  const targetSpeed = speedForThrottle(throttle);
  speed += (targetSpeed - speed) * (1 - Math.exp(-2.6 * dt));
  speed = THREE.MathUtils.clamp(speed, MIN_SPEED, MAX_SPEED);

  flightVelocity.set(0, 0, 0);
  flightVelocity.addScaledVector(forward, speed);

  const strafeSpeed = Math.min(speed * 0.55, 5000);
  if (keys.has('KeyA')) flightVelocity.addScaledVector(right, -strafeSpeed);
  if (keys.has('KeyD')) flightVelocity.addScaledVector(right, strafeSpeed);

  const verticalSpeed = THREE.MathUtils.clamp(speed * 0.45, 150, 6000);
  if (keys.has('Space')) flightVelocity.y += verticalSpeed;
  if (keys.has('ControlLeft') || keys.has('ControlRight')) flightVelocity.y -= verticalSpeed;

  playerPos.addScaledVector(flightVelocity, dt);

  // Keep the aircraft above the terrain surface at any speed.
  const groundY = terrain.sampleHeight(playerPos.x, playerPos.z, 0) + 120;
  if (playerPos.y < groundY) playerPos.y = groundY;

  camera.rotation.set(pitch, yaw, 0);
}

// ---------------------------------------------------------------------------
// Sky, fog and rendering helpers
// ---------------------------------------------------------------------------

function updateFog() {
  const altitude = Math.max(
    0,
    playerPos.y - terrain.sampleHeight(playerPos.x, playerPos.z, 0)
  );
  const t = THREE.MathUtils.clamp(altitude / 45000, 0, 1);
  // High altitude thins the haze and pushes every atmosphere band outward;
  // near the ground the bands compress so ridge overlaps stay readable.
  atmosphereUniforms.density.value = THREE.MathUtils.lerp(1.75, 0.42, t);
}

function updateClouds() {
  for (const layer of cloudLayers) {
    layer.mesh.position.set(camera.position.x, layer.altitude, camera.position.z);
    layer.material.uniforms.uWorldOrigin.value.set(renderOrigin.x, renderOrigin.z);
  }
}

function rebaseIfNeeded() {
  const dx = playerPos.x - renderOrigin.x;
  const dz = playerPos.z - renderOrigin.z;
  if (dx * dx + dz * dz > REBASE_DISTANCE * REBASE_DISTANCE) {
    for (const entry of loadedTiles.values()) {
      entry.mesh.position.x -= dx;
      entry.mesh.position.z -= dz;
      entry.mesh.updateMatrix();
    }
    renderOrigin.set(playerPos.x, 0, playerPos.z);
    camera.position.set(0, playerPos.y, 0);
  } else {
    camera.position.set(dx, playerPos.y, dz);
  }
}

function updateSkyAndSun() {
  skyMesh.position.copy(camera.position);
  sun.position.copy(camera.position).add(SUN_OFFSET);
  sun.target.position.copy(camera.position);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const hud = {
  pos: document.getElementById('hud-pos'),
  alt: document.getElementById('hud-alt'),
  speed: document.getElementById('hud-speed'),
  tiles: document.getElementById('hud-tiles'),
  fps: document.getElementById('hud-fps'),
  seed: document.getElementById('hud-seed'),
  overlay: document.getElementById('overlay'),
};

hud.seed.textContent = String(WORLD_SEED);

let hudTimer = 0;
let fpsTimer = 0;
let fpsFrames = 0;
let fpsValue = 0;

function formatKm(v) {
  const km = v / 1000;
  if (Math.abs(km) >= 1000) return `${km.toFixed(0)} km`;
  if (Math.abs(km) >= 10) return `${km.toFixed(1)} km`;
  return `${km.toFixed(2)} km`;
}

function formatSpeed(v) {
  if (v >= 10000) return `${(v / 1000).toFixed(2)} km/s`;
  return `${v.toFixed(0)} m/s`;
}

function updateHUD(dt) {
  fpsFrames += 1;
  fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    fpsValue = fpsFrames / fpsTimer;
    fpsFrames = 0;
    fpsTimer = 0;
    hud.fps.textContent = fpsValue.toFixed(0);
  }

  hudTimer += dt;
  if (hudTimer < 0.12) return;
  hudTimer = 0;

  const ground = terrain.sampleHeight(playerPos.x, playerPos.z, 0);
  const altitude = playerPos.y - ground;
  hud.pos.textContent = `${formatKm(playerPos.x)}, ${formatKm(playerPos.z)}`;
  hud.alt.textContent = `${altitude.toFixed(0)} m`;
  hud.speed.textContent = formatSpeed(speed);
  hud.tiles.textContent = `${loadedTiles.size} / ${MAX_LOADED_TILES}`;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function showOverlay(show) {
  hud.overlay.classList.toggle('hidden', !show);
}

hud.overlay.addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  isLocked = document.pointerLockElement === renderer.domElement;
  showOverlay(!isLocked);
});

document.addEventListener('mousemove', (event) => {
  if (!isLocked) return;
  const sensitivity = 0.0021;
  yaw -= event.movementX * sensitivity;
  pitch -= event.movementY * sensitivity;
  pitch = THREE.MathUtils.clamp(pitch, -Math.PI * 0.49, Math.PI * 0.49);
});

document.addEventListener('wheel', (event) => {
  if (!isLocked) return;
  throttle = THREE.MathUtils.clamp(throttle - Math.sign(event.deltaY) * 0.06, 0, 1);
}, { passive: true });

window.addEventListener('keydown', (event) => {
  keys.add(event.code);
  if (event.code === 'Space') event.preventDefault();
});

window.addEventListener('keyup', (event) => {
  keys.delete(event.code);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);

  if (isLocked) updateFlight(dt);

  rebaseIfNeeded();
  updateLOD(flightVelocity);
  updateFog();
  updateSkyAndSun();
  updateClouds();
  updateHUD(dt);

  renderer.render(scene, camera);
}

showOverlay(true);
animate();
