// Test af mp4-mux.js.
//
// Det farlige ved at lægge to MP4'er sammen er ikke at bygge boksene – det er
// chunk-offsets. De er absolutte filpositioner, og flytter man mediedata bag
// et nyt, større moov, peger hver eneste af dem forkert. Filen ser hel ud,
// har alle sine bytes, og er alligevel ubrugelig.
//
// Derfor lægger testen et genkendeligt mærke i hver chunk og læser bagefter
// den samlede fil på de nye offsets: står mærket der, peger offsettet rigtigt.

global.self = global;
require('../mp4-mux.js');
const MUX = global.__wfMux;

let failed = 0;
function ok(name, cond, extra) {
  console.log(`  ${cond ? 'ok ' : 'FEJL'}  ${name}${cond || !extra ? '' : ' – ' + extra}`);
  if (!cond) failed++;
}

// ---- Byggeklodser ---------------------------------------------------------

const str = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

function u32(v) {
  return Uint8Array.from([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
}

function u64(v) {
  return concat([u32(Math.floor(v / 4294967296)), u32(v >>> 0)]);
}

function concat(list) {
  const total = list.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of list) { out.set(a, at); at += a.length; }
  return out;
}

function box(type, ...children) {
  const body = concat(children);
  return concat([u32(body.length + 8), str(type), body]);
}

function fullBox(type, version, ...children) {
  return box(type, Uint8Array.from([version, 0, 0, 0]), ...children);
}

function flagBox(type, version, flags, ...children) {
  return box(type, Uint8Array.from([
    version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255
  ]), ...children);
}

// mvhd: version 0 → timescale ved +20, duration ved +24, next_track_ID sidst.
function mvhd(timescale, duration, nextId) {
  return fullBox('mvhd', 0,
    u32(0), u32(0), u32(timescale), u32(duration),
    new Uint8Array(76),   // rate, volume, matrix, pre_defined
    u32(nextId));
}

function tkhd(trackId) {
  return fullBox('tkhd', 0, u32(0), u32(0), u32(trackId), u32(0), u32(0),
    new Uint8Array(60));
}

function elst(version, segmentDuration) {
  return fullBox('elst', version, u32(1),
    version === 1 ? u64(segmentDuration) : u32(segmentDuration),
    version === 1 ? u64(0) : u32(0),
    u32(0x00010000));
}

function stco(offsets) {
  return fullBox('stco', 0, u32(offsets.length), ...offsets.map(u32));
}

function co64(offsets) {
  return fullBox('co64', 0, u32(offsets.length), ...offsets.map(u64));
}

// En hel lille MP4: ftyp + moov + et eller flere mdat.
// chunks: liste af Uint8Array (én pr. chunk). De lægges i mdat, og deres
// positioner skrives i stco/co64 – præcis som en rigtig fil.
function makeMp4(opts) {
  const {
    chunks, trackId = 1, timescale = 1000, duration = 5000,
    use64 = false, mdatCount = 1, withFtyp = true, edit = null
  } = opts;

  // Byg først med foreløbige offsets for at kende moov'ens størrelse, og igen
  // med de rigtige – samme kneb som muxeren selv bruger.
  const build = (offsets) => {
    const trak = box('trak',
      tkhd(trackId),
      ...(edit ? [box('edts', elst(edit.version, edit.duration))] : []),
      box('mdia',
        fullBox('mdhd', 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0)),
        box('minf', box('stbl', use64 ? co64(offsets) : stco(offsets)))));
    return box('moov', mvhd(timescale, duration, trackId + 1), trak);
  };

  const ftyp = withFtyp
    ? box('ftyp', str('isom'), u32(512), str('isommp42'))
    : new Uint8Array(0);
  const moovSize = build(chunks.map(() => 0)).length;

  // Fordel chunks over det ønskede antal mdat-bokse.
  const perBox = Math.ceil(chunks.length / mdatCount);
  const groups = [];
  for (let i = 0; i < chunks.length; i += perBox) groups.push(chunks.slice(i, i + perBox));

  const offsets = [];
  const mdats = [];
  let at = ftyp.length + moovSize;
  for (const g of groups) {
    at += 8; // mdat-header
    for (const c of g) { offsets.push(at); at += c.length; }
    mdats.push(box('mdat', ...g));
  }

  return { bytes: concat([ftyp, build(offsets), ...mdats]), offsets };
}

