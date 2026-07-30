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
  let lastQuizCount = 0;  // diagnostik: antal quiz-svar bevaret ved sidste optag
  let lastQuizInputs = 0; // diagnostik: antal rå input/role-svar fundet i klonen
  let lastQuizRows = 0;   // diagnostik: antal svar-rækker samlet i rowSet

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
  const btnAll = mkBtn('📄 Hele siden');
  const btnLinks = mkBtn('🔗 Links: til');
  const btnCopy = mkBtn('📋 Kopiér');
  btnCopy.style.background = '#2563eb';
  const btnCancel = mkBtn('✕');

  toolbar.append(status, btnLess, btnMore, btnAll, btnLinks, btnCopy, btnCancel);

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

  // Find sidens hoved-indhold (fanger alt uanset hvor man klikkede).
  function pickMainRoot() {
    const cand = document.querySelector('main, [role="main"], article');
    if (cand && (cand.textContent || '').trim().length > 200) return cand;
    let best = document.body, bestLen = 0;
    document.body.querySelectorAll('div, section').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 250 || r.height < 250) return; // spring små/skjulte over
      const len = (el.textContent || '').length;
      if (len > bestLen) { bestLen = len; best = el; }
    });
    return best;
  }

  btnAll.onclick = () => {
    const root = pickMainRoot();
    if (currentEl && currentEl !== root) historyStack.push(currentEl);
    currentEl = root;
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
    const quiz = lastQuizCount ? `, ${lastQuizCount} quiz-svar` : '';
    status.textContent = `Klar (${imgCount} billeder${quiz})`;
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
    lastQuizCount = 0;
    lastQuizInputs = 0;
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

    // 1c) Quiz: konvertér svar-muligheder til punkter PÅ STEDET (så flere quizzer
    //     hver især bevares), FØR step 2 fjerner input/label/button/form.
    //     Håndterer både rigtige <input> OG custom klikbare rækker (role=radio
    //     eller "fake radio" med en rounded-full-markør), som Cisco U. bruger.
    {
      const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

      // Diagnostik: hvor mange rå svar-elementer ligger overhovedet i klonen?
      lastQuizInputs = root.querySelectorAll(
        'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"]'
      ).length;

      // Saml svar-rækker i dokument-rækkefølge uden dubletter/indlejrede.
      const rowSet = [];
      const pushRow = (el) => {
        if (!el || el === root || !root.contains(el)) return;
        for (const r of rowSet) { if (r === el || r.contains(el) || el.contains(r)) return; }
        rowSet.push(el);
      };

      // a) Rigtige <input type=radio/checkbox>.
      root.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((input) => {
        const label = input.closest('label') ||
          (input.id ? root.querySelector('label[for="' + esc(input.id) + '"]') : null);
        const row = label ||
          input.closest('li, button, [role="radio"], [role="checkbox"], [class*="option"], [class*="answer"], [class*="choice"]') ||
          input.parentElement || input;
        pushRow(row);
      });
      // b) Custom role-baserede svar.
      root.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]').forEach(pushRow);
      // c) "Fake radio": lille rund markør → nærmeste klikbare/labelled række.
      //    Kun hvis markøren indgår i en GRUPPE (≥2), så avatarer/ikoner udelukkes.
      root.querySelectorAll('[class*="rounded-full"]').forEach((marker) => {
        const group = marker.parentElement && marker.parentElement.parentElement;
        if (!group || group.querySelectorAll('[class*="rounded-full"]').length < 2) return;
        let row = marker.closest(
          'button, label, li, a[role], [role="button"], [class*="answer"], [class*="/ans"], [class*="option"], [class*="choice"]'
        );
        if (!row) {
          let p = marker.parentElement;
          while (p && p !== root && !(p.textContent || '').trim()) p = p.parentElement;
          row = p;
        }
        if (row && (row.textContent || '').trim()) pushRow(row);
      });

      lastQuizRows = rowSet.length;

      if (rowSet.length) {
        // Live-rækker til computed-style-fallback (grøn baggrund), matchet på tekst.
        const liveRows = opts.liveRoot ? [...opts.liveRoot.querySelectorAll(
          'input[type=radio],input[type=checkbox],[role=radio],[role=checkbox],[role=option],button,label,li'
        )] : [];
        const findLive = (row) => {
          const t = (row.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t) return null;
          return liveRows.find((lr) => (lr.textContent || '').replace(/\s+/g, ' ').trim() === t) || null;
        };
        const greenBg = (el) => {
          try {
            const m = getComputedStyle(el).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (m) { const r = +m[1], g = +m[2], b = +m[3];
              return g > r + 5 && g > b + 5 && !(r > 240 && g > 240 && b > 240); }
          } catch (_) {}
          return false;
        };
        const isCorrect = (row) => {
          // Tjek KUN svarets egen boks (dets eget <li>/option-element), IKKE delte
          // forældre – ellers "smitter" et valgt svar af på alle svar i samme quiz.
          const box = row.closest(
            'li, [class*="answer-option"], [class*="answer"], [class*="option"], [role="radio"], [role="checkbox"]'
          ) || row;
          const cls = (box.className && box.className.toString()) || '';
          if (/\b(is-)?correct\b|answer-correct|right-answer|border-green|bg-green|bg-lime|bg-emerald/i.test(cls)) return true;
          if (box.getAttribute && box.getAttribute('aria-checked') === 'true') return true;
          const inp = box.querySelector && box.querySelector('input[type="radio"], input[type="checkbox"]');
          if (inp && inp.hasAttribute('checked')) return true;
          // Live: grøn baggrund på svarets egen boks (ikke forældre).
          const live = findLive(row);
          const liveBox = live ? (live.closest(
            'li, [class*="answer"], [class*="option"], [role="radio"], [role="checkbox"]'
          ) || live) : null;
          if (liveBox && greenBg(liveBox)) return true;
          return false;
        };

        // Erstat hver svar-række PÅ STEDET med et punkt (bevarer placering pr. quiz).
        const quizForms = new Set();
        rowSet.forEach((row) => {
          if (!root.contains(row)) return; // klonen er detached → brug contains, ikke isConnected
          const form = row.closest('form, fieldset');
          if (form && root.contains(form)) quizForms.add(form);
          const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text) { row.remove(); return; }
          const correct = isCorrect(row);
          const p = document.createElement('p');
          p.setAttribute('style', 'margin:2px 0');
          if (correct) {
            const b = document.createElement('b');
            b.textContent = '• ✓ ' + text;
            p.appendChild(b);
          } else {
            p.textContent = '• ' + text;
          }
          row.replaceWith(p);
          lastQuizCount++;
        });

        // Beskyt quiz-<form>/<fieldset> mod at blive slettet helt i step 2.
        quizForms.forEach((f) => {
          if (!root.contains(f)) return;
          const div = document.createElement('div');
          while (f.firstChild) div.appendChild(f.firstChild);
          f.replaceWith(div);
        });
      }
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

  function scrollAllToTop() {
    // Vinduet + dokumentets scroll-element.
    window.scrollTo(0, 0);
    const se = document.scrollingElement || document.documentElement;
    if (se) se.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
    // Indre scroll-containere (mange sider scroller i en div, ikke vinduet).
    document.querySelectorAll('*').forEach((el) => {
      if (el.scrollTop > 0 && !overlay.contains(el) && !toolbar.contains(el)) {
        el.scrollTop = 0;
      }
    });
  }

  function startPick() {
    if (phase !== 'idle') return;
    phase = 'hover';
    // Scroll til toppen så du markerer fra artiklens start.
    scrollAllToTop();
    // Nogle sider scroller tilbage et øjeblik efter – nulstil igen.
    setTimeout(scrollAllToTop, 60);
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
