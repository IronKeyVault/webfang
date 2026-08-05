// Selve optaget: fra valgt element til et ClipboardItem der ligger klar.
//
// prepare() kaldes hver gang valget ændrer sig, og den er langsom (udfoldning,
// scroll, billed-hentning). Derfor tager hver kørsel et løbenummer og stopper
// stille og roligt hvis en nyere kørsel er startet imens.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('capture', (WF) => {
    const { sleep, textLen } = WF.util;

    function buildClone(el) {
      const clone = el.cloneNode(true);
      // Iframes kan ikke klones – deres indhold hentes bagefter af rammen selv.
      // Skal ske før oprydningen, som ellers fjerner dem sammen med <script>.
      WF.iframes.markIframes(clone, el);
      WF.clean.clean(clone, { stripLinks: WF.state.stripLinks, liveRoot: el });
      WF.clean.absolutize(clone);
      return clone;
    }

    // Klipper flere løsrevne blokke sammen til ét dokument. Hver blok renses for
    // sig (så quiz-genkendelse og video-plakater virker pr. blok), og
    // pladsholder-numrene skrives om, fordi clean() nulstiller listen for hver
    // blok.
    function buildBlocksClone(els) {
      const wrap = document.createElement('div');
      const all = [];
      els.forEach((el) => {
        if (!el.isConnected) return;
        // En hel iframe inden for rammen er én blok for sig: pladsholder nu,
        // indhold når rammen svarer.
        if (WF.iframes.isFrame(el)) { wrap.appendChild(WF.iframes.slotFor(el)); return; }
        const c = buildClone(el);
        const offset = all.length;
        c.querySelectorAll('img[data-wf-frame]').forEach((img) => {
          img.setAttribute('data-wf-frame',
            String(offset + Number(img.getAttribute('data-wf-frame'))));
        });
        all.push(...WF.state.pendingFrames);
        wrap.appendChild(c);
      });
      WF.state.pendingFrames = all;
      return wrap;
    }

    const buildRegionClone = () => buildBlocksClone(WF.state.regionEls);

    // Er valget koblet ud af siden, eller kom der ingen tekst ud af det, findes
    // indholdet på ny. Cisco U. og andre SPA'er bygger nemlig indholdet om
    // undervejs – også af vores egen udfoldning og scroll.
    function refindIfDetached() {
      const s = WF.state;
      if (s.currentEl.isConnected) return;
      const again = WF.page.pickMainRoot();
      if (!again) return;
      s.currentEl = again;
      s.historyStack = [];
      WF.ui.positionOverlay(s.currentEl);
    }

    // Blev der ingen tekst ud af det, sad valget på en tom skal (en wrapper der
    // kun holder afspilleren, eller en container siden har tømt). Prøv sidens
    // hoved-indhold i stedet frem for at aflevere et tomt klip.
    function fallbackToMainRoot(clone) {
      const s = WF.state;
      if (textLen(clone) >= 20) return clone;
      const alt = WF.page.pickMainRoot();
      if (!alt || alt === s.currentEl) return clone;
      // clean() nulstiller pendingFrames, så pladsholderne i den FØRSTE klon
      // mister deres afspillere hvis vi ender med at beholde den.
      const framesOfFirst = s.pendingFrames;
      const altClone = buildClone(alt);
      if (textLen(altClone) > textLen(clone)) {
        s.currentEl = alt;
        s.historyStack = [];
        WF.ui.positionOverlay(s.currentEl);
        return altClone;
      }
      s.pendingFrames = framesOfFirst;
      return clone;
    }

    async function prepare() {
      const s = WF.state;
      s.prepared = null;
      s.pendingIframes = [];
      if (!s.currentEl) return;
      const alive = s.beginRun();
      WF.ui.setBusy('Udfolder & henter…');

      // 1) Udfold sammenklappet indhold ("Show Me", accordions, <details>).
      await WF.page.expandCollapsibles(s.currentEl);
      if (!alive()) return;

      // 2) Scroll hele siden igennem én gang, så lazy-billeder loades.
      await WF.page.autoScroll(alive);
      if (!alive()) return;
      // Sørg for at det valgte element er scrollet ind (udløser evt. dets egne
      // billeder).
      try { s.currentEl.scrollIntoView({ block: 'start' }); } catch (_) {}
      await sleep(150);
      if (!alive()) return;

      // 3a) Frihånds-ramme: brug de blokke rammen omsluttede, præcis som de var
      //     da du slap musen. Ingen gætterier om hoved-indhold og ingen
      //     adoption af en afspiller udefra – rammen ER valget.
      if (s.regionEls) {
        const regionClone = buildRegionClone();
        if (!regionClone.children.length) {
          // Siden har bygget indholdet om mens vi scrollede – blokkene findes
          // ikke længere. Sig det i stedet for at aflevere et tomt klip.
          WF.ui.setError('Rammens indhold forsvandt – træk den igen');
          return;
        }
        await finish(regionClone, alive);
        return;
      }

      // 3b) Almindeligt valg: klon, rens, og red valget hvis siden har ændret
      //     sig under os.
      refindIfDetached();
      let clone = fallbackToMainRoot(buildClone(s.currentEl));
      if (textLen(clone) < 20) {
        console.warn('Webfang: valget indeholder ingen tekst', s.currentEl);
      }

      // 3c) Afspilleren ligger tit i sin EGEN container ved siden af artiklen
      //     (Cisco U.: video øverst, tekst nedenunder = to søskende), så et valg
      //     af teksten har den ikke med. Findes der en afspiller på siden som
      //     valget ikke dækker, sættes dens billede ind øverst i klippet.
      WF.media.adoptOutsideVideo(clone);

      await finish(clone, alive);
    }

    // Fælles afslutning: opløs afspiller-pladsholdere, inline billeder, byg HTML
    // og læg et ClipboardItem klar.
    async function finish(clone, alive) {
      // Iframes først: hver ramme leverer sit eget færdige klip (billeder
      // indlejret i rammens egen kontekst), som sættes ind i pladsholderen.
      await WF.iframes.fillSlots(clone, alive);
      if (!alive()) return;

      // Afspillere uden plakat: hent billedet fra selve afspilleren.
      const frames = await WF.media.fillFrames(clone, alive);
      if (!alive()) return;

      const urls = WF.images.collectImageUrls(clone);
      const map = await WF.images.resolveImages(urls, alive);
      if (!alive()) return;
      WF.images.applyImages(clone, map);
      const embedded = urls.filter((u) => map[u]).length;

      // Cache et ClipboardItem, så selve kopieringen kan ske synkront inde i
      // knap-klikket = gyldig user activation.
      const html = wrapHtml(clone);
      const text = (clone.innerText || clone.textContent || '').trim();
      WF.state.prepared = {
        item: new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        }),
        html,
        text
      };
      WF.ui.setReady(urls.length + frames.total, embedded + frames.filled);
    }

    function wrapHtml(clone) {
      return '<meta charset="utf-8">' + clone.outerHTML;
    }

    // Fald tilbage til selektions-baseret kopiering hvis Clipboard API fejler.
    function execCopyFallback(html) {
      const holder = document.createElement('div');
      holder.setAttribute('contenteditable', 'true');
      Object.assign(holder.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0' });
      holder.innerHTML = html;
      document.body.appendChild(holder);
      const range = document.createRange();
      range.selectNodeContents(holder);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      sel.removeAllRanges();
      holder.remove();
      return ok;
    }

    // Læg det forberedte klip på udklipsholderen. Returnerer true ved held.
    async function copyPrepared() {
      const prepared = WF.state.prepared;
      if (!prepared) return false;
      try {
        await navigator.clipboard.write([prepared.item]);
        return true;
      } catch (e) {
        if (execCopyFallback(prepared.html)) return true;
        WF.ui.toast('Kunne ikke kopiere: ' + e.message, 4000);
        return false;
      }
    }

    WF.capture = { buildClone, buildRegionClone, prepare, copyPrepared, wrapHtml };
  });
})();
