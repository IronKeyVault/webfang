// Diagnose: hvorfor endte netop DET her ikke i klippet?
//
// Et manglende panel kan skyldes to helt forskellige ting: enten blev det aldrig
// valgt, eller også blev det ryddet væk undervejs. Uden et svar på hvilken af
// delene, er fejlsøgningen gætteri. Diagnosen måler begge dele på den side der
// står åben, og skriver svaret i popup'en – ingen konsol nødvendig.
//
// Den ændrer ikke siden: alt måles på kopier, og den tilstand oprydningen
// skriver i, lægges tilbage bagefter.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('diagnose', (WF) => {
    const { norm } = WF.util;

    const len = (el) => (el ? norm(el.textContent).length : 0);

    function label(el) {
      if (!el) return '(ingen)';
      const cls = typeof el.className === 'string'
        ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.')
        : '';
      return el.tagName + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
    }

    // Sidens tekst-tunge blokke. Kun den INDERSTE beholder af en tekstmængde
    // tæller med – ellers ville hele kæden af wrappers op til <body> stå på
    // listen med samme tal.
    function panels(max, minText, minSize) {
      const found = [];
      document.querySelectorAll('main, article, section, div').forEach((el) => {
        if (WF.ui.isOurUI(el)) return;
        const t = len(el);
        if (t < minText) return;
        const r = el.getBoundingClientRect();
        if (r.width < minSize || r.height < minSize) return;
        for (const child of el.children) if (len(child) >= t * 0.9) return;
        found.push({ el, t, r });
      });
      return found.sort((a, b) => b.t - a.t).slice(0, max);
    }

    // Kør oprydningen ét trin ad gangen på en kopi og notér hvor teksten
    // forsvinder. Det er svaret på "hvilket trin spiser panelet".
    function trace(el) {
      const s = WF.state;
      const keep = {
        pendingFrames: s.pendingFrames, pendingIframes: s.pendingIframes,
        quiz: s.lastQuizCount, groups: s.lastQuizGroups
      };
      s.pendingIframes = [];

      const clone = el.cloneNode(true);
      WF.iframes.markIframes(clone, el);
      const ctx = {
        opts: { stripLinks: s.stripLinks, liveRoot: el },
        liveOf: WF.clean.pairWithLive(clone, el)
      };

      const drops = [];
      let prev = len(clone);
      const start = prev;
      for (const [name, fn] of WF.clean.STEPS) {
        try { fn(clone, ctx); } catch (e) { drops.push(name + ': FEJL ' + e.message); continue; }
        const now = len(clone);
        // Kun trin der faktisk fjerner noget nævneværdigt.
        if (now < prev - Math.max(20, start * 0.02)) drops.push(name + ': ' + prev + '→' + now);
        prev = now;
      }

      s.pendingFrames = keep.pendingFrames;
      s.pendingIframes = keep.pendingIframes;
      s.lastQuizCount = keep.quiz;
      s.lastQuizGroups = keep.groups;
      return { start, end: prev, drops };
    }

    // ---- Kode-blokke -------------------------------------------------------

    // Linjeskift vises som ⏎, så en flerlinjet blok kan stå på én linje i
    // rapporten uden at man er i tvivl om hvor linjerne går.
    const oneLine = (s, max) => {
      const t = s.replace(/\n/g, ' ⏎ ');
      return t.length > max ? t.slice(0, max) + '…' : t;
    };

    const lineCount = (s) => (s ? s.split('\n').length : 0);

    // Yderste kode-blokke på siden.
    function codeBlocks(max) {
      const all = [...document.querySelectorAll(
        'pre, code, [class*="hljs"], [class*="language-"], [class*="font-mono"]'
      )];
      return all
        .filter((e) => !all.some((o) => o !== e && o.contains(e)))
        .filter((e) => (e.textContent || '').trim())
        .slice(0, max);
    }

    // Hvad ser de tre kilder? Det er dem der er uenige når en CLI-sekvens
    // lander på én linje.
    function codeReport(say) {
      const blocks = codeBlocks(4);
      if (!blocks.length) return;
      say('');
      say('Kode-blokke:');
      const sel = WF.state.currentEl;
      blocks.forEach((el, i) => {
        const txt = el.textContent || '';
        const geo = WF.util.livePreText(el);
        const struct = WF.util.clonePreText(el);
        say((i + 1) + '. ' + label(el) +
          (sel ? ' · i valget: ' + (sel.contains(el) ? 'ja' : 'NEJ') : ''));
        say('   tekstens egne linjeskift: ' + (txt.indexOf('\n') >= 0 ? 'ja' : 'nej') +
          ' · layout: ' + lineCount(geo) + ' linjer' +
          ' · struktur: ' + lineCount(struct) + ' linjer');
        say('   → ' + oneLine(struct || geo || WF.util.norm(txt), 150));
      });
    }

    // Hvad beslutter quiz-koden for hver svar-række? Kører på en KOPI, præcis
    // som optaget selv gør, så svaret er det rigtige og siden er urørt.
    function quizReport(say) {
      const root = WF.state.currentEl || WF.page.pickMainRoot();
      if (!root || !WF.quiz.inspect) return;
      const q = WF.quiz.inspect;
      const clone = root.cloneNode(true);
      const liveOf = WF.clean.pairWithLive(clone, root);
      const findLive = q.liveFinder(clone, { liveRoot: root }, liveOf);
      const rows = q.collectRows(clone);
      if (!rows.length) return;

      say('');
      say('Quiz-rækker (' + rows.length + ' – som optaget ser dem):');
      rows.slice(0, 6).forEach((row, i) => {
        const isPre = q.preformatted(row, findLive);
        const text = isPre ? q.rowTextPre(row, findLive) : q.rowText(row);
        say((i + 1) + '. ' + label(row) +
          ' · kode: ' + (isPre ? 'ja' : 'NEJ') +
          ' · levende tvilling: ' + (findLive(row) ? 'ja' : 'NEJ') +
          ' · linjer: ' + lineCount(text));
        say('   → ' + oneLine(text, 150));
      });
    }

    function run() {
      const s = WF.state;
      const out = [];
      const say = (line) => out.push(line);

      const frames = [...document.querySelectorAll('iframe, frame')]
        .filter((f) => { const r = f.getBoundingClientRect(); return r.width > 40 && r.height > 40; });

      say('Webfang v' + WF.version + ' · ' + location.host);
      say('rammer på siden: ' + frames.length +
        (frames.length ? ' (' + frames.map((f) => (f.src || 'srcdoc').slice(0, 40)).join(', ') + ')' : ''));

      const root = WF.page.pickMainRoot();
      say('hoved-rod (📄 Hele siden): ' + label(root) + ' · ' + len(root) + ' tegn');
      say('valg lige nu: ' + (s.currentEl ? label(s.currentEl) + ' · ' + len(s.currentEl) + ' tegn' : 'intet – fase ' + s.phase));
      if (s.regionEls) say('frihånds-ramme: ' + s.regionEls.length + ' blokke');
      say('klip klar: ' + (s.prepared ? s.prepared.html.length + ' tegn HTML' : 'nej'));
      say('');
      say('Tekst-tunge blokke på siden:');

      // Først de rigtige paneler; giver målene ingenting (en side der bygger sit
      // indhold på en måde vi ikke forudser), sænkes kravene frem for at
      // aflevere en tom rapport.
      let list = panels(6, 300, 150);
      if (!list.length) {
        list = panels(6, 100, 0);
        if (list.length) say('  (ingen store blokke – viser de små)');
      }
      if (!list.length) say('  (fandt ingen – siden har måske sit indhold i en ramme)');

      list.forEach((p, i) => {
        const inSel = s.currentEl ? (s.currentEl.contains(p.el) ? 'ja' : 'NEJ') : '–';
        const inRoot = root ? (root === p.el || root.contains(p.el) ? 'ja' : 'NEJ') : '–';
        const t = trace(p.el);
        say((i + 1) + '. ' + label(p.el));
        say('   ' + Math.round(p.r.width) + '×' + Math.round(p.r.height) + ' px · ' +
          p.t + ' tegn · i valget: ' + inSel + ' · i hoved-rod: ' + inRoot);
        say('   efter oprydning: ' + t.end + ' tegn' +
          (t.end < t.start * 0.5 ? '  ← MISTER indhold' : ''));
        if (t.drops.length) say('   trin der fjerner: ' + t.drops.join(' | '));
      });

      codeReport(say);
      quizReport(say);

      const text = out.join('\n');
      console.log('Webfang diagnose:\n' + text);
      return text;
    }

    WF.diagnose = { run, panels, trace, label };
  });
})();
