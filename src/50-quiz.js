// Quiz-svar.
//
// Svar-mulighederne konverteres til punkter PÅ STEDET (så flere quizzer hver
// især bevares), FØR oprydningen fjerner input/label/button/form. Både rigtige
// <input> og custom klikbare rækker (role=radio eller "fake radio" med en
// rounded-full-markør, som Cisco U. bruger) genkendes, og det VALGTE svar
// markeres med ✓ og fed skrift.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('quiz', (WF) => {
    const { norm, esc, rgb, saturated } = WF.util;

    const BOXES = 'input[type="radio"], input[type="checkbox"]';

    // ---- Find svar-rækkerne ------------------------------------------------

    // Saml svar-rækker i dokument-rækkefølge uden dubletter/indlejrede.
    function collectRows(root) {
      const rows = [];
      const push = (el) => {
        if (!el || el === root || !root.contains(el)) return;
        // Sikkerhedsnet: en rund navigations-knap må aldrig tælle som svar.
        if (WF.text.isNav(norm(el.textContent))) return;
        for (const r of rows) { if (r === el || r.contains(el) || el.contains(r)) return; }
        rows.push(el);
      };

      // a) Rigtige <input type=radio/checkbox>.
      root.querySelectorAll(BOXES).forEach((input) => {
        const label = input.closest('label') ||
          (input.id ? root.querySelector('label[for="' + esc(input.id) + '"]') : null);
        push(label ||
          input.closest('li, button, [role="radio"], [role="checkbox"], [class*="option"], [class*="answer"], [class*="choice"]') ||
          input.parentElement || input);
      });

      // b) Custom role-baserede svar.
      root.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]').forEach(push);

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
        if (row && (row.textContent || '').trim()) push(row);
      });

      return rows;
    }

    // ---- Kobling til den levende side --------------------------------------

    // Klonen har ikke .checked og ingen beregnede farver – dem skal vi hente på
    // den levende side. Findes parringen ikke, matches der på tekst.
    function liveFinder(root, opts, liveOf) {
      const liveRows = opts.liveRoot ? [...opts.liveRoot.querySelectorAll(
        'input[type=radio],input[type=checkbox],[role=radio],[role=checkbox],' +
        '[role=option],button,label,li,td,pre'
      )] : [];
      return (row) => {
        const paired = liveOf.get(row);
        if (paired) return paired;
        const t = norm(row.textContent);
        if (!t) return null;
        return liveRows.find((lr) => norm(lr.textContent) === t) || null;
      };
    }

    // ---- Markering: farve ---------------------------------------------------

    // Tegnede radio-knapper/afkrydsningsfelter (ingen <input>, ingen
    // aria-checked): den valgte markør er FARVET, de øvrige står tomme. I stedet
    // for at gætte på en bestemt nuance sammenligner vi rækkernes markør-farve
    // indbyrdes – flertallets farve er "ikke valgt", og en afviger med en mættet
    // farve er den valgte.
    function markerColor(row, findLive) {
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
    }

    function pickedByColor(rows, findLive) {
      const picked = new Set();
      if (rows.length < 2) return picked;
      const colors = rows.map((r) => markerColor(r, findLive));
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
        rows.forEach((row, i) => {
          const c = colors[i];
          if (c && c !== common && saturated(c)) picked.add(row);
        });
      }
      return picked;
    }

    // Grøn baggrund = markeret svar. Her tæller gennemsigtigheden ikke med:
    // en let tonet markering er stadig en markering.
    const greenBg = (el) => {
      try {
        const m = getComputedStyle(el).backgroundColor
          .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          const r = +m[1], g = +m[2], b = +m[3];
          return g > r + 5 && g > b + 5 && !(r > 240 && g > 240 && b > 240);
        }
      } catch (_) {}
      return false;
    };

    // ---- Markering: rækkens eget felt --------------------------------------

    // Rækkens eget afkrydsningsfelt. Det ligger ikke altid inde i rækken:
    // mønstret "<input class='peer sr-only' id=x> <label for=x>" (Tailwind,
    // bl.a. Cisco U.) lægger feltet som SØSKENDE til sit label, og selve
    // markeringen tegnes af et pseudoelement. Derfor også opslag via for/id
    // og – som sidste udvej – rækkens egen boks (dens <li>/option-element,
    // ALDRIG en delt forælder, som ville smitte af på hele quizzen).
    function ownInput(root, row) {
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
    }

    function makeIsCorrect(root, colorPicked, findLive) {
      return (row) => {
        if (colorPicked.has(row)) return true;
        const own = ownInput(root, row);
        if (own && own.hasAttribute('checked')) return true;

        // Den levende rækkes eget felt. `checked` er en DOM-EGENSKAB, ikke en
        // attribut, så den findes kun på siden selv – og parringen der ellers
        // skriver den over i klonen, går i stå på den første gren hvor klon og
        // side ikke har lige mange børn. Derfor spørges siden også direkte.
        const liveRow = findLive(row);
        if (liveRow && liveRow.querySelector) {
          const liveBox = liveRow.matches(BOXES) ? liveRow : liveRow.querySelector(BOXES);
          if (liveBox && liveBox.checked) return true;
          // Tailwind-mønstret: feltet er SØSKENDE til sit label (label[for=id]).
          const forId = liveRow.getAttribute('for');
          const byId = forId && liveRow.ownerDocument.getElementById(forId);
          if (byId && byId.checked) return true;
          const liveOwn = liveRow.closest('li, [class*="answer"], [class*="option"], [class*="choice"]');
          const near = liveOwn && liveOwn !== liveRow ? liveOwn.querySelector(BOXES) : null;
          if (near && near.checked) return true;
        }

        // Ellers: svarets egen boks (dets eget <li>/option-element), IKKE delte
        // forældre – ellers "smitter" et valgt svar af på alle svar i samme quiz.
        const box = row.closest(
          'li, [class*="answer-option"], [class*="answer"], [class*="option"], [role="radio"], [role="checkbox"]'
        ) || row;
        const cls = (box.className && box.className.toString()) || '';
        if (/\b(is-)?correct\b|answer-correct|right-answer|border-green|bg-green|bg-lime|bg-emerald/i.test(cls)) return true;
        if (box.getAttribute && box.getAttribute('aria-checked') === 'true') return true;
        // Live: grøn baggrund på svarets egen boks (ikke forældre).
        const live = liveRow;
        const liveBox = live ? (live.closest(
          'li, [class*="answer"], [class*="option"], [role="radio"], [role="checkbox"]'
        ) || live) : null;
        return !!(liveBox && greenBg(liveBox));
      };
    }

    // ---- Svarets tekst og punkt --------------------------------------------

    // To ting ud over oprydningen: knap-tekster fjernes, og match-øvelser
    // (venstre kolonne parret med højre) skrives som "spørgsmål → svar", så
    // sammenhængen overlever i Word – ellers bliver parret til én løbende
    // sætning man ikke kan læse.
    function rowText(row) {
      const c = row.cloneNode(true);
      WF.text.stripControlLeaves(c, WF.text.CONTROL_TXT);
      const blocks = [...c.children].map((x) => norm(x.textContent)).filter(Boolean);
      if (blocks.length === 2) return blocks[0] + ' → ' + blocks[1];
      return norm(c.textContent);
    }

    // Er svaret en kode-blok? Så ER linjeskiftene indholdet: fire CLI-linjer
    // klemt sammen til én sætning er ikke bare grimt, det er en anden
    // kommando-sekvens end den der stod på skærmen. Både et rigtigt <pre>/<code>
    // og en <div> som sidens CSS har givet white-space: pre tæller.
    function preformatted(row, findLive) {
      if (row.matches('pre, code') || row.querySelector('pre, code')) return true;
      const live = findLive(row);
      if (!live || !live.isConnected || !live.querySelectorAll) return false;
      const isPre = (el) => {
        try { return /^pre/.test(getComputedStyle(el).whiteSpace || ''); } catch (_) { return false; }
      };
      if (isPre(live)) return true;
      const inner = [...live.querySelectorAll('*')];
      return inner.length < 200 && inner.some(isPre);
    }

    // Kode-blokkens tekst MED linjeskift. Rækkefølgen af forsøg er vigtig:
    // textContent har kun linjeskift hvis kilden selv har dem, og en
    // highlighter der lægger hver linje i sit eget element har dem ikke –
    // dér findes linjerne kun i layoutet.
    function rowTextPre(row, findLive) {
      const live = findLive(row);
      // Linjerne som de står på skærmen. Først når geometrien ikke kan svare
      // (elementet er ikke i siden længere), falder vi tilbage til teksten selv.
      const geo = WF.util.livePreText(live);
      if (geo.indexOf('\n') >= 0) return geo;
      // Ingen levende tvilling: læs linjerne af klonens egen struktur.
      const structural = WF.util.clonePreText(row);
      if (structural.indexOf('\n') >= 0) return structural;
      const raw = (live && live.innerText) || row.textContent || '';
      return raw.replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    // Billeder/diagrammer i svaret skal med. Punktet bygges af tekst, men et
    // svar kan være et helt netværksdiagram (Cisco U.'s "Content Review
    // Question"), og et rent tekst-punkt ville smide det væk.
    // Ikoner tæller ikke som indhold: afkrydsningsboksen ved siden af svaret er
    // ikke svaret, og som tom kasse i Word skubber den de næste punkter langt ned.
    const mediaIn = (row, liveOf) => [...row.querySelectorAll('img, svg, picture')]
      .filter((m) => !m.closest('picture') || m.tagName === 'PICTURE')
      .filter((m) => m.tagName !== 'svg' || !WF.media.svgIsIcon(m, liveOf));

    // Hvad skal erstattes: er svaret pakket ind i et <li> der ikke indeholder
    // andet, udskifter vi hele <li>'et, så vi ikke efterlader et tomt punkt.
    function replaceTarget(root, row) {
      const li = row.closest('li');
      return (li && root.contains(li) && norm(li.textContent) === norm(row.textContent))
        ? li : row;
    }

    function buildBullet(target, text, media, correct, pre) {
      const parent = target.parentElement;
      // Sidder svaret i en rigtig liste, bliver punkttegnet sat af listen selv –
      // så skal vi ikke også skrive "•", ellers står der "• •" i Word.
      const inList = parent && (parent.tagName === 'UL' || parent.tagName === 'OL');
      // <div> når der er billeder: en <div> inde i et <p> er ugyldig HTML og
      // bliver revet fra hinanden når Word parser klippet.
      const p = document.createElement(inList ? 'li' : (media.length ? 'div' : 'p'));
      // Kode-svar: linjeskiftene skal stå. pre-wrap frem for <pre>, så punktet
      // stadig ombryder i Word i stedet for at løbe ud over sidekanten.
      const style = 'margin:2px 0' +
        (pre ? ';white-space:pre-wrap;font-family:Consolas,\'Courier New\',monospace' : '');
      if (!inList || pre) WF.util.setOwnStyle(p, style);
      const bullet = inList ? '' : '• ';
      if (text) {
        const label = bullet + (correct ? '✓ ' : '') + text;
        // Linjeskift skrives som <br>: Word ignorerer white-space, men aldrig
        // et <br>. Uden det stod en firelinjet CLI-sekvens som én linje.
        if (correct) {
          const b = document.createElement('b');
          WF.util.setLines(b, label);
          p.appendChild(b);
        } else {
          WF.util.setLines(p, label);
        }
      } else if (correct) {
        p.appendChild(document.createTextNode(bullet + '✓'));
      }
      // Billederne flyttes med over på hver sin linje under teksten.
      media.forEach((m) => {
        const line = document.createElement('div');
        WF.util.setOwnStyle(line, 'margin:4px 0');
        line.appendChild(m.tagName === 'svg' ? WF.media.svgToImg(m) : m);
        p.appendChild(line);
      });
      return p;
    }

    // ---- Hovedindgang ------------------------------------------------------

    // Konvertér alle svar-rækker i klonen. Returnerer {count, groups} til
    // status-linjen.
    function convert(root, opts, liveOf) {
      const rows = collectRows(root);
      if (!rows.length) return { count: 0, groups: 0 };

      const findLive = liveFinder(root, opts, liveOf);
      const colorPicked = opts.liveRoot ? pickedByColor(rows, findLive) : new Set();
      const isCorrect = makeIsCorrect(root, colorPicked, findLive);

      // Tæl distinkte quizzer FØR rækkerne bliver skiftet ud. En quiz af rene
      // <div>'er har hverken form eller liste at gruppere på, og hver rækkes egen
      // forælder ville tælle som sin egen quiz – derfor: nærmeste ophæng der
      // rummer mindst to svar.
      const groups = new Set();
      rows.forEach((row) => {
        let p = row.closest('form, fieldset, [role="radiogroup"], ul, ol');
        if (!p) {
          p = row.parentElement;
          while (p && p !== root && rows.filter((r) => p.contains(r)).length < 2) {
            p = p.parentElement;
          }
        }
        groups.add(p || row);
      });

      let count = 0;
      rows.forEach((row) => {
        // Klonen er detached → brug contains, ikke isConnected.
        if (!root.contains(row)) return;

        const media = mediaIn(row, liveOf);
        const pre = preformatted(row, findLive);
        const text = pre ? rowTextPre(row, findLive) : rowText(row);
        if (!text && !media.length) { row.remove(); return; }
        const target = replaceTarget(root, row);
        target.replaceWith(buildBullet(target, text, media, isCorrect(row), pre));
        count++;
      });

      return { count, groups: groups.size };
    }

    // Til 🔎 Diagnose: de enkelte beslutninger skal kunne aflæses hver for sig,
    // ellers er "hvorfor kom kode-blokken ud på én linje" ren gætteri.
    WF.quiz = {
      convert,
      inspect: { collectRows, liveFinder, preformatted, rowText, rowTextPre }
    };
  });
})();
