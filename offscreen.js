// Offscreen-dokument: henter en HLS- eller DASH-stream, samler dens segmenter
// til én fil og giver baggrunds-workeren en blob-URL den kan downloade.
//
// Bemærk: kun ubeskyttede streams. Er streamen DRM-beskyttet (Widevine/
// FairPlay/SAMPLE-AES) stopper vi med en klar fejl – Webfang bryder ikke DRM.

// Hvor mange segmenter der hentes ad gangen. Det er den eneste knap vi selv
// har på hastigheden: resten sætter CDN'en, din linje og rundturstiden pr.
// forespørgsel. Hvert segment er sin egen HTTP-forespørgsel, så ved små
// segmenter er ventetiden på svar — ikke båndbredden — det der koster.
// Højere tal er ikke gratis: serveren kan begynde at afvise (429), og alle
// igangværende segmenter ligger i hukommelsen samtidig.
const CONCURRENCY = 8;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'OFFSCREEN_HLS' || msg.type === 'OFFSCREEN_DASH' ||
      msg.type === 'OFFSCREEN_VIMEO') {
    const build = msg.type === 'OFFSCREEN_HLS' ? buildHls
      : msg.type === 'OFFSCREEN_DASH' ? buildDash : buildVimeo;
    startBuild(msg);
    build(msg.url, msg.tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  if (msg.type === 'OFFSCREEN_REVOKE') {
    (msg.blobUrls || []).forEach((u) => {
      try { URL.revokeObjectURL(u); } catch (_) {}
    });
    return;
  }
});

function progress(tabId, text) {
  chrome.runtime.sendMessage({ type: 'HLS_PROGRESS', tabId, text }).catch(() => {});
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status} på playlisten`);
  return res.text();
}

// ---- Hent via siden -------------------------------------------------------
//
// Et signeret CDN udleverer kun streamen til en forespørgsel der ligner
// afspillerens: rigtig `Origin`, rigtig `Referer`, sidens cookies. Dette
// dokument har sin egen oprindelse og ingen af delene, så nogle CDN'er svarer
// 403 på alt vi selv beder om – også playlister der er gyldige nok.
//
// Vejen udenom er at lade afspillerens EGEN ramme hente (src/15-fetch.js).
// Den ligger her for sig selv: de direkte fetchText/fetchRange ovenfor er
// stadig den normale vej, og træder man ikke ved siden af, mærker man ikke at
// den her findes.

let ctx = { tabId: 0, frameId: 0 };

// Sider hvor den direkte vej allerede er faldet. Så snart ét kald er blevet
// afvist, går resten af segmenterne direkte til siden – ellers ville hvert
// eneste segment koste en spildt forespørgsel først.
const pageFirst = new Set();

function startBuild(msg) {
  ctx = { tabId: msg.tabId || 0, frameId: msg.frameId || 0 };
  pageFirst.clear();
}

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

async function pageGet(url, range, wantBytes) {
  const res = await chrome.runtime.sendMessage({
    type: 'PAGE_FETCH',
    tabId: ctx.tabId,
    frameId: ctx.frameId,
    req: { url, range, wantBytes }
  });
  if (!res || !res.ok) {
    throw new Error((res && res.error) || 'siden kunne ikke hente den');
  }
  return res;
}

// De to smarte varianter: direkte først, siden bagefter. Kender vi ingen fane
// (kaldt uden for et optag), er der kun den direkte vej, og fejlen står som den
// er – så ligner den sig selv i stedet for at blive pakket ind.
async function fetchTextSmart(url) {
  const host = hostOf(url);
  if (!pageFirst.has(host)) {
    try { return await fetchText(url); } catch (e) { if (!ctx.tabId) throw e; }
  }
  const res = await pageGet(url, null, false);
  pageFirst.add(host);
  return res.text;
}

async function fetchRangeSmart(url, byterange) {
  const host = hostOf(url);
  if (!pageFirst.has(host)) {
    try { return await fetchRange(url, byterange); } catch (e) { if (!ctx.tabId) throw e; }
  }
  let range = null;
  if (byterange) {
    const start = byterange.offset || 0;
    range = `bytes=${start}-${start + byterange.length - 1}`;
  }
  const res = await pageGet(url, range, true);
  pageFirst.add(host);
  return b64ToBytes(res.b64).buffer;
}

// Tæller fremdrift på tværs af alle segmenter i en download — med fart og resttid. Uden dem er en lang hentning bare et tal der
// kryber, og man kan hverken se om den er gået i stå eller om det kan betale
// sig at skrue på CONCURRENCY.
function makeTicker(tabId, total) {
  let done = 0;
  let bytes = 0;
  const started = Date.now();
  return (n = 0) => {
    done++;
    bytes += n;
    if (done % 5 !== 0 && done !== total) return;
    const secs = (Date.now() - started) / 1000;
    const parts = [`Henter video… ${done}/${total}`];
    if (secs > 1 && bytes) parts.push(`${fmtNum(bytes / 1048576 / secs)} MB/s`);
    if (secs > 3 && done < total) parts.push(`~${fmtTime(secs * (total - done) / done)} tilbage`);
    progress(tabId, parts.join(' · '));
  };
}

const fmtNum = (n) => n.toFixed(1).replace('.', ',');

function fmtTime(secs) {
  if (secs < 90) return `${Math.round(secs)} sek`;
  const min = Math.round(secs / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} t ${min % 60} min`;
}

