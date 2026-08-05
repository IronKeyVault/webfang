// Tekst- og klassemønstre der bruges flere steder i oprydningen.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('text', (WF) => {
    const { norm } = WF.util;

    // Nøgleord der typisk peger på NON-artikel-indhold (menuer, del-knapper,
    // relaterede-artikler, reklamer, kommentarer osv.).
    const JUNK_RE = /(^|[\s_-])(share|social|related|recirc|newsletter|subscribe|promo|advert|adslot|ad-|-ad|sponsor|comment|sidebar|side-bar|breadcrumb|nav|navbar|menu|toolbar|tags?|taglist|byline|author-?bio|cookie|consent|gdpr|popup|modal|overlay|footer|masthead|subnav|pagination|read-?more|more-?stories|trending|popular|recommend|widget|banner|social-share|post-nav|skip-link|screen-?reader|visually-hidden)([\s_-]|$)/i;

    // Navigations-links ("Return to …", "Tilbage til …") er aldrig indhold.
    const NAV_TXT =
      /^(return to|back to|go back|return$|back$|tilbage til|tilbage$|næste|forrige|next (topic|lesson|page|module)|previous (topic|lesson|page|module))/i;

    // Tekst fra knapper der betjener en quiz ("Remove Match", ✕) er ikke en del
    // af svaret og skal ikke med i optaget.
    const CONTROL_TXT =
      /^(remove match|remove|clear|reset|fjern match|fjern|slet|nulstil|drag|træk|[×✕✖x])$/i;

    // Rene styreknapper – dem må oprydningen gerne fjerne helt.
    const CTRL_TXT =
      /^(submit|send|next|previous|prev|back|continue|close|cancel|ok|done|reset|clear|remove match|remove|delete|drag|drop|check|check answer|try again|retry|start|play|pause|search|menu|show me|show more|show answer|show details|show solution|vis mere|vis svar|læs mere|read more|expand|reveal|indsend|næste|forrige|luk|fortryd|nulstil|prøv igen|slet|fjern|søg|[×✕✖x+‹›<>])$/i;

    // Løsrevne status-linjer fra en videoafspiller.
    const PLAYER_TXT =
      /^(video player is loading|current time\b|duration\b|loaded:|stream type|remaining time|progress\b|playback rate|open transcript|close transcript|mute|unmute|fullscreen|picture-in-picture)/i;

    // Tekst på "fold ud"-knapper.
    const TOGGLE_TXT =
      /^(show me|show more|show answer|show details|show solution|vis mere|vis svar|læs mere|read more|expand|reveal)\b/i;

    const isNav = (t) => !!t && t.length < 80 && NAV_TXT.test(t);

    const looksJunk = (el) => {
      const id = el.id || '';
      const cls = typeof el.className === 'string' ? el.className : '';
      const role = (el.getAttribute && el.getAttribute('role')) || '';
      return JUNK_RE.test(id) || JUNK_RE.test(cls) ||
        /^(navigation|complementary|banner|contentinfo|search)$/.test(role);
    };

    // Fjern efterkommere der kun er betjening (bruges på quiz-rækker og
    // indholdsbærende knapper, hvor teksten ellers ville få "✕" med).
    const stripControlLeaves = (el, re) => {
      el.querySelectorAll('*').forEach((n) => {
        if (n.children.length === 0 && re.test(norm(n.textContent))) n.remove();
      });
    };

    WF.text = {
      JUNK_RE, NAV_TXT, CONTROL_TXT, CTRL_TXT, PLAYER_TXT, TOGGLE_TXT,
      isNav, looksJunk, stripControlLeaves
    };
  });
})();
