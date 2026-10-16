import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const PUBLIC_ASSETS = path.join(ROOT, 'public', 'assets');
const MODELS_DIR = path.join(PUBLIC_ASSETS, 'models');
const TEXTURES_DIR = path.join(PUBLIC_ASSETS, 'textures');
const HDRI_DIR = path.join(PUBLIC_ASSETS, 'hdri');

// Ensure directories exist
for (const dir of [PUBLIC_ASSETS, MODELS_DIR, TEXTURES_DIR, HDRI_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function runCurl(url, destPath) {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
    console.log(`[SKIP] Already exists: ${path.basename(destPath)} (${fs.statSync(destPath).size} bytes)`);
    return;
  }
  console.log(`[DOWNLOAD] ${url} -> ${path.basename(destPath)}`);
  try {
    execSync(`curl.exe -L -s -A "frostbound-game-jam" "${url}" -o "${destPath}"`);
    console.log(`[OK] Saved ${path.basename(destPath)} (${fs.statSync(destPath).size} bytes)`);
  } catch (err) {
    console.error(`[ERROR] Failed to download ${url}:`, err.message);
  }
}

async function downloadHdriAndTextures() {
  console.log('--- 1. Poly Haven HDRIs ---');
  runCurl('https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_48d_partly_cloudy_1k.hdr', path.join(HDRI_DIR, 'sky_day.hdr'));
  runCurl('https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/blue_lagoon_night_1k.hdr', path.join(HDRI_DIR, 'sky_night.hdr'));

  console.log('--- 2. Poly Haven PBR Terrain Textures ---');
  // Grass
  runCurl('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/grass_ground/grass_ground_diff_1k.jpg', path.join(TEXTURES_DIR, 'grass_diff.jpg'));
  runCurl('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/grass_ground/grass_ground_nor_gl_1k.jpg', path.join(TEXTURES_DIR, 'grass_nor.jpg'));

  // Dirt
  runCurl('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/brown_mud/brown_mud_diff_1k.jpg', path.join(TEXTURES_DIR, 'dirt_diff.jpg'));
  runCurl('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/brown_mud/brown_mud_nor_gl_1k.jpg', path.join(TEXTURES_DIR, 'dirt_nor.jpg'));

  // Rock
  runCurl('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/cliff_side/cliff_side_diff_1k.jpg', path.join(TEXTURES_DIR, 'rock_diff.jpg'));
  runCurl('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/cliff_side/cliff_side_nor_gl_1k.jpg', path.join(TEXTURES_DIR, 'rock_nor.jpg'));

  // Snow
  runCurl('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/snow_02/snow_02_diff_1k.jpg', path.join(TEXTURES_DIR, 'snow_diff.jpg'));
  runCurl('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/snow_02/snow_02_nor_gl_1k.jpg', path.join(TEXTURES_DIR, 'snow_nor.jpg'));
}

async function downloadAndExtractKenneyKits() {
  console.log('--- 3. Kenney Nature & Props Kits ---');
  const tempDir = path.join(ROOT, 'temp_kits');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const kits = [
    {
      name: 'nature-kit',
      url: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip',
      zip: path.join(tempDir, 'nature.zip'),
      extract: path.join(tempDir, 'nature')
    },
    {
      name: 'graveyard-kit',
      url: 'https://kenney.nl/media/pages/assets/graveyard-kit/ba8d4b4517-1760691807/kenney_graveyard-kit_5.0.zip',
      zip: path.join(tempDir, 'graveyard.zip'),
      extract: path.join(tempDir, 'graveyard')
    },
    {
      name: 'pirate-kit',
      url: 'https://kenney.nl/media/pages/assets/pirate-kit/e6d4bb1525-1771333093/kenney_pirate-kit.zip',
      zip: path.join(tempDir, 'pirate.zip'),
      extract: path.join(tempDir, 'pirate')
    }
  ];

  for (const kit of kits) {
    runCurl(kit.url, kit.zip);
    if (!fs.existsSync(kit.extract) && fs.existsSync(kit.zip)) {
      console.log(`[UNZIP] Extracting ${kit.name}...`);
      try {
        execSync(`powershell -Command "Expand-Archive -Path '${kit.zip}' -DestinationPath '${kit.extract}' -Force"`);
      } catch (e) {
        console.error(`Error unzipping ${kit.name}:`, e.message);
      }
    }
  }

  // Helper to find file recursively in directory
  function findFile(dir, pattern) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        const found = findFile(full, pattern);
        if (found) return found;
      } else if (pattern.test(entry)) {
        return full;
      }
    }
    return null;
  }

  // Copy target models to public/assets/models/
  const targetModels = [
    { target: 'tree_pine.glb', regex: /tree_pineDefault\.glb$/i, kit: 'nature' },
    { target: 'tree_birch.glb', regex: /tree_birchDefault\.glb$/i, kit: 'nature' },
    { target: 'tree_dead.glb', regex: /tree_dead\.glb$/i, kit: 'nature' },
    { target: 'tree_stump.glb', regex: /stump_round\.glb|stump\.glb$/i, kit: 'nature' },
    { target: 'bush.glb', regex: /bush\.glb$/i, kit: 'nature' },
    { target: 'rock.glb', regex: /rock_large\.glb|rock_largeA\.glb$/i, kit: 'nature' },
    { target: 'rock_small.glb', regex: /rock_small\.glb|rock_smallA\.glb$/i, kit: 'nature' },
    { target: 'log.glb', regex: /wood_log\.glb|log\.glb$/i, kit: 'nature' },
    { target: 'grass.glb', regex: /plant_bush\.glb|grass\.glb|crop_wheat\.glb$/i, kit: 'nature' },
    { target: 'flower.glb', regex: /flower_red\.glb|flower\.glb$/i, kit: 'nature' },
    { target: 'fence_broken.glb', regex: /fence_broken\.glb|gate_broken\.glb$/i, kit: 'graveyard' },
    { target: 'barrel.glb', regex: /barrel\.glb$/i, kit: 'pirate' }
  ];

  for (const m of targetModels) {
    const kitDir = path.join(tempDir, m.kit);
    const foundPath = findFile(kitDir, m.regex);
    const dest = path.join(MODELS_DIR, m.target);
    if (foundPath) {
      fs.copyFileSync(foundPath, dest);
      console.log(`[COPIED] ${path.basename(foundPath)} -> ${m.target} (${fs.statSync(dest).size} bytes)`);
    } else {
      console.warn(`[WARN] Model matching ${m.regex} not found in ${m.kit}`);
    }
  }

  // Clean up zip downloads to save workspace disk space
  for (const kit of kits) {
    if (fs.existsSync(kit.zip)) fs.unlinkSync(kit.zip);
  }
}