// ---- HLS ------------------------------------------------------------------

async function buildHls(url, tabId) {
  let text = await fetchTextSmart(url);
  let playlistUrl = url;

  // Master-playliste? Vælg varianten med højest bitrate (= bedste kvalitet).
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const variants = parseMaster(text, playlistUrl);
    if (!variants.length) throw new Error('Ingen kvaliteter fundet i playlisten');
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const best = variants[0];
    progress(tabId, `Vælger ${best.resolution || Math.round(best.bandwidth / 1000) + ' kbps'}…`);
    playlistUrl = best.url;
    text = await fetchTextSmart(playlistUrl);
  }

  const pl = parseMedia(text, playlistUrl);
  if (!pl.segments.length) throw new Error('Playlisten indeholder ingen segmenter');

  const tick = makeTicker(tabId, pl.segments.length + (pl.map ? 1 : 0));
  const parts = new Array(pl.segments.length);
  const keyCache = new Map();

  await pool(pl.segments, CONCURRENCY, async (seg, i) => {
    const buf = await fetchRangeSmart(seg.url, seg.byterange);
    parts[i] = seg.key ? await decrypt(buf, seg, keyCache) : new Uint8Array(buf);
    tick(buf.byteLength);
  });

  if (pl.map) {
    // fMP4: init-segmentet forrest, så er filen en færdig .mp4. Init-segmentet
    // kommer fra en CDN og har alle varigheder sat til 0 – afspilleren får dem
    // gennem playlisten, ikke gennem filen. På disken er der ingen playliste,
    // så tallene skal skrives ind, præcis som på DASH- og TS-vejene.
    const initBuf = await fetchRangeSmart(pl.map.url, pl.map.byterange);
    tick(initBuf.byteLength);
    const whole = [new Uint8Array(initBuf), ...parts];
    if (self.__wfDuration) self.__wfDuration.stamp(whole);
    return { ok: true, files: [makeFile(whole, 'mp4')] };
  }

  // MPEG-TS: skal remuxes for at blive en .mp4 (se remuxTs).
  const file = await tsToMp4(parts, tabId);
  return { ok: true, files: [file], note: file.note || '' };
}

// ---- DASH -----------------------------------------------------------------

async function buildDash(url, tabId) {
  progress(tabId, 'Læser .mpd-filen…');
  const { streams } = parseMpd(await fetchTextSmart(url), url);
  return assembleStreams(streams, tabId);
}

