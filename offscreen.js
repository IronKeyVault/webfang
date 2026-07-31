// Offscreen-dokument: henter en HLS-playliste, samler dens segmenter til én
// fil og giver baggrunds-workeren en blob-URL den kan downloade.
//
// Bemærk: kun almindelig HLS. Er streamen DRM-beskyttet (Widevine/FairPlay/
// SAMPLE-AES) stopper vi med en klar fejl – Webfang bryder ikke DRM.

const CONCURRENCY = 5;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'OFFSCREEN_HLS') {
    buildHls(msg.url, msg.tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  if (msg.type === 'OFFSCREEN_REVOKE') {
    try { URL.revokeObjectURL(msg.blobUrl); } catch (_) {}
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

  const total = pl.segments.length + (pl.map ? 1 : 0);
  let done = 0;
  const tick = () => {
    done++;
    if (done % 5 === 0 || done === total) {
      progress(tabId, `Henter video… ${done}/${total}`);
    }
  };

  const parts = new Array(pl.segments.length);
  const keyCache = new Map();

  await pool(pl.segments, CONCURRENCY, async (seg, i) => {
    const buf = await fetchRange(seg.url, seg.byterange);
    parts[i] = seg.key ? await decrypt(buf, seg, keyCache) : new Uint8Array(buf);
    tick();
  });

  const blobParts = [];
  if (pl.map) {
    const initBuf = await fetchRange(pl.map.url, pl.map.byterange);
    blobParts.push(new Uint8Array(initBuf));
    tick();
  }
  blobParts.push(...parts);

  // fMP4-segmenter (med init-segment) giver en rigtig .mp4; ellers er det
  // MPEG-TS, som beholder .ts – den spiller i VLC og de fleste afspillere.
  const ext = pl.map ? 'mp4' : 'ts';
  const type = pl.map ? 'video/mp4' : 'video/mp2t';

  progress(tabId, 'Samler filen…');
  const blob = new Blob(blobParts, { type });
  return { ok: true, blobUrl: URL.createObjectURL(blob), size: blob.size, ext };
}

// ---- Playliste-parsing ----------------------------------------------------

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
