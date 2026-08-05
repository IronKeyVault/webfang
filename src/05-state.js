// Delt tilstand. Ét sted at slå op hvad optaget står i lige nu – i stedet for
// et dusin løse variabler spredt ud over filerne.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('state', (WF) => {
    WF.state = {
      // 'idle' | 'hover' | 'region' | 'selected' | 'vhover' | 'vselected'
      phase: 'idle',
      hoverEl: null,
      currentEl: null,
      historyStack: [],
      prepared: null,      // { item, html, text }
      stripLinks: false,   // fjern links helt (kun tekst)

      // Løbenummer for en forberedelse. Hver prepare() tager sit eget nummer;
      // trykker man på en anden knap undervejs, får den næste et nyt nummer, og
      // den gamle opdager det efter sit næste await og stopper. Uden det kørte
      // to forberedelser videre side om side og skrev i den samme tilstand –
      // det var især "Hele siden" der blev ustabil, fordi den er langsom nok
      // til at man når at trykke igen.
      runId: 0,

      lastQuizCount: 0,    // antal quiz-svar bevaret ved sidste optag
      lastQuizGroups: 0,   // antal distinkte quizzer (spørgsmål)

      // Afspillere uden plakat-billede: pladsholder i klonen + det levende
      // element billedet skal hentes fra. Fyldes ud i clean(), opløses i
      // capture-modulets fillFrames().
      pendingFrames: [],

      // Frihånds-område: de elementer rammen omsluttede, og rammen selv i
      // dokument-koordinater.
      regionEls: null,
      regionRect: null,
      dragFrom: null,

      // Iframes: pladsholder i klonen + den levende ramme dens indhold skal
      // hentes fra. Fyldes ud i capture-modulets buildClone(), opløses i
      // iframes-modulets fillSlots(). Rammens del-udsnit (når frihånds-rammen
      // kun dækker en del af en iframe) ligger i regionFrameRects.
      pendingIframes: [],
      regionFrameRects: new Map(),

      vidCands: []         // [{url, kind, size}]
    };

    // Nyt løbenummer til en forberedelse + en test på om den stadig er den
    // aktuelle. Alle langsomme trin spørger `alive()` efter hvert await.
    WF.state.beginRun = () => {
      const my = ++WF.state.runId;
      return () => WF.state.runId === my;
    };

    // Justerer man valget med knapperne, forlades frihånds-rammen: fra nu af er
    // det igen ét element der er i spil.
    WF.state.leaveRegion = () => {
      if (!WF.state.regionEls) return;
      WF.state.regionEls = WF.state.regionRect = null;
    };

    WF.state.reset = () => {
      const s = WF.state;
      s.phase = 'idle';
      s.hoverEl = s.currentEl = null;
      s.historyStack = [];
      s.prepared = null;
      s.regionEls = s.regionRect = s.dragFrom = null;
      s.pendingFrames = [];
      s.pendingIframes = [];
      s.regionFrameRects = new Map();
      s.vidCands = [];
      s.runId++; // afbryd en forberedelse der stadig kører
    };
  });
})();
