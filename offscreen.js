// Offscreen-dokument: henter en HLS- eller DASH-stream, samler dens segmenter
// til én fil og giver baggrunds-workeren en blob-URL den kan downloade.
//
// Bemærk: kun ubeskyttede streams. Er streamen DRM-beskyttet (Widevine/
// FairPlay/SAMPLE-AES) stopper vi med en klar fejl – Webfang bryder ikke DRM.

const CONCURRENCY = 5;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'OFFSCREEN_HLS' || msg.type === 'OFFSCREEN_DASH') {
    const build = msg.type === 'OFFSCREEN_HLS' ? buildHls : buildDash;
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

// Tæller fremdrift på tværs af alle segmenter i en download.
function makeTicker(tabId, total) {
  let done = 0;
  return () => {
    done++;
    if (done % 5 === 0 || done === total) progress(tabId, `Henter video… ${done}/${total}`);
  };
}

// ---- HLS ------------------------------------------------------------------

async function buildHls(url, tabId) {
  let text = await fetchText(url);
  let playlistUrl = url;

  // Master-playliste? Vælg varianten med højest bitrate (= bedste kvalitet).
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const variants = parseMaster(text, playlistUrl);
    if (!variants.length) throw new Error('Ingen kvaliteter fundet i playlisten');
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const best = variants[0];
    progress(tabId, `Vælger ${best.resolution || Math.round(best.bandwidth / 1000) + ' kbps'}…`);
    playlistUrl = best.url;
    text = await fetchText(playlistUrl);
  }

  const pl = parseMedia(text, playlistUrl);
  if (!pl.segments.length) throw new Error('Playlisten indeholder ingen segmenter');

  const tick = makeTicker(tabId, pl.segments.length + (pl.map ? 1 : 0));
  const parts = new Array(pl.segments.length);
  const keyCache = new Map();

  await pool(pl.segments, CONCURRENCY, async (seg, i) => {
    const buf = await fetchRange(seg.url, seg.byterange);
    parts[i] = seg.key ? await decrypt(buf, seg, keyCache) : new Uint8Array(buf);
    tick();
  });

  if (pl.map) {
    // fMP4: init-segmentet forrest, så er filen en færdig .mp4.
    const initBuf = await fetchRange(pl.map.url, pl.map.byterange);
    tick();
    return { ok: true, files: [makeFile([new Uint8Array(initBuf), ...parts], 'mp4')] };
  }

  // MPEG-TS: skal remuxes for at blive en .mp4 (se remuxTs).
  return { ok: true, files: [await tsToMp4(parts, tabId)] };
}

// ---- DASH -----------------------------------------------------------------

async function buildDash(url, tabId) {
  progress(tabId, 'Læser .mpd-filen…');
  const { streams } = parseMpd(await fetchText(url), url);

  const total = streams.reduce((n, s) => n + s.segments.length + (s.init ? 1 : 0), 0);
  const tick = makeTicker(tabId, total);
  const files = [];

  for (const s of streams) {
    // Ligger hele streamen i én fil, henter vi den bare som den er.
    if (s.single) {
      const buf = await fetchRange(s.segments[0].url, s.segments[0].byterange);
      tick();
      files.push(makeFile([new Uint8Array(buf)], 'mp4', suffixFor(streams, s)));
      continue;
    }

    const parts = new Array(s.segments.length);
    await pool(s.segments, CONCURRENCY, async (seg, i) => {
      const buf = await fetchRange(seg.url, seg.byterange);
      parts[i] = new Uint8Array(buf);
      tick();
    });

    const blobParts = [];
    if (s.init) {
      const initBuf = await fetchRange(s.init.url, s.init.byterange);
      tick();
      blobParts.push(new Uint8Array(initBuf));
    }
    blobParts.push(...parts);

    // DASH-segmenter er fMP4; lyd alene gemmes som .m4a.
    const ext = s.kind === 'audio' && streams.length > 1 ? 'm4a' : 'mp4';
    files.push(makeFile(blobParts, ext, suffixFor(streams, s)));
  }

  return {
    ok: true,
    files,
    // Er lyden en separat fil, skal brugeren have det at vide.
    note: files.length > 1 ? 'video og lyd kom som to filer' : ''
  };
}

// Navne-tilføjelse når en stream bliver til flere filer.
function suffixFor(streams, s) {
  if (streams.length < 2) return '';
  return s.kind === 'audio' ? ' (lyd)' : ' (video)';
}

// ---- TS → MP4 -------------------------------------------------------------

// MPEG-TS kan ikke bare omdøbes til .mp4 – indholdet skal pakkes om. mux.js
// demuxer H.264/AAC ud af TS-strømmen og skriver den som fragmenteret MP4.
async function tsToMp4(parts, tabId) {
  progress(tabId, 'Konverterer til MP4…');
  try {
    const out = await remuxTs(parts);
    if (!out.length) throw new Error('tom uddata');
    return makeFile(out, 'mp4');
  } catch (e) {
    // Hellere en .ts der kan afspilles i VLC end ingen fil.
    progress(tabId, 'Kunne ikke konvertere – gemmer som .ts');
    return makeFile(parts, 'ts');
  }
}

function remuxTs(parts) {
  return new Promise((resolve, reject) => {
    const tm = new muxjs.mp4.Transmuxer({ remux: true });
    const out = [];
    let haveInit = false;
    tm.on('data', (seg) => {
      if (!haveInit && seg.initSegment) { out.push(seg.initSegment); haveInit = true; }
      out.push(seg.data);
    });
    tm.on('error', (e) => reject(new Error(e && e.message || 'remux fejlede')));
    try {
      parts.forEach((p) => tm.push(p));
      tm.flush();
      resolve(out);
    } catch (e) {
      reject(e);
    }
  });
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
    const res = await fetch(seg.key.uri, { credentials: 'include' });
    if (!res.ok) throw new Error('Kunne ikke hente afspilnings-nøglen');
    const raw = await res.arrayBuffer();
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
