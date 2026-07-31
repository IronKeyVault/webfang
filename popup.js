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
document.getElementById('startVideo')
  .addEventListener('click', () => startPick('video'));
