// scripts/download_stream.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
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

async function downloadFile(url, dest) {
  console.log(`[STREAMING] ${path.basename(dest)} from ${url}...`);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const fileStream = fs.createWriteStream(dest, { flags: 'w' });
  await finished(Readable.fromWeb(res.body).pipe(fileStream));
  console.log(`[SAVED] ${path.basename(dest)} (${fs.statSync(dest).size} bytes)`);
}

function extract(zip, target) {
  console.log(`[EXTRACTING] ${path.basename(zip)}...`);
  execSync(`powershell -Command "Expand-Archive -Path '${zip}' -DestinationPath '${target}' -Force"`);
  console.log(`[EXTRACTED] to ${path.basename(target)}`);
}

function walk(dir, regex, list = []) {
  if (!fs.existsSync(dir)) return list;
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    if (fs.statSync(full).isDirectory()) walk(full, regex, list);
    else if (regex.test(item)) list.push(full);
  }
  return list;
}

async function main() {
  const KITS = [
    {
      name: 'fantasy-town',
      url: 'https://kenney.nl/media/pages/assets/fantasy-town-kit/efe948d309-1754222374/kenney_fantasy-town-kit_2.0.zip',
      zip: path.join(TEMP_DIR, 'town.zip'),
      dir: path.join(TEMP_DIR, 'town')
    },
    {
      name: 'holiday',
      url: 'https://kenney.nl/media/pages/assets/holiday-kit/3976a6496a-1733923970/kenney_holiday-kit.zip',
      zip: path.join(TEMP_DIR, 'holiday.zip'),
      dir: path.join(TEMP_DIR, 'holiday')
    },
    {
      name: 'survival',
      url: 'https://kenney.nl/media/pages/assets/survival-kit/4065a8185b-1712149243/kenney_survival-kit.zip',
      zip: path.join(TEMP_DIR, 'survival.zip'),
      dir: path.join(TEMP_DIR, 'survival')
    }
  ];

  for (const k of KITS) {
    await downloadFile(k.url, k.zip);
    extract(k.zip, k.dir);
  }

  console.log('\n--- Organizing 3D Models into Folders ---');
  // Copy town buildings
  const townGlbs = walk(path.join(TEMP_DIR, 'town'), /\.glb$/i);
  for (const f of townGlbs) {
    fs.copyFileSync(f, path.join(VILLAGE_DIR, path.basename(f)));
  }
  console.log(`Village folder now has ${fs.readdirSync(VILLAGE_DIR).length} models!`);

  // Copy holiday winter models
  const holGlbs = walk(path.join(TEMP_DIR, 'holiday'), /\.glb$/i);
  for (const f of holGlbs) {
    if (/tree|snow/i.test(f)) {
      fs.copyFileSync(f, path.join(NATURE_DIR, path.basename(f)));
    } else {
      fs.copyFileSync(f, path.join(VILLAGE_DIR, path.basename(f)));
    }
  }

  // Copy survival props
  const survGlbs = walk(path.join(TEMP_DIR, 'survival'), /\.glb$/i);
  for (const f of survGlbs) {
    fs.copyFileSync(f, path.join(PROPS_DIR, path.basename(f)));
  }
  console.log(`Props folder now has ${fs.readdirSync(PROPS_DIR).length} models!`);

  console.log('--- ALL KITS READY AND ORGANIZED! ---');
}

main().catch(err => console.error('FATAL:', err));