// Samler et sæt streams (video + evt. adskilt lyd) til færdige filer. Delt
// mellem DASH og Vimeo, fordi begge leverer det samme: en liste af segmenter
// pr. spor, med et init-segment foran.
async function assembleStreams(streams, tabId) {
  const total = streams.reduce((n, s) => n + s.segments.length + (s.init ? 1 : 0), 0);
  const tick = makeTicker(tabId, total);
  const built = [];
  let muxNote = '';

  for (const s of streams) {
    // Ligger hele streamen i én fil, henter vi den bare som den er.
    if (s.single) {
      const buf = await fetchRangeSmart(s.segments[0].url, s.segments[0].byterange);
      tick(buf.byteLength);
      built.push({ kind: s.kind, parts: [new Uint8Array(buf)] });
      continue;
    }

    const parts = new Array(s.segments.length);
    await pool(s.segments, CONCURRENCY, async (seg, i) => {
      const buf = await fetchRangeSmart(seg.url, seg.byterange);
      parts[i] = new Uint8Array(buf);
      tick(buf.byteLength);
    });

    const blobParts = [];
    if (s.init && s.init.data) {
      // Vimeo leverer init-segmentet i selve playlisten (base64), ikke som URL.
      blobParts.push(s.init.data);
      tick(s.init.data.length);
    } else if (s.init) {
      const initBuf = await fetchRangeSmart(s.init.url, s.init.byterange);
      tick(initBuf.byteLength);
      blobParts.push(new Uint8Array(initBuf));
    }
    blobParts.push(...parts);

    built.push({ kind: s.kind, parts: blobParts });
  }

  // Kom lyden for sig, lægges de to spor sammen til én fil. Det er ren
  // ompakning – se mp4-mux.js. Går det galt, er to spilbare filer stadig
  // bedre end ingen, så vi falder tilbage til dem og siger hvorfor.
  const video = built.find((b) => b.kind !== 'audio');
  const audio = built.find((b) => b.kind === 'audio');
  if (built.length === 2 && video && audio && self.__wfMux) {
    try {
      progress(tabId, 'Lægger video og lyd sammen…');
      const merged = self.__wfMux.mux(video.parts, audio.parts);
      // Init-segmenterne fra en DASH-stream har alle varigheder sat til 0 –
      // afspilleren får dem gennem playlisten, ikke gennem filen. En fil på
      // disken har ingen playliste, så tallene skal skrives ind, præcis som på
      // TS-vejen nedenfor. Uden dem kunne ffmpeg slet ikke bestemme længden af
      // de sammenlagte film, og afspillerne måtte gætte. Se mp4-duration.js.
      if (self.__wfDuration) self.__wfDuration.stamp(merged);
      return { ok: true, files: [makeFile(merged, 'mp4')], note: '' };
    } catch (e) {
      muxNote = `lyden ligger for sig (kunne ikke samles: ${e.message || e})`;
    }
  }

  const files = built.map((b) => makeFile(
    b.parts,
    b.kind === 'audio' && built.length > 1 ? 'm4a' : 'mp4',
    built.length > 1 ? (b.kind === 'audio' ? ' (lyd)' : ' (video)') : ''
  ));

  return {
    ok: true,
    files,
    // Er lyden en separat fil, skal brugeren have det at vide.
    note: files.length > 1 ? (muxNote || 'video og lyd kom som to filer') : ''
  };
}

// ---- Vimeo ----------------------------------------------------------------
//
// Vimeos adaptive afspiller bruger hverken .m3u8 eller .mpd, men en signeret
// JSON-playliste. Hvert spor er én mp4-fil skåret i byte-intervaller, og hvert
// interval har sin egen signatur i stien (`range/prot/<base64>/…&pathsig=…`).
// Derfor kan man ikke selv bede om hele filen: URL'en til den findes ikke.
// Det eneste sted alle intervallerne står samlet, er playlisten – så den er
// nøglen til at få hele videoen i stedet for de få sekunder afspilleren lige
// havde hentet, da man trykkede.