// Læser en boks-type ud af en færdig fil (kun øverste niveau).
function topBox(bytes, type) {
  let off = 0;
  while (off + 8 <= bytes.length) {
    const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(off);
    const t = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    if (t === type) return { start: off, size };
    if (size < 8) break;
    off += size;
  }
  return null;
}

function readChunkOffsets(bytes, trakIndex) {
  // Find alle stco/co64 i rækkefølge ved at gennemsøge hele moov'en råt.
  const hits = [];
  for (let i = 0; i + 8 < bytes.length; i++) {
    const t = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    if (t !== 'stco' && t !== 'co64') continue;
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    const count = dv.getUint32(i + 12);
    const out = [];
    for (let k = 0; k < count; k++) {
      out.push(t === 'stco' ? dv.getUint32(i + 16 + k * 4)
        : Number(dv.getBigUint64(i + 16 + k * 8)));
    }
    hits.push(out);
  }
  return hits[trakIndex];
}

function readTrackIds(bytes) {
  const ids = [];
  for (let i = 0; i + 8 < bytes.length; i++) {
    if (String.fromCharCode(...bytes.subarray(i + 4, i + 8)) !== 'tkhd') continue;
    ids.push(new DataView(bytes.buffer, bytes.byteOffset).getUint32(i + 20));
  }
  return ids;
}

// Mærkede chunks: chunk nr. n er n gentaget, så den kan genkendes hvor som helst.
const marked = (n, len, base) => new Uint8Array(len).fill(base + n);

// ---- Testene --------------------------------------------------------------

function run(name, opts) {
  console.log(`\n${name}`);
  const vChunks = [0, 1, 2, 3].map((n) => marked(n, 1000, 10));
  const aChunks = [0, 1, 2].map((n) => marked(n, 400, 100));

  const v = makeMp4({ chunks: vChunks, trackId: 1, ...(opts.video || {}) });
  const a = makeMp4({ chunks: aChunks, trackId: 1, ...(opts.audio || {}) });

  // Filerne kommer fra nettet i stumper; det efterligner vi, så reader'ens
  // læsning på tværs af stumper også bliver kørt igennem.
  const split = (bytes, size) => {
    const out = [];
    for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
    return out;
  };

  const out = concat(MUX.mux(split(v.bytes, 137), split(a.bytes, 91)));

  ok('filen begynder med ftyp', !!topBox(out, 'ftyp'));
  ok('filen har ét moov', !!topBox(out, 'moov'));
  const mdat = topBox(out, 'mdat');
  ok('filen har ét mdat', !!mdat);

  const ids = readTrackIds(out);
  ok('to spor', ids.length === 2, `fandt ${ids.length}`);
  ok('sporene har hver sit id', ids[0] !== ids[1], `id: ${ids.join(', ')}`);

  // Kernen: peger hvert offset på den chunk det hører til?
  const check = (trakIndex, chunks, label) => {
    const offs = readChunkOffsets(out, trakIndex);
    if (!offs || offs.length !== chunks.length) {
      ok(`${label}: antal offsets`, false, `fik ${offs && offs.length}`);
      return;
    }
    let bad = -1;
    for (let i = 0; i < chunks.length; i++) {
      const got = out.subarray(offs[i], offs[i] + chunks[i].length);
      if (got.length !== chunks[i].length || got.some((b, k) => b !== chunks[i][k])) {
        bad = i;
        break;
      }
    }
    ok(`${label}: alle offsets peger rigtigt`, bad === -1,
      bad === -1 ? '' : `chunk ${bad} peger på ${out[offs[bad]]}, ikke ${chunks[bad][0]}`);
  };

  check(0, vChunks, 'video');
  check(1, aChunks, 'lyd');

  // Ligger mediedata inden for mdat, og er intet gået tabt?
  const payloadStart = mdat.start + 16;
  const totalMedia = vChunks.reduce((n, c) => n + c.length, 0) +
    aChunks.reduce((n, c) => n + c.length, 0);
  ok('mdat rummer begge spors mediedata',
    out.length >= payloadStart + totalMedia,
    `${out.length} < ${payloadStart + totalMedia}`);
}

