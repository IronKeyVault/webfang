document.getElementById('start').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  const send = () => chrome.tabs.sendMessage(tab.id, { type: 'START_PICK' });

  try {
    await send();
  } catch (e) {
    // Content-scriptet er ikke injiceret (fx side loadet før udvidelsen) → injicér og prøv igen.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await send();
    } catch (e2) {
      // Fx chrome:// eller store-sider hvor scripts ikke må køre.
      console.warn('Kan ikke starte på denne side:', e2);
    }
  }
  window.close();
});
