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

      const text = out.join('\n');
      console.log('Webfang diagnose:\n' + text);
      return text;
    }

    WF.diagnose = { run, panels, trace, label };
  });
})();
