import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MODELS_DIR = path.join(ROOT, 'public', 'assets', 'models');
const TEMP_DIR = path.join(ROOT, 'temp_kits');

function copyIfFound(relSource, targetName) {
  const fullSource = path.join(TEMP_DIR, relSource);
  const dest = path.join(MODELS_DIR, targetName);
  if (fs.existsSync(fullSource)) {
    fs.copyFileSync(fullSource, dest);
    console.log(`[COPIED] ${relSource} -> ${targetName} (${fs.statSync(dest).size} bytes)`);
  } else {
    // Search recursively
    let found = null;
    function walk(dir) {
      if (found) return;
      for (const item of fs.readdirSync(dir)) {
        const p = path.join(dir, item);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (item.toLowerCase() === path.basename(relSource).toLowerCase()) {
          found = p;
          return;
        }
      }
    }
    walk(TEMP_DIR);
    if (found) {
      fs.copyFileSync(found, dest);
      console.log(`[FOUND & COPIED] ${path.relative(TEMP_DIR, found)} -> ${targetName} (${fs.statSync(dest).size} bytes)`);
    } else {
      console.warn(`[NOT FOUND] ${relSource}`);
    }
  }
}

console.log('--- Copying Models to public/assets/models ---');
copyIfFound('nature/tree_pineDefaultA.glb', 'tree_pine.glb');
copyIfFound('nature/tree_default.glb', 'tree_birch.glb');
copyIfFound('graveyard/pine-crooked.glb', 'tree_dead.glb');
copyIfFound('nature/stump_oldTall.glb', 'tree_stump.glb');
copyIfFound('nature/plant_bushDetailed.glb', 'bush.glb');
copyIfFound('nature/rock_largeA.glb', 'rock.glb');
copyIfFound('nature/rock_smallA.glb', 'rock_small.glb');
copyIfFound('nature/log_large.glb', 'log.glb');
copyIfFound('graveyard/fence-damaged.glb', 'fence_broken.glb');
copyIfFound('pirate/barrel.glb', 'barrel.glb');
copyIfFound('nature/grass_leafsLarge.glb', 'grass.glb');
copyIfFound('nature/flower_redA.glb', 'flower.glb');
copyIfFound('graveyard/character-keeper.glb', 'character.glb');

// Clean up temp_kits to keep workspace clean
if (fs.existsSync(TEMP_DIR)) {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  console.log('[CLEANUP] Removed temp_kits folder');
}