function writeCreditsFile() {
  const creditsContent = `# FROSTBOUND: THE LONG DESCENT - ASSET ATTRIBUTION & CREDITS

All 3D models, environment textures, and sky HDRIs used in Frostbound are free, CC0 (Public Domain) or Creative Commons Attribution:

### 1. Poly Haven (CC0 Public Domain)
- **Website**: https://polyhaven.com
- **Sky HDRIs**:
  - \`kloofendal_48d_partly_cloudy_1k.hdr\` (Partly cloudy alpine sky by Poly Haven)
  - \`blue_lagoon_night_1k.hdr\` (Crisp moonlit night sky by Poly Haven)
- **Terrain PBR Textures (1K Diffuse & Normal)**:
  - Grass: \`grass_ground\` (Poly Haven CC0)
  - Dirt / Mud: \`brown_mud\` (Poly Haven CC0)
  - Rock / Cliff: \`cliff_side\` (Poly Haven CC0)
  - Snow: \`snow_02\` (Poly Haven CC0)

### 2. Kenney (CC0 1.0 Universal - Public Domain)
- **Website**: https://kenney.nl
- **Nature Kit**:
  - \`tree_pine.glb\` (Pine tree)
  - \`tree_birch.glb\` (Birch tree)
  - \`tree_dead.glb\` (Dead tree)
  - \`tree_stump.glb\` (Tree stump)
  - \`bush.glb\` (Foliage bush)
  - \`rock.glb\` & \`rock_small.glb\` (Boulders & stones)
  - \`log.glb\` (Fallen log)
  - \`grass.glb\` & \`flower.glb\` (Ground foliage)
- **Graveyard & Pirate / Survival Kits**:
  - \`fence_broken.glb\` (Broken timber fence)
  - \`barrel.glb\` (Weathered survival barrel)

### 3. Audio & Soundscape
- **Procedural Sound Engine**: Web Audio API procedural synthesis (wind noise curves, creek resonance, owl/wolf generators, hard landing shockwave, and title screen atmospheric drone).
`;

  fs.writeFileSync(path.join(PUBLIC_ASSETS, 'CREDITS.md'), creditsContent, 'utf-8');
  console.log(`[OK] Created ${path.join(PUBLIC_ASSETS, 'CREDITS.md')}`);
}

async function main() {
  console.log('=== STARTING ASSET DOWNLOAD PIPELINE ===');
  await downloadHdriAndTextures();
  await downloadAndExtractKenneyKits();
  writeCreditsFile();
  console.log('=== ASSET DOWNLOAD PIPELINE COMPLETE ===');
}

main().catch(console.error);
