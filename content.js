// Artikel-kopier – content script.
// Vælg et element (artikel), scroll siden igennem for at loade lazy-billeder,
// inline billederne som data-URI'er, og kopiér som rich HTML til udklipsholderen.

(() => {
  if (window.__artikelKopierLoaded) return;
  window.__artikelKopierLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let phase = 'idle'; // 'idle' | 'hover' | 'selected'
  let hoverEl = null;
  let currentEl = null;
  let historyStack = [];
  let prepared = null; // { item, html, text }

  // ---- UI-elementer -------------------------------------------------------

  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: 2147483646,
    border: '2px solid #2563eb', background: 'rgba(37,99,235,0.12)',
    borderRadius: '4px', display: 'none', boxSizing: 'border-box',
    transition: 'all 0.05s ease-out'
  });

  const toolbar = document.createElement('div');
  Object.assign(toolbar.style, {
    position: 'fixed', zIndex: 2147483647, left: '50%', bottom: '24px',
    transform: 'translateX(-50%)', display: 'none', gap: '8px',
    alignItems: 'center', padding: '10px 14px', borderRadius: '12px',
    background: '#111827', color: '#fff', boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
    font: '13px system-ui, sans-serif'
  });
  toolbar.style.display = 'none';

  const status = document.createElement('span');
  status.style.marginRight = '4px';

  const mkBtn = (label) => {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      padding: '6px 10px', border: 'none', borderRadius: '8px',
      cursor: 'pointer', font: '600 13px system-ui, sans-serif', color: '#fff',
      background: '#374151'
    });
    return b;
  };

  const btnLess = mkBtn('⬇ Mindre');
  const btnMore = mkBtn('⬆ Mere');
  const btnCopy = mkBtn('📋 Kopiér');
  btnCopy.style.background = '#2563eb';
  const btnCancel = mkBtn('✕');

  toolbar.append(status, btnLess, btnMore, btnCopy, btnCancel);

  const toast = (() => {
    const t = document.createElement('div');
    Object.assign(t.style, {
      position: 'fixed', zIndex: 2147483647, left: '50%', top: '24px',
      transform: 'translateX(-50%)', padding: '10px 16px', borderRadius: '10px',
      background: '#111827', color: '#fff', font: '600 13px system-ui, sans-serif',
      boxShadow: '0 8px 30px rgba(0,0,0,0.35)', display: 'none'
    });
    return (msg, ms = 2500) => {
      if (!t.isConnected) document.documentElement.appendChild(t);
      t.textContent = msg;
      t.style.display = 'block';
      clearTimeout(t.__timer);
      t.__timer = setTimeout(() => { t.style.display = 'none'; }, ms);
    };
  })();

  function mount() {
    document.documentElement.append(overlay, toolbar);
  }
  function unmount() {
    overlay.remove();
    toolbar.remove();
  }

  // ---- Highlight ----------------------------------------------------------

  function positionOverlay(el) {
    if (!el) { overlay.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: 'block', top: r.top + 'px', left: r.left + 'px',
      width: r.width + 'px', height: r.height + 'px'
    });
  }

  const isOurUI = (el) => overlay.contains(el) || toolbar.contains(el) || el === overlay || el === toolbar;

  // ---- Event-handlere -----------------------------------------------------

  function onMove(e) {
    if (phase !== 'hover') return;
    const el = e.target;
    if (isOurUI(el)) return;
    hoverEl = el;
    positionOverlay(el);
  }

  function onClick(e) {
    if (phase !== 'hover') return;
    if (isOurUI(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    selectElement(pickTarget(e.target));
  }

  function onKey(e) {
    if (phase === 'idle') return;
    if (e.key === 'Escape') { e.preventDefault(); teardown(); }
  }

  function onScrollResize() {
    if (phase === 'selected') positionOverlay(currentEl);
  }

  // ---- Element-valg -------------------------------------------------------

  function pickTarget(el) {
    // Klatr op til nærmeste "artikel"-agtige container, ellers brug det klikkede.
    const article = el.closest('article, [role="article"], [itemprop="articleBody"], main article');
    return article || el;
  }

  function selectElement(el) {
    phase = 'selected';
    currentEl = el;
    historyStack = [];
    positionOverlay(el);
    toolbar.style.display = 'flex';
    prepare();
  }

  btnMore.onclick = () => {
    if (!currentEl || !currentEl.parentElement) return;
    historyStack.push(currentEl);
    currentEl = currentEl.parentElement;
    positionOverlay(currentEl);
    prepare();
  };

  btnLess.onclick = () => {
    if (!historyStack.length) return;
    currentEl = historyStack.pop();
    positionOverlay(currentEl);
    prepare();
  };

  btnCancel.onclick = () => teardown();

  btnCopy.onclick = async () => {
    if (!prepared) return;
    try {
      await navigator.clipboard.write([prepared.item]);
      toast('Artikel kopieret ✓ – indsæt med Ctrl+V');
      teardown();
    } catch (e) {
      if (execCopyFallback(prepared.html)) {
        toast('Artikel kopieret ✓ – indsæt med Ctrl+V');
        teardown();
      } else {
        toast('Kunne ikke kopiere: ' + e.message, 4000);
      }
    }
  };

  // ---- Forberedelse (scroll + inline billeder + byg HTML) -----------------

  async function prepare() {
    prepared = null;
    setBusy('Henter billeder…');

    // 1) Scroll hele siden igennem én gang, så lazy-billeder loades.
    await autoScroll();
    // Sørg for at det valgte element er scrollet ind (udløser evt. dets egne billeder).
    try { currentEl.scrollIntoView({ block: 'start' }); } catch (_) {}
    await sleep(150);

    // 2) Klon og rens.
    const clone = currentEl.cloneNode(true);
    clean(clone);
    absolutize(clone);

    // 3) Saml billed-URL'er og få dem inlinet af baggrunds-workeren.
    const urls = collectImageUrls(clone);
    let map = {};
    if (urls.length) {
      try {
        map = await chrome.runtime.sendMessage({ type: 'INLINE_IMAGES', urls }) || {};
      } catch (_) { map = {}; }
    }
    applyImages(clone, map);

    // 4) Byg endeligt output og cache et ClipboardItem (så selve kopieringen
    //    kan ske synkront inde i knap-klikket = gyldig user activation).
    const html = wrapHtml(clone);
    const text = (clone.innerText || clone.textContent || '').trim();
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' })
    });
    prepared = { item, html, text };
    setReady(urls.length);
  }

  function setBusy(msg) {
    status.textContent = msg;
    btnCopy.disabled = true;
    btnCopy.style.opacity = '0.5';
    btnCopy.style.cursor = 'default';
  }
  function setReady(imgCount) {
    status.textContent = `Klar (${imgCount} billeder)`;
    btnCopy.disabled = false;
    btnCopy.style.opacity = '1';
    btnCopy.style.cursor = 'pointer';
  }

  async function autoScroll() {
    const originalY = window.scrollY;
    const step = Math.max(300, window.innerHeight * 0.9);
    const maxHeight = () => Math.max(
      document.body.scrollHeight, document.documentElement.scrollHeight
    );
    for (let y = 0; y <= maxHeight(); y += step) {
      window.scrollTo(0, y);
      await sleep(120);
    }
    window.scrollTo(0, maxHeight());
    await sleep(150);
    window.scrollTo(0, originalY);
    await sleep(50);
  }

  // ---- Rensning & billed-håndtering --------------------------------------

  function clean(root) {
    root.querySelectorAll(
      'script, style, noscript, iframe, canvas, link, object, embed, template'
    ).forEach((n) => n.remove());
    // Fjern indlejrede handlers.
    root.querySelectorAll('*').forEach((n) => {
      [...n.attributes].forEach((a) => {
        if (a.name.startsWith('on')) n.removeAttribute(a.name);
      });
    });
  }

  function absolutize(root) {
    root.querySelectorAll('a[href]').forEach((a) => {
      try { a.setAttribute('href', new URL(a.getAttribute('href'), location.href).href); } catch (_) {}
    });
  }

  function bestImageUrl(img) {
    const attrs = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-lazy'];
    for (const name of attrs) {
      const v = img.getAttribute(name);
      if (v && !v.startsWith('data:') && v.trim()) {
        try { return new URL(v, location.href).href; } catch (_) {}
      }
    }
    // srcset: vælg den største kandidat.
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (srcset) {
      const best = srcset.split(',')
        .map((s) => s.trim().split(/\s+/))
        .map(([u, d]) => ({ u, w: parseInt(d) || 0 }))
        .sort((a, b) => b.w - a.w)[0];
      if (best && best.u) {
        try { return new URL(best.u, location.href).href; } catch (_) {}
      }
    }
    return null;
  }

  function collectImageUrls(root) {
    const set = new Set();
    root.querySelectorAll('img').forEach((img) => {
      const u = bestImageUrl(img);
      if (u) { img.setAttribute('data-akurl', u); set.add(u); }
    });
    return [...set];
  }

  function applyImages(root, map) {
    root.querySelectorAll('img').forEach((img) => {
      const u = img.getAttribute('data-akurl');
      if (u) {
        img.setAttribute('src', map[u] || u);
        img.removeAttribute('data-akurl');
      }
      ['srcset', 'data-src', 'data-srcset', 'data-original', 'data-lazy-src', 'data-lazy', 'loading']
        .forEach((a) => img.removeAttribute(a));
      // Sørg for at billeder ikke sprænger sidebredden ved paste.
      const style = img.getAttribute('style') || '';
      if (!/max-width/.test(style)) img.setAttribute('style', (style + ';max-width:100%;height:auto;').replace(/^;/, ''));
    });
  }

  function wrapHtml(clone) {
    return '<meta charset="utf-8">' + clone.outerHTML;
  }

  // Fald tilbage til selektions-baseret kopiering hvis Clipboard API fejler.
  function execCopyFallback(html) {
    const holder = document.createElement('div');
    holder.setAttribute('contenteditable', 'true');
    Object.assign(holder.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0' });
    holder.innerHTML = html;
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    sel.removeAllRanges();
    holder.remove();
    return ok;
  }

  // ---- Livscyklus ---------------------------------------------------------

  function startPick() {
    if (phase !== 'idle') return;
    phase = 'hover';
    mount();
    toolbar.style.display = 'none';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize, true);
    toast('Klik på artiklen du vil kopiere (Esc = fortryd)', 3500);
  }

  function teardown() {
    phase = 'idle';
    hoverEl = currentEl = null;
    historyStack = [];
    prepared = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScrollResize, true);
    window.removeEventListener('resize', onScrollResize, true);
    unmount();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'START_PICK') startPick();
  });
})();
