// Alt hvad brugeren ser: markerings-ramme, værktøjslinje, knapper og beskeder.
// Modulet bygger elementerne og ved hvordan de tegnes – hvad knapperne GØR,
// bestemmes i 90-app.js.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('ui', (WF) => {
    const { sleep } = WF.util;

    const TOOLBAR_STYLE = {
      position: 'fixed', zIndex: 2147483647, left: '50%', bottom: '24px',
      transform: 'translateX(-50%)', display: 'none', gap: '8px',
      alignItems: 'center', padding: '10px 14px', borderRadius: '12px',
      background: '#111827', color: '#fff', boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
      font: '13px system-ui, sans-serif'
    };

    // ---- Elementer --------------------------------------------------------

    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: 2147483646,
      border: '2px solid #2563eb', background: 'rgba(37,99,235,0.12)',
      borderRadius: '4px', display: 'none', boxSizing: 'border-box',
      transition: 'all 0.05s ease-out'
    });

    const toolbar = document.createElement('div');
    Object.assign(toolbar.style, TOOLBAR_STYLE);

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

    const btn = {
      less: mkBtn('⬇ Mindre'),
      more: mkBtn('⬆ Mere'),
      all: mkBtn('📄 Hele siden'),
      links: mkBtn('🔗 Links: til'),
      copy: mkBtn('📋 Kopiér'),
      cancel: mkBtn('✕')
    };
    btn.copy.style.background = '#2563eb';

    toolbar.append(status, btn.less, btn.more, btn.all, btn.links, btn.copy, btn.cancel);

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

    // ---- Vores egne elementer ---------------------------------------------
    //
    // Alt vi selv lægger på siden meldes ind her, så hverken markeringen,
    // frihånds-rammen eller skærmklippene forveksler vores UI med sidens
    // indhold.

    const own = new Set([overlay, toolbar]);
    const register = (el) => own.add(el);
    const isOurUI = (el) => {
      if (!el) return false;
      for (const o of own) if (o === el || o.contains(el)) return true;
      return false;
    };

    function mount() {
      document.documentElement.append(overlay, toolbar);
    }
    function unmount() {
      overlay.remove();
      toolbar.remove();
    }

    // ---- Markerings-ramme --------------------------------------------------

    function positionOverlay(el) {
      if (!el) { overlay.style.display = 'none'; return; }
      const r = el.getBoundingClientRect();
      let top = r.top, left = r.left, right = r.right, bottom = r.bottom;
      // Adopteres en afspiller udefra (video og tekst er søskende), så vis det:
      // rammen dækker begge dele, ellers ser det ud som om videoen ikke er med.
      const extra = WF.media && WF.media.adoptedPlayerBox(el);
      if (extra) {
        const p = extra.getBoundingClientRect();
        if (p.width && p.height) {
          top = Math.min(top, p.top); left = Math.min(left, p.left);
          right = Math.max(right, p.right); bottom = Math.max(bottom, p.bottom);
        }
      }
      Object.assign(overlay.style, {
        display: 'block', top: top + 'px', left: left + 'px',
        width: (right - left) + 'px', height: (bottom - top) + 'px'
      });
    }

    // Tegn frihånds-rammen (gemt i dokument-koordinater) i vinduet.
    function positionOverlayRect(rect) {
      if (!rect) { overlay.style.display = 'none'; return; }
      Object.assign(overlay.style, {
        display: 'block',
        left: (rect.left - window.scrollX) + 'px',
        top: (rect.top - window.scrollY) + 'px',
        width: (rect.right - rect.left) + 'px',
        height: (rect.bottom - rect.top) + 'px'
      });
    }

    function hideOverlay() {
      overlay.style.display = 'none';
    }

    // Skjul vores eget UI mens der tages skærmklip, så ramme og værktøjslinje
    // ikke ender oven i billedet.
    async function withoutChrome(fn) {
      const shown = [...own].map((el) => [el, el.style.display]);
      shown.forEach(([el]) => { el.style.display = 'none'; });
      await sleep(60);
      try {
        return await fn();
      } finally {
        shown.forEach(([el, d]) => { el.style.display = d; });
      }
    }

    // ---- Status i værktøjslinjen -------------------------------------------

    function setBusy(msg) {
      status.textContent = msg;
      status.style.color = '';
      btn.copy.disabled = true;
      btn.copy.style.opacity = '0.5';
      btn.copy.style.cursor = 'default';
    }

    function setError(msg) {
      status.textContent = msg;
      status.style.color = '#fca5a5';
      btn.copy.disabled = true;
      btn.copy.style.opacity = '0.5';
      btn.copy.style.cursor = 'default';
    }

    function setReady(imgCount, embedded) {
      const { lastQuizGroups, lastQuizCount } = WF.state;
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
      btn.copy.disabled = false;
      btn.copy.style.opacity = '1';
      btn.copy.style.cursor = 'pointer';
    }

    function showToolbar(on) {
      toolbar.style.display = on ? 'flex' : 'none';
    }

    WF.ui = {
      TOOLBAR_STYLE, overlay, toolbar, status, btn, mkBtn, toast,
      register, isOurUI, mount, unmount,
      positionOverlay, positionOverlayRect, hideOverlay, withoutChrome,
      setBusy, setError, setReady, showToolbar
    };
  });
})();
