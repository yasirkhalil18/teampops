import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

async function testDownload() {
  const zipPath = path.resolve('temp_nature.zip');
  const outDir = path.resolve('temp_nature');
  console.log('Downloading kenney_nature-kit.zip...');
  const res = await fetch('https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip');
  const buffer = await res.arrayBuffer();
  fs.writeFileSync(zipPath, Buffer.from(buffer));
  console.log('Downloaded', buffer.byteLength, 'bytes. Unzipping with PowerShell...');

  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force"`);
  
  const files = [];
  function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else files.push(path.relative(outDir, full));
    }
  }
  walk(outDir);
  console.log('Total files in nature-kit:', files.length);
  const gltfFiles = files.filter(f => f.endsWith('.gltf') || f.endsWith('.glb'));
  console.log('GLTF/GLB files sample:', gltfFiles.slice(0, 30));
  fs.unlinkSync(zipPath);
}
testDownload().catch(console.error);