run('almindelig video + lyd', {});
run('64-bit offsets (co64)', { video: { use64: true }, audio: { use64: true } });
run('mediedata i flere mdat-bokse', { video: { mdatCount: 3 }, audio: { mdatCount: 2 } });
run('lyd uden ftyp', { audio: { withFtyp: false } });
run('samme spor-id i begge filer', { video: { trackId: 1 }, audio: { trackId: 1 } });

// ---- Fragmenteret MP4 (det Vimeo leverer) ---------------------------------
//
// Her er der ingen chunk-offsets at rette: hver moof beskriver sine samples
// relativt til sig selv. Til gengæld skal sporene have hver sit nummer *i
// hvert eneste fragment*, mvex skal rumme en trex pr. spor, og fragmenterne
// skal flettes i tidsrækkefølge – ellers skal afspilleren søge frem og
// tilbage gennem en gigabyte for at finde lyden til billedet.

function mvex(trackId) {
  return box('mvex',
    fullBox('mehd', 1, u64(10000)),
    fullBox('trex', 0, u32(trackId), u32(1), u32(0), u32(0), u32(0)));
}

// timescale-enheder pr. fragment: fragment n starter på n * step.
// dataOffset=false laver en trun uden data-offset — den slags traf kan ikke
// flyttes, og muxeren skal så falde tilbage til én moof pr. spor.
function makeFragmentedMp4(opts) {
  const {
    count, trackId = 1, timescale = 1000, step = 1000, handler = 'vide',
    payload, dataOffset = true, baseIsMoof = true, samples = 1
  } = opts;
  const moov = box('moov',
    mvhd(timescale, 0, trackId + 1),
    box('trak',
      tkhd(trackId),
      box('mdia',
        fullBox('mdhd', 0, u32(0), u32(0), u32(timescale), u32(0), u32(0)),
        box('hdlr', u32(0), str('    '), str(handler), new Uint8Array(13)),
        box('minf', box('stbl', stco([]))))),
    mvex(trackId));

  const parts = [box('ftyp', str('isom'), u32(512), str('isommp42')), moov];
  const medias = [];
  for (let n = 0; n < count; n++) {
    const data = payload(n);
    // trun-flag 0x201 = data-offset og sample-størrelse med. data_offset måles
    // fra moof'ens begyndelse (tfhd-flag 0x20000, default-base-is-moof), så
    // det kendes først når moof'ens størrelse kendes: byg, mål, byg igen.
    // Varighed og størrelse pr. sample (flag 0x100 og 0x200), så et fragment
    // kan rumme flere samples – det er dem muxeren skal kunne dele op igen.
    const rows = [];
    for (let k = 0; k < samples; k++) {
      rows.push(u32(step / samples), u32(data.length / samples));
    }
    const trun = (off) => dataOffset
      ? flagBox('trun', 0, 0x000301, u32(samples), u32(off), concat(rows))
      : flagBox('trun', 0, 0x000300, u32(samples), concat(rows));
    const build = (off) => box('moof',
      fullBox('mfhd', 0, u32(n + 1)),
      box('traf',
        flagBox('tfhd', 0, baseIsMoof ? 0x020000 : 0, u32(trackId)),
        fullBox('tfdt', 1, u64(n * step)),
        trun(off)));
    const moof = build(build(0).length + 8);
    medias.push(data);
    parts.push(moof, box('mdat', data));
  }
  return { bytes: concat(parts), medias };
}