async function buildVimeo(url, tabId) {
  progress(tabId, 'Læser Vimeo-playlisten…');
  const data = JSON.parse(await fetchTextSmart(url));

  const streams = parseVimeo(data, url);
  if (!streams.length) throw new Error('Ingen spor i Vimeo-playlisten');
  return assembleStreams(streams, tabId);
}

function parseVimeo(data, playlistUrl) {
  // base_url'erne er relative og lægges oven på hinanden: playlist → sæt → spor.
  const setBase = new URL(data.base_url || '.', playlistUrl).href;
  const streams = [];

  const pick = (list, kind) => {
    if (!Array.isArray(list) || !list.length) return;
    // Højeste kvalitet: opløsning for video, bitrate for lyd.
    const best = [...list].sort((a, b) =>
      ((b.height || 0) * (b.width || 0) - (a.height || 0) * (a.width || 0)) ||
      ((b.bitrate || 0) - (a.bitrate || 0))
    )[0];
    const base = new URL(best.base_url || '.', setBase).href;
    const segs = (best.segments || []).map((s) => ({
      url: new URL(s.url, base).href,
      byterange: null
    }));
    if (!segs.length) return;
    streams.push({
      kind,
      init: initOf(best, base),
      segments: segs,
      duration: best.duration || 0
    });
  };

  pick(data.video, 'video');
  pick(data.audio, 'audio');
  return streams;
}

// init_segment er enten base64-data direkte i playlisten eller en URL til det.
function initOf(rep, base) {
  const s = rep.init_segment;
  if (!s) return null;
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 64 && !/\.(mp4|m4s)$/i.test(s)) {
    return { data: b64ToBytes(s) };
  }
  return { url: new URL(s, base).href, byterange: null };
}

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- TS → MP4 -------------------------------------------------------------

// MPEG-TS kan ikke bare omdøbes til .mp4 – indholdet skal pakkes om. mux.js
// demuxer H.264/AAC ud af TS-strømmen og skriver den som fragmenteret MP4.
async function tsToMp4(parts, tabId) {
  progress(tabId, 'Konverterer til MP4…');
  try {
    const tracks = await remuxTs(parts);
    const out = joinTracks(tracks);
    if (!out.length) throw new Error('tom uddata');
    // mux.js mærker alle varigheder "ukendt" (den er lavet til MSE, hvor
    // afspilleren får dem gennem JavaScript). I en fil på disken skal de stå
    // i filen selv – se mp4-duration.js.
    if (self.__wfDuration) self.__wfDuration.stamp(out);
    return makeFile(out, 'mp4');
  } catch (e) {
    // Hellere en .ts der kan afspilles i VLC end ingen fil. Men GRUNDEN skal
    // med tilbage: en tavs fallback her skjulte i sin tid at ompakningen slet
    // ikke kunne starte, og alle TS-streams landede som .ts uden at nogen
    // opdagede hvorfor.
    progress(tabId, 'Kunne ikke konvertere – gemmer som .ts');
    const file = makeFile(parts, 'ts');
    file.note = `kunne ikke pakkes om til MP4 (${e.message || e}) – gemt som .ts`;
    return file;
  }
}

// mux.js udgives i to snit: den fulde bundle lægger værktøjerne under
// `muxjs.mp4`, mens den slanke mp4-bundle – den vi vendorer – eksporterer dem
// direkte på `muxjs`. Slå op begge steder, så et skift af bundle ikke lydløst
// slår TS→MP4 fra igen. Findes den ikke, siger vi det højt i stedet for at
// lade en TypeError blive fanget som "remux fejlede".
function muxTransmuxer() {
  const m = (typeof muxjs !== 'undefined' && muxjs) || {};
  const T = (m.mp4 && m.mp4.Transmuxer) || m.Transmuxer;
  if (!T) throw new Error('mux.js er ikke indlæst – ingen Transmuxer fundet');
  return T;
}

