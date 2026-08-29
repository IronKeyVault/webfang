// Video-optag.
//
// Samme peg-og-klik som artiklen, men målet er en video. Kilden findes i to
// trin: først afspillerens egen src, og hvis den er en blob: (streaming, hvor
// src'en er ubrugelig uden for siden) spørger vi baggrunds-workeren hvilke
// medie-URL'er den har set fanen hente.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('video', (WF) => {
    const VIDEO_SEL = 'video, .video-js, [data-vjs-player], [class*="videoplayer"], ' +
      '[class*="video-player"], [class*="videoPlayer"], [class*="player"]';

    // ---- Værktøjslinje -----------------------------------------------------

    const vToolbar = document.createElement('div');
    Object.assign(vToolbar.style, WF.ui.TOOLBAR_STYLE);
    WF.ui.register(vToolbar);

    const vStatus = document.createElement('span');
    vStatus.style.marginRight = '4px';

    const vSelect = document.createElement('select');
    Object.assign(vSelect.style, {
      padding: '6px 8px', borderRadius: '8px', border: 'none',
      font: '13px system-ui, sans-serif', maxWidth: '420px', display: 'none'
    });
    // Sidens egen CSS rammer også vores select. Farverne sættes med !important,
    // så en mørk side ikke efterlader hvid tekst på hvid baggrund = tom liste.
    vSelect.style.setProperty('color', '#111827', 'important');
    vSelect.style.setProperty('background', '#fff', 'important');

    const btnGet = WF.ui.mkBtn('⬇ Hent video');
    btnGet.style.background = '#2563eb';
    const btnProbe = WF.ui.mkBtn('🔎 Kilder');
    btnProbe.title = 'Undersøg alle kilder og kopiér rapporten';
    const btnCancel = WF.ui.mkBtn('✕');
    vToolbar.append(vStatus, vSelect, btnProbe, btnGet, btnCancel);

    function setBusy(msg) {
      vStatus.textContent = msg;
      btnGet.disabled = true;
      btnGet.style.opacity = '0.5';
    }

    function setError(msg) {
      vStatus.textContent = msg;
      btnGet.disabled = false;
      btnGet.style.opacity = '1';
    }

    // ---- Kilder -------------------------------------------------------------

    // Afspillerens egne kilder (springer blob:/data: over – de kan ikke hentes).
    function localSources(container) {
      const out = [];
      const push = (u) => {
        if (!u || u.startsWith('blob:') || u.startsWith('data:')) return;
        const abs = WF.util.absUrl(u);
        if (abs) out.push(abs);
      };
      const videos = container.matches && container.matches('video')
        ? [container] : [...container.querySelectorAll('video')];
      videos.forEach((v) => {
        push(v.currentSrc);
        push(v.getAttribute('src'));
        v.querySelectorAll('source').forEach((s) => push(s.getAttribute('src')));
      });
      // Nogle afspillere gemmer kilden i et data-attribut på wrapperen.
      if (container.attributes) {
        [...container.attributes].forEach((a) => {
          const m = (a.value || '').match(/https?:\/\/[^\s"']+\.(m3u8|mp4|webm)(\?[^\s"']*)?/i);
          if (m) push(m[0]);
        });
      }
      return [...new Set(out)];
    }

    // Kilder som baggrunds-workeren har set fanen hente (fanger blob:-afspillere).
    async function sniffedSources() {
      try {
        return await chrome.runtime.sendMessage({ type: 'GET_MEDIA' }) || [];
      } catch (_) {
        return [];
      }
    }

    // Rækkefølgen kan ikke afgøres på størrelsen. En playliste på 3½ time fylder
    // få kilobyte, mens et enkelt fMP4-segment eller en forhåndsvisning fra et
    // miniaturebillede sagtens fylder megabyte – så størrelse alene lægger
    // stumperne øverst og filmen nederst. Derfor: playlister først, dernæst hele
    // filer, og segmenter sidst. Kender vi spilletiden (🔎/auto-undersøgelse),
    // vejer den tungest af alt: den længste er filmen.
    const PLAYLIST_KINDS = ['hls', 'dash', 'vimeo'];

    function rank(c) {
      if (c.seg) return 3;
      if (PLAYLIST_KINDS.includes(c.kind)) return 0;
      return 1;
    }

    // En master-playliste er ikke én kvalitet – den er LISTEN over dem alle,
    // og hentningen vælger så den bedste. En enkelt variant låser dig fast på
    // lige den kvalitet afspilleren tilfældigvis stod på, da du fangede den,
    // og streaming-afspillere starter altid lavt. De to måler samme spilletid,
    // så uden det her afgøres valget af rækkefølgen på netværket – og det
    // faldt ud til den dårligste.
    const masterRank = (c) => (c.master ? 0 : 1);

    function sortCands(list) {
      return list.sort((a, b) =>
        (rank(a) - rank(b)) ||
        ((b.dur || 0) - (a.dur || 0)) ||
        (masterRank(a) - masterRank(b)) ||
        ((b.size || 0) - (a.size || 0)) ||
        ((b.ts || 0) - (a.ts || 0))
      );
    }

    async function findCandidates(container) {
      const seen = new Set();
      const cands = [];
      const add = (c) => {
        if (!c.url || seen.has(c.url)) return;
        seen.add(c.url);
        cands.push(c);
      };
      localSources(container).forEach((u) => {
        add({ url: u, kind: /\.m3u8(\?|$)/i.test(u) ? 'hls' : 'file', size: 0 });
      });
      (await sniffedSources()).forEach(add);
      return sortCands(cands);
    }

    const fmtSize = (n) => !n ? '' :
      n > 1048576 ? ` (${Math.round(n / 1048576)} MB)` : ` (${Math.round(n / 1024)} kB)`;

    function fmtDur(s) {
      if (!s) return '';
      const t = Math.round(s);
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
      const two = (n) => String(n).padStart(2, '0');
      return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
    }

    function labelFor(c) {
      let name = c.url;
      try { name = new URL(c.url).pathname.split('/').pop() || c.url; } catch (_) {}
      // Navnene på to varianter af samme video ligner hinanden til forveksling,
      // og det der skiller dem ad – bitraten – står til sidst, hvor
      // afkortningen rammer. Så sig det med ord i stedet.
      const kind = c.master ? 'stream, alle kvaliteter'
        : c.kind === 'hls' ? 'stream' : c.kind === 'dash' ? 'DASH'
        : c.kind === 'vimeo' ? 'Vimeo' : c.seg ? 'stump' : 'fil';
      const dur = c.dur ? ` ⏱ ${fmtDur(c.dur)}` : '';
      return `${name.slice(0, 48)} – ${kind}${dur}${fmtSize(c.size)}`;
    }

    function showCandidates(cands) {
      if (!cands.length) {
        vSelect.style.display = 'none';
        setBusy('Ingen video fundet – start afspilningen og prøv igen');
        return;
      }
      vSelect.innerHTML = '';
      cands.forEach((c, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = labelFor(c);
        vSelect.appendChild(o);
      });
      vSelect.style.display = cands.length > 1 ? 'block' : 'none';
      // Fandt vi kun byte-intervaller, er playlisten hentet før Webfang lyttede
      // med. Uden den er der intet at hente hele filmen ud fra.
      if (cands.every((c) => c.seg)) {
        setError('Kun stumper fundet – genindlæs siden (F5), start afspilningen, prøv igen');
        return;
      }
      vStatus.textContent = cands.length > 1
        ? `${cands.length} kilder${probed ? ' – længste øverst' : ''}:`
        : 'Kilde fundet:';
      btnGet.disabled = false;
      btnGet.style.opacity = '1';
    }

    // ---- Valg og hentning ---------------------------------------------------

    function videoTarget(el) {
      if (!el || !el.closest) return null;
      const hit = el.closest(VIDEO_SEL);
      if (hit) return hit;
      // Klikket lige ved siden af? Tag containeren hvis den rummer en afspiller.
      return el.querySelector && el.querySelector('video, .video-js') ? el : null;
    }

    async function select(container) {
      const s = WF.state;
      s.phase = 'vselected';
      s.currentEl = container;
      WF.ui.positionOverlay(container);
      vToolbar.style.display = 'flex';
      setBusy('Leder efter video-kilden…');
      s.vidCands = await findCandidates(container);
      showCandidates(s.vidCands);
      // Playlisterne måles bagefter, så listen ikke venter på netværket: når
      // spilletiderne er hjemme, ordner listen sig selv med filmen øverst.
      if (s.vidCands.some((c) => PLAYLIST_KINDS.includes(c.kind))) {
        probe(true).catch(() => {});
      }
    }

    // ---- Undersøgelse af kilderne ------------------------------------------

    let probed = false;

    // Har brugeren selv rørt dropdown'en? Kun et klik tæller som et valg –
    // se probe() om hvorfor feltets indhold ikke kan bruges til det.
    let userPicked = false;
    vSelect.addEventListener('change', () => { userPicked = true; });

    async function probe(quiet) {
      const s = WF.state;
      const cands = s.vidCands || [];
      if (!cands.length) return [];
      const keep = vSelect.value;
      if (!quiet) vStatus.textContent = 'Undersøger kilder…';
      const results = await chrome.runtime.sendMessage({
        type: 'PROBE_MEDIA',
        items: cands.map((c) => ({ url: c.url, kind: c.kind }))
      }) || [];
      if (s.phase !== 'vselected') return results;
      const byUrl = new Map(results.map((r) => [r.url, r]));
      cands.forEach((c) => {
        const r = byUrl.get(c.url);
        if (!r) return;
        if (r.dur) c.dur = r.dur;
        if (r.size && !c.size) c.size = r.size;
        if (r.note) c.note = r.note;
        if (r.err) c.err = r.err;
        if (r.master) c.master = true;
      });
      const wasSel = cands[Number(keep) || 0];
      sortCands(cands);
      probed = true;
      showCandidates(cands);
      // Har brugeren selv valgt en kilde, følger valget med efter omsorteringen.
      //
      // Det skal måles på om der er KLIKKET, ikke på hvad der står i feltet:
      // uden et klik står der "0" — en ikke-tom streng, altså sand — og så
      // gendanner vi et valg brugeren aldrig har truffet. Det ruller
      // sorteringen tilbage, og master-playlisten kom aldrig øverst.
      if (userPicked && wasSel) {
        const i = cands.indexOf(wasSel);
        if (i >= 0) vSelect.value = String(i);
      }
      return results;
    }

    function report(cands) {
      const lines = [
        `Webfang video-kilder – ${location.href}`,
        `${cands.length} kilder, sorteret som i listen`, ''
      ];
      cands.forEach((c, i) => {
        lines.push(`${i + 1}. [${c.kind}${c.seg ? '/stump' : ''}] ` +
          `${c.dur ? fmtDur(c.dur) : 'ukendt længde'}${fmtSize(c.size)}`);
        if (c.note) lines.push(`   ${c.note}`);
        if (c.err) lines.push(`   FEJL: ${c.err}`);
        lines.push(`   ${c.url}`);
      });
      return lines.join('\n');
    }

    async function probeAndReport() {
      const s = WF.state;
      try {
        if (!probed) await probe(false);
        const text = report(s.vidCands || []);
        try {
          await navigator.clipboard.writeText(text);
          WF.ui.toast('Kilde-rapport kopieret ✓ – indsæt med Ctrl+V', 4000);
        } catch (_) {
          console.log('[Webfang] kilder:\n' + text);
          WF.ui.toast('Kunne ikke kopiere – rapporten står i konsollen (F12)', 5000);
        }
      } catch (e) {
        setError('Fejl: ' + (e.message || e));
      }
    }

    async function download() {
      const c = WF.state.vidCands[Number(vSelect.value) || 0];
      if (!c) return;
      setBusy('Henter…');
      vSelect.style.display = 'none';
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'DOWNLOAD_MEDIA',
          url: c.url,
          kind: c.kind,
          filename: (document.title || 'video').trim()
        });
        if (res && res.ok) {
          // DASH kan levere video og lyd som to separate filer – sig det, i
          // stedet for at lade brugeren opdage en tavs video bagefter.
          const nr = res.seq ? ` (nr. ${res.seq})` : '';
          WF.ui.toast(res.note
            ? `Hentet ✓${nr} – ${res.note}, ligger i Overførsler`
            : `Video hentet ✓${nr} – ligger i Overførsler`, res.note ? 6000 : 3500);
          teardown();
        } else {
          setError('Fejl: ' + ((res && res.error) || 'ukendt'));
        }
      } catch (e) {
        setError('Fejl: ' + (e.message || e));
      }
    }

    btnGet.onclick = download;
    btnProbe.onclick = probeAndReport;
    btnCancel.onclick = () => teardown();

    // ---- Livscyklus ---------------------------------------------------------

    function onMove(e) {
      if (WF.state.phase !== 'vhover' || WF.ui.isOurUI(e.target)) return;
      WF.ui.positionOverlay(videoTarget(e.target) || e.target);
    }

    function onClick(e) {
      if (WF.state.phase !== 'vhover' || WF.ui.isOurUI(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      select(videoTarget(e.target) || e.target);
    }

    function start() {
      const s = WF.state;
      if (s.phase !== 'idle') return;
      s.phase = 'vhover';
      s.vidCands = [];
      probed = false;
      userPicked = false;
      document.documentElement.append(WF.ui.overlay, vToolbar);
      vToolbar.style.display = 'none';
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      WF.app.listenGlobal();
      WF.ui.toast('Klik på videoen du vil hente (Esc = fortryd)', 3500);
    }

    function teardown() {
      const s = WF.state;
      s.phase = 'idle';
      s.currentEl = null;
      s.vidCands = [];
      probed = false;
      userPicked = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      WF.app.unlistenGlobal();
      WF.ui.overlay.remove();
      vToolbar.remove();
    }

    // Fremdrift undervejs i en stream-download.
    function onProgress(text) {
      if (WF.state.phase === 'vselected') vStatus.textContent = text;
    }

    WF.video = { start, teardown, onProgress };
  });
})();
