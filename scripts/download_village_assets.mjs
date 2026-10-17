// scripts/download_village_assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const PUBLIC_MODELS = path.join(ROOT, 'public', 'assets', 'models');
const VILLAGE_DIR = path.join(PUBLIC_MODELS, 'village');
const NATURE_DIR = path.join(PUBLIC_MODELS, 'nature');
const PROPS_DIR = path.join(PUBLIC_MODELS, 'props');
const TEMP_DIR = path.join(ROOT, 'temp_kits');

// Ensure target directories exist
for (const dir of [VILLAGE_DIR, NATURE_DIR, PROPS_DIR, TEMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function runCurl(url, destPath) {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 5000) {
    console.log(`[EXISTS] ${path.basename(destPath)}`);
    return;
  }
  console.log(`[DOWNLOADING] ${url} -> ${path.basename(destPath)}`);
  try {
    execSync(`curl.exe -L -s -A "Mozilla/5.0" "${url}" -o "${destPath}"`);
    console.log(`[DONE] ${path.basename(destPath)} (${fs.statSync(destPath).size} bytes)`);
  } catch (err) {
    console.error(`[ERROR] Failed downloading ${url}:`, err.message);
  }
}

function extractZip(zipPath, outDir) {
  if (!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0) {
    console.log(`[EXTRACTING] ${path.basename(zipPath)}...`);
    try {
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force"`);
      console.log(`[EXTRACTED] to ${path.basename(outDir)}`);
    } catch (e) {
      console.error(`Error unzipping ${zipPath}:`, e.message);
    }
  } else {
    console.log(`[EXTRACTED EXISTS] ${path.basename(outDir)}`);
  }
}

// Helper to find all files matching extension or regex recursively
function walkDir(dir, pattern, results = []) {
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      walkDir(full, pattern, results);
    } else if (pattern.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

const KITS = [
  {
    name: 'fantasy-town-kit',
    url: 'https://kenney.nl/media/pages/assets/fantasy-town-kit/efe948d309-1754222374/kenney_fantasy-town-kit_2.0.zip',
    zip: path.join(TEMP_DIR, 'fantasy-town.zip'),
    extract: path.join(TEMP_DIR, 'fantasy-town')
  },
  {
    name: 'holiday-kit',
    url: 'https://kenney.nl/media/pages/assets/holiday-kit/3976a6496a-1733923970/kenney_holiday-kit.zip',
    zip: path.join(TEMP_DIR, 'holiday.zip'),
    extract: path.join(TEMP_DIR, 'holiday')
  },
  {
    name: 'survival-kit',
    url: 'https://kenney.nl/media/pages/assets/survival-kit/4065a8185b-1712149243/kenney_survival-kit.zip',
    zip: path.join(TEMP_DIR, 'survival.zip'),
    extract: path.join(TEMP_DIR, 'survival')
  }
];

async function main() {
  console.log('=== Step 1: Downloading Kenney Asset Kits ===');
  for (const kit of KITS) {
    runCurl(kit.url, kit.zip);
    extractZip(kit.zip, kit.extract);
  }

  console.log('\n=== Step 2: Unpacking Models into Clean Game Folders ===');

  // 1. Fantasy Town Kit -> public/assets/models/village/
  const townModels = walkDir(path.join(TEMP_DIR, 'fantasy-town'), /\.glb$/i);
  console.log(`Found ${townModels.length} models in Fantasy Town Kit`);
  
  // Copy key village buildings, cabins, market stalls, chimney, fences
  const villagePicks = [
    /building_cabin.*\.glb$/i,
    /building_house.*\.glb$/i,
    /building_store.*\.glb$/i,
    /building_blacksmith.*\.glb$/i,
    /building_mill.*\.glb$/i,
    /market_stall.*\.glb$/i,
    /fence_.*\.glb$/i,
    /chimney.*\.glb$/i,
    /bench.*\.glb$/i,
    /lantern.*\.glb$/i,
    /well.*\.glb$/i,
    /cart.*\.glb$/i,
    /barrel.*\.glb$/i,
    /crate.*\.glb$/i
  ];

  let copiedTown = 0;
  for (const src of townModels) {
    const filename = path.basename(src);
    if (villagePicks.some(regex => regex.test(filename))) {
      const dest = path.join(VILLAGE_DIR, filename);
      fs.copyFileSync(src, dest);
      copiedTown++;
    }
  }
  console.log(`Copied ${copiedTown} village architecture models to public/assets/models/village/`);

  // 2. Holiday Kit -> Snow trees, snow houses -> public/assets/models/nature/ & village/
  const holidayModels = walkDir(path.join(TEMP_DIR, 'holiday'), /\.glb$/i);
  console.log(`Found ${holidayModels.length} models in Holiday Kit`);
  let copiedHoliday = 0;
  for (const src of holidayModels) {
    const filename = path.basename(src);
    if (/tree.*\.glb$/i.test(filename) || /snow.*\.glb$/i.test(filename)) {
      const dest = path.join(NATURE_DIR, filename);
      fs.copyFileSync(src, dest);
      copiedHoliday++;
    } else if (/house.*\.glb$/i.test(filename) || /cabin.*\.glb$/i.test(filename) || /log.*\.glb$/i.test(filename)) {
      const dest = path.join(VILLAGE_DIR, filename);
      fs.copyFileSync(src, dest);
      copiedHoliday++;
    }
  }
  console.log(`Copied ${copiedHoliday} winter snow & cabin models`);

  // 3. Survival Kit -> Campfire, tents, backpack, tools, rations -> public/assets/models/props/
  const survivalModels = walkDir(path.join(TEMP_DIR, 'survival'), /\.glb$/i);
  console.log(`Found ${survivalModels.length} models in Survival Kit`);
  let copiedSurvival = 0;
  for (const src of survivalModels) {
    const filename = path.basename(src);
    const dest = path.join(PROPS_DIR, filename);
    fs.copyFileSync(src, dest);
    copiedSurvival++;
  }
  console.log(`Copied ${copiedSurvival} survival props to public/assets/models/props/`);

  console.log('\n=== Download & Organization Complete! ===');
}

main();
