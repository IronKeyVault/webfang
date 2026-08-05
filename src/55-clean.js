// Oprydningen: fra rå klon til noget der kan indsættes i Word.
//
// Rækkefølgen er ikke tilfældig – hvert trin regner med at det forrige har
// kørt. Derfor står trinene som navngivne funktioner i clean(), så man kan se
// rækkefølgen ét sted og læse detaljen ved siden af.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('clean', (WF) => {
    const { norm } = WF.util;

    // Klonen er en tro kopi, så vi kan parre hver knude med sin levende tvilling
    // ved at gå de to træer igennem side om side – FØR oprydningen begynder at
    // fjerne knuder og bryde sammenhængen. Koblingen bruges til alt der kun
    // findes i den levende side: .checked (som er en DOM-egenskab, ikke en
    // attribut, og derfor ikke følger med cloneNode) og beregnede farver.
    function pairWithLive(root, liveRoot) {
      const liveOf = new WeakMap();
      if (!liveRoot) return liveOf;
      const pair = (copy, live) => {
        liveOf.set(copy, live);
        const a = copy.children, b = live.children;
        if (a.length !== b.length) return;  // ude af trit → stop denne gren
        for (let i = 0; i < a.length; i++) pair(a[i], b[i]);
      };
      pair(root, liveRoot);

      // Afkrydsninger skrives over som attribut, så de overlever i klonen.
      root.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((c) => {
        const live = liveOf.get(c);
        if (!live) return;
        if (live.checked) c.setAttribute('checked', '');
        else c.removeAttribute('checked');
      });
      return liveOf;
    }

    // 1) Tekniske/ikke-indholds-tags væk.
    function stripTechnical(root) {
      root.querySelectorAll(
        'script, style, noscript, iframe, canvas, link, object, embed, template'
      ).forEach((n) => n.remove());
    }

    // 2) Navigations-links ("Return to …", "Tilbage til …") er aldrig indhold.
    //    De fjernes på TEKSTEN, ikke på strukturen, fordi de tit har et
    //    pile-ikon i sig – og oprydningen af tomme wrappers springer alt med
    //    billeder over, så artiklens egne billeder ikke ryger med.
    //    Skal ske FØR quiz-konverteringen: en rund pileknap har typisk klassen
    //    "rounded-full", som quiz-genkendelsen bruger til at finde svar, og så
    //    ender linket som et punkt i stedet for at blive fjernet.
    function removeNavLinks(root) {
      root.querySelectorAll('a').forEach((a) => {
        if (WF.text.isNav(norm(a.textContent))) a.remove();
      });
    }

    // 3) Knapper/labels der bærer INDHOLD. Match-øvelser ("Match the benefit to
    //    the appropriate security concept") har hverken radioknapper eller runde
    //    markører – brikkerne ER knapper, og oprydningen ville fjerne hele
    //    svaret. Derfor pakkes indholdsbærende knapper ud til almindelige
    //    afsnit, mens rene styreknapper (Submit, ✕, Next …) lades tilbage.
    function unwrapContentButtons(root) {
      root.querySelectorAll('button, [role="button"], label').forEach((b) => {
        if (!root.contains(b)) return;
        // Betjeningen inde i brikken (✕, "Remove Match") er ikke indhold.
        WF.text.stripControlLeaves(b, WF.text.CTRL_TXT);
        const t = norm(b.textContent);
        // Kun et rigtigt <img> tæller som indhold uden tekst – en knap hvis
        // eneste indhold er en inline-<svg> er et ikon (✕, pil), ikke et svar.
        const hasImg = !!b.querySelector('img');
        // Tom, ren styreknap, navigation eller løst ikon → lad den stå til
        // næste trin, som fjerner den.
        if (!hasImg && (!t || t.length < 2 || WF.text.CTRL_TXT.test(t) || WF.text.isNav(t))) return;
        const div = document.createElement('div');
        WF.util.setOwnStyle(div, 'margin:2px 0');
        while (b.firstChild) div.appendChild(b.firstChild);
        b.replaceWith(div);
      });
    }

    // 4) Sikkerhedsnet: løsrevne afspiller-status-linjer selv uden vjs-klasse.
    function removePlayerChrome(root) {
      root.querySelectorAll('span, div, p, li, button, a').forEach((n) => {
        if (n.children.length === 0) {
          const t = (n.textContent || '').trim();
          if (t && t.length < 40 && WF.text.PLAYER_TXT.test(t)) n.remove();
        }
      });
    }

    // 5) <form>/<fieldset> pakkes ud i stedet for at blive slettet. En hel
    //    øvelse kan ligge i en formular – fx match-opgaven på Cisco U., hvor
    //    brikkerne er almindelige <div>'er – og en sletning ville tage svaret
    //    med. Selve betjeningen (knapper/felter) ryger i næste trin, og en
    //    formular uden indhold (søgefelt o.l.) står tilbage tom og fjernes til
    //    sidst.
    function unwrapForms(root) {
      root.querySelectorAll('form, fieldset').forEach((f) => {
        const div = document.createElement('div');
        while (f.firstChild) div.appendChild(f.firstChild);
        f.replaceWith(div);
      });
    }

    // 6) Strukturel navigation/UI der aldrig er selve artiklen.
    //    (header beholdes bevidst – artiklens titel ligger tit deri.)
    function removeChrome(root) {
      root.querySelectorAll(
        'nav, aside, footer, button, input, select, textarea, label, ' +
        '[role="navigation"], [role="complementary"], [role="banner"], ' +
        '[role="contentinfo"], [role="search"], [aria-hidden="true"], [hidden]'
      ).forEach((n) => n.remove());
    }

    // 7) Elementer hvis class/id/role skriger "reklame/del/relateret/menu".
    function removeJunk(root) {
      root.querySelectorAll('*').forEach((n) => {
        if (WF.text.looksJunk(n)) n.remove();
      });
    }

    // 8) Lister der reelt bare er link-samlinger (menuer/relaterede).
    function removeLinkLists(root) {
      root.querySelectorAll('ul, ol').forEach((list) => {
        const items = [...list.children].filter((c) => c.tagName === 'LI');
        if (items.length < 3) return;
        const linky = items.filter((li) => {
          const txt = norm(li.textContent);
          const linkTxt = [...li.querySelectorAll('a')]
            .map((a) => (a.textContent || '').trim()).join('');
          return txt.length > 0 && linkTxt.length >= txt.length * 0.9;
        });
        if (linky.length >= items.length * 0.8) list.remove();
      });
    }

    // 9) Pak billeder ud af deres link. Et <a><img></a> bliver i Word til et
    //    billede med hyperlink til den originale side/fil, og det skygger for
    //    et hyperlink man selv sætter på billedet bagefter. Kun links uden
    //    egentlig tekst pakkes ud, så "læs mere"-links med ikon beholdes.
    function unwrapImageLinks(root) {
      root.querySelectorAll('a').forEach((a) => {
        if (!a.querySelector('img')) return;
        if ((a.textContent || '').trim().length > 3) return;
        a.replaceWith(...a.childNodes);
      });
    }

    // 10) Valgfrit: fjern links helt (behold kun teksten – og billederne, som
    //     ellers ville forsvinde sammen med linket).
    function dropLinks(root) {
      root.querySelectorAll('a').forEach((a) => {
        if (a.querySelector('img')) { a.replaceWith(...a.childNodes); return; }
        a.replaceWith(document.createTextNode(a.textContent || ''));
      });
    }

    // 11) Fjern indlejrede event-handlers.
    function stripEventHandlers(root) {
      root.querySelectorAll('*').forEach((n) => {
        [...n.attributes].forEach((a) => {
          if (a.name.startsWith('on')) n.removeAttribute(a.name);
        });
      });
    }

    // 12) Ikon-SVG'er væk (afkrydsningsbokse, pile, logoer). Se svgIsIcon:
    //     Word tegner dem ikke, men holder pladsen fri til dem.
    function removeIconSvgs(root, liveOf) {
      root.querySelectorAll('svg').forEach((s) => {
        if (WF.media.svgIsIcon(s, liveOf)) s.remove();
      });
    }

    // 13) Sidens egne højde- og afstands-styles væk. På skærmen giver
    //     style="height:72px" en pæn svar-række; i Word bliver den til en tom
    //     kasse på 72 px, og en quiz med ti svar bliver til flere siders luft.
    //     Word har hverken sidens CSS-fil eller dens layout – kun de inline
    //     styles vi sender med – så det er netop dem der skal slankes.
    //     Vores egne elementer (mærket data-wf) beholder deres.
    const INFLATING = /^\s*((min-|max-)?(height|width)|padding|margin|line-height|gap|row-gap|column-gap|flex|flex-basis|aspect-ratio)(-[a-z]+)?\s*:/i;

    function slimStyles(root) {
      root.querySelectorAll('[style]').forEach((n) => {
        if (n.hasAttribute('data-wf')) return;
        const kept = n.getAttribute('style').split(';')
          .filter((decl) => decl.trim() && !INFLATING.test(decl));
        if (kept.length) n.setAttribute('style', kept.join(';'));
        else n.removeAttribute('style');
      });
    }

    // 14) Ryd op i nu-tomme wrappers.
    function dropEmptyWrappers(root) {
      root.querySelectorAll('div, span, section, p').forEach((n) => {
        if (!n.querySelector('img, svg') && !(n.textContent || '').trim()) n.remove();
      });
    }

    // 13) Fjern løsrevne "bare-link"-blokke i toppen og bunden (fx "tilbage
    //     til…", "næste side"). Beholder overskrifter og billeder, så titlen
    //     ikke ryger.
    function trimBareLinks(root) {
      const isBareLink = (el) => {
        if (!el || el.nodeType !== 1) return false;
        if (el.querySelector('img, h1, h2, h3, h4, h5, h6')) return false;
        const links = el.tagName === 'A' ? [el] : [...el.querySelectorAll('a')];
        if (links.length !== 1) return false;
        const txt = norm(el.textContent);
        const linkTxt = norm(links[0].textContent);
        return txt.length > 0 && txt === linkTxt && txt.length < 100;
      };
      while (isBareLink(root.firstElementChild)) root.firstElementChild.remove();
      while (isBareLink(root.lastElementChild)) root.lastElementChild.remove();
    }

    function absolutize(root) {
      root.querySelectorAll('a[href]').forEach((a) => {
        const abs = WF.util.absUrl(a.getAttribute('href'));
        if (abs) a.setAttribute('href', abs);
      });
    }

    // Hele pipelinen som en LISTE. Rækkefølgen er den samme som før, men nu kan
    // trinene også køres ét ad gangen udefra – diagnosen bruger det til at vise
    // hvilket trin der fjerner indhold, når et panel forsvinder ud af klippet.
    // Hvert trin får (root, ctx) med ctx = { opts, liveOf }.
    const STEPS = [
      ['tekniske tags', (root) => stripTechnical(root)],
      ['afspillere', (root, ctx) => WF.media.replacePlayers(root, ctx.liveOf)],
      // Tabeller skal bygges FØR oprydningen pakker wrappers ud og river
      // strukturen fra hinanden.
      ['tabeller', (root, ctx) => WF.tables.tablify(root, ctx.liveOf)],
      ['nav-links', (root) => removeNavLinks(root)],
      ['quiz', (root, ctx) => {
        const quiz = WF.quiz.convert(root, ctx.opts, ctx.liveOf);
        WF.state.lastQuizCount = quiz.count;
        WF.state.lastQuizGroups = quiz.groups;
      }],
      ['indholdsknapper', (root) => unwrapContentButtons(root)],
      ['afspiller-tekst', (root) => removePlayerChrome(root)],
      ['formularer', (root) => unwrapForms(root)],
      ['sidens betjening', (root) => removeChrome(root)],
      ['junk-klasser', (root) => removeJunk(root)],
      ['link-lister', (root) => removeLinkLists(root)],
      ['billed-links', (root) => unwrapImageLinks(root)],
      ['links helt væk', (root, ctx) => { if (ctx.opts.stripLinks) dropLinks(root); }],
      ['event-handlers', (root) => stripEventHandlers(root)],
      ['ikon-svg', (root, ctx) => removeIconSvgs(root, ctx.liveOf)],
      ['højde-styles', (root) => slimStyles(root)],
      ['tomme wrappers', (root) => dropEmptyWrappers(root)],
      ['løse links i kanten', (root) => trimBareLinks(root)],
      // Mærket har gjort sit; det skal ikke med i klippet. (data-wf-frame og
      // data-wf-iframe er noget andet – de opløses senere i optaget.)
      ['ryd mærker', (root) => {
        root.querySelectorAll('[data-wf]').forEach((n) => n.removeAttribute('data-wf'));
      }]
    ];

    // `opts`: { stripLinks, liveRoot }.
    function clean(root, opts = {}) {
      WF.state.lastQuizCount = 0;
      WF.state.lastQuizGroups = 0;
      WF.state.pendingFrames = [];

      const ctx = { opts, liveOf: pairWithLive(root, opts.liveRoot) };
      for (const [, fn] of STEPS) fn(root, ctx);
    }

    WF.clean = { clean, absolutize, pairWithLive, STEPS };
  });
})();
