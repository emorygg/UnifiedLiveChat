chrome.action.onClicked.addListener(async (tab) => {
  try {
    // Inject into the MAIN page only (not allFrames).
    // We access the chat iframe from the parent since it's same-origin.
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['styles.css']
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  } catch (error) {
    console.error('Failed to inject unified chat scripts:', error);
  }
});
