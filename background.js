// Baggrunds-service worker.
//
// To opgaver:
//  1) Hente billeder på tværs af oprindelser (bypasser side-CORS takket være
//     host_permissions) og returnere dem som base64 data-URI'er  → artikel-optag.
//  2) Lytte med på sidens medie-trafik (webRequest) så vi kender de rigtige
//     video-URL'er selv når afspilleren bruger en ubrugelig blob:-src, og
//     downloade den valgte video → video-optag.

// ---------------------------------------------------------------- artikel ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'INLINE_IMAGES') {
    inlineAll(msg.urls || []).then(sendResponse);
    return true; // hold kanalen åben til det asynkrone svar
  }

  // Sidste udvej for et billede der ikke kan hentes: et foto af fanen, som
  // content-scriptet selv klipper billedets rektangel ud af.
  if (msg.type === 'CAPTURE_TAB') {
    const windowId = sender.tab && sender.tab.windowId;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true;
  }

  // Content-scriptet spørger: hvilke medie-URL'er har du set på min fane?
  if (msg.type === 'GET_MEDIA') {
    const tabId = sender.tab && sender.tab.id;
    getMedia(tabId).then(sendResponse);
    return true;
  }

  // Content-scriptet beder om at få kilderne undersøgt (🔎 Kilder).
  if (msg.type === 'PROBE_MEDIA') {
    probeAll(msg.items || [], sender.tab && sender.tab.id).then(sendResponse);
    return true;
  }

  // Offscreen-dokumentet kan ikke selv tale med en fane – vi stiller om, så
  // den kan få et segment hentet af sidens egen ramme (se pageFetch).
  if (msg.type === 'PAGE_FETCH') {
    pageFetch(msg.tabId, msg.req || {}, msg.frameId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  // Content-scriptet beder om at få en konkret video hentet.
  if (msg.type === 'DOWNLOAD_MEDIA') {
    const tabId = sender.tab && sender.tab.id;
    downloadMedia(msg, tabId)
      .then((r) => sendResponse(r || { ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  // Svar fra offscreen-dokumentet undervejs i en HLS-samling.
  if (msg.type === 'HLS_PROGRESS') {
    relay(msg.tabId, { type: 'MEDIA_PROGRESS', text: msg.text });
    return;
  }
});

// Genvejstaster → start optag direkte på den aktive fane.
// Samme fremgangsmåde som popup'en: indsprøjt scriptet og kald dets start-
// funktion direkte, så et forældet content-script på en åben side ikke svarer
// i stedet for det nye.
chrome.commands.onCommand.addListener(async (command) => {
  const what = command === 'start-pick' ? 'artikel'
    : command === 'start-pick-video' ? 'video'
    : null;
  if (!what) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    // Fil-listen står ét sted – i manifestet – så indsprøjtning og automatisk
    // indlæsning aldrig kan komme ud af trit.
    // allFrames: sidens iframes skal også have koden – indhold der ligger i en
    // ramme (fx midterpanelet på en lab-side) hentes af rammen selv.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: chrome.runtime.getManifest().content_scripts[0].js
    });
    // Selve optaget startes KUN i hovedrammen; den spørger rammerne selv.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: (w) => { if (window.__webfang) window.__webfang.start(w); },
      args: [what]
    });
  } catch (_) {
    // Fx chrome://- eller store-sider hvor scripts ikke må køre.
  }
});

