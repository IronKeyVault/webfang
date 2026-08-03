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
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
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

function classify(url, contentType) {
  let path;
  try { path = new URL(url).pathname.toLowerCase(); } catch (_) { return null; }
  const ct = (contentType || '').toLowerCase();
  if (SEGMENT_RE.test(path)) return null;
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
    record(details.tabId, {
      url: details.url,
      kind,
      size: len ? Number(len.value) || 0 : 0,
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
  if (!map) return [];
  return [...map.values()];
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

  if (kind === 'hls' || kind === 'dash') {
    relay(tabId, { type: 'MEDIA_PROGRESS', text: 'Læser playliste…' });
    const res = await runInOffscreen({
      type: kind === 'hls' ? 'OFFSCREEN_HLS' : 'OFFSCREEN_DASH', url, tabId
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
