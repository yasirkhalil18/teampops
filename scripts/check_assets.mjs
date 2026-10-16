async function checkKits() {
  const kits = ['pirate-kit', 'graveyard-kit', 'survival-kit', 'props-kit', 'fantasy-town-kit'];
  for (const k of kits) {
    try {
      const res = await fetch(`https://kenney.nl/assets/${k}`);
      if (res.ok) {
        const text = await res.text();
        const m = text.match(/https:\/\/kenney\.nl\/media\/pages\/assets\/[^\s\"']+\.zip/);
        console.log(k, 'found:', m ? m[0] : 'no zip match');
      } else {
        console.log(k, 'status:', res.status);
      }
    } catch (e) {
      console.log(k, 'err:', e.message);
    }
  }
}
checkKits();
