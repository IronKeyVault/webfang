// Baggrunds-service worker: henter billeder på tværs af oprindelser (bypasser side-CORS
// takket være host_permissions) og returnerer dem som base64 data-URI'er.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'INLINE_IMAGES') {
    inlineAll(msg.urls || []).then(sendResponse);
    return true; // hold kanalen åben til det asynkrone svar
  }
});

// Genvejstast (Ctrl+Shift+Y) → start optag direkte på den aktive fane.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-pick') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_PICK' });
  } catch (e) {
    // Content-scriptet er ikke injiceret endnu → injicér og prøv igen.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'START_PICK' });
    } catch (_) {
      // Fx chrome://- eller store-sider hvor scripts ikke må køre.
    }
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
