// Starter et optag på den aktive fane. Samme mønster for artikel og video –
// kun argumentet til content-scriptet er forskelligt.
//
// Vi indsprøjter ALTID content.js først (den er selv-versionerende og gør intet
// hvis den nyeste udgave allerede kører) og kalder derefter dens start-funktion
// direkte. Det er med vilje ikke en besked: en side der stod åben da udvidelsen
// blev opdateret, har stadig det gamle script kørende, og en besked ville ryge
// derhen og lydløst ikke gøre noget.

const err = document.getElementById('err');

function showError(msg) {
  err.textContent = msg;
  err.style.display = 'block';
}

async function startPick(what) {
  err.style.display = 'none';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return showError('Ingen aktiv fane.');

  const url = tab.url || '';
  if (/^(chrome|edge|about|devtools|chrome-extension):/.test(url) ||
      url.startsWith('https://chromewebstore.google.com')) {
    return showError('Browseren tillader ikke udvidelser på denne side. Prøv på en almindelig webside.');
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (w) => {
        if (!window.__webfang) return 'ikke-indlæst';
        window.__webfang.start(w);
        return 'ok';
      },
      args: [what]
    });
    if (res && res.result !== 'ok') {
      return showError('Kunne ikke starte på siden (' + res.result + '). Prøv at genindlæse siden.');
    }
  } catch (e) {
    // Fejlen vises nu i popup'en i stedet for at forsvinde i en konsol
    // der lukker sammen med vinduet.
    return showError('Fejl: ' + (e.message || e));
  }

  window.close();
}

document.getElementById('start')
  .addEventListener('click', () => startPick('artikel'));
document.getElementById('startRegion')
  .addEventListener('click', () => startPick('område'));
document.getElementById('startVideo')
  .addEventListener('click', () => startPick('video'));

// ------------------------------------------------------ fortløbende nummer ---
//
// Tælleren ligger i storage.local (ikke .session), så den fortsætter hvor den
// slap næste gang browseren åbnes. Baggrunds-workeren tæller op efter hver
// hentning; her kan nummeret sættes manuelt, fx når man skifter serie.

const SEQ_KEY = 'videoSeq';
const SEQ_ON_KEY = 'videoSeqOn';

const seqOn = document.getElementById('seqOn');
const seqNext = document.getElementById('seqNext');
const seqSaved = document.getElementById('seqSaved');
let savedTimer = null;

function flashSaved() {
  seqSaved.style.visibility = 'visible';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { seqSaved.style.visibility = 'hidden'; }, 1200);
}

chrome.storage.local.get([SEQ_KEY, SEQ_ON_KEY]).then((st) => {
  const n = Number(st[SEQ_KEY]);
  seqNext.value = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  seqOn.checked = st[SEQ_ON_KEY] !== false;
  seqNext.disabled = !seqOn.checked;
});

seqOn.addEventListener('change', () => {
  seqNext.disabled = !seqOn.checked;
  chrome.storage.local.set({ [SEQ_ON_KEY]: seqOn.checked }).then(flashSaved);
});

// Gem mens der tastes – popup'en kan lukke når som helst.
seqNext.addEventListener('input', () => {
  const n = Math.floor(Number(seqNext.value));
  if (!Number.isFinite(n) || n < 1) return;
  chrome.storage.local.set({ [SEQ_KEY]: n }).then(flashSaved);
});

// ------------------------------------------------------------- gem-dialog ---
//
// Hvor filerne lander styres i browserens egne indstillinger; en udvidelse må
// alligevel kun skrive under downloadmappen. Her er kun til/fra for gem-
// dialogen, til dem der vil et andet sted hen i ny og næ.

const ASK_KEY = 'videoAsk';
const ask = document.getElementById('ask');

chrome.storage.local.get(ASK_KEY).then((st) => { ask.checked = st[ASK_KEY] === true; });
chrome.storage.local.remove('videoDir').catch(() => {});  // ryd op efter tidligere mappe-felt

ask.addEventListener('change', () => {
  chrome.storage.local.set({ [ASK_KEY]: ask.checked }).then(flashSaved);
});