// Demuxer TS-strømmen og giver sporene TILBAGE HVER FOR SIG, som færdige
// fMP4-strømme: { video: [...], audio: [...] }.
//
// `remux: false` er det vigtige. Med `true` klistrer mux.js selv sporene
// sammen – men den kan kun skrive ét spor pr. moof, så resultatet bliver
// skiftende ét-spors-fragmenter: 6 sekunder lyd, 6 sekunder video, 6 sekunder
// lyd. En afspiller der læser fragmenterne i rækkefølge (VLC) spiller dem
// præcis sådan, og så er der huller i begge dele. Holder vi i stedet sporene
// adskilt, kan vores egen muxer flette dem rigtigt – se joinTracks.
function remuxTs(parts) {
  return new Promise((resolve, reject) => {
    const Transmuxer = muxTransmuxer();
    const tm = new Transmuxer({ remux: false });
    const tracks = Object.create(null);
    tm.on('data', (seg) => {
      const kind = seg.type || 'combined';
      const list = tracks[kind] || (tracks[kind] = []);
      // Init-segmentet forrest, én gang pr. spor – så er hver strøm en hel fil.
      if (!list.length && seg.initSegment) list.push(seg.initSegment);
      list.push(seg.data);
    });
    tm.on('error', (e) => reject(new Error(e && e.message || 'remux fejlede')));
    try {
      // Flush pr. SEGMENT, ikke én gang til sidst.
      //
      // Hvert flush lukker et fragment. Flusher man først til allersidst,
      // bliver hvert spor ét kæmpefragment, og så er der ikke noget at flette:
      // filen bliver hele lyden efterfulgt af hele videoen. Ét flush pr.
      // segment giver mange små fragmenter, som joinTracks kan lægge parvis
      // sammen hen over tiden.
      //
      // Det koster nogle få kilobyte i fragment-hoveder og ikke ét eneste
      // billede – hvert HLS-segment begynder på et nøglebillede, så der er
      // intet at klippe midt over.
      parts.forEach((p) => { tm.push(p); tm.flush(); });
      resolve(tracks);
    } catch (e) {
      reject(e);
    }
  });
}

// Lægger de adskilte spor sammen til ÉN fil med begge spor i hvert fragment.
//
// Det er vores egen muxer der kan det: den bygger ét nyt moov med begge spor
// og fletter fragmenterne i tidsrækkefølge. Præcis det DASH- og Vimeo-vejen
// allerede bruger den til – TS-vejen havde bare aldrig fået glæde af den.
function joinTracks(tracks) {
  const video = tracks.video;
  const audio = tracks.audio;

  // Kun ét spor – eller en mux.js der selv har slået dem sammen. Så er
  // strømmen allerede en hel fil, og der er intet at flette.
  if (!video || !audio) return tracks.combined || video || audio || [];

  if (!self.__wfMux) throw new Error('mp4-mux.js er ikke indlæst');
  return self.__wfMux.mux(video, audio);
}

function makeFile(parts, ext, suffix = '') {
  const type = ext === 'mp4' ? 'video/mp4'
    : ext === 'm4a' ? 'audio/mp4' : 'video/mp2t';
  const blob = new Blob(parts, { type });
  return { blobUrl: URL.createObjectURL(blob), size: blob.size, ext, suffix };
}

// ---- HLS-playliste-parsing ------------------------------------------------

function parseMaster(text, base) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = parseAttrs(lines[i].slice(lines[i].indexOf(':') + 1));
    // Næste ikke-tomme, ikke-kommentar-linje er URL'en.
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
    if (j >= lines.length) break;
    out.push({
      bandwidth: Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0),
      resolution: attrs.RESOLUTION || '',
      url: abs(lines[j].trim(), base)
    });
  }
  return out;
}

