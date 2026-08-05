// Sidens tilstand FØR vi kloner: hvad skal med, og hvordan får vi alt frem.
// (Scroll for lazy-billeder, udfoldning af sammenklappet indhold, valg af rod.)
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('page', (WF) => {
    const { sleep, norm } = WF.util;

    // Klatr op til nærmeste "artikel"-agtige container, ellers brug det klikkede.
    function pickTarget(el) {
      const article = el.closest(
        'article, [role="article"], [itemprop="articleBody"], main article'
      );
      return article || el;
    }

    const textLen = (el) => norm(el && el.textContent).length;

    // Er blokken i praksis en menu? Så er den ikke indhold, uanset hvor meget
    // tekst der står i den.
    function linkHeavy(el) {
      const t = textLen(el);
      if (!t) return true;
      let inLinks = 0;
      el.querySelectorAll('a').forEach((a) => { inLinks += textLen(a); });
      return inLinks >= t * 0.7;
    }

    // Sidens indholdspaneler: synlige blokke med rigtig tekst. Kun den INDERSTE
    // beholder af en tekstmængde tæller med, så hele wrapper-kæden op til
    // <body> ikke står på listen med det samme tal.
    function textBlocks(minText) {
      const out = [];
      document.body.querySelectorAll('main, article, section, div').forEach((el) => {
        const t = textLen(el);
        if (t < minText) return;
        const r = el.getBoundingClientRect();
        if (r.width < 250 || r.height < 250) return;
        for (const child of el.children) if (textLen(child) >= t * 0.9) return;
        if (linkHeavy(el)) return;
        out.push({ el, t });
      });
      return out;
    }

    // Nærmeste fælles ophæng for to elementer.
    function commonAncestor(a, b) {
      let n = a;
      while (n && !n.contains(b)) n = n.parentElement;
      return n || document.body;
    }

    // Find sidens hoved-indhold (fanger alt uanset hvor man klikkede).
    //
    // <main>/<article> er kun ét bud. Delte sider – fx en lab-side hvor
    // opgaven står i venstre panel og scenariet i midterpanelet – har flere
    // indholdspaneler ved siden af hinanden, og så tager <main> kun det ene.
    // Derfor: findes der andre STORE tekstpaneler uden for buddet, flyttes
    // valget op til det fælles ophæng, så de kommer med. Kun hvis ophænget ikke
    // slæber hele siden med i købet — ellers er buddet bedre end ingenting.
    function pickMainRoot() {
      let root = null;
      const cand = document.querySelector('main, [role="main"], article');
      if (cand && textLen(cand) > 200) root = cand;

      if (!root) {
        let best = document.body, bestLen = 0;
        document.body.querySelectorAll('div, section').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 250 || r.height < 250) return; // spring små/skjulte over
          const len = (el.textContent || '').length;
          if (len > bestLen) { bestLen = len; best = el; }
        });
        root = best;
      }

      const rootLen = textLen(root);
      const outside = textBlocks(Math.max(300, rootLen * 0.25))
        .filter((b) => !root.contains(b.el) && !b.el.contains(root));
      if (!outside.length) return root;

      let wide = root;
      outside.forEach((b) => { wide = commonAncestor(wide, b.el); });
      const wanted = rootLen + outside.reduce((sum, b) => sum + b.t, 0);
      return textLen(wide) <= wanted * 1.6 ? wide : root;
    }

    function scrollAllToTop() {
      // Vinduet + dokumentets scroll-element.
      window.scrollTo(0, 0);
      const se = document.scrollingElement || document.documentElement;
      if (se) se.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
      // Indre scroll-containere (mange sider scroller i en div, ikke vinduet).
      document.querySelectorAll('*').forEach((el) => {
        if (el.scrollTop > 0 && !WF.ui.isOurUI(el)) el.scrollTop = 0;
      });
    }

    const pageHeight = () => Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement.scrollHeight
    );

    // Scroll hele siden igennem én gang, så lazy-billeder loades, og læg
    // udsigten tilbage hvor den var.
    async function autoScroll(alive) {
      const originalY = window.scrollY;
      const step = Math.max(300, window.innerHeight * 0.9);
      for (let y = 0; y <= pageHeight(); y += step) {
        window.scrollTo(0, y);
        await sleep(120);
        if (alive && !alive()) return;
      }
      window.scrollTo(0, pageHeight());
      await sleep(150);
      window.scrollTo(0, originalY);
      await sleep(50);
    }

    // Udfold sammenklappet indhold: <details>, "Show Me"/"Show more"-toggles og
    // aria-expanded=false, så skjult tekst kommer med i optaget.
    //
    // Loftet på antal klik er ikke pynt: på "Hele siden" er roden hele sidens
    // indhold, og de brede klasse-mønstre ("toggle", "expand") rammer også
    // sidens egen betjening. Hundredvis af klik river en SPA fra hinanden mens
    // vi arbejder – og så peger valget på noget der ikke findes mere.
    const MAX_TOGGLE_CLICKS = 40;

    function isCollapsedToggle(el) {
      // Undgå at navigere væk: spring links over der peger på en rigtig side.
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) return false;
      }
      // Sidens egen navigation/betjening er ikke sammenklappet indhold.
      if (WF.text.looksJunk(el) || el.closest('nav, aside, footer, [role="navigation"]')) {
        return false;
      }
      const txt = norm(el.textContent);
      if (WF.text.isNav(txt)) return false;
      // Klik kun hvis den ser sammenklappet ud – undgå at lukke åbne igen.
      return el.getAttribute('aria-expanded') === 'false' ||
        (txt.length < 30 && WF.text.TOGGLE_TXT.test(txt));
    }

    async function expandCollapsibles(rootEl) {
      if (!rootEl) return;
      let clicked = 0;

      // <details> åbnes direkte.
      rootEl.querySelectorAll('details:not([open])').forEach((d) => {
        d.open = true; clicked++;
      });

      const candidates = rootEl.querySelectorAll(
        'a, button, summary, [role="button"], [aria-expanded="false"], ' +
        '[class*="show"], [class*="toggle"], [class*="expand"], [class*="accordion"], [class*="collaps"]'
      );
      for (const el of candidates) {
        if (clicked >= MAX_TOGGLE_CLICKS) break;
        if (WF.ui.isOurUI(el)) continue;
        if (!isCollapsedToggle(el)) continue;
        try { el.click(); clicked++; } catch (_) {}
      }

      // Giv udfoldet indhold (evt. netværkskald) tid til at dukke op.
      if (clicked) await sleep(400);
    }

    WF.page = {
      pickTarget, pickMainRoot, scrollAllToTop, autoScroll, expandCollapsibles,
      textBlocks, linkHeavy
    };
  });
})();
