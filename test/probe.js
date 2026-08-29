// Test af kilde-undersøgelsen i background.js.
//
// Undersøgelsen afgør hvad der står øverst i kilde-listen, og dermed hvad der
// bliver hentet. Går et felt tabt på vejen tilbage, ser alt normalt ud – der
// hentes bare den forkerte kilde, og det opdages først når filen er i hus.
// Præcis sådan gik master-flaget tabt: det blev sat på de to fejl-veje og
// glemt på den ene der virkede.
//
// background.js kan ikke indlæses i node som den er – den kalder chrome.* med
// det samme. Så vi stubber chrome og fetch og henter funktionerne ud.

const fs = require('fs');
const path = require('path');

let failed = 0;
function ok(name, cond, extra) {
  console.log(`  ${cond ? 'ok ' : 'FEJL'}  ${name}${cond || !extra ? '' : ' – ' + extra}`);
  if (!cond) failed++;
}

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

const noop = () => {};
const listener = { addListener: noop };
const chromeStub = {
  runtime: { onMessage: listener, sendMessage: async () => ({}) },
  webRequest: { onHeadersReceived: listener },
  tabs: {
    onUpdated: listener, onRemoved: listener,
    sendMessage: async () => ({}), query: async () => []
  },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} }
  },
  commands: { onCommand: listener },
  downloads: { onChanged: listener },
  offscreen: {}, scripting: {}
};

// Indlæs background.js med vores egen fetch, og få fat i de funktioner vi
// vil undersøge.
function load(bodies) {
  let i = 0;
  const fetchStub = async () => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, text: async () => body, headers: { get: () => null } };
  };
  return new Function('chrome', 'fetch', src + '\n;return { probeHls };')
    (chromeStub, fetchStub);
}

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=317709,RESOLUTION=1920x1080',
  'lav.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1128000,RESOLUTION=1920x1080',
  'hoej.m3u8',
  ''
].join('\n');

const MEDIA = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:6',
  '#EXTINF:6.0,',
  'seg1.ts',
  '#EXTINF:6.0,',
  'seg2.ts',
  '#EXT-X-ENDLIST',
  ''
].join('\n');

(async () => {
  console.log('master-playliste');
  {
    const r = await load([MASTER, MEDIA]).probeHls('https://x/master.m3u8', 0);
    ok('master-flaget kommer med tilbage', r.master === true, JSON.stringify(r));
    ok('spilletiden måles gennem varianten', r.dur === 12, 'fik ' + r.dur);
    ok('noten nævner antal kvaliteter', /2 kvaliteter/.test(r.note || ''), r.note);
    ok('bedste kvalitet vælges til målingen', /1920x1080/.test(r.note || ''), r.note);
  }

  console.log('\nenkelt variant');
  {
    const r = await load([MEDIA]).probeHls('https://x/variant.m3u8', 0);
    ok('er ikke en master', r.master === false, JSON.stringify(r.master));
    ok('spilletiden måles direkte', r.dur === 12, 'fik ' + r.dur);
  }

  console.log('\nmaster uden kvaliteter');
  {
    const r = await load(['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n']).probeHls('https://x/m.m3u8', 0);
    // Sidste linje mangler, så der er ingen variant-URL at følge.
    ok('er stadig en master', r.master === true, JSON.stringify(r));
    ok('siger hvad der er galt', /uden kvaliteter/.test(r.note || ''), r.note);
  }

  console.log(failed ? `\n${failed} fejl` : '\nalt grønt');
  process.exit(failed ? 1 : 0);
})();
