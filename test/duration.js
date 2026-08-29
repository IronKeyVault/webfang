// Test af mp4-duration.js.
//
// Det farlige ved at skrive varigheder ind i en færdig fil er offsets: hvert
// felt ligger et forskelligt sted afhængigt af boksens version, og rammer man
// fire bytes ved siden af, ødelægger man et andet felt uden at filen holder op
// med at se hel ud. Derfor bygger testen en MP4 op af kendte tal og læser
// bagefter efter, om det RIGTIGE felt fik det rigtige tal – og om nabofelterne
// stadig står urørt.

global.self = global;
require('../mp4-duration.js');
const D = global.__wfDuration;

let failed = 0;
function ok(name, cond, extra) {
  console.log(`  ${cond ? 'ok ' : 'FEJL'}  ${name}${cond || !extra ? '' : ' – ' + extra}`);
  if (!cond) failed++;
}

// ---- Byggeklodser ---------------------------------------------------------

const u32 = (v) => Uint8Array.from([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const zeros = (n) => new Uint8Array(n);

function concat(list) {
  const total = list.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of list) { out.set(a, at); at += a.length; }
  return out;
}

function box(type, ...body) {
  const b = concat(body);
  const name = Uint8Array.from([...type].map((c) => c.charCodeAt(0)));
  return concat([u32(b.length + 8), name, b]);
}

const UNKNOWN = 0xffffffff;

// mvhd v0: vf, creation, modification, timescale, duration, + hale
const mvhd = (ts) => box('mvhd', zeros(4), zeros(8), u32(ts), u32(UNKNOWN), zeros(80));
// tkhd v0: vf, creation, modification, track_id, reserved, duration, + hale
const tkhd = (id) => box('tkhd', zeros(4), zeros(8), u32(id), zeros(4), u32(UNKNOWN), zeros(60));
// mdhd v0: vf, creation, modification, timescale, duration, + hale
const mdhd = (ts) => box('mdhd', zeros(4), zeros(8), u32(ts), u32(UNKNOWN), zeros(4));

const trak = (id, mediaTs) => box('trak', tkhd(id), box('mdia', mdhd(mediaTs)));
// mehd v0: vf, fragment_duration — filmens længde i en fragmenteret MP4.
const mehd = (dur) => box('mehd', zeros(4), u32(dur));

const init = (movieTs, traks) =>
  concat([box('ftyp', zeros(16)), box('moov', mvhd(movieTs), ...traks)]);

// tfhd med valgfri fælles sample-varighed (flag 0x08)
function tfhd(id, defaultDur) {
  const flags = defaultDur === undefined ? 0 : 0x08;
  return box('tfhd', Uint8Array.from([0, 0, 0, flags]), u32(id),
    defaultDur === undefined ? zeros(0) : u32(defaultDur));
}

// trun med varighed pr. sample (flag 0x100) eller helt uden (bruger tfhd'ens)
function trun(durations) {
  if (!durations) return box('trun', Uint8Array.from([0, 0, 0, 0]), u32(3));
  return box('trun', Uint8Array.from([0, 0, 1, 0]), u32(durations.length),
    concat(durations.map(u32)));
}

const frag = (id, durations, defaultDur) =>
  concat([box('moof', box('traf', tfhd(id, defaultDur), trun(durations))),
    box('mdat', zeros(8))]);

// ---- Aflæsning ------------------------------------------------------------

// Læs et 32-bit felt målt fra boksens TYPE-navn.
function read(u8, name, off, nth = 0) {
  const s = Buffer.from(u8).toString('latin1');
  let at = s.indexOf(name);
  for (let i = 0; i < nth && at >= 0; i++) at = s.indexOf(name, at + 1);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return dv.getUint32(at + off);
}
const mvhdDur = (u8) => read(u8, 'mvhd', 20);
const mvhdTs = (u8) => read(u8, 'mvhd', 16);
const tkhdDur = (u8, n) => read(u8, 'tkhd', 24, n);
const tkhdId = (u8, n) => read(u8, 'tkhd', 16, n);
const mdhdDur = (u8, n) => read(u8, 'mdhd', 20, n);
const mdhdTs = (u8, n) => read(u8, 'mdhd', 16, n);
const mehdDur = (u8) => read(u8, 'mehd', 8);

// ---- Målingen -------------------------------------------------------------

console.log('varigheder måles ud af fragmenterne');
{
  const parts = [init(1000, [trak(1, 90000)]),
    frag(1, [3000, 3000, 3000]), frag(1, [3000, 1500])];
  const t = D.trackDurations(parts);
  ok('summerer på tværs af fragmenter', t[1] === 13500, 'fik ' + t[1]);
}
{
  const parts = [init(1000, [trak(1, 90000)]), frag(1, null, 3000)];
  const t = D.trackDurations(parts);
  ok('bruger tfhd-varighed når trun ingen har', t[1] === 9000, 'fik ' + t[1]);
}
{
  const parts = [init(1000, [trak(1, 90000), trak(2, 44100)]),
    frag(1, [3000, 3000]), frag(2, [1024, 1024])];
  const t = D.trackDurations(parts);
  ok('holder sporene adskilt', t[1] === 6000 && t[2] === 2048,
    `fik ${t[1]} og ${t[2]}`);
}

// ---- Indskrivningen -------------------------------------------------------

console.log('\nvarigheder skrives i de rigtige felter');
{
  // Video: 90000 ticks/s, 2 s. Lyd: 44100 ticks/s, 2 s.
  const head = init(1000, [trak(1, 90000), trak(2, 44100)]);
  const parts = [head, frag(1, [90000, 90000]), frag(2, [44100, 44100])];
  ok('stamp() melder at den rettede noget', D.stamp(parts) === true);

  ok('mdhd får sporets egen tidsskala', mdhdDur(head, 0) === 180000 &&
    mdhdDur(head, 1) === 88200, `fik ${mdhdDur(head, 0)} og ${mdhdDur(head, 1)}`);
  ok('tkhd regnes om til filmens tidsskala', tkhdDur(head, 0) === 2000 &&
    tkhdDur(head, 1) === 2000, `fik ${tkhdDur(head, 0)} og ${tkhdDur(head, 1)}`);
  ok('mvhd får det længste spor', mvhdDur(head) === 2000, 'fik ' + mvhdDur(head));

  ok('ingen står som "ukendt" længere',
    ![mvhdDur(head), tkhdDur(head, 0), tkhdDur(head, 1),
      mdhdDur(head, 0), mdhdDur(head, 1)].includes(UNKNOWN));

  // Nabofelterne må ikke være rørt – det er den klassiske offset-fejl.
  ok('timescales står urørt', mvhdTs(head) === 1000 &&
    mdhdTs(head, 0) === 90000 && mdhdTs(head, 1) === 44100);
  ok('track-id står urørt', tkhdId(head, 0) === 1 && tkhdId(head, 1) === 2);
}

console.log('\nmehd får det længste spor, ikke det første');
{
  // I en fragmenteret MP4 er det ofte mehd afspilleren tror på. Vores egen
  // muxer bygger den nye moov af VIDEOENS dele og kopierer mvex – og dermed
  // mehd – med uændret. Var lyden det længste af de to spor, blev filmen
  // derfor skåret af ved videoens slutning.
  const head = concat([box('ftyp', zeros(16)),
    box('moov', mvhd(1000), trak(1, 90000), trak(2, 44100),
      box('mvex', mehd(2000)))]);
  // Video: 2 s. Lyd: 3 s.
  const parts = [head, frag(1, [90000, 90000]), frag(2, [44100, 44100, 44100])];
  ok('stamp() melder at den rettede noget', D.stamp(parts) === true);
  ok('mehd får det længste spor', mehdDur(head) === 3000, 'fik ' + mehdDur(head));
  ok('mvhd siger det samme', mvhdDur(head) === 3000, 'fik ' + mvhdDur(head));
}

console.log('\nmoov findes uanset hvor den ligger');
{
  // mux.js leverer ftyp+moov samlet i ét init-segment; vores egen muxer
  // leverer dem som hver sin stump. Regner man med at moov'en ligger forrest,
  // står varighederne stille som "ukendt" uden at nogen får det at vide.
  const ftyp = box('ftyp', zeros(16));
  const moovOnly = box('moov', mvhd(1000), trak(1, 90000));
  const parts = [ftyp, moovOnly, frag(1, [90000, 90000])];
  ok('stamp() finder moov i anden stump', D.stamp(parts) === true);
  ok('varigheden blev skrevet ind', mvhdDur(moovOnly) === 2000,
    'fik ' + mvhdDur(moovOnly));
}

console.log('\nfilen røres ikke når den ikke kan måles');
{
  const head = init(1000, [trak(1, 90000)]);
  ok('ingen fragmenter → ingen ændring',
    D.stamp([head]) === false && mvhdDur(head) === UNKNOWN);
}
{
  const head = init(1000, [trak(1, 90000)]);
  // Fragment for et spor der ikke findes i moov.
  ok('ukendt spor rører ikke moov',
    D.stamp([head, frag(9, [3000])]) === false && mvhdDur(head) === UNKNOWN);
}

console.log(failed ? `\n${failed} fejl` : '\nalt grønt');
process.exit(failed ? 1 : 0);