async function inlineAll(urls) {
  const out = {};
  await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        // Grænse: spring meget store billeder over (> 12 MB) for at holde clipboard sund.
        if (buf.byteLength > 12 * 1024 * 1024) return;
        const type = (res.headers.get('content-type') || guessType(url)).split(';')[0];
        out[url] = `data:${type};base64,${toBase64(buf)}`;
      } catch (e) {
        // Billede kunne ikke hentes → springes over, original-URL bruges i stedet.
      }
    })
  );
  return out;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function guessType(url) {
  const u = url.toLowerCase();
  if (u.includes('.png')) return 'image/png';
  if (u.includes('.gif')) return 'image/gif';
  if (u.includes('.webp')) return 'image/webp';
  if (u.includes('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

// ------------------------------------------------------------ medie-sniffer ---
//
// Service workeren kan blive lagt i dvale mellem to netværkskald, så listen
// gemmes i chrome.storage.session (overlever dvale, ryddes når browseren lukkes).

const MAX_PER_TAB = 60;
const mem = new Map();      // tabId -> Map(url -> entry)
let loadedPromise = null;   // sikrer at vi kun læser storage én gang
let saveTimer = null;

function ensureLoaded() {
  if (!loadedPromise) {
    loadedPromise = chrome.storage.session.get('media').then(({ media }) => {
      if (media) {
        for (const [tid, arr] of Object.entries(media)) {
          mem.set(Number(tid), new Map(arr.map((e) => [e.url, e])));
        }
      }
    }).catch(() => {});
  }
  return loadedPromise;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const media = {};
    for (const [tid, map] of mem) media[tid] = [...map.values()];
    chrome.storage.session.set({ media }).catch(() => {});
  }, 400);
}

// Segmenter og småfiler er støj – vi vil kun have playlister og hele videofiler.
const SEGMENT_RE = /\.(ts|m4s|aac|vtt|key|jpg|png)(\?|$)/i;

// fMP4-segmenter hedder .mp4 og slipper derfor forbi SEGMENT_RE. De ligner
// hinanden på navnet: seg-12-v1-a1.mp4, chunk-stream0-00007.mp4, init.mp4,
// eller bare 00012.mp4. Sådan et stykke er få sekunder af filmen – ikke filmen.
const FMP4_SEG_RE =
  /(?:^|[/_-])(?:seg|segment|chunk|frag|fragment|init|media)[-_.]?\d*\.(?:mp4|m4v|webm)(?:$)/i;
const NUMERIC_SEG_RE = /\/\d{1,7}\.(?:mp4|m4v|webm)$/i;

// Et byte-interval af en større fil (Vimeo: /v2/range/prot/…, eller ?range=a-b)
// er heller ikke filmen, uanset at det hedder .mp4 og fylder et par hundrede kB.
const RANGE_URL_RE = /\/range\/|(?:^|[?&])range=\d+-\d+/i;

function isSegmentFile(path, url) {
  return FMP4_SEG_RE.test(path) || NUMERIC_SEG_RE.test(path) ||
    RANGE_URL_RE.test(url || '');
}

function classify(url, contentType) {
  let path;
  try { path = new URL(url).pathname.toLowerCase(); } catch (_) { return null; }
  const ct = (contentType || '').toLowerCase();
  if (SEGMENT_RE.test(path)) return null;
  // Vimeos adaptive afspiller har hverken .m3u8 eller .mpd – dens playliste er
  // en signeret JSON. Uden den ser vi kun løsrevne byte-intervaller.
  if (/\/v2\/playlist\//.test(path) || /\/(playlist|master)\.json$/.test(path)) {
    return 'vimeo';
  }
  if (path.endsWith('.m3u8') || ct.includes('mpegurl')) return 'hls';
  if (path.endsWith('.mpd') || ct.includes('dash+xml')) return 'dash';
  if (/\.(mp4|m4v|webm|mov|mkv|ogv)$/.test(path)) return 'file';
  if (ct.startsWith('video/') || ct.startsWith('audio/mp4')) return 'file';
  return null;
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const ct = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === 'content-type'
    );
    const kind = classify(details.url, ct && ct.value);
    if (!kind) return;
    const len = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === 'content-length'
    );
    let path = '';
    try { path = new URL(details.url).pathname.toLowerCase(); } catch (_) {}
    record(details.tabId, {
      url: details.url,
      kind,
      seg: kind === 'file' && isSegmentFile(path, details.url),
      size: len ? Number(len.value) || 0 : 0,
      // Hvilken ramme hentede den? Ligger afspilleren i en iframe (Hotmart,
      // Vimeo, YouTube-agtige indlejringer), er det DEN ramme der må hente
      // igen på vores vegne – se pageFetch().
      frameId: details.frameId >= 0 ? details.frameId : 0,
      ts: Date.now()
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other'] },
  ['responseHeaders']
);

async function record(tabId, entry) {
  await ensureLoaded();
  let map = mem.get(tabId);
  if (!map) { map = new Map(); mem.set(tabId, map); }
  const prev = map.get(entry.url);
  // Behold den største kendte størrelse (range-requests melder kun delen).
  if (prev && prev.size > entry.size) entry.size = prev.size;
  map.delete(entry.url);
  map.set(entry.url, entry);
  while (map.size > MAX_PER_TAB) map.delete(map.keys().next().value);
  scheduleSave();
}

async function getMedia(tabId) {
  await ensureLoaded();
  const map = mem.get(tabId);
  const seen = map ? [...map.values()] : [];
  if (seen.some((e) => !e.seg)) return seen;
  // Lyttet med for sent: playlisten hentes én gang når afspilleren starter, og
  // derefter kun segmenter. Er listen ryddet siden (udvidelsen genindlæst,
  // service workeren tabte den, siden skiftede URL) ser vi aldrig playlisten
  // igen. Men rammen der hentede den, husker det selv – i sin performance-log.
  const found = await scanFrames(tabId);
  for (const e of found) await record(tabId, e);
  return [...seen, ...found.filter((f) => !seen.some((e) => e.url === f.url))];
}

// Hver rammes egen liste over hvad den har hentet (Resource Timing). Den
// overlever alt det der kan rydde vores liste, så længe rammen står. Bufferen
// tager de første ~250 kald og smider resten – så playlisten, der kommer
// først, er med, selv når segmenterne har fyldt den op.
async function scanFrames(tabId) {
  if (!tabId) return [];
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => performance.getEntriesByType('resource')
        .map((r) => [r.name, r.encodedBodySize || 0])
    });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const fr of results) {
    for (const [url, size] of fr.result || []) {
      const kind = classify(url, '');
      if (!kind) continue;
      let path = '';
      try { path = new URL(url).pathname.toLowerCase(); } catch (_) {}
      out.push({
        url, kind, size,
        seg: kind === 'file' && isSegmentFile(path, url),
        frameId: fr.frameId >= 0 ? fr.frameId : 0,
        ts: Date.now()
      });
    }
  }
  return out;
}