// Bokse på filens øverste niveau, talt op efter type.
function topCounts(out) {
  const dv = new DataView(out.buffer, out.byteOffset);
  const counts = {};
  let off = 0;
  while (off + 8 <= out.length) {
    const size = dv.getUint32(off);
    if (size < 8) break;
    const t = String.fromCharCode(...out.subarray(off + 4, off + 8));
    counts[t] = (counts[t] || 0) + 1;
    off += size;
  }
  return { counts, covered: off };
}

// Trafs i hver moof, læst efter flagene. Hvilke felter der står i en trun
// afhænger af dens flag; læser testen dem forkert, måler den noget andet end
// den tror – og en grøn test på et forkert tal er værre end ingen test.
function readMoofs(out) {
  const dv = new DataView(out.buffer, out.byteOffset);
  const moofs = [];
  let off = 0;
  while (off + 8 <= out.length) {
    const size = dv.getUint32(off);
    if (size < 8) break;
    if (String.fromCharCode(...out.subarray(off + 4, off + 8)) === 'moof') {
      const trafs = [];
      let p = off + 8;
      while (p + 8 <= off + size) {
        const sz = dv.getUint32(p);
        if (sz < 8) break;
        if (String.fromCharCode(...out.subarray(p + 4, p + 8)) === 'traf') {
          trafs.push(readTraf(dv, out, p + 8, p + sz, off));
        }
        p += sz;
      }
      moofs.push({ start: off, trafs });
    }
    off += size;
  }
  return moofs;
}

function readTraf(dv, out, from, to, moofStart) {
  const t = { trackId: 0, tfhdFlags: 0, baseTime: 0, sizes: [], durations: [], dataAt: 0 };
  let p = from;
  while (p + 8 <= to) {
    const sz = dv.getUint32(p);
    if (sz < 8) break;
    const type = String.fromCharCode(...out.subarray(p + 4, p + 8));
    if (type === 'tfhd') {
      t.tfhdFlags = dv.getUint32(p + 8) & 0xffffff;
      t.trackId = dv.getUint32(p + 12);
    } else if (type === 'tfdt') {
      t.baseTime = out[p + 8] === 1
        ? Number(dv.getBigUint64(p + 12)) : dv.getUint32(p + 12);
    } else if (type === 'trun') {
      const fl = dv.getUint32(p + 8) & 0xffffff;
      const count = dv.getUint32(p + 12);
      let q = p + 16;
      if (fl & 0x000001) { t.dataAt = moofStart + dv.getInt32(q); q += 4; }
      if (fl & 0x000004) q += 4;
      for (let i = 0; i < count; i++) {
        if (fl & 0x000100) { t.durations.push(dv.getUint32(q)); q += 4; }
        if (fl & 0x000200) { t.sizes.push(dv.getUint32(q)); q += 4; }
        if (fl & 0x000400) q += 4;
        if (fl & 0x000800) q += 4;
      }
    }
    p += sz;
  }
  return t;
}

// Læser de bytes en traf peger på, sample for sample.
function bytesOf(out, traf) {
  const seen = [];
  let at = traf.dataAt;
  for (const size of traf.sizes) {
    seen.push({ first: out[at], uniform: out.subarray(at, at + size).every((b) => b === out[at]), size });
    at += size;
  }
  return seen;
}

