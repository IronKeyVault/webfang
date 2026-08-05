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
      font: '13px system-ui, sans-serif', maxWidth: '320px', display: 'none'
    });

    const btnGet = WF.ui.mkBtn('⬇ Hent video');
    btnGet.style.background = '#2563eb';
    const btnCancel = WF.ui.mkBtn('✕');
    vToolbar.append(vStatus, vSelect, btnGet, btnCancel);

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
        const list = await chrome.runtime.sendMessage({ type: 'GET_MEDIA' }) || [];
        return list.sort((a, b) => (b.size - a.size) || (b.ts - a.ts));
      } catch (_) {
        return [];
      }
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
      return cands;
    }

    const fmtSize = (n) => !n ? '' :
      n > 1048576 ? ` (${Math.round(n / 1048576)} MB)` : ` (${Math.round(n / 1024)} kB)`;

    function labelFor(c) {
      let name = c.url;
      try { name = new URL(c.url).pathname.split('/').pop() || c.url; } catch (_) {}
      const kind = c.kind === 'hls' ? 'stream' : c.kind === 'dash' ? 'DASH' : 'fil';
      return `${name.slice(0, 48)} – ${kind}${fmtSize(c.size)}`;
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
      vStatus.textContent = cands.length > 1
        ? `${cands.length} kilder fundet:` : 'Kilde fundet:';
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
