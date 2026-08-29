// Test af opslaget i mux.js.
//
// Baggrund: offscreen.js kaldte `muxjs.mp4.Transmuxer`, men den bundle vi
// vendorer (dist/mux-mp4.min.js) eksporterer værktøjerne DIREKTE på `muxjs`.
// Opslaget gav derfor `undefined.Transmuxer` → TypeError, som blev fanget af
// fallback'en i tsToMp4 og gemt som "kunne ikke konvertere". Resultatet var at
// TS→MP4-ompakningen aldrig virkede, mens fejlen så ud som et problem med
// selve videoen. Testen her holder de to ting op mod hinanden: hvad bundlen
// faktisk eksporterer, og hvad koden slår op.

const fs = require('fs');
const path = require('path');

let failed = 0;
function ok(name, cond, extra) {
  console.log(`  ${cond ? 'ok ' : 'FEJL'}  ${name}${cond || !extra ? '' : ' – ' + extra}`);
  if (!cond) failed++;
}

const root = path.join(__dirname, '..');

// ---- Hvad eksporterer bundlen? --------------------------------------------

// mux.js er UMD og beder om require('global/window'); i browseren er det
// vinduet, her rækker globalThis.
const src = fs.readFileSync(path.join(root, 'vendor/mux-mp4.min.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'require', src)(
  mod, mod.exports, (name) => (name === 'global/window' ? globalThis : require(name))
);
const muxjs = mod.exports;

// Samme opslag som muxTransmuxer() i offscreen.js: begge snit af biblioteket.
const Transmuxer = (muxjs.mp4 && muxjs.mp4.Transmuxer) || muxjs.Transmuxer;

console.log('mux.js-bundle');
ok('bundlen kan indlæses', !!muxjs && typeof muxjs === 'object');
ok('en Transmuxer kan findes', typeof Transmuxer === 'function',
  'eksporterede navne: ' + Object.keys(muxjs || {}).join(', '));
ok('den kan konstrueres', (() => {
  try { return !!new Transmuxer({ remux: true }); } catch (_) { return false; }
})());

// ---- Slår koden op begge steder? ------------------------------------------

const offscreen = fs.readFileSync(path.join(root, 'offscreen.js'), 'utf8');

console.log('\noffscreen.js');
ok('slår op på begge snit af biblioteket',
  /m\.mp4 && m\.mp4\.Transmuxer/.test(offscreen) && /\|\|\s*m\.Transmuxer/.test(offscreen));
ok('ingen hårdkodet muxjs.mp4.Transmuxer tilbage',
  !/\bmuxjs\.mp4\.Transmuxer\b/.test(offscreen));
ok('manglende bibliotek siger det højt', /ikke indlæst/.test(offscreen));
ok('fallback til .ts giver en grund med',
  /file\.note\s*=/.test(offscreen) && /gemt som \.ts/.test(offscreen));

// mux.js skriver ét moof/mdat-par pr. flush, og et par rummer kun ét spor.
// Flushes der først til sidst, bliver filen to kæmpefragmenter – hele lyden,
// så hele videoen – og en afspiller der læser fragmenterne i rækkefølge (VLC)
// viser aldrig et billede. Ét flush pr. segment fletter sporene, som de skal.
ok('flusher pr. segment, ikke én gang til sidst',
  /parts\.forEach\(\(p\)\s*=>\s*\{\s*tm\.push\(p\);\s*tm\.flush\(\);\s*\}\)/.test(offscreen));
ok('ingen enkelt afsluttende flush tilbage',
  !/parts\.forEach\(\(p\)\s*=>\s*tm\.push\(p\)\);\s*\n\s*tm\.flush\(\);/.test(offscreen));

// mux.js kan kun skrive ét spor pr. moof. Lader man den selv slå sporene
// sammen (remux: true), bliver filen skiftende ét-spors-fragmenter – 6 sek
// lyd, 6 sek video – og en sekventiel afspiller giver huller i begge dele.
// Sporene skal holdes adskilt og flettes af vores egen muxer i stedet.
ok('holder sporene adskilt (remux: false)', /remux:\s*false/.test(offscreen));
ok('lader ikke mux.js slå sporene sammen', !/remux:\s*true/.test(offscreen));
ok('fletter sporene med vores egen muxer',
  /__wfMux\.mux\(video,\s*audio\)/.test(offscreen));
// Fejlen der kostede: stamp() blev kun kaldt på TS-vejen. DASH-filerne kom
// derfor på disken med mvhd, tkhd og mdhd sat til 0 – ffmpeg kunne slet ikke
// bestemme deres længde, og afspillerne måtte gætte. Ét kald er ikke nok til
// at vise at begge veje er dækket, så de tælles hver for sig.
ok('varigheder skrives ind bagefter — TS-vejen',
  /__wfDuration\.stamp\(out\)/.test(offscreen));
ok('varigheder skrives ind bagefter — mux-vejen',
  /__wfDuration\.stamp\(merged\)/.test(offscreen));
ok('varigheder skrives ind bagefter — HLS-fMP4-vejen',
  /__wfDuration\.stamp\(whole\)/.test(offscreen));

console.log(failed ? `\n${failed} fejl` : '\nalt grønt');
process.exit(failed ? 1 : 0);