// ------------------------------------------------------- hent via siden ---
//
// Et signeret CDN (Akamai og lignende) udleverer kun streamen til en
// forespørgsel der ligner afspillerens: rigtig `Origin`, rigtig `Referer`,
// sidens cookies. Vores egne fetch-kald – fra service workeren og fra
// offscreen-dokumentet – har ingen af delene og får 403, selv om afspilleren
// på siden henter den samme URL uden problemer.
//
// Derfor kan vi lade RAMMEN hente for os (src/15-fetch.js). Vi behøver ikke
// vide hvilke headere CDN'en kigger efter; afsenderen er den rigtige, og så
// sætter browseren dem selv.

// Hvilken ramme hørte URL'en hjemme i? Kender vi den ikke (fx en variant eller
// et segment vi selv har regnet os frem til), bruger vi den ramme det seneste
// medie på fanen kom fra – det er afspillerens.
async function frameForUrl(tabId, url) {
  await ensureLoaded();
  const map = mem.get(tabId);
  if (!map) return 0;
  const hit = map.get(url);
  if (hit && hit.frameId >= 0) return hit.frameId;
  let last = 0;
  for (const e of map.values()) if (e.frameId >= 0) last = e.frameId;
  return last;
}

// Prøv først rammen vi tror på, dernæst hovedrammen. En ramme kan være væk
// (afspilleren er skiftet ud) eller uden content-script (sandboxed iframe).
async function pageFetch(tabId, req, frameId) {
  if (!tabId) return { ok: false, error: 'ingen fane' };
  const frames = frameId ? [frameId, 0] : [0];
  let last = { ok: false, error: 'ingen ramme svarede' };
  for (const f of frames) {
    try {
      const res = await chrome.tabs.sendMessage(
        tabId, { type: 'WF_FETCH', ...req }, { frameId: f }
      );
      if (res && res.ok) return res;
      if (res) last = res;
    } catch (e) {
      last = { ok: false, error: e.message || String(e) };
    }
  }
  return last;
}

