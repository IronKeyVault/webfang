// Indhold der ligger i en iframe.
//
// Cisco U.'s lab-sider – og mange andre – sætter siden sammen af paneler, hvor
// midterpanelet er sin egen iframe med sin egen URL og sin egen scroll. Set fra
// den ydre side er den ét tomt element: dens DOM kan ikke læses, dens knuder
// kan ikke klones, og oprydningen smed den ud sammen med <script>. Derfor
// forsvandt netop den midterste del af klippet.
//
// Løsningen er at lade Webfang køre i ALLE rammer (manifest: all_frames) og
// lade rammerne aflevere hver sit færdige klip:
//
//   ydre side              ramme
//   ---------              -----
//   pladsholder i klonen
//   REQ (postMessage) ───▶ optag mit indhold (evt. kun inden for udsnittet)
//                          – med mine egne cookies, så MINE billeder kan hentes
//                          – og spørg selv mine egne rammer på samme måde
//   indsæt HTML       ◀─── RES { html }
//
// postMessage bruges frem for baggrunds-workeren, fordi en ramme kan nås
// direkte via contentWindow uden at nogen skal holde styr på frame-id'er – og
// fordi det virker lige så godt i tredje niveau som i første.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('iframes', (WF) => {
    const TAG = '__webfang_frame';
    const TIMEOUT = 25000;   // en ramme der aldrig svarer må ikke låse optaget

    // Eget id-præfiks pr. dokument, så svar aldrig kan forveksles på tværs af
    // niveauer i en dyb ramme-kæde.
    const ORIGIN_ID = Math.random().toString(36).slice(2);
    let seq = 0;

    const isFrame = (el) => el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME');

    // ---- Den ydre side: pladsholdere ---------------------------------------

    // En tom <div> ville ryge i oprydningens dropEmptyWrappers, så pladsholderen
    // bærer et tegn indtil rammens HTML sættes ind i stedet.
    function slotFor(live) {
      const div = document.createElement('div');
      if (live && live.contentWindow) {
        div.setAttribute('data-wf-iframe', String(WF.state.pendingIframes.length));
        div.textContent = '⧉';
        WF.state.pendingIframes.push(live);
      }
      return div;
    }

    // Klonen er en tro kopi, så den i'te <iframe> i klonen svarer til den i'te i
    // den levende gren. Skal ske FØR oprydningen: den fjerner iframes helt.
    function markIframes(clone, liveRoot) {
      const copies = [...clone.querySelectorAll('iframe, frame')];
      if (!copies.length) return;
      const lives = liveRoot ? [...liveRoot.querySelectorAll('iframe, frame')] : [];
      const aligned = lives.length === copies.length;
      copies.forEach((c, i) => c.replaceWith(slotFor(aligned ? lives[i] : null)));
    }

    // Frihånds-rammen kan dække en iframe kun delvist; så gemte region-modulet
    // udsnittet i rammens egne koordinater.
    const rectFor = (live) => WF.state.regionFrameRects.get(live) || null;

    async function fillSlots(root, alive) {
      const slots = [...root.querySelectorAll('[data-wf-iframe]')];
      if (!slots.length) return;
      if (!WF.util.inFrame) WF.ui.setBusy('Henter indhold fra rammer…');
      for (const slot of slots) {
        const live = WF.state.pendingIframes[Number(slot.getAttribute('data-wf-iframe'))];
        slot.removeAttribute('data-wf-iframe');
        const html = await ask(live, rectFor(live));
        if (alive && !alive()) return;
        if (html) {
          const holder = document.createElement('div');
          holder.innerHTML = html;
          slot.replaceWith(...holder.childNodes);
        } else {
          // Ingen svarer: rammen kører ikke vores kode (fx en PDF-viser eller en
          // sandkasse-ramme). Bedre en tom plads end tegnet "⧉".
          console.warn('Webfang: ingen svar fra ramme', live && live.src);
          slot.remove();
        }
      }
    }

    function ask(live, rect) {
      const win = live && live.contentWindow;
      if (!win) return Promise.resolve(null);
      const id = ORIGIN_ID + '-' + (++seq);
      return new Promise((resolve) => {
        const done = (html) => {
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          resolve(html);
        };
        const onMsg = (e) => {
          const d = e.data;
          if (!d || d[TAG] !== 'RES' || d.id !== id) return;
          done(typeof d.html === 'string' && d.html ? d.html : null);
        };
        window.addEventListener('message', onMsg);
        const timer = setTimeout(() => {
          console.warn('Webfang: rammen svarede ikke i tide', live.src);
          done(null);
        }, TIMEOUT);
        try {
          win.postMessage({ [TAG]: 'REQ', id, rect, stripLinks: !!WF.state.stripLinks }, '*');
        } catch (_) {
          done(null);
        }
      });
    }

    // ---- Inde i rammen: lav klippet og send det op -------------------------

    // Optag mit eget dokument. `rectClient` er udsnittet i MINE koordinater set
    // fra mit vindues øverste venstre hjørne – eller null for "det hele".
    async function captureLocal(rectClient, stripLinks) {
      const s = WF.state;
      s.stripLinks = !!stripLinks;
      s.pendingIframes = [];
      const alive = () => true;

      // Regn udsnittet om til dokument-koordinater FØR vi selv scroller.
      const rect = rectClient ? {
        left: rectClient.left + window.scrollX, right: rectClient.right + window.scrollX,
        top: rectClient.top + window.scrollY, bottom: rectClient.bottom + window.scrollY
      } : null;

      await WF.page.expandCollapsibles(document.body);
      await WF.page.autoScroll(alive);

      let clone = null;
      if (rect) {
        const els = WF.region.elementsInRect(rect);
        if (els.length) clone = WF.capture.buildBlocksClone(els);
      }
      if (!clone) {
        // Hele rammen (eller et udsnit der ikke ramte noget): tag mit
        // hovedindhold, præcis som et almindeligt valg ville gøre.
        clone = WF.capture.buildClone(WF.page.pickMainRoot() || document.body);
      }

      await fillSlots(clone, alive);            // mine egne rammer, samme vej
      await WF.media.fillFrames(clone, alive);  // afspiller-plakater
      const urls = WF.images.collectImageUrls(clone);
      WF.images.applyImages(clone, await WF.images.resolveImages(urls, alive));
      return clone.outerHTML;
    }

    // Ét optag ad gangen pr. ramme: to samtidige ville skrive i den samme
    // WF.state (pendingFrames, pendingIframes) og bytte indhold.
    let queue = Promise.resolve();

    function onRequest(e) {
      const d = e.data;
      if (!d || d[TAG] !== 'REQ') return;
      if (!WF.util.inFrame || e.source !== window.parent) return;
      const reply = (html) => {
        try { e.source.postMessage({ [TAG]: 'RES', id: d.id, html }, '*'); } catch (_) {}
      };
      queue = queue
        .then(() => captureLocal(d.rect, d.stripLinks))
        .then(reply, (err) => {
          console.warn('Webfang: optag i ramme fejlede', err);
          reply('');
        });
    }

    if (WF.util.inFrame) window.addEventListener('message', onRequest);

    WF.iframes = { isFrame, slotFor, markIframes, fillSlots, captureLocal, rectFor };
  });
})();
