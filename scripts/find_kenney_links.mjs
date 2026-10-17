// scripts/find_kenney_links.mjs
const kits = ['holiday-kit', 'medieval-town-kit', 'fantasy-town-kit', 'survival-kit', 'pirate-kit', 'nature-kit', 'graveyard-kit'];

async function run() {
  for (const k of kits) {
    try {
      const res = await fetch(`https://kenney.nl/assets/${k}`);
      if (res.ok) {
        const text = await res.text();
        const m = text.match(/https:\/\/kenney\.nl\/media\/pages\/assets\/[^\s\"']+\.zip/);
        console.log(`FOUND: ${k} -> ${m ? m[0] : 'NO_ZIP'}`);
      } else {
        console.log(`STATUS ${res.status}: ${k}`);
      }
    } catch (e) {
      console.log(`ERR: ${k} -> ${e.message}`);
    }
  }
}
run();
