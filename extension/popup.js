// Popup script for managing YouTube → Twitch/Kick channel links

document.addEventListener('DOMContentLoaded', function () {
  var linksList = document.getElementById('links-list');
  var ytInput = document.getElementById('yt-input');
  var twitchInput = document.getElementById('twitch-input');
  var kickInput = document.getElementById('kick-input');
  var addBtn = document.getElementById('add-btn');
  var statusMsg = document.getElementById('status-msg');

  loadLinks();
  autoFillYouTubeChannel();

  // Add button handler
  addBtn.addEventListener('click', function () {
    var ytName = ytInput.value.trim().toLowerCase();
    var twitchName = twitchInput.value.trim().toLowerCase();
    var kickName = kickInput.value.trim().toLowerCase();

    if (!ytName) {
      showStatus('YouTube channel is required.', 'error');
      return;
    }
    if (!twitchName && !kickName) {
      showStatus('Enter at least one channel (Twitch or Kick).', 'error');
      return;
    }

    chrome.storage.local.get(['channelLinks'], function (result) {
      var links = result.channelLinks || {};
      var entry = {};
      if (twitchName) entry.twitch = twitchName;
      if (kickName) entry.kick = kickName;
      links[ytName] = entry;

      chrome.storage.local.set({ channelLinks: links }, function () {
        ytInput.value = '';
        twitchInput.value = '';
        kickInput.value = '';

        var label = ytName + ' → ';
        var parts = [];
        if (twitchName) parts.push('twitch:' + twitchName);
        if (kickName) parts.push('kick:' + kickName);
        label += parts.join(', ');

        showStatus('Link added: ' + label, 'success');
        loadLinks();

        // If running in an iframe inside the YT page
        if (window.parent !== window) {
          window.parent.postMessage({ type: 'activate-unified-chat' }, '*');
        }

        // Tell the active tab to activate immediately (if running as a browser action popup)
        if (chrome.tabs) {
          chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, { type: 'activate-unified-chat' }).catch(function() {});
            }
          });
        }
      });
    });
  });

  // Enter key handling
  twitchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') kickInput.focus();
  });
  kickInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addBtn.click();
  });
  ytInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') twitchInput.focus();
  });

  function loadLinks() {
    chrome.storage.local.get(['channelLinks'], function (result) {
      var links = result.channelLinks || {};
      renderLinks(links);
    });
  }

  function renderLinks(links) {
    linksList.innerHTML = '';

    var keys = Object.keys(links);
    if (keys.length === 0) {
      linksList.innerHTML = '<div class="empty-msg">No channel links yet. Add one below!</div>';
      return;
    }

    keys.forEach(function (ytName) {
      var entry = links[ytName];
      // Handle legacy format (string instead of object)
      if (typeof entry === 'string') {
        entry = { twitch: entry };
      }

      var item = document.createElement('div');
      item.className = 'link-item';

      var names = document.createElement('div');
      names.className = 'link-names';

      var ytSpan = document.createElement('span');
      ytSpan.className = 'link-yt';
      ytSpan.textContent = ytName;

      var arrow = document.createElement('span');
      arrow.className = 'link-arrow';
      arrow.textContent = '→';

      names.appendChild(ytSpan);
      names.appendChild(arrow);

      if (entry.twitch) {
        var twitchSpan = document.createElement('span');
        twitchSpan.className = 'link-twitch';
        twitchSpan.textContent = entry.twitch;
        names.appendChild(twitchSpan);
      }
      if (entry.kick) {
        var kickSpan = document.createElement('span');
        kickSpan.className = 'link-kick';
        kickSpan.textContent = entry.kick;
        names.appendChild(kickSpan);
      }

      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-btn';
      deleteBtn.title = 'Remove link';
      deleteBtn.textContent = '✕';
      deleteBtn.addEventListener('click', function () {
        removeLink(ytName);
      });

      item.appendChild(names);
      item.appendChild(deleteBtn);
      linksList.appendChild(item);
    });
  }

  function removeLink(ytName) {
    chrome.storage.local.get(['channelLinks'], function (result) {
      var links = result.channelLinks || {};
      delete links[ytName];
      chrome.storage.local.set({ channelLinks: links }, function () {
        showStatus('Removed: ' + ytName, 'success');
        loadLinks();
      });
    });
  }

  function showStatus(msg, type) {
    statusMsg.textContent = msg;
    statusMsg.className = 'status-msg ' + type;
    setTimeout(function () {
      statusMsg.textContent = '';
      statusMsg.className = 'status-msg';
    }, 3000);
  }

  function autoFillYouTubeChannel() {
    // If embedded, read from URL param
    var params = new URLSearchParams(window.location.search);
    if (params.has('yt')) {
      var ytName = params.get('yt');
      ytInput.value = ytName;
      ytInput.setAttribute('placeholder', ytName);
      twitchInput.focus();
      return;
    }

    if (!chrome.tabs) return;

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs[0] || !tabs[0].url || !tabs[0].url.includes('youtube.com/watch')) return;

      chrome.tabs.sendMessage(tabs[0].id, { type: 'get-yt-channel' }, function (response) {
        if (chrome.runtime.lastError) return;
        if (response) {
          ytInput.value = response;
          ytInput.setAttribute('placeholder', response);
          twitchInput.focus();
        }
      });
    });
  }
});