function parseMedia(text, base) {
  const segments = [];
  let key = null;          // aktuel EXT-X-KEY
  let map = null;          // EXT-X-MAP (init-segment til fMP4)
  let seq = 0;             // media sequence – bruges som IV når IV mangler
  let pendingRange = null; // EXT-X-BYTERANGE for næste segment
  const lastEnd = new Map();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      seq = Number(line.split(':')[1]) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-SESSION-KEY')) {
      const a = parseAttrs(line.slice(line.indexOf(':') + 1));
      const method = (a.METHOD || 'NONE').toUpperCase();
      const fmt = (a.KEYFORMAT || 'identity').toLowerCase();
      if (method === 'NONE') { key = null; continue; }
      if (method !== 'AES-128' || fmt !== 'identity') {
        throw new Error('Videoen er DRM-beskyttet og kan ikke hentes');
      }
      key = { uri: abs(a.URI, base), iv: a.IV ? hexToBytes(a.IV) : null };
      continue;
    }

    if (line.startsWith('#EXT-X-MAP')) {
      const a = parseAttrs(line.slice(line.indexOf(':') + 1));
      map = { url: abs(a.URI, base), byterange: a.BYTERANGE ? parseRange(a.BYTERANGE) : null };
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE')) {
      pendingRange = parseRange(line.split(':')[1]);
      continue;
    }

    if (line.startsWith('#')) continue;

    const url = abs(line, base);
    let byterange = pendingRange;
    pendingRange = null;
    if (byterange && byterange.offset === null) {
      // Offset udeladt = fortsæt hvor forrige segment i samme fil slap.
      byterange = { length: byterange.length, offset: lastEnd.get(url) || 0 };
    }
    if (byterange) lastEnd.set(url, byterange.offset + byterange.length);

    segments.push({ url, byterange, key, seq: seq + segments.length });
  }

  return { segments, map };
}

function parseAttrs(s) {
  const out = {};
  // Split på kommaer der ikke står inde i anførselstegn.
  (s || '').match(/[A-Z0-9-]+=(?:"[^"]*"|[^,]*)/gi)?.forEach((pair) => {
    const eq = pair.indexOf('=');
    const k = pair.slice(0, eq).trim().toUpperCase();
    let v = pair.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  });
  return out;
}

function parseRange(s) {
  const [len, off] = (s || '').trim().split('@');
  return { length: Number(len) || 0, offset: off === undefined ? null : Number(off) };
}

function abs(u, base) {
  try { return new URL(u, base).href; } catch (_) { return u; }
}

// ---- Hentning & dekryptering ---------------------------------------------

async function fetchRange(url, byterange) {
  const opts = { credentials: 'include' };
  if (byterange) {
    const start = byterange.offset || 0;
    opts.headers = { Range: `bytes=${start}-${start + byterange.length - 1}` };
  }
  const res = await fetch(url, opts);
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} på segment`);
  return res.arrayBuffer();
}

// AES-128 er HLS' almindelige transport-kryptering: nøglen udleveres åbent til
// enhver klient der må se streamen. Er der DRM involveret, er vi allerede
// stoppet i parseMedia().
async function decrypt(buf, seg, cache) {
  let key = cache.get(seg.key.uri);
  if (!key) {
    // Nøglen er beskyttet på samme måde som segmenterne, så den skal kunne
    // hentes ad samme vej – ellers falder en AES-128-stream på sidste skridt.
    let raw;
    try {
      raw = await fetchRangeSmart(seg.key.uri, null);
    } catch (_) {
      throw new Error('Kunne ikke hente afspilnings-nøglen');
    }
    key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    cache.set(seg.key.uri, key);
  }
  const iv = seg.key.iv || seqToIv(seg.seq);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buf);
  return new Uint8Array(plain);
}

function seqToIv(seq) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, seq >>> 0, false); // big-endian i de sidste 4 bytes
  return iv;
}

function hexToBytes(hex) {
  const s = hex.replace(/^0x/i, '');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// Kør `fn` over alle elementer med højst `limit` samtidige hentninger.
async function pool(items, limit, fn) {
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}