console.log('\nfragmenteret MP4: video + lyd');
{
  // Lige lange fragmenter i begge spor: 4 × 6 s. Lyden har fire samples pr.
  // fragment, så den er delt op ligesom rigtig lyd er.
  const v = makeFragmentedMp4({
    count: 4, trackId: 1, timescale: 25, step: 150, handler: 'vide',
    payload: (n) => marked(n, 500, 10)
  });
  const a = makeFragmentedMp4({
    count: 4, trackId: 1, timescale: 48000, step: 288000, handler: 'soun',
    samples: 4, payload: (n) => marked(n, 200, 100)
  });
  const out = concat(MUX.mux([v.bytes], [a.bytes]));
  const { counts, covered } = topCounts(out);
  const moofs = readMoofs(out);

  ok('boksene dækker filen præcist', covered === out.length, `${covered} af ${out.length}`);
  ok('ét moov', counts.moov === 1, `fik ${counts.moov}`);
  ok('én moof pr. tidsinterval', counts.moof === 4, `fik ${counts.moof}`);
  ok('ét mdat pr. moof', counts.mdat === 4, `fik ${counts.mdat}`);
  ok('hver moof rummer begge spor',
    moofs.every((m) => m.trafs.length === 2 &&
      m.trafs[0].trackId === 1 && m.trafs[1].trackId === 2),
    moofs.map((m) => m.trafs.map((t) => t.trackId).join('+')).join(' '));

  // Uden default-base-is-moof siger ISO-standarden at ANDET spor i en moof
  // måles fra hvor det første spors data sluttede – ikke fra moof'ens start.
  // Vi regner fra moof-starten, så flaget SKAL stå der. Gør det ikke det,
  // rammer video stadig rigtigt (den ligger først) mens lyden læses langt
  // inde i filen: filen ser hel ud og er tavs.
  ok('hver traf siger default-base-is-moof',
    moofs.every((m) => m.trafs.every((t) => (t.tfhdFlags & 0x020000) !== 0)),
    moofs.map((m) => m.trafs.map((t) => '0x' + t.tfhdFlags.toString(16)).join('+')).join(' '));

  const ids = readTrackIds(out);
  ok('to spor i moov med hver sit id', ids.length === 2 && ids[0] !== ids[1], ids.join(','));

  const trex = [];
  for (let i = 0; i + 16 < out.length; i++) {
    if (String.fromCharCode(...out.subarray(i + 4, i + 8)) === 'trex') {
      trex.push(new DataView(out.buffer, out.byteOffset).getUint32(i + 12));
    }
  }
  ok('mvex har en trex til hvert spor', trex.length === 2 && trex[0] !== trex[1], trex.join(','));

  // Kernen i den sammenlagte form: hver trafs data_offset måles fra sin moof
  // og skal ramme præcis dét sporets data i det fælles mdat. Rammer den ved
  // siden af, spiller filen video uden lyd – eller støj.
  let bad = null;
  moofs.forEach((m, i) => {
    const want = [{ first: 10 + i, size: 500 }, { first: 100 + i, size: 50 }];
    m.trafs.forEach((t, k) => {
      for (const s of bytesOf(out, t)) {
        if (s.first !== want[k].first || !s.uniform || s.size !== want[k].size) {
          if (!bad) bad = `moof ${i}, traf ${k}: byte ${s.first}/${s.size}, ventede ${want[k].first}/${want[k].size}`;
        }
      }
    });
  });
  ok('hver trafs data_offset rammer sit eget spors data i det fælles mdat', bad === null, bad);

  ok('lyden står med fire samples pr. moof',
    moofs.every((m) => m.trafs[1].sizes.length === 4),
    moofs.map((m) => m.trafs[1].sizes.length).join(','));

  const total = [...v.medias, ...a.medias].reduce((n, m) => n + m.length, 0);
  const mdatBytes = moofs.reduce((n, m) =>
    n + m.trafs.reduce((s, t) => s + t.sizes.reduce((x, y) => x + y, 0), 0), 0);
  ok('al mediedata er med', mdatBytes === total, `${mdatBytes} af ${total}`);
}

