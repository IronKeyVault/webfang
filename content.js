// Artikel-kopier – content script.
// Vælg et element (artikel), scroll siden igennem for at loade lazy-billeder,
// inline billederne som data-URI'er, og kopiér som rich HTML til udklipsholderen.

(() => {
  // Versioneret vagt. En side der stod åben da udvidelsen blev opdateret, har
  // stadig det GAMLE script kørende; uden versionsnummer ville en ny indsprøjtning
  // blive afvist, og nye funktioner ville lydløst ikke virke.
  const VERSION = 5;
  if (window.__webfang && window.__webfang.version >= VERSION) return;
  window.__artikelKopierLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let phase = 'idle'; // 'idle' | 'hover' | 'selected'
  let hoverEl = null;
  let currentEl = null;
  let historyStack = [];
  let prepared = null; // { item, html, text }
  let stripLinks = false; // fjern links helt (kun tekst)
  let lastQuizCount = 0;   // antal quiz-svar bevaret ved sidste optag
  let lastQuizGroups = 0;  // antal distinkte quizzer (spørgsmål) ved sidste optag

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
    if (e.key === 'Escape') {
      e.preventDefault();
      if (phase === 'vhover' || phase === 'vselected') videoTeardown();
      else teardown();
    }
  }

  function onScrollResize() {
    if (phase === 'selected' || phase === 'vselected') positionOverlay(currentEl);
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

      // Andet forsøg for dem workeren ikke kunne hente: prøv fra selve siden.
      // Nogle CDN'er (fx Cisco's e-learning) kræver sidens cookies OG referer,
      // og dem har kun sidens egen kontekst. Et billede der ikke bliver
      // indlejret, ender som et LINKET billede i Word – det peger tilbage på
      // nettet og overskygger et hyperlink man selv sætter på billedet.
      const missing = urls.filter((u) => !map[u]);
      if (missing.length) {
        Object.assign(map, await inlineInPage(missing));
      }
    }
    applyImages(clone, map);
    const embedded = urls.filter((u) => map[u]).length;

    // 4) Byg endeligt output og cache et ClipboardItem (så selve kopieringen
    //    kan ske synkront inde i knap-klikket = gyldig user activation).
    const html = wrapHtml(clone);
    const text = (clone.innerText || clone.textContent || '').trim();
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' })
    });
    prepared = { item, html, text };
    setReady(urls.length, embedded);
  }

  // Hent billeder fra sidens egen kontekst (cookies + referer følger med) og
  // omdan til data-URI. Bruges kun for dem baggrunds-workeren ikke kunne få.
  async function inlineInPage(urls) {
    const out = {};
    await Promise.all(urls.map(async (url) => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return;
        const blob = await res.blob();
        if (blob.size > 12 * 1024 * 1024) return; // samme grænse som workeren
        out[url] = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
      } catch (_) {
        // Blokeret af CORS → billedet beholder sin original-URL.
      }
    }));
    return out;
  }

  function setBusy(msg) {
    status.textContent = msg;
    btnCopy.disabled = true;
    btnCopy.style.opacity = '0.5';
    btnCopy.style.cursor = 'default';
  }
  function setReady(imgCount, embedded) {
    const quiz = lastQuizGroups
      ? `, ${lastQuizGroups} quiz (${lastQuizCount} svar)` : '';
    // Vis det hvis nogle billeder ikke kunne indlejres: de bliver til linkede
    // billeder i Word (peger tilbage på nettet) i stedet for rigtigt indhold.
    const miss = imgCount - embedded;
    const img = miss > 0
      ? `${embedded}/${imgCount} billeder – ${miss} kunne ikke indlejres`
      : `${imgCount} billeder`;
    status.textContent = `Klar (${img}${quiz})`;
    status.style.color = miss > 0 ? '#fca5a5' : '';
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
    lastQuizGroups = 0;

    // 0) Klonen er en tro kopi, så vi kan parre hver knude med sin levende
    //    tvilling ved at gå de to træer igennem side om side – FØR oprydningen
    //    begynder at fjerne knuder og bryde sammenhængen. Koblingen bruges til
    //    alt der kun findes i den levende side: .checked (som er en DOM-
    //    egenskab, ikke en attribut, og derfor ikke følger med cloneNode) og
    //    beregnede farver (markeringen af et valgt svar).
    const liveOf = new WeakMap();
    if (opts.liveRoot) {
      const pair = (copy, live) => {
        liveOf.set(copy, live);
        const a = copy.children, b = live.children;
        if (a.length !== b.length) return;  // ude af trit → stop denne gren
        for (let i = 0; i < a.length; i++) pair(a[i], b[i]);
      };
      pair(root, opts.liveRoot);

      // Afkrydsninger skrives over som attribut, så de overlever i klonen.
      root.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((c) => {
        const live = liveOf.get(c);
        if (!live) return;
        if (live.checked) c.setAttribute('checked', '');
        else c.removeAttribute('checked');
      });
    }

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

    // 1b2) Navigations-links ("Return to …", "Tilbage til …") er aldrig indhold.
    //      De fjernes på TEKSTEN, ikke på strukturen, fordi de tit har et
    //      pile-ikon i sig – og oprydningen i step 8 springer alt med billeder
    //      over, så artiklens egne billeder ikke ryger med.
    //      Skal ske FØR quiz-konverteringen: en rund pileknap har typisk klassen
    //      "rounded-full", som quiz-genkendelsen bruger til at finde svar, og så
    //      ender linket som et punkt i stedet for at blive fjernet.
    const NAV_TXT =
      /^(return to|back to|go back|return$|back$|tilbage til|tilbage$|næste|forrige|next (topic|lesson|page|module)|previous (topic|lesson|page|module))/i;
    const isNav = (t) => !!t && t.length < 80 && NAV_TXT.test(t);
    root.querySelectorAll('a').forEach((a) => {
      if (isNav((a.textContent || '').replace(/\s+/g, ' ').trim())) a.remove();
    });

    // 1c) Quiz: konvertér svar-muligheder til punkter PÅ STEDET (så flere quizzer
    //     hver især bevares), FØR step 2 fjerner input/label/button/form.
    //     Håndterer både rigtige <input> OG custom klikbare rækker (role=radio
    //     eller "fake radio" med en rounded-full-markør), som Cisco U. bruger.
    {
      const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

      // Tekst fra knapper der betjener quizzen ("Remove Match", ✕) er ikke en
      // del af svaret og skal ikke med i optaget.
      const CONTROL_TXT =
        /^(remove match|remove|clear|reset|fjern match|fjern|slet|nulstil|drag|træk|[×✕✖x])$/i;

      // Svarets tekst. To ting ud over oprydningen: knap-tekster fjernes, og
      // match-øvelser (venstre kolonne parret med højre) skrives som
      // "spørgsmål → svar", så sammenhængen overlever i Word – ellers bliver
      // parret til én løbende sætning man ikke kan læse.
      const rowText = (row) => {
        const c = row.cloneNode(true);
        c.querySelectorAll('*').forEach((n) => {
          if (n.children.length === 0 && CONTROL_TXT.test(norm(n.textContent))) n.remove();
        });
        const blocks = [...c.children].map((x) => norm(x.textContent)).filter(Boolean);
        if (blocks.length === 2) return blocks[0] + ' → ' + blocks[1];
        return norm(c.textContent);
      };

      // Saml svar-rækker i dokument-rækkefølge uden dubletter/indlejrede.
      const rowSet = [];
      const pushRow = (el) => {
        if (!el || el === root || !root.contains(el)) return;
        // Sikkerhedsnet: en rund navigations-knap må aldrig tælle som svar.
        if (isNav(norm(el.textContent))) return;
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

      if (rowSet.length) {
        // Live-rækker til computed-style-fallback (grøn baggrund), matchet på tekst.
        const liveRows = opts.liveRoot ? [...opts.liveRoot.querySelectorAll(
          'input[type=radio],input[type=checkbox],[role=radio],[role=checkbox],[role=option],button,label,li'
        )] : [];
        const findLive = (row) => {
          const paired = liveOf.get(row);
          if (paired) return paired;
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
        // Tegnede radio-knapper/afkrydsningsfelter (ingen <input>, ingen
        // aria-checked): den valgte markør er FARVET, de øvrige står tomme.
        // I stedet for at gætte på en bestemt nuance sammenligner vi rækkernes
        // markør-farve indbyrdes – flertallets farve er "ikke valgt", og en
        // afviger med en mættet farve er den valgte.
        const rgb = (c) => {
          const m = (c || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
          if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return null;
          return [+m[1], +m[2], +m[3]];
        };
        const saturated = (c) => {
          const v = rgb(c);
          return !!v && Math.max(...v) - Math.min(...v) > 30;  // ikke hvid/grå/sort
        };
        // Markørens farve i en række: et lille, kvadratisk/rundt element.
        const markerColor = (row) => {
          const live = findLive(row);
          if (!live || !live.querySelectorAll) return null;
          let filled = null;
          for (const el of live.querySelectorAll('*')) {
            let r;
            try { r = el.getBoundingClientRect(); } catch (_) { continue; }
            if (r.width < 8 || r.width > 34 || r.height < 8 || r.height > 34) continue;
            if (Math.abs(r.width - r.height) > 6) continue;
            const bg = getComputedStyle(el).backgroundColor;
            if (saturated(bg)) return bg;          // en fyldt markør vinder altid
            if (!filled && rgb(bg)) filled = bg;   // ellers husk den tomme markørs farve
          }
          return filled;
        };
        const colorPicked = new Set();
        if (opts.liveRoot && rowSet.length >= 2) {
          const colors = rowSet.map(markerColor);
          const tally = new Map();
          colors.forEach((c) => { if (c) tally.set(c, (tally.get(c) || 0) + 1); });
          // Flertallet = den tomme markør. Ved uafgjort vinder den umættede.
          let common = null, bestN = 0;
          for (const [c, n] of tally) {
            if (n > bestN || (n === bestN && !saturated(c) && saturated(common))) {
              bestN = n; common = c;
            }
          }
          if (tally.size > 1) {
            rowSet.forEach((row, i) => {
              const c = colors[i];
              if (c && c !== common && saturated(c)) colorPicked.add(row);
            });
          }
        }

        // Rækkens eget afkrydsningsfelt. Det ligger ikke altid inde i rækken:
        // mønstret "<input class='peer sr-only' id=x> <label for=x>" (Tailwind,
        // bl.a. Cisco U.) lægger feltet som SØSKENDE til sit label, og selve
        // markeringen tegnes af et pseudoelement. Derfor også opslag via for/id
        // og – som sidste udvej – rækkens egen boks (dens <li>/option-element,
        // ALDRIG en delt forælder, som ville smitte af på hele quizzen).
        const BOXES = 'input[type="radio"], input[type="checkbox"]';
        const ownInput = (row) => {
          if (row.matches && row.matches(BOXES)) return row;
          const inside = row.querySelector && row.querySelector(BOXES);
          if (inside) return inside;
          const id = row.getAttribute && row.getAttribute('for');
          if (id) {
            const byId = root.querySelector('#' + esc(id));
            if (byId && byId.matches(BOXES)) return byId;
          }
          const box = row.closest('li, [class*="answer"], [class*="option"], [class*="choice"]');
          return (box && box !== row) ? box.querySelector(BOXES) : null;
        };

        const isCorrect = (row) => {
          if (colorPicked.has(row)) return true;
          const own = ownInput(row);
          if (own && own.hasAttribute('checked')) return true;

          // Ellers: svarets egen boks (dets eget <li>/option-element), IKKE delte
          // forældre – ellers "smitter" et valgt svar af på alle svar i samme quiz.
          const box = row.closest(
            'li, [class*="answer-option"], [class*="answer"], [class*="option"], [role="radio"], [role="checkbox"]'
          ) || row;
          const cls = (box.className && box.className.toString()) || '';
          if (/\b(is-)?correct\b|answer-correct|right-answer|border-green|bg-green|bg-lime|bg-emerald/i.test(cls)) return true;
          if (box.getAttribute && box.getAttribute('aria-checked') === 'true') return true;
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
        const quizGroups = new Set();
        rowSet.forEach((row) => {
          if (!root.contains(row)) return; // klonen er detached → brug contains, ikke isConnected
          const form = row.closest('form, fieldset');
          if (form && root.contains(form)) quizForms.add(form);
          // Tæl distinkte quizzer: gruppér på nærmeste svar-container.
          const group = row.closest('form, fieldset, [role="radiogroup"], ul, ol') || row.parentElement;
          if (group) quizGroups.add(group);
          const text = rowText(row);
          if (!text) { row.remove(); return; }
          const correct = isCorrect(row);
          // Sidder svaret i en rigtig liste, bliver punkttegnet sat af listen
          // selv – så skal vi ikke også skrive "•", ellers står der "• •" i Word.
          // Er svaret pakket ind i et <li> der ikke indeholder andet, udskifter
          // vi hele <li>'et, så vi ikke efterlader et tomt punkt.
          const li = row.closest('li');
          const target = (li && root.contains(li) && norm(li.textContent) === norm(row.textContent))
            ? li : row;
          const parent = target.parentElement;
          const inList = parent && (parent.tagName === 'UL' || parent.tagName === 'OL');
          const p = document.createElement(inList ? 'li' : 'p');
          if (!inList) p.setAttribute('style', 'margin:2px 0');
          const label = (inList ? '' : '• ') + (correct ? '✓ ' : '') + text;
          if (correct) {
            const b = document.createElement('b');
            b.textContent = label;
            p.appendChild(b);
          } else {
            p.textContent = label;
          }
          target.replaceWith(p);
          lastQuizCount++;
        });
        lastQuizGroups = quizGroups.size;

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

    // 4b) Pak billeder ud af deres link. Et <a><img></a> bliver i Word til et
    //     billede med hyperlink til den originale side/fil, og det skygger for
    //     et hyperlink man selv sætter på billedet bagefter. Kun links uden
    //     egentlig tekst pakkes ud, så "læs mere"-links med ikon beholdes.
    root.querySelectorAll('a').forEach((a) => {
      if (!a.querySelector('img')) return;
      if ((a.textContent || '').trim().length > 3) return;
      a.replaceWith(...a.childNodes);
    });

    // 5) Valgfrit: fjern links helt (behold kun teksten – og billederne, som
    //    ellers ville forsvinde sammen med linket).
    if (opts.stripLinks) {
      root.querySelectorAll('a').forEach((a) => {
        if (a.querySelector('img')) { a.replaceWith(...a.childNodes); return; }
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

  // ---- Video-optag --------------------------------------------------------
  //
  // Samme peg-og-klik som artiklen, men målet er en video. Kilden findes i to
  // trin: først afspillerens egen src, og hvis den er en blob: (streaming, hvor
  // src'en er ubrugelig uden for siden) spørger vi baggrunds-workeren hvilke
  // medie-URL'er den har set fanen hente.

  const VIDEO_SEL = 'video, .video-js, [data-vjs-player], [class*="videoplayer"], ' +
    '[class*="video-player"], [class*="videoPlayer"], [class*="player"]';

  let vidCands = [];   // [{url, kind, size, label}]

  const vToolbar = document.createElement('div');
  Object.assign(vToolbar.style, {
    position: 'fixed', zIndex: 2147483647, left: '50%', bottom: '24px',
    transform: 'translateX(-50%)', display: 'none', gap: '8px',
    alignItems: 'center', padding: '10px 14px', borderRadius: '12px',
    background: '#111827', color: '#fff', boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
    font: '13px system-ui, sans-serif'
  });

  const vStatus = document.createElement('span');
  vStatus.style.marginRight = '4px';

  const vSelect = document.createElement('select');
  Object.assign(vSelect.style, {
    padding: '6px 8px', borderRadius: '8px', border: 'none',
    font: '13px system-ui, sans-serif', maxWidth: '320px', display: 'none'
  });

  const btnGet = mkBtn('⬇ Hent video');
  btnGet.style.background = '#2563eb';
  const btnVCancel = mkBtn('✕');
  vToolbar.append(vStatus, vSelect, btnGet, btnVCancel);

  const isOurVideoUI = (el) =>
    overlay.contains(el) || vToolbar.contains(el) || el === overlay || el === vToolbar;

  function videoTarget(el) {
    if (!el || !el.closest) return null;
    const hit = el.closest(VIDEO_SEL);
    if (hit) return hit;
    // Klikket lige ved siden af? Tag containeren hvis den rummer en afspiller.
    return el.querySelector && el.querySelector('video, .video-js') ? el : null;
  }

  function onVideoMove(e) {
    if (phase !== 'vhover') return;
    if (isOurVideoUI(e.target)) return;
    positionOverlay(videoTarget(e.target) || e.target);
  }

  function onVideoClick(e) {
    if (phase !== 'vhover') return;
    if (isOurVideoUI(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    selectVideo(videoTarget(e.target) || e.target);
  }

  // Afspillerens egne kilder (springer blob:/data: over – de kan ikke hentes).
  function localSources(container) {
    const out = [];
    const push = (u) => {
      if (!u || u.startsWith('blob:') || u.startsWith('data:')) return;
      try { out.push(new URL(u, location.href).href); } catch (_) {}
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

  const fmtSize = (n) => !n ? '' :
    n > 1048576 ? ` (${Math.round(n / 1048576)} MB)` : ` (${Math.round(n / 1024)} kB)`;

  function labelFor(c) {
    let name = c.url;
    try { name = new URL(c.url).pathname.split('/').pop() || c.url; } catch (_) {}
    const kind = c.kind === 'hls' ? 'stream' : c.kind === 'dash' ? 'DASH' : 'fil';
    return `${name.slice(0, 48)} – ${kind}${fmtSize(c.size)}`;
  }

  async function selectVideo(container) {
    phase = 'vselected';
    currentEl = container;
    positionOverlay(container);
    vToolbar.style.display = 'flex';
    setVBusy('Leder efter video-kilden…');

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

    // Kilder som baggrunds-workeren har set fanen hente (fanger blob:-afspillere).
    let sniffed = [];
    try {
      sniffed = await chrome.runtime.sendMessage({ type: 'GET_MEDIA' }) || [];
    } catch (_) {}
    sniffed
      .sort((a, b) => (b.size - a.size) || (b.ts - a.ts))
      .forEach(add);

    vidCands = cands;

    if (!cands.length) {
      vSelect.style.display = 'none';
      vStatus.textContent = 'Ingen video fundet – start afspilningen og prøv igen';
      btnGet.disabled = true;
      btnGet.style.opacity = '0.5';
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

  function setVBusy(msg) {
    vStatus.textContent = msg;
    btnGet.disabled = true;
    btnGet.style.opacity = '0.5';
  }

  btnGet.onclick = async () => {
    const c = vidCands[Number(vSelect.value) || 0];
    if (!c) return;
    setVBusy('Henter…');
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
        toast(res.note
          ? `Hentet ✓${nr} – ${res.note}, ligger i Overførsler`
          : `Video hentet ✓${nr} – ligger i Overførsler`, res.note ? 6000 : 3500);
        videoTeardown();
      } else {
        vStatus.textContent = 'Fejl: ' + ((res && res.error) || 'ukendt');
        btnGet.disabled = false;
        btnGet.style.opacity = '1';
      }
    } catch (e) {
      vStatus.textContent = 'Fejl: ' + (e.message || e);
      btnGet.disabled = false;
      btnGet.style.opacity = '1';
    }
  };

  btnVCancel.onclick = () => videoTeardown();

  function startPickVideo() {
    if (phase !== 'idle') return;
    phase = 'vhover';
    vidCands = [];
    document.documentElement.append(overlay, vToolbar);
    vToolbar.style.display = 'none';
    document.addEventListener('mousemove', onVideoMove, true);
    document.addEventListener('click', onVideoClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize, true);
    toast('Klik på videoen du vil hente (Esc = fortryd)', 3500);
  }

  function videoTeardown() {
    phase = 'idle';
    currentEl = null;
    vidCands = [];
    document.removeEventListener('mousemove', onVideoMove, true);
    document.removeEventListener('click', onVideoClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScrollResize, true);
    window.removeEventListener('resize', onScrollResize, true);
    overlay.remove();
    vToolbar.remove();
  }

  // Optag startes ved at kalde denne direkte (chrome.scripting), IKKE via en
  // besked. En besked ville også ramme et gammelt content-script på en side der
  // stod åben under opdateringen, og starte optaget to gange.
  window.__webfang = {
    version: VERSION,
    start: (what) => { what === 'video' ? startPickVideo() : startPick(); }
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    // Fremdrift undervejs i en stream-download.
    if (msg.type === 'MEDIA_PROGRESS' && phase === 'vselected') {
      vStatus.textContent = msg.text;
    }
  });
})();