// ------------------------------------------------------------ undersøg ---
//
// En side kan sagtens have 30+ medie-URL'er: forhåndsvisninger på hvert
// miniaturebillede, reklamer, lydsporet for sig. Størrelsen alene afslører
// ikke hvilken der er *filmen* – en playliste fylder få kilobyte, uanset om
// den beskriver 10 sekunder eller 3½ time. Derfor åbner vi playlisterne og
// måler deres rigtige spilletid, så valget kan træffes på det.

const PROBE_TIMEOUT = 8000;
const PROBE_MAX = 24;

async function probeAll(items, tabId) {
  const out = [];
  const queue = items.slice(0, PROBE_MAX);
  let i = 0;
  const workers = new Array(Math.min(4, queue.length)).fill(0).map(async () => {
    while (i < queue.length) {
      const item = queue[i++];
      try {
        out.push({ url: item.url, ...(await probeOne(item, tabId)) });
      } catch (e) {
        out.push({ url: item.url, err: e.message || String(e) });
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function probeFetch(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT);
  try {
    return await fetch(url, { credentials: 'include', signal: ctl.signal, ...init });
  } finally {
    clearTimeout(timer);
  }
}

// Undersøgelse i to forsøg: først vores eget kald, og hvis CDN'en afviser det,
// samme URL hentet af sidens egen ramme. Står den nye vej for sig selv, kan den
// direkte vej blive som den er – den virker på langt de fleste sider, og den
// koster ikke en ekstra rundtur.
async function probeFetchSmart(url, init, tabId) {
  try {
    const res = await probeFetch(url, init);
    if (res.ok) return { ok: true, text: () => res.text(), res };
    if (!tabId) return { ok: false, status: res.status };
  } catch (e) {
    if (!tabId) throw e;
  }
  const via = await pageFetch(tabId, {
    url, wantBytes: false
  }, await frameForUrl(tabId, url));
  if (!via.ok) return { ok: false, status: via.status, error: via.error };
  return { ok: true, text: async () => via.text, viaPage: true };
}

async function probeOne(item, tabId) {
  if (item.kind === 'hls') return probeHls(item.url, tabId);
  if (item.kind === 'dash') return probeDash(item.url, tabId);
  if (item.kind === 'vimeo') return probeVimeo(item.url, tabId);
  return probeFile(item.url);
}

async function probeVimeo(url, tabId) {
  const res = await probeFetchSmart(url, null, tabId);
  if (!res.ok) return { err: res.error || `HTTP ${res.status}` };
  const data = JSON.parse(await res.text());
  const vids = data.video || [];
  const best = [...vids].sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  const notes = [`${vids.length} kvaliteter`];
  if (best && best.height) notes.push(`bedst ${best.width}x${best.height}`);
  if ((data.audio || []).length) notes.push('adskilt lyd');
  return {
    dur: (best && best.duration) || data.duration || 0,
    note: notes.join('; ')
  };
}

async function probeHls(url, tabId) {
  const res = await probeFetchSmart(url, null, tabId);
  if (!res.ok) return { err: res.error || `HTTP ${res.status}` };
  let text = await res.text();
  const notes = [];
  // En master-playliste er ikke en kvalitet – den er LISTEN over kvaliteter,
  // og den lader os vælge den bedste. Det skal med tilbage, så valget kan
  // falde på den frem for en enkelt variant (se sortCands i src/85-video.js).
  let master = false;

  // Alle svar herfra bygges ét sted. Med tre spredte return-sætninger er det
  // for let at tilføje et felt de to steder og glemme det tredje – og netop
  // det gjorde at master-flaget aldrig nåede frem fra den vej der virkede.
  const result = (extra) => ({ master, note: notes.join('; '), ...extra });

  if (/#EXT-X-STREAM-INF/.test(text)) {
    master = true;
    const variants = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const bw = Number((lines[i].match(/BANDWIDTH=(\d+)/i) || [])[1] || 0);
      const res2 = (lines[i].match(/RESOLUTION=([0-9x]+)/i) || [])[1] || '';
      const next = (lines[i + 1] || '').trim();
      if (next && !next.startsWith('#')) {
        variants.push({ bw, res: res2, url: new URL(next, url).href });
      }
    }
    if (!variants.length) {
      notes.push('master uden kvaliteter');
      return result();
    }
    variants.sort((a, b) => b.bw - a.bw);
    notes.push(`master, ${variants.length} kvaliteter, bedst ${variants[0].res ||
      Math.round(variants[0].bw / 1000) + ' kbps'}`);
    const vres = await probeFetchSmart(variants[0].url, null, tabId);
    if (!vres.ok) {
      return result({ err: vres.error || `variant HTTP ${vres.status}` });
    }
    text = await vres.text();
  }

  const dur = [...text.matchAll(/#EXTINF:\s*([\d.]+)/g)]
    .reduce((n, m) => n + (Number(m[1]) || 0), 0);
  const segs = (text.match(/#EXTINF/g) || []).length;
  notes.push(`${segs} segmenter`);
  if (/#EXT-X-KEY[^\n]*METHOD=SAMPLE-AES/i.test(text)) notes.push('DRM (SAMPLE-AES)');
  else if (/#EXT-X-KEY[^\n]*METHOD=AES-128/i.test(text)) notes.push('AES-128');
  if (!/#EXT-X-ENDLIST/.test(text)) notes.push('live/uafsluttet');
  return result({ dur });
}

async function probeDash(url, tabId) {
  const res = await probeFetchSmart(url, null, tabId);
  if (!res.ok) return { err: res.error || `HTTP ${res.status}` };
  const text = await res.text();
  const iso = (text.match(/mediaPresentationDuration="([^"]+)"/) || [])[1] || '';
  const m = iso.match(/P(?:(\d+)D)?T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?/);
  const dur = m
    ? (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) +
      (Number(m[3] || 0) * 60) + Number(m[4] || 0)
    : 0;
  const notes = [`${(text.match(/<Representation\b/g) || []).length} kvaliteter`];
  if (/type="dynamic"/.test(text)) notes.push('live (dynamic)');
  if (/<ContentProtection\b/.test(text)) notes.push('DRM');
  return { dur, note: notes.join('; ') };
}

async function probeFile(url) {
  const res = await probeFetch(url, { method: 'HEAD' });
  if (!res.ok) return { err: `HTTP ${res.status}` };
  return {
    size: Number(res.headers.get('content-length')) || 0,
    note: res.headers.get('content-type') || ''
  };
}

// Ryd listen når fanen navigerer til en ny side eller lukkes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) { mem.delete(tabId); scheduleSave(); }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  mem.delete(tabId); scheduleSave();
});

// -------------------------------------------------------------- download ---

function relay(tabId, msg) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// Fortløbende nummer foran filnavnet. Ligger i storage.local, så tælleren
// overlever både browseren og en genstart af service workeren – brugeren kan
// fortsætte hvor hen slap. Nummeret bruges først, tælles op når downloaden er
// sat i gang, så en fejlet hentning ikke brænder et nummer.
const SEQ_KEY = 'videoSeq';        // næste nummer der bruges
const SEQ_ON_KEY = 'videoSeqOn';   // slået til/fra

async function seqState() {
  const st = await chrome.storage.local.get([SEQ_KEY, SEQ_ON_KEY]);
  const n = Number(st[SEQ_KEY]);
  return {
    on: st[SEQ_ON_KEY] !== false,
    next: Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
  };
}

function seqPrefix(n) {
  return n + ' - ';
}

// Hvor filerne lander styres af browserens egen downloadmappe
// (chrome://settings/downloads) – en udvidelse må alligevel kun skrive under
// den. Eneste knap her er "spørg hvor": browserens gem-dialog, hvor man kan
// browse frit, og som selv husker sidste mappe.
const ASK_KEY = 'videoAsk';

async function askState() {
  const st = await chrome.storage.local.get(ASK_KEY);
  return { ask: st[ASK_KEY] === true };
}

async function downloadMedia(msg, tabId) {
  const { url, kind } = msg;
  if (!url) throw new Error('Ingen video-URL');

  const seq = await seqState();
  const { ask } = await askState();
  const filename = seq.on ? seqPrefix(seq.next) + (msg.filename || 'video')
                          : msg.filename;
  const bumpSeq = () => seq.on
    ? chrome.storage.local.set({ [SEQ_KEY]: seq.next + 1 }).catch(() => {})
    : Promise.resolve();

  if (kind === 'hls' || kind === 'dash' || kind === 'vimeo') {
    relay(tabId, { type: 'MEDIA_PROGRESS', text: 'Læser playliste…' });
    const res = await runInOffscreen({
      type: kind === 'hls' ? 'OFFSCREEN_HLS'
        : kind === 'dash' ? 'OFFSCREEN_DASH' : 'OFFSCREEN_VIMEO',
      url, tabId,
      // Hvilken ramme afspilleren hører hjemme i – offscreen-dokumentet skal
      // kunne bede DEN om at hente, hvis CDN'en afviser vores egne kald.
      frameId: await frameForUrl(tabId, url)
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Kunne ikke samle videoen');

    // En DASH-stream med adskilt lyd giver to filer.
    const ids = [];
    for (const f of res.files) {
      ids.push(await chrome.downloads.download({
        url: f.blobUrl,
        filename: safeName(filename + (f.suffix || ''), f.ext || 'mp4'),
        saveAs: ask
      }));
    }
    // Frigiv blob'erne igen når filerne er skrevet.
    Promise.all(ids.map(whenDone)).finally(() => {
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_REVOKE', blobUrls: res.files.map((f) => f.blobUrl)
      }).catch(() => {});
    });
    await bumpSeq();
    return {
      ok: true,
      size: res.files.reduce((n, f) => n + f.size, 0),
      note: res.note || '',
      seq: seq.on ? seq.next : null
    };
  }

  // Direkte fil: lad browseren om det – den sender sidens cookies med.
  await chrome.downloads.download({
    url,
    filename: safeName(filename, extFromUrl(url)),
    saveAs: ask
  });
  await bumpSeq();
  return { ok: true, seq: seq.on ? seq.next : null };
}

function whenDone(id) {
  return new Promise((resolve) => {
    const listener = (delta) => {
      if (delta.id !== id) return;
      if (delta.state && delta.state.current !== 'in_progress') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    // Sikkerhedsnet hvis vi aldrig hører fra downloaden.
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve();
    }, 10 * 60 * 1000);
  });
}

function extFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,4})$/i);
    return m ? m[1].toLowerCase() : 'mp4';
  } catch (_) { return 'mp4'; }
}

function safeName(name, ext) {
  const base = (name || 'video')
    .replace(/[\\/:*?"<>|]/g, '-')   // ulovlige tegn i Windows-filnavne
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'video';
  return base.toLowerCase().endsWith('.' + ext) ? base : `${base}.${ext}`;
}

// ------------------------------------------------------------- offscreen ---
//
// Service workere har hverken Blob-URL'er eller DOM. Segment-hentning og
// sammensætning sker derfor i et offscreen-dokument, som har begge dele – og
// som takket være host_permissions også må hente på tværs af oprindelser.

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Samler video-segmenter til én fil før download.'
    });
  } catch (e) {
    // "Only a single offscreen document may be created" = den findes allerede.
    if (!/single offscreen/i.test(e.message || '')) throw e;
  }
}

async function runInOffscreen(payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(payload);
}
