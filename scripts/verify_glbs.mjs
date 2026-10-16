import fs from 'node:fs';
import path from 'node:path';

const MODELS_DIR = path.resolve('public/assets/models');
console.log('Verifying GLB files in', MODELS_DIR);
for (const file of fs.readdirSync(MODELS_DIR)) {
  const p = path.join(MODELS_DIR, file);
  const buf = fs.readFileSync(p);
  const magic = buf.toString('ascii', 0, 4);
  console.log(`${file}: size=${buf.length} bytes, magic=${magic} (valid glTF binary: ${magic === 'glTF'})`);
}
