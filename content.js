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
  let stripLinks = false; // fjern links helt (kun tekst)

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
  const btnLinks = mkBtn('🔗 Links: til');
  const btnCopy = mkBtn('📋 Kopiér');
  btnCopy.style.background = '#2563eb';
  const btnCancel = mkBtn('✕');

  toolbar.append(status, btnLess, btnMore, btnLinks, btnCopy, btnCancel);

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

  btnLinks.onclick = () => {
    stripLinks = !stripLinks;
    btnLinks.textContent = stripLinks ? '🔗 Links: fra' : '🔗 Links: til';
    btnLinks.style.background = stripLinks ? '#b45309' : '#374151';
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
    setBusy('Udfolder & henter…');

    // 0) Udfold sammenklappet indhold ("Show Me", accordions, <details>).
    await expandCollapsibles(currentEl);

    // 1) Scroll hele siden igennem én gang, så lazy-billeder loades.
    await autoScroll();
    // Sørg for at det valgte element er scrollet ind (udløser evt. dets egne billeder).
    try { currentEl.scrollIntoView({ block: 'start' }); } catch (_) {}
    await sleep(150);

    // 2) Klon og rens.
    const clone = currentEl.cloneNode(true);
    clean(clone, { stripLinks, liveRoot: currentEl });
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

  // Udfold sammenklappet indhold: <details>, "Show Me"/"Show more"-toggles og
  // aria-expanded=false, så skjult tekst kommer med i optaget.
  async function expandCollapsibles(rootEl) {
    if (!rootEl) return;
    let clicked = 0;

    // <details> åbnes direkte.
    rootEl.querySelectorAll('details:not([open])').forEach((d) => {
      d.open = true; clicked++;
    });

    const TOGGLE_TXT = /^(show me|show more|show answer|show details|show solution|vis mere|vis svar|læs mere|read more|expand|reveal)\b/i;
    const candidates = rootEl.querySelectorAll(
      'a, button, summary, [role="button"], [aria-expanded="false"], ' +
      '[class*="show"], [class*="toggle"], [class*="expand"], [class*="accordion"], [class*="collaps"]'
    );
    candidates.forEach((el) => {
      // Undgå at navigere væk: spring links over der peger på en rigtig side.
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) return;
      }
      const collapsed = el.getAttribute('aria-expanded') === 'false';
      const txt = (el.textContent || '').trim();
      // Klik kun hvis den ser sammenklappet ud – undgå at lukke åbne igen.
      if (collapsed || (txt.length < 30 && TOGGLE_TXT.test(txt))) {
        try { el.click(); clicked++; } catch (_) {}
      }
    });

    // Giv udfoldet indhold (evt. netværkskald) tid til at dukke op.
    if (clicked) await sleep(400);
  }

  // ---- Rensning & billed-håndtering --------------------------------------

  // Nøgleord der typisk peger på NON-artikel-indhold (menuer, del-knapper,
  // relaterede-artikler, reklamer, kommentarer osv.).
  const JUNK_RE = /(^|[\s_-])(share|social|related|recirc|newsletter|subscribe|promo|advert|adslot|ad-|-ad|sponsor|comment|sidebar|side-bar|breadcrumb|nav|navbar|menu|toolbar|tags?|taglist|byline|author-?bio|cookie|consent|gdpr|popup|modal|overlay|footer|masthead|subnav|pagination|read-?more|more-?stories|trending|popular|recommend|widget|banner|social-share|post-nav|skip-link|screen-?reader|visually-hidden)([\s_-]|$)/i;

  function looksJunk(el) {
    const id = el.id || '';
    const cls = typeof el.className === 'string' ? el.className : '';
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    return JUNK_RE.test(id) || JUNK_RE.test(cls) ||
      /^(navigation|complementary|banner|contentinfo|search)$/.test(role);
  }

  function clean(root, opts = {}) {
    // 1) Tekniske/ikke-indholds-tags væk.
    root.querySelectorAll(
      'script, style, noscript, iframe, canvas, link, object, embed, template'
    ).forEach((n) => n.remove());

    // 1b) Video (video.js m.fl.): erstat HELE afspilleren med dens plakat-billede.
    //     Wrapperen ".video-js" har selv vjs-klasser (fx vjs-paused), så vi kan
    //     ikke bare fjerne alt "vjs-" – vi trækker plakaten ud som rent <img>
    //     og udskifter hele afspilleren (kontrol/status-tekst ryger dermed med).
    const extractPoster = (player) => {
      // a) rigtigt <img> i plakaten (nyere video.js: <picture>/<img>).
      const innerImg = player.querySelector(
        '.vjs-poster img, img.vjs-poster-img, [class*="poster"] img'
      );
      if (innerImg && (innerImg.getAttribute('src') || innerImg.getAttribute('srcset'))) {
        const img = document.createElement('img');
        if (innerImg.getAttribute('src')) img.setAttribute('src', innerImg.getAttribute('src'));
        if (innerImg.getAttribute('srcset')) img.setAttribute('srcset', innerImg.getAttribute('srcset'));
        return img;
      }
      // b) background-image på .vjs-poster.
      const pEl = player.querySelector('.vjs-poster, [class*="poster"]');
      const m = pEl && (pEl.getAttribute('style') || '').match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1]) {
        const img = document.createElement('img');
        img.setAttribute('src', m[1]);
        return img;
      }
      // c) <video poster="...">.
      const v = player.querySelector('video[poster]');
      if (v) {
        const img = document.createElement('img');
        img.setAttribute('src', v.getAttribute('poster'));
        return img;
      }
      return null;
    };

    root.querySelectorAll('.video-js, [data-vjs-player], [class*="videoplayer"]').forEach((player) => {
      const img = extractPoster(player);
      if (img) player.replaceWith(img);
      else player.remove();
    });

    // Rester: løse <video>-tags og evt. vjs-elementer uden for en .video-js-wrapper.
    root.querySelectorAll('video').forEach((v) => {
      const poster = v.getAttribute('poster');
      if (poster) {
        const img = document.createElement('img');
        img.setAttribute('src', poster);
        v.replaceWith(img);
      } else {
        v.remove();
      }
    });
    root.querySelectorAll('[class*="vjs-"], [class*="transcript"]')
      .forEach((n) => n.remove());

    // 1c) Quiz: udtræk svar-muligheder (checkbox/radio) til en punktliste, FØR
    //     step 2 fjerner input/label/form. Ellers forsvinder svarene helt.
    //     Korrekte svar (afkrydset / "correct"-klasse / grøn baggrund) markeres
    //     grønt + ✓. "Korrekt"-status aflæses fra det LEVENDE element (opts.liveRoot),
    //     da cloneNode ikke bevarer checkbox-tilstanden pålideligt.
    const OPT_SEL = 'input[type="checkbox"], input[type="radio"]';
    const optInputs = [...root.querySelectorAll(OPT_SEL)];
    if (optInputs.length) {
      const liveInputs = opts.liveRoot ? [...opts.liveRoot.querySelectorAll(OPT_SEL)] : [];
      const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

      const isCorrect = (liveInput) => {
        if (!liveInput) return false;
        if (liveInput.checked) return true;
        const lr = liveInput.closest(
          'label, li, [class*="option"], [class*="answer"], [class*="choice"]'
        ) || liveInput.parentElement;
        if (!lr) return false;
        if (/correct|is-?correct|answer-?correct|right\b/i.test(lr.className || '')) return true;
        try {
          const m = getComputedStyle(lr).backgroundColor
            .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (m) {
            const r = +m[1], g = +m[2], b = +m[3];
            // Grønlig baggrund (og ikke bare hvid/lys grå).
            if (g > r + 5 && g > b + 5 && !(r > 240 && g > 240 && b > 240)) return true;
          }
        } catch (_) {}
        return false;
      };

      const rows = [];
      const items = [];
      optInputs.forEach((input, i) => {
        const label = input.closest('label') ||
          (input.id ? root.querySelector('label[for="' + esc(input.id) + '"]') : null);
        const row = label ||
          input.closest('li, [class*="option"], [class*="answer"], [class*="choice"], [class*="radio"], [class*="checkbox"]') ||
          input;
        const text = ((label || row).textContent || '').replace(/\s+/g, ' ').trim();
        if (text && row !== input) items.push({ text, correct: isCorrect(liveInputs[i]) });
        rows.push(row);
      });

      if (items.length) {
        const ul = document.createElement('ul');
        items.forEach(({ text, correct }) => {
          const li = document.createElement('li');
          if (correct) {
            // Word dropper farve/highlight ved "Merge Formatting", men beholder
            // fed – så korrekte svar markeres med fed tekst + ✓.
            const b = document.createElement('b');
            b.textContent = '✓ ' + text;
            li.appendChild(b);
          } else {
            li.textContent = text;
          }
          ul.appendChild(li);
        });
        // Indsæt listen uden for en evt. <form>/<fieldset> (som fjernes i step 2).
        const anchor = rows[0];
        const target = anchor.closest('form, fieldset') || anchor;
        if (target.parentNode) target.parentNode.insertBefore(ul, target);
      }
      rows.forEach((r) => { if (r && r.isConnected && r !== root) r.remove(); });
    }

    // Sikkerhedsnet: fjern løsrevne afspiller-status-linjer selv uden vjs-klasse.
    const PLAYER_TXT = /^(video player is loading|current time\b|duration\b|loaded:|stream type|remaining time|progress\b|playback rate|open transcript|close transcript|mute|unmute|fullscreen|picture-in-picture)/i;
    root.querySelectorAll('span, div, p, li, button, a').forEach((n) => {
      if (n.children.length === 0) {
        const t = (n.textContent || '').trim();
        if (t && t.length < 40 && PLAYER_TXT.test(t)) n.remove();
      }
    });

    // 2) Strukturel navigation/UI der aldrig er selve artiklen.
    //    (header beholdes bevidst – artiklens titel ligger tit deri.)
    root.querySelectorAll(
      'nav, aside, footer, form, button, input, select, textarea, label, fieldset, ' +
      '[role="navigation"], [role="complementary"], [role="banner"], ' +
      '[role="contentinfo"], [role="search"], [aria-hidden="true"], [hidden]'
    ).forEach((n) => n.remove());

    // 3) Elementer hvis class/id/role skriger "reklame/del/relateret/menu".
    root.querySelectorAll('*').forEach((n) => {
      if (looksJunk(n)) n.remove();
    });

    // 4) Fjern lister der reelt bare er link-samlinger (menuer/relaterede).
    root.querySelectorAll('ul, ol').forEach((list) => {
      const items = [...list.children].filter((c) => c.tagName === 'LI');
      if (items.length >= 3) {
        const linky = items.filter((li) => {
          const txt = (li.textContent || '').trim();
          const linkTxt = [...li.querySelectorAll('a')]
            .map((a) => (a.textContent || '').trim()).join('');
          return txt.length > 0 && linkTxt.length >= txt.length * 0.9;
        });
        if (linky.length >= items.length * 0.8) list.remove();
      }
    });

    // 5) Valgfrit: fjern links helt (behold kun teksten).
    if (opts.stripLinks) {
      root.querySelectorAll('a').forEach((a) => {
        a.replaceWith(document.createTextNode(a.textContent || ''));
      });
    }

    // 6) Fjern indlejrede event-handlers.
    root.querySelectorAll('*').forEach((n) => {
      [...n.attributes].forEach((a) => {
        if (a.name.startsWith('on')) n.removeAttribute(a.name);
      });
    });

    // 7) Ryd op i nu-tomme wrappers.
    root.querySelectorAll('div, span, section, p').forEach((n) => {
      if (!n.querySelector('img') && !(n.textContent || '').trim()) n.remove();
    });

    // 8) Fjern løsrevne "bare-link"-blokke i toppen og bunden (fx "tilbage til…",
    //    "næste side"). Beholder overskrifter og billeder, så titlen ikke ryger.
    const isBareLink = (el) => {
      if (!el || el.nodeType !== 1) return false;
      if (el.querySelector('img, h1, h2, h3, h4, h5, h6')) return false;
      const links = el.tagName === 'A' ? [el] : [...el.querySelectorAll('a')];
      if (links.length !== 1) return false;
      const txt = (el.textContent || '').trim();
      const linkTxt = (links[0].textContent || '').trim();
      return txt.length > 0 && txt === linkTxt && txt.length < 100;
    };
    while (isBareLink(root.firstElementChild)) root.firstElementChild.remove();
    while (isBareLink(root.lastElementChild)) root.lastElementChild.remove();
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
