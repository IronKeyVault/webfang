// Sammenkobling: hvad knapperne gør, hvordan man starter og stopper, og
// indgangen som popup/genvejstast kalder.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('app', (WF) => {
    const s = WF.state;
    const ui = WF.ui;

    // ---- Fælles hændelser --------------------------------------------------

    function onKey(e) {
      if (s.phase === 'idle') return;
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (s.phase === 'vhover' || s.phase === 'vselected') WF.video.teardown();
      else teardown();
    }

    function onScrollResize() {
      if (s.regionRect) WF.region.draw();
      else if (s.phase === 'selected' || s.phase === 'vselected') ui.positionOverlay(s.currentEl);
    }

    function listenGlobal() {
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScrollResize, true);
      window.addEventListener('resize', onScrollResize, true);
    }

    function unlistenGlobal() {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize, true);
    }

    // ---- Peg-og-klik på artiklen -------------------------------------------

    function onMove(e) {
      if (s.phase !== 'hover' || ui.isOurUI(e.target)) return;
      s.hoverEl = e.target;
      ui.positionOverlay(e.target);
    }

    function onClick(e) {
      if (s.phase !== 'hover' || ui.isOurUI(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      selectElement(WF.page.pickTarget(e.target));
    }

    function selectElement(el) {
      s.phase = 'selected';
      s.currentEl = el;
      s.historyStack = [];
      ui.positionOverlay(el);
      ui.showToolbar(true);
      WF.capture.prepare();
    }

    // Skift valg og forbered forfra.
    function reselect(el) {
      s.currentEl = el;
      ui.positionOverlay(el);
      WF.capture.prepare();
    }

    // ---- Knapper ------------------------------------------------------------

    ui.btn.more.onclick = () => {
      if (!s.currentEl || !s.currentEl.parentElement) return;
      s.leaveRegion();
      s.historyStack.push(s.currentEl);
      reselect(s.currentEl.parentElement);
    };

    ui.btn.less.onclick = () => {
      if (!s.historyStack.length) return;
      s.leaveRegion();
      reselect(s.historyStack.pop());
    };

    ui.btn.all.onclick = () => {
      s.leaveRegion();
      const root = WF.page.pickMainRoot();
      if (s.currentEl && s.currentEl !== root) s.historyStack.push(s.currentEl);
      reselect(root);
    };

    ui.btn.links.onclick = () => {
      s.stripLinks = !s.stripLinks;
      ui.btn.links.textContent = s.stripLinks ? '🔗 Links: fra' : '🔗 Links: til';
      ui.btn.links.style.background = s.stripLinks ? '#b45309' : '#374151';
      WF.capture.prepare();
    };

    ui.btn.cancel.onclick = () => teardown();

    ui.btn.copy.onclick = async () => {
      if (await WF.capture.copyPrepared()) {
        ui.toast('Artikel kopieret ✓ – indsæt med Ctrl+V');
        teardown();
      }
    };

    // ---- Start og stop ------------------------------------------------------

    function startPick() {
      if (s.phase !== 'idle') return;
      s.phase = 'hover';
      // Scroll til toppen så du markerer fra artiklens start.
      WF.page.scrollAllToTop();
      // Nogle sider scroller tilbage et øjeblik efter – nulstil igen.
      setTimeout(WF.page.scrollAllToTop, 60);
      ui.mount();
      ui.showToolbar(false);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      listenGlobal();
      ui.toast('Klik på artiklen du vil kopiere (Esc = fortryd)', 3500);
    }

    function startPickRegion() {
      if (s.phase !== 'idle') return;
      s.phase = 'region';
      s.regionEls = s.regionRect = null;
      ui.mount();
      ui.showToolbar(false);
      WF.region.startDragging();
      listenGlobal();
      ui.toast('Træk en ramme om det du vil have med ' +
        '(du må gerne scrolle undervejs – Esc = fortryd)', 5000);
    }

    function teardown() {
      s.reset();
      WF.region.stopDragging();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      unlistenGlobal();
      ui.unmount();
    }

    WF.app = { startPick, startPickRegion, teardown, listenGlobal, unlistenGlobal };

    // Optag startes ved at kalde denne direkte (chrome.scripting), IKKE via en
    // besked. En besked ville også ramme et gammelt content-script på en side
    // der stod åben under opdateringen, og starte optaget to gange.
    window.__webfang = {
      version: WF.version,
      // Måler hvorfor et panel ikke kom med. Kaldes fra popup'en, som viser
      // svaret; teksten returneres, så den ikke kræver en åben konsol.
      diagnose: () => WF.diagnose.run(),
      start: (what) => {
        if (what === 'video') WF.video.start();
        else if (what === 'område') startPickRegion();
        else startPick();
      }
    };

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'MEDIA_PROGRESS') WF.video.onProgress(msg.text);
    });
  });
})();
