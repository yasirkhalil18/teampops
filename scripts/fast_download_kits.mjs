// scripts/fast_download_kits.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const PUBLIC_MODELS = path.join(ROOT, 'public', 'assets', 'models');
const VILLAGE_DIR = path.join(PUBLIC_MODELS, 'village');
const NATURE_DIR = path.join(PUBLIC_MODELS, 'nature');
const PROPS_DIR = path.join(PUBLIC_MODELS, 'props');
const TEMP_DIR = path.join(ROOT, 'temp_kits');

for (const dir of [VILLAGE_DIR, NATURE_DIR, PROPS_DIR, TEMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function downloadBuffer(url, destPath) {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 10000) {
    console.log(`[SKIP] Already exists: ${path.basename(destPath)} (${fs.statSync(destPath).size} bytes)`);
    return;
  }
  console.log(`[DOWNLOADING] ${url} ...`);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  console.log(`[DOWNLOADED] ${path.basename(destPath)} (${arrayBuffer.byteLength} bytes)`);
}

function extractZip(zipPath, outDir) {
  if (!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0) {
    console.log(`[UNZIPPING] ${path.basename(zipPath)} -> ${path.basename(outDir)}`);
    try {
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force"`);
      console.log(`[UNZIPPED] Successfully`);
    } catch (e) {
      console.error(`Unzip error:`, e.message);
    }
  } else {
    console.log(`[EXISTS] ${path.basename(outDir)} already extracted`);
  }
}

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

async function run() {
  console.log('=== Step 1: Downloading Kits via Fast Node Streams ===');
  for (const kit of KITS) {
    await downloadBuffer(kit.url, kit.zip);
    extractZip(kit.zip, kit.extract);
  }

  console.log('\n=== Step 2: Copying Models to Public Folders ===');

  // 1. Fantasy Town
  const townModels = walkDir(path.join(TEMP_DIR, 'fantasy-town'), /\.glb$/i);
  let townCopied = 0;
  for (const file of townModels) {
    const fn = path.basename(file);
    if (/building|stall|cart|bench|chimney|fence|well|door|window|roof|wall/i.test(fn)) {
      fs.copyFileSync(file, path.join(VILLAGE_DIR, fn));
      townCopied++;
    }
  }
  console.log(`Copied ${townCopied} village models to public/assets/models/village/`);

  // 2. Holiday Kit (Snow Trees, Cabins)
  const holidayModels = walkDir(path.join(TEMP_DIR, 'holiday'), /\.glb$/i);
  let holCopied = 0;
  for (const file of holidayModels) {
    const fn = path.basename(file);
    if (/tree|snow|drift/i.test(fn)) {
      fs.copyFileSync(file, path.join(NATURE_DIR, fn));
      holCopied++;
    } else if (/house|cabin|fence/i.test(fn)) {
      fs.copyFileSync(file, path.join(VILLAGE_DIR, fn));
      holCopied++;
    }
  }
  console.log(`Copied ${holCopied} winter nature/cabin models to public/assets/models/nature/`);

  // 3. Survival Kit (Campfires, Crates, Tools, Barrels, Tents)
  const survModels = walkDir(path.join(TEMP_DIR, 'survival'), /\.glb$/i);
  let survCopied = 0;
  for (const file of survModels) {
    const fn = path.basename(file);
    fs.copyFileSync(file, path.join(PROPS_DIR, fn));
    survCopied++;
  }
  console.log(`Copied ${survCopied} survival props to public/assets/models/props/`);

  console.log('\n=== COMPLETE! ALL ASSETS READY ===');
}

run();
