// Video og andet der ikke er almindelige billeder.
//
// En afspiller skal ende som ÉT billede i klippet. Kilderne prøves i den
// rækkefølge der giver bedst resultat: plakaten (rigtig opløsning, ingen
// play-knap) → video-framen via canvas → et skærmklip af afspillerens
// rektangel.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('media', (WF) => {
    const { sleep, loadImage } = WF.util;

    const PLAYER_SEL = '.video-js, [data-vjs-player], [class*="videoplayer"]';
    const PLAYER_BOX_SEL = PLAYER_SEL + ', [class*="video-player"], [class*="poster"], ' +
      'iframe[src*="player"], iframe[src*="video"], iframe[allowfullscreen]';

    // ---- Plakat-billede ----------------------------------------------------

    // Plakat-billedet fra en afspiller: rigtigt <img>, background-image eller
    // <video poster>. Bruges både når afspilleren ligger i valget og når den
    // hentes ind udefra.
    function extractPoster(player) {
      return posterFromImg(player) || posterFromBackground(player) || posterFromAttr(player);
    }

    // a) rigtigt <img> i plakaten (nyere video.js: <picture>/<img>).
    function posterFromImg(player) {
      const innerImg = player.querySelector(
        '.vjs-poster img, img.vjs-poster-img, [class*="poster"] img'
      );
      if (!innerImg) return null;
      const src = innerImg.getAttribute('src');
      const srcset = innerImg.getAttribute('srcset');
      if (!src && !srcset) return null;
      const img = document.createElement('img');
      if (src) img.setAttribute('src', src);
      if (srcset) img.setAttribute('srcset', srcset);
      return img;
    }

    // b) background-image på plakaten – som inline style eller fra stylesheet.
    function posterFromBackground(player) {
      const pEl = player.querySelector('.vjs-poster, [class*="poster"]') ||
        (/poster/i.test(player.className || '') ? player : null);
      if (!pEl) return null;
      const bg = (pEl.getAttribute('style') || '') + ';' +
        (pEl.isConnected ? getComputedStyle(pEl).backgroundImage || '' : '');
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (!m || !m[1]) return null;
      const img = document.createElement('img');
      img.setAttribute('src', m[1]);
      return img;
    }

    // c) <video poster="...">.
    function posterFromAttr(player) {
      const v = player.matches('video[poster]') ? player : player.querySelector('video[poster]');
      if (!v) return null;
      const img = document.createElement('img');
      img.setAttribute('src', v.getAttribute('poster'));
      return img;
    }

    // ---- Pladsholdere ------------------------------------------------------

    // Ingen plakat? Så står billedet alligevel på skærmen – afspilleren viser et
    // billede (pauset frame eller første frame). Vi sætter en pladsholder ind og
    // henter selve billedet senere fra det LEVENDE element.
    function framePlaceholder(live) {
      if (!live) return null;
      const liveVideo = live.tagName === 'VIDEO' ? live : live.querySelector('video');
      return placeholderFor({ video: liveVideo || null, box: live });
    }

    function placeholderFor(spec) {
      const img = document.createElement('img');
      img.setAttribute('data-wf-frame', String(WF.state.pendingFrames.length));
      WF.state.pendingFrames.push(spec);
      return img;
    }

    // ---- Afspilleren på siden ---------------------------------------------

    // En afspiller ser ud som en afspiller: bredere end høj, i et rimeligt
    // billedformat, og den indeholder ikke artiklen. Uden de krav ender vi med
    // en side-container – og skærmklippet bliver hele siden i stedet for
    // plakaten (Cisco U. har ingen <video> før man trykker play).
    function playerArea(el) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 150) return 0;
      // Bred slide-video (fx 2000×510 = 3,9) er helt normal, så loftet skal
      // være højt. Det er ikke formatet der holder side-containere ude, men de
      // to krav nedenfor: en container fylder hele vinduets højde eller
      // indeholder artiklen – en afspiller gør ingen af delene.
      const ratio = r.width / r.height;
      if (ratio < 1.0 || ratio > 6) return 0;
      if (r.height > window.innerHeight * 0.95) return 0;
      const sel = WF.state.currentEl;
      if (sel && el.contains(sel)) return 0; // det er en side, ikke en afspiller
      return r.width * r.height;
    }

    function biggestBy(selector) {
      let best = null, bestArea = 0;
      document.querySelectorAll(selector).forEach((el) => {
        const area = playerArea(el);
        if (area > bestArea) { bestArea = area; best = el; }
      });
      return best;
    }

    // Den største synlige afspiller på siden – uanset hvor i træet den ligger.
    // Returnerer { video, box }: er afspilleren en iframe (fx en indlejret
    // afspiller), findes der intet <video> i vores dokument, og så er boksen alt
    // vi har – den kan stadig fotograferes.
    function biggestPlayer() {
      const v = biggestBy('video');
      if (v) return { video: v, box: v };
      // Cisco U. lægger afspilleren i en iframe – der er hverken <video> eller
      // plakat-klasser i VORES dokument, så uden iframe-kandidaten er der intet
      // at hente.
      const box = biggestBy(PLAYER_BOX_SEL);
      return box ? { video: null, box } : null;
    }

    // Afspilleren der bliver hentet ind udefra for et givet valg – eller null,
    // hvis valget selv indeholder afspilleren (eller der ingen er).
    function adoptedPlayerBox(el) {
      if (!el || !el.querySelector || el.querySelector('video')) return null;
      const p = biggestPlayer();
      if (!p || el.contains(p.box)) return null;
      return p.box;
    }

    // Har det valgte område ingen afspiller, men siden har én, så adopteres den
    // ind i klippet som et billede øverst.
    function adoptOutsideVideo(clone) {
      const sel = WF.state.currentEl;
      if (clone.querySelector('img[data-wf-frame]')) return; // allerede med
      if (sel && sel.querySelector && sel.querySelector('video')) return;
      const p = biggestPlayer();
      if (!p) return;
      if (sel && sel.contains(p.box)) return; // afspilleren er allerede med
      // Har afspilleren en plakat, er den langt bedre end et skærmklip: rigtig
      // opløsning, ingen play-knap og ingen risiko for at fange resten af siden.
      // Den bliver hentet og indlejret i det normale billed-trin bagefter.
      const poster = extractPoster(p.box);
      if (poster) {
        const abs = WF.util.absUrl(poster.getAttribute('src'));
        if (abs) poster.setAttribute('src', abs);
        clone.insertBefore(poster, clone.firstChild);
        return;
      }
      clone.insertBefore(placeholderFor(p), clone.firstChild);
    }

    // ---- Skærmklip ---------------------------------------------------------

    // Scroll elementet ind, bed workeren fotografere fanen, og klip elementets
    // rektangel ud af fotoet.
    async function screenshotElement(live) {
      live.scrollIntoView({ block: 'center' });
      await sleep(200);
      const r = live.getBoundingClientRect();
      // Kun det der faktisk er i vinduet kan fotograferes.
      const x = Math.max(0, r.left), y = Math.max(0, r.top);
      const w = Math.min(r.right, window.innerWidth) - x;
      const h = Math.min(r.bottom, window.innerHeight) - y;
      if (w < 8 || h < 8) return null;

      const shot = await WF.ui.withoutChrome(
        () => chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' })
      );
      if (!shot) return null;

      const full = await loadImage(shot);
      // Fotoet er i fysiske pixels, rektanglet i CSS-pixels.
      const dpr = full.width / window.innerWidth || 1;
      const c = document.createElement('canvas');
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.getContext('2d').drawImage(
        full, Math.round(x * dpr), Math.round(y * dpr),
        c.width, c.height, 0, 0, c.width, c.height
      );
      return c.toDataURL('image/png');
    }

    // Er billedet i praksis ensfarvet (typisk helsort)? En video der afspilles
    // gennem MSE/EME – eller ligger i et hardware-overlag – tegner nemlig et
    // SORT rektangel på canvas'et i stedet for at kaste en fejl. Uden dette
    // tjek ville vi tro det gik godt og aldrig prøve skærmklippet.
    async function looksBlank(dataUrl) {
      try {
        const img = await loadImage(dataUrl);
        const n = 16;
        const c = document.createElement('canvas');
        c.width = n; c.height = n;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, n, n);
        const px = ctx.getImageData(0, 0, n, n).data;
        let min = 255, max = 0;
        for (let i = 0; i < px.length; i += 4) {
          const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          if (lum < min) min = lum;
          if (lum > max) max = lum;
        }
        return max - min < 8; // ingen variation = intet billede
      } catch (_) {
        return false; // kan vi ikke måle, så tror vi på billedet
      }
    }

    // Video-framen direkte fra <video> via canvas (skarpt, i videoens egen
    // opløsning). Null hvis den ikke kan læses ud: tainted canvas ved
    // fremmed-origin uden CORS, eller et sort felt fordi videoen slet ikke
    // tegnes på canvas.
    async function frameFromVideo(v) {
      if (!v || !v.videoWidth || v.readyState < 2) return null;
      try {
        const scale = Math.min(1, 2000 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(v.videoWidth * scale));
        c.height = Math.max(1, Math.round(v.videoHeight * scale));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        const data = c.toDataURL('image/jpeg', 0.92);
        return (await looksBlank(data)) ? null : data;
      } catch (_) {
        return null; // tainted canvas → skærmklip
      }
    }

    // Er <svg>'en et ikon (afkrydsning, pil, logo) frem for indhold? Ikoner må
    // ikke med i klippet: Word tegner ikke inline-SVG, men reserverer pladsen,
    // så hvert ikon bliver til en tom kasse – ti svar med hver sin
    // afkrydsningsboks blev til flere siders luft.
    //
    // Størrelsen tages fra den LEVENDE tvilling hvis vi har den (klonen er
    // løsrevet og måler 0), ellers fra width/height eller viewBox.
    function svgIsIcon(svg, liveOf) {
      const live = liveOf && liveOf.get(svg);
      if (live && live.getBoundingClientRect) {
        const r = live.getBoundingClientRect();
        if (r.width || r.height) return r.width < 64 || r.height < 64;
      }
      const w = parseFloat(svg.getAttribute('width')) || 0;
      const h = parseFloat(svg.getAttribute('height')) || 0;
      if (w || h) return w < 64 || h < 64;
      const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb[2] && vb[3]) return vb[2] < 64 || vb[3] < 64;
      return true;  // ukendt størrelse → hellere et manglende ikon end en tom kasse
    }

    async function frameFromScreenshot(box) {
      // Se resolveImages: et skærmklip taget inde fra en iframe rammer forkert.
      if (!box || WF.util.inFrame) return null;
      let data = null;
      try { data = await screenshotElement(box); } catch (_) {}
      // Også skærmklippet kan være sort (beskyttet afspilning i et
      // hardware-overlag). En sort klods i Word er værre end ingenting.
      if (data && await looksBlank(data)) data = null;
      await sleep(550); // captureVisibleTab er kvoteret til et par kald i sekundet
      return data;
    }

    // Opløs alle pladsholdere i en klon til rigtige billeder.
    async function fillFrames(root, alive) {
      const slots = [...root.querySelectorAll('img[data-wf-frame]')];
      let filled = 0;
      for (const img of slots) {
        const spec = WF.state.pendingFrames[Number(img.getAttribute('data-wf-frame'))];
        img.removeAttribute('data-wf-frame');
        let data = await frameFromVideo(spec && spec.video);
        if (alive && !alive()) return { total: slots.length, filled };
        if (!data) data = await frameFromScreenshot(spec && spec.box);
        if (alive && !alive()) return { total: slots.length, filled };
        if (data) { img.setAttribute('src', data); filled++; }
        else {
          img.remove(); // intet billede at vise → ingen tom pladsholder
          console.warn('Webfang: kunne ikke fange billede fra afspilleren');
        }
      }
      return { total: slots.length, filled };
    }

    // ---- Afspillere i klonen ----------------------------------------------

    // Erstat HELE afspilleren med ét billede. Wrapperen ".video-js" har selv
    // vjs-klasser (fx vjs-paused), så vi kan ikke bare fjerne alt "vjs-" – vi
    // trækker plakaten ud som rent <img> og udskifter hele afspilleren
    // (kontrol/status-tekst ryger dermed med).
    function replacePlayers(root, liveOf) {
      root.querySelectorAll(PLAYER_SEL).forEach((player) => {
        const img = extractPoster(player) || framePlaceholder(liveOf.get(player));
        if (img) player.replaceWith(img);
        else player.remove();
      });

      // Rester: løse <video>-tags uden for en .video-js-wrapper.
      root.querySelectorAll('video').forEach((v) => {
        const img = posterFromAttr(v) || framePlaceholder(liveOf.get(v) || null);
        if (img) v.replaceWith(img);
        else v.remove();
      });

      root.querySelectorAll('[class*="vjs-"], [class*="transcript"]')
        .forEach((n) => n.remove());
    }

    // Inline <svg> overlever ikke en indsætning i Word – det gør et <img> med
    // en data-URI. Tegningen pakkes derfor om, så diagrammer i quiz-svar
    // (og andre steder) kommer med i klippet.
    function svgToImg(svg) {
      const img = document.createElement('img');
      try {
        const c = svg.cloneNode(true);
        if (!c.getAttribute('xmlns')) c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        // Uden mål gætter Word på 0×0. Fald tilbage på viewBox.
        const vb = (c.getAttribute('viewBox') || '').trim().split(/[\s,]+/);
        if (!c.getAttribute('width') && vb.length === 4) c.setAttribute('width', vb[2]);
        if (!c.getAttribute('height') && vb.length === 4) c.setAttribute('height', vb[3]);
        if (c.getAttribute('width')) img.setAttribute('width', parseInt(c.getAttribute('width')) || '');
        const xml = new XMLSerializer().serializeToString(c);
        img.setAttribute('src',
          'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml))));
      } catch (_) {
        return svg; // kunne ikke serialiseres → behold originalen
      }
      return img;
    }

    WF.media = {
      PLAYER_SEL, extractPoster, framePlaceholder, biggestPlayer, adoptedPlayerBox,
      adoptOutsideVideo, screenshotElement, looksBlank, fillFrames, replacePlayers,
      svgToImg, svgIsIcon
    };
  });
})();
