// scripts/walk_test.mjs
// Automated road navigation and obstacle self-test from Crash Site to Radio Tower

// Provide minimal headless environment shims for Three.js / Node
globalThis.window = {
  innerWidth: 1920,
  innerHeight: 1080,
  addEventListener: () => {}
};

globalThis.document = {
  createElement: () => ({
    getContext: () => ({
      fillRect: () => {},
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillText: () => {}
    }),
    appendChild: () => {},
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {}
  }),
  createElementNS: () => ({
    getContext: () => ({
      fillRect: () => {},
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillText: () => {}
    }),
    appendChild: () => {},
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {}
  }),
  addEventListener: () => {},
  getElementById: () => null
};

globalThis.Image = class {
  set src(v) {}
};

import {
  FrostboundGame,
  getTerrainHeight,
  getRoadSignedDistance,
  ROAD_SAMPLES,
  ROAD_SAMPLES_COUNT
} from '../src/main.js';

console.log('================================================================');
console.log('FROSTBOUND ROAD SELF-TEST: CRASH SITE TO RADIO TOWER');
console.log('================================================================');

const game = new FrostboundGame(true);
const colliders = game.colliders;
const samples = ROAD_SAMPLES;
const totalSamples = samples.length;
const playerRadius = 0.55;
const climbLimit = 0.839; // ~40 degree steep climb threshold

console.log(`Sampling road curve: ${totalSamples} samples (1728m track length)`);
console.log(`Active colliders registered in world: ${colliders.length}`);
console.log(`Player collision radius: ${playerRadius}m | Max climb grade: ${climbLimit} (~40°)`);
console.log('----------------------------------------------------------------');

// 1. Test slope along entire road path
let maxGrade = 0;
let maxGradeSample = null;
const steepPoints = [];

for (let i = 0; i < totalSamples; i++) {
  const s = samples[i];
  const eps = 0.25;
  const hL = getTerrainHeight(s.x - eps, s.z);
  const hR = getTerrainHeight(s.x + eps, s.z);
  const hD = getTerrainHeight(s.x, s.z - eps);
  const hU = getTerrainHeight(s.x, s.z + eps);
  const dhdx = (hR - hL) / (2 * eps);
  const dhdz = (hU - hD) / (2 * eps);
  const grade = Math.hypot(dhdx, dhdz);

  if (grade > maxGrade) {
    maxGrade = grade;
    maxGradeSample = { index: i, x: s.x, z: s.z, grade };
  }

  if (grade > climbLimit) {
    steepPoints.push({ index: i, x: s.x, z: s.z, grade });
  }
}

console.log(`Slope Test:`);
console.log(`  Max slope grade on road: ${(maxGrade).toFixed(3)} (Angle: ${(Math.atan(maxGrade) * 180 / Math.PI).toFixed(1)}°) at sample ${maxGradeSample.index} (x=${maxGradeSample.x.toFixed(1)}, z=${maxGradeSample.z.toFixed(1)})`);
console.log(`  Samples exceeding climb limit (> ${climbLimit}): ${steepPoints.length}`);
if (steepPoints.length > 0) {
  steepPoints.forEach(p => console.warn(`    [STEEP] Sample ${p.index}: x=${p.x.toFixed(1)}, z=${p.z.toFixed(1)}, grade=${p.grade.toFixed(3)}`));
} else {
  console.log(`  ✓ All road samples are well within the walkable climb limit.`);
}
console.log('----------------------------------------------------------------');

// 2. Collision Test: Initial State (Story progression gates locked)
function testCollisions(activeColliders, label) {
  const blockedPoints = [];

  for (let i = 0; i < totalSamples; i++) {
    const s = samples[i];
    for (const col of activeColliders) {
      if (col.type === 'aabb') {
        const cx = Math.max(col.minX, Math.min(col.maxX, s.x));
        const cz = Math.max(col.minZ, Math.min(col.maxZ, s.z));
        const dx = s.x - cx;
        const dz = s.z - cz;
        if (dx * dx + dz * dz < playerRadius * playerRadius) {
          blockedPoints.push({ index: i, x: s.x, z: s.z, colliderId: col.id || 'unnamed_aabb' });
        }
      } else if (col.type === 'sphere') {
        const cx = col.center.x;
        const cz = col.center.z !== undefined ? col.center.z : col.center.y;
        const dx = s.x - cx;
        const dz = s.z - cz;
        const minDist = col.radius + playerRadius;
        if (dx * dx + dz * dz < minDist * minDist) {
          blockedPoints.push({ index: i, x: s.x, z: s.z, colliderId: col.id || 'unnamed_sphere' });
        }
      }
    }
  }

  console.log(`Collision Test [${label}]:`);
  console.log(`  Total blocked sample points: ${blockedPoints.length} / ${totalSamples}`);
  const breakdown = {};
  blockedPoints.forEach(b => breakdown[b.colliderId] = (breakdown[b.colliderId] || 0) + 1);
  for (const [id, count] of Object.entries(breakdown)) {
    console.log(`    - Collider '${id}': ${count} sample(s) blocked`);
  }
  return blockedPoints;
}

// Initial state with gates active
const initialBlocked = testCollisions(colliders, 'Initial State - Story Gates Active');

console.log('----------------------------------------------------------------');

// Unlocked state (once player progresses through Chapter Missions 1-6)
const unlockedColliders = colliders.filter(c =>
  c.id !== 'col_suv_blockade' &&
  c.id !== 'col_bridge' &&
  c.id !== 'col_khai_security' &&
  c.id !== 'col_tower_gate'
);

const unlockedBlocked = testCollisions(unlockedColliders, 'Progression State - Story Gates Unlocked');

console.log('----------------------------------------------------------------');
if (unlockedBlocked.length === 0) {
  console.log('TEST RESULT: SUCCESS!');
  console.log('The road path from start (z=520) to Radio Tower (z=-560) is completely clear and traversable.');
} else {
  console.error(`TEST RESULT: FAILED! Found ${unlockedBlocked.length} blocked points on the open road.`);
  process.exitCode = 1;
}
console.log('================================================================');
