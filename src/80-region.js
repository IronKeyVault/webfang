// Frihånds-område.
//
// Peg-og-klik kan kun tage ÉT element, og siden bestemmer selv hvor grænserne
// går – står video og tekst i hver sin container, kan intet enkelt element
// dække begge uden også at tage menuen med. Her trækkes en ramme i stedet, og
// alt der ligger helt inden for den kommer med, uanset hvor i træet det står.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('region', (WF) => {
    const { docRect } = WF.util;

    const dragLayer = document.createElement('div');
    Object.assign(dragLayer.style, {
      position: 'fixed', inset: '0', zIndex: 2147483645, cursor: 'crosshair',
      background: 'rgba(0,0,0,0.03)'
    });
    WF.ui.register(dragLayer);

    // De STØRSTE elementer der ligger helt inden for rammen. Et element der kun
    // rager delvist ind, åbnes i stedet, så dets indre dele kan komme med –
    // ellers ville en container der stikker uden for rammen tage alt eller
    // intet.
    // En iframe kan ikke åbnes udefra, så rammen kan ikke gå ned i den. I
    // stedet noteres hvor MEGET af den rammen dækker – i rammens egne
    // koordinater – og den del beder vi rammen selv om bagefter.
    function noteFrame(ifr, rect) {
      const b = docRect(ifr);
      const cs = getComputedStyle(ifr);
      const px = (v) => parseFloat(v) || 0;
      // Indholdet begynder inden for kant og indvendig margen.
      const left = b.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
      const top = b.top + px(cs.borderTopWidth) + px(cs.paddingTop);
      const right = b.right - px(cs.borderRightWidth) - px(cs.paddingRight);
      const bottom = b.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom);

      const ix = {
        left: Math.max(rect.left, left), top: Math.max(rect.top, top),
        right: Math.min(rect.right, right), bottom: Math.min(rect.bottom, bottom)
      };
      const whole = ix.left <= left + 2 && ix.top <= top + 2 &&
        ix.right >= right - 2 && ix.bottom >= bottom - 2;
      // null = "det hele" – så slipper rammen for at regne på et udsnit der
      // alligevel dækker den helt.
      WF.state.regionFrameRects.set(ifr, whole ? null : {
        left: ix.left - left, right: ix.right - left,
        top: ix.top - top, bottom: ix.bottom - top
      });
    }

    function elementsInRect(rect) {
      const slop = 4;
      const inside = (b) =>
        b.left >= rect.left - slop && b.right <= rect.right + slop &&
        b.top >= rect.top - slop && b.bottom <= rect.bottom + slop;
      const overlaps = (b) =>
        b.left < rect.right && b.right > rect.left &&
        b.top < rect.bottom && b.bottom > rect.top;

      // Et panel med sin EGEN scroll er en fælde: dets kasse er kun det man kan
      // se, mens indholdet inde i det er meget højere. Rammer man ikke kassen
      // helt præcist, ville vi gå ned i børnene – og deres kasser ligger for
      // størstedelen uden for rammen, fordi de er scrollet væk. Resultatet var
      // kun de synlige linjer. Dækker rammen det meste af sådan et panel, tages
      // hele panelet i stedet.
      const scrolls = (el) => {
        const cs = getComputedStyle(el);
        return (el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(cs.overflowY)) ||
          (el.scrollWidth > el.clientWidth + 4 && /auto|scroll/.test(cs.overflowX));
      };
      const covered = (b) => {
        const w = Math.min(b.right, rect.right) - Math.max(b.left, rect.left);
        const h = Math.min(b.bottom, rect.bottom) - Math.max(b.top, rect.top);
        if (w <= 0 || h <= 0) return 0;
        return (w * h) / (b.width * b.height);
      };

      const out = [];
      WF.state.regionFrameRects = new Map();
      const walk = (el) => {
        for (const child of el.children) {
          if (WF.ui.isOurUI(child)) continue;
          const b = docRect(child);
          if (!b.width && !b.height) continue;
          if (WF.iframes.isFrame(child)) {
            if (!inside(b) && !overlaps(b)) continue;
            noteFrame(child, rect);
            out.push(child);
            continue;
          }
          if (inside(b)) out.push(child);
          else if (overlaps(b) && covered(b) >= 0.7 && scrolls(child)) out.push(child);
          else if (overlaps(b)) walk(child);
        }
      };
      walk(document.body);
      return out;
    }

    const draw = () => WF.ui.positionOverlayRect(WF.state.regionRect);

    function onDown(e) {
      const s = WF.state;
      if (s.phase !== 'region' || e.button !== 0) return;
      e.preventDefault();
      s.dragFrom = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
      s.regionRect = {
        left: s.dragFrom.x, top: s.dragFrom.y,
        right: s.dragFrom.x, bottom: s.dragFrom.y
      };
      draw();
    }

    function onMove(e) {
      const s = WF.state;
      if (s.phase !== 'region' || !s.dragFrom) return;
      const x = e.clientX + window.scrollX, y = e.clientY + window.scrollY;
      s.regionRect = {
        left: Math.min(s.dragFrom.x, x), right: Math.max(s.dragFrom.x, x),
        top: Math.min(s.dragFrom.y, y), bottom: Math.max(s.dragFrom.y, y)
      };
      draw();
    }

    function onUp() {
      const s = WF.state;
      if (s.phase !== 'region' || !s.dragFrom) return;
      s.dragFrom = null;
      const r = s.regionRect;
      if (!r || r.right - r.left < 20 || r.bottom - r.top < 20) {
        s.regionRect = null;
        WF.ui.hideOverlay();
        WF.ui.toast('Rammen var for lille – træk en større', 2500);
        return;
      }
      const els = elementsInRect(r);
      if (!els.length) {
        WF.ui.toast('Ingenting inden for rammen – prøv at trække lidt bredere', 3000);
        return;
      }
      s.regionEls = els;
      // Et fælles ophæng, så ⬆ Mere stadig har et sted at klatre op fra.
      s.currentEl = els[0].parentElement || document.body;
      s.historyStack = [];
      s.phase = 'selected';
      stopDragging();
      WF.ui.showToolbar(true);
      draw();
      WF.capture.prepare();
    }

    function startDragging() {
      document.documentElement.appendChild(dragLayer);
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    }

    function stopDragging() {
      dragLayer.remove();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    }

    WF.region = { startDragging, stopDragging, draw, elementsInRect };
  });
})();