// Sporene er sjældent skåret i lige lange stykker: her 6 s video mod 5 s lyd.
// Lægger man fragmenterne sammen som de kommer, beskriver de to trafs i ét
// moof derfor hver sit stykke tid, og forskellen vokser. VLC hakkede og tabte
// små stumper lyd af netop dét. Derfor skæres lyden om efter videoens
// opdeling – lydens fragmenter deles og samles, så hvert moof bærer præcis de
// samples der hører til dets stykke film.
console.log('\nfragmenteret MP4: lyden skæres efter videoens opdeling');
{
  const v = makeFragmentedMp4({
    count: 20, trackId: 1, timescale: 25, step: 150, handler: 'vide',
    payload: (n) => marked(n, 500, 10)
  });
  // 24 fragmenter à 5 s med ti samples hver: 240 samples à 0,5 s.
  const a = makeFragmentedMp4({
    count: 24, trackId: 1, timescale: 48000, step: 240000, handler: 'soun',
    samples: 10, payload: (n) => marked(n, 200, 100)
  });
  const out = concat(MUX.mux([v.bytes], [a.bytes]));
  const moofs = readMoofs(out);

  ok('én moof pr. videofragment', moofs.length === 20, `fik ${moofs.length}`);
  ok('hver moof rummer begge spor',
    moofs.every((m) => m.trafs.length === 2 &&
      m.trafs[0].trackId === 1 && m.trafs[1].trackId === 2),
    moofs.map((m) => m.trafs.length).join(','));

  // Det hele handler om dette ene tal: de to spor i ét moof skal begynde på
  // samme tid. 6 s video = 288000 enheder i lydens tidsskala.
  const skews = moofs.map((m) =>
    Math.abs(m.trafs[1].baseTime / 48000 - m.trafs[0].baseTime / 25));
  ok('video og lyd begynder samme sted i hver moof',
    Math.max(...skews) === 0, `største forskel ${Math.max(...skews)} s`);

  // 12 lydsamples pr. moof – og de kommer på tværs af kildens fragmenter,
  // som havde ti hver. Det er selve opdelingen der prøves her.
  ok('lyden er skåret om, ikke bare flyttet',
    moofs.every((m) => m.trafs[1].sizes.length === 12),
    moofs.map((m) => m.trafs[1].sizes.length).join(','));

  const allSizes = moofs.flatMap((m) => m.trafs[1].sizes);
  ok('alle 240 lydsamples med, hver på 20 bytes',
    allSizes.length === 240 && allSizes.every((x) => x === 20),
    `${allSizes.length} samples`);

  // Og de rigtige bytes skal ligge i den rigtige moof: sample nr. k stammer
  // fra kildens fragment nr. k/10, som er fyldt med tallet 100 + k/10.
  let wrong = null;
  let k = 0;
  for (const m of moofs) {
    for (const s of bytesOf(out, m.trafs[1])) {
      const want = 100 + Math.floor(k / 10);
      if ((s.first !== want || !s.uniform) && !wrong) {
        wrong = `lydsample ${k}: byte ${s.first}, ventede ${want}`;
      }
      k++;
    }
  }
  ok('hver lydsample ligger i den moof der dækker dens tid', wrong === null, wrong);
}

// Det er sådan mux.js' egen uddata ser ud: offsets måles fra moof-starten,
// men flaget der siger det, er ikke sat. Så længe hvert moof kun rummede ét
// spor, gjorde det ingen forskel. Lægger vi to spor i samme moof, skal
// muxeren sætte flaget selv – ellers bliver lyden tavs.
console.log('\nfragmenteret MP4: input uden flaget får det sat');
{
  const opts = { count: 3, trackId: 1, baseIsMoof: false };
  const v = makeFragmentedMp4({
    ...opts, timescale: 25, step: 150, handler: 'vide',
    payload: (n) => marked(n, 500, 10)
  });
  const a = makeFragmentedMp4({
    ...opts, timescale: 48000, step: 288000, handler: 'soun',
    payload: (n) => marked(n, 200, 100)
  });
  const out = concat(MUX.mux([v.bytes], [a.bytes]));

  const flags = [];
  let off = 0;
  while (off + 8 <= out.length) {
    const dv0 = new DataView(out.buffer, out.byteOffset);
    const size = dv0.getUint32(off);
    const t = String.fromCharCode(...out.subarray(off + 4, off + 8));
    if (t === 'moof') {
      const m = out.subarray(off, off + size);
      const dv = new DataView(m.buffer, m.byteOffset);
      for (let i = 0; i + 8 < m.length; i++) {
        if (String.fromCharCode(...m.subarray(i + 4, i + 8)) === 'tfhd') {
          flags.push(dv.getUint32(i + 8) & 0xffffff);
        }
      }
    }
    if (size < 8) break;
    off += size;
  }
  ok('muxeren sætter flaget selv', flags.length === 6 &&
    flags.every((fl) => (fl & 0x020000) !== 0),
    `${flags.length} trafs: ` + flags.map((x) => '0x' + x.toString(16)).join(' '));
}

