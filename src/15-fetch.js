// Hentning på SIDENS vegne.
//
// Nogle CDN'er (Akamai-signerede streams som Hotmart/Vimeo/Brightcove) udleverer
// kun en video til en forespørgsel der ligner afspillerens: samme `Origin`,
// samme `Referer`, sidens egne cookies. Udvidelsens offscreen-dokument har
// ingen af delene – det er sin egen oprindelse – så CDN'en svarer 403, selv om
// afspilleren i rammen ved siden af henter den samme URL uden problemer.
//
// Derfor dette modul: baggrunds-workeren kan bede den RAMME hvor videoen hører
// hjemme, om at hente en URL. Så er afsenderen afspillerens egen side, og
// forespørgslen bærer alt det CDN'en kigger efter, uden at vi selv skal gætte
// hvilke headere det drejer sig om.
//
// Bytes kommer retur som base64: chrome.runtime-beskeder er JSON, og en
// ArrayBuffer overlever ikke turen.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('fetcher', () => {
    // Kun de to tilstande er værd at prøve: uden cookies (som en almindelig
    // afspiller henter) og med (hvis CDN'en kræver sidens session). Rækkefølgen
    // betyder noget – `credentials: 'include'` falder på CORS hvis serveren
    // svarer `Access-Control-Allow-Origin: *`, hvilket de fleste CDN'er gør.
    const MODES = ['omit', 'include'];

    async function pageFetch({ url, range, wantBytes }) {
      const headers = range ? { Range: range } : undefined;
      let last = null;

      for (const credentials of MODES) {
        let res;
        try {
          res = await fetch(url, { credentials, headers });
        } catch (e) {
          // Netværksfejl eller CORS-afvisning – prøv næste tilstand.
          last = { ok: false, error: e.message || String(e) };
          continue;
        }
        if (!res.ok && res.status !== 206) {
          last = { ok: false, status: res.status, error: `HTTP ${res.status}` };
          continue;
        }
        return wantBytes
          ? { ok: true, status: res.status, b64: toBase64(await res.arrayBuffer()) }
          : { ok: true, status: res.status, text: await res.text() };
      }
      return last || { ok: false, error: 'kunne ikke hentes' };
    }

    function toBase64(buf) {
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunk = 0x8000; // btoa på hele filen ad gangen sprænger kaldstakken
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'WF_FETCH') return;
      pageFetch(msg)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
      return true; // svaret er asynkront
    });
  });
})();