console.log('\nfragmenteret MP4: traf uden data-offset falder tilbage til én moof pr. spor');
{
  const v = makeFragmentedMp4({
    count: 3, trackId: 1, timescale: 25, step: 150, handler: 'vide',
    dataOffset: false, payload: (n) => marked(n, 500, 10)
  });
  const a = makeFragmentedMp4({
    count: 3, trackId: 1, timescale: 48000, step: 288000, handler: 'soun',
    dataOffset: false, payload: (n) => marked(n, 200, 100)
  });
  const out = concat(MUX.mux([v.bytes], [a.bytes]));
  let off = 0, moofs = 0, ids = [];
  while (off + 8 <= out.length) {
    const size = new DataView(out.buffer, out.byteOffset).getUint32(off);
    const t = String.fromCharCode(...out.subarray(off + 4, off + 8));
    if (t === 'moof') {
      moofs++;
      const m = out.subarray(off, off + size);
      for (let i = 0; i + 8 < m.length; i++) {
        if (String.fromCharCode(...m.subarray(i + 4, i + 8)) === 'tfhd') {
          ids.push(new DataView(m.buffer, m.byteOffset).getUint32(i + 12));
        }
      }
    }
    if (size < 8) break;
    off += size;
  }
  ok('faldt tilbage til én moof pr. fragment', moofs === 6, `fik ${moofs}`);
  ok('og flettede dem i tid', ids.join('') === '121212', ids.join(''));
  ok('filen er stadig hel', off === out.length, `${off} af ${out.length}`);
}

console.log('\nblandede slags afvises');
{
  const prog = makeMp4({ chunks: [marked(0, 100, 10)] }).bytes;
  const frag = makeFragmentedMp4({ count: 1, payload: () => marked(0, 100, 100) }).bytes;
  let msg = '';
  try { MUX.mux([prog], [frag]); } catch (e) { msg = e.message; }
  ok('progressiv + fragmenteret giver en forklarende fejl', /hver sin slags/.test(msg), msg);
}

console.log('\nedit list omregnes til filmens tidsskala');
{
  const v = makeMp4({ chunks: [marked(0, 100, 10)], timescale: 600, duration: 3000 });
  const a = makeMp4({
    chunks: [marked(0, 100, 100)], timescale: 1000, duration: 5000,
    edit: { version: 0, duration: 5000 }
  });
  const out = concat(MUX.mux([v.bytes], [a.bytes]));
  let elstAt = -1;
  for (let i = 0; i + 8 < out.length; i++) {
    if (String.fromCharCode(...out.subarray(i + 4, i + 8)) === 'elst') { elstAt = i; break; }
  }
  const dur = new DataView(out.buffer, out.byteOffset).getUint32(elstAt + 16);
  // 5000 i lydens 1000-skala er 3000 i videoens 600-skala.
  ok('elst omregnet 1000 → 600', dur === 3000, `fik ${dur}`);
}

console.log('\nfejl fanges');
{
  const bad = Uint8Array.from([0, 0, 0, 8, 102, 114, 101, 101]); // 'free', intet andet
  let msg = '';
  try { MUX.mux([bad], [bad]); } catch (e) { msg = e.message; }
  ok('fil uden moov giver en forklarende fejl', /moov/.test(msg), msg);
}

console.log(failed ? `\n${failed} fejl` : '\nalt grønt');
process.exit(failed ? 1 : 0);
