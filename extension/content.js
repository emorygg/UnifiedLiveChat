// Content Script for Unified Chat — Direct Injection Mode
// Injects Twitch & Kick messages directly into the YouTube live chat iframe DOM.

(function () {
  // ==========================================
  // STATE
  // ==========================================
  var itemsContainer = null;   // ref to YT iframe's #items list
  var chatScroller = null;     // ref to #item-scroller inside the iframe
  var chatIframe = null;       // ref to the chat iframe element
  var twitchWs = null;
  var kickWs = null;
  var thirdPartyEmotes = {};
  var currentActivation = null;
  var currentTwitchName = null;
  var currentKickName = null;
  var iframeStylesInjected = false;
  var ytObserver = null;
  var rebuildObserver = null;  // watches for chat mode switches (Top chat ↔ Live chat)
  var rebuildPoll = null;      // periodic fallback to detect stale references
  var globalMessageCounter = 1;

  // ==========================================
  // ENTRY POINT — SPA-aware page watcher
  // ==========================================
  function onPageChange() {
    teardown();
    if (!window.location.pathname.startsWith('/watch')) return;
    setTimeout(function () { tryActivate(); }, 2000);
  }

  async function tryActivate() {
    var ytChannel = getYouTubeChannelHandle();
    if (!ytChannel) {
      console.log('[UnifiedChat] Could not detect YouTube channel.');
      return;
    }

    var links = await getChannelLinks();
    var entry = links[ytChannel] || links[ytChannel.replace('@', '')];
    if (!entry) {
      console.log('[UnifiedChat] No link for channel: ' + ytChannel);
    }

    // Handle legacy string format
    if (entry && typeof entry === 'string') entry = { twitch: entry };

    var twitchName = entry && entry.twitch ? entry.twitch.trim().toLowerCase() : null;
    var kickName   = entry && entry.kick   ? entry.kick.trim().toLowerCase()   : null;

    if (!twitchName && !kickName) {
      console.log('[UnifiedChat] Entry has no channels configured.');
    }

    // Find the live chat frame
    var chatFrame = document.querySelector('ytd-live-chat-frame');
    if (!chatFrame) {
      console.log('[UnifiedChat] No live chat frame found (not a live stream?).');
      return;
    }

    // Wait for the iframe inside the chat frame
    var iframe = await waitForElement(chatFrame, 'iframe', 10000);
    if (!iframe) {
      console.log('[UnifiedChat] Chat iframe did not load.');
      return;
    }

    // Prevent duplicate activation for the same channel
    if (currentActivation === ytChannel) return;
    currentActivation = ytChannel;
    currentTwitchName = twitchName;
    currentKickName = kickName;
    chatIframe = iframe;

    console.log('[UnifiedChat] Activating injection for ' + ytChannel +
      (twitchName ? ' + Twitch:' + twitchName : '') +
      (kickName   ? ' + Kick:'   + kickName   : ''));

    // Load third-party emotes
    if (twitchName) await loadThirdPartyEmotes(twitchName);

    // Attach to the YT chat DOM and start observing
    await attachToYouTubeChat(iframe);

    // Connect to platforms
    if (twitchName) startTwitchConnection(twitchName);
    if (kickName)   startKickConnection(kickName);
  }

  function teardown() {
    var badge = document.getElementById('uc-status-badge');
    if (badge) badge.remove();

    if (twitchWs) { twitchWs.close(); twitchWs = null; }
    if (kickWs)   { kickWs.close();   kickWs = null; }
    if (ytObserver) { ytObserver.disconnect(); ytObserver = null; }
    if (rebuildObserver) { rebuildObserver.disconnect(); rebuildObserver = null; }
    if (rebuildPoll) { clearInterval(rebuildPoll); rebuildPoll = null; }

    itemsContainer = null;
    chatScroller = null;
    chatIframe = null;
    currentActivation = null;
    currentTwitchName = null;
    currentKickName = null;
    iframeStylesInjected = false;
  }

  // ==========================================
  // ATTACH TO YOUTUBE CHAT IFRAME
  // ==========================================
  function attachToYouTubeChat(iframe) {
    return new Promise(function (resolve) {
      var giveUp = setTimeout(function () {
        clearInterval(poll);
        console.log('[UnifiedChat] Timed out waiting for YT chat items.');
        resolve();
      }, 15000);

      var poll = setInterval(function () {
        try {
          var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (!iframeDoc) return;

          var container = iframeDoc.querySelector('yt-live-chat-item-list-renderer #items');
          if (!container) return;

          clearInterval(poll);
          clearTimeout(giveUp);

          bindToItemsContainer(container, iframeDoc);

          resolve();
        } catch (e) {
          // iframe not accessible yet
        }
      }, 500);
    });
  }

  /**
   * Bind our injection to a specific #items container.
   * Called on initial attach and again whenever the chat DOM rebuilds
   * (e.g. switching between "Top chat" and "Live chat").
   */
  function bindToItemsContainer(container, iframeDoc) {
    // Clean up previous observer if rebinding
    if (ytObserver) { ytObserver.disconnect(); ytObserver = null; }

    itemsContainer = container;
    // Reset scroller cache — will be re-discovered on next message
    chatScroller = null;

    // Find #item-scroller directly — this is the actual scrollable element in YT chat
    var scroller = iframeDoc.querySelector('yt-live-chat-item-list-renderer #item-scroller');
    if (scroller) {
      chatScroller = scroller;
    }

    console.log('[UnifiedChat] Attached to YT chat #items (scroller: ' + (chatScroller ? 'found' : 'fallback') + ').');

    // Force flexbox on items container so we can enforce strict visual chronological ordering
    itemsContainer.style.display = 'flex';
    itemsContainer.style.flexDirection = 'column';

    // Assign initial order to pre-existing native messages
    var existingNodes = itemsContainer.children;
    for (var i = 0; i < existingNodes.length; i++) {
        if (existingNodes[i].nodeType === 1) {
            existingNodes[i].style.order = globalMessageCounter++;
        }
    }

    // Inject our settings button into the chat header
    injectSettingsButton(iframeDoc);

    // Inject our styles into the iframe document
    injectIframeStyles(iframeDoc);

    // Observe #items to intercept native YT messages and assign them the next chronological order
    ytObserver = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        for (var n = 0; n < mutations[m].addedNodes.length; n++) {
          var node = mutations[m].addedNodes[n];
          if (node.nodeType === 1) {
            node.style.order = globalMessageCounter++;
          }
        }
      }
    });
    ytObserver.observe(container, { childList: true });

    // Watch for chat mode switches (Top chat ↔ Live chat) or Theater Mode toggles.
    // When the user changes modes or toggles Theater Mode, YT either rebuilds
    // everything under yt-live-chat-renderer, or re-parents the entire iframe
    // (which causes the whole iframe to document reload).
    startRebuildWatcher(iframeDoc);
  }

  /**
   * Watches for the chat DOM being rebuilt (e.g. mode switch or Theater mode).
   * Uses a MutationObserver on the renderer + a periodic fallback poll.
   */
  function startRebuildWatcher(iframeDoc) {
    // Clean up previous watcher
    if (rebuildObserver) { rebuildObserver.disconnect(); rebuildObserver = null; }
    if (rebuildPoll) { clearInterval(rebuildPoll); rebuildPoll = null; }

    var renderer = iframeDoc.querySelector('yt-live-chat-renderer');
    if (renderer) {
      rebuildObserver = new MutationObserver(function () {
        checkForStaleContainer();
      });
      rebuildObserver.observe(renderer, { childList: true, subtree: true });
    }

    // Periodic fallback in case the MutationObserver misses a rebuild or the iframe reloaded
    rebuildPoll = setInterval(function () {
      checkForStaleContainer();
    }, 2000);
  }

  /**
   * Check if our itemsContainer reference is still attached to the live DOM.
   * If it's been detached (stale) or the iframe reloaded, find the new #items and rebind.
   */
  function checkForStaleContainer() {
    try {
      // Find the currently active chat iframe (in case YouTube recreated it entirely for theater mode)
      var chatFrame = document.querySelector('ytd-live-chat-frame');
      if (chatFrame) {
        var iframe = chatFrame.querySelector('iframe');
        if (iframe) chatIframe = iframe;
      }

      if (!chatIframe) return;

      // Always fetch the LIVE document. If the iframe was moved in the DOM,
      // the old document is destroyed and a new one is created.
      var currentDoc = chatIframe.contentDocument || chatIframe.contentWindow.document;
      if (!currentDoc) return;

      // Check if our reference is still in the LIVE document
      if (itemsContainer && itemsContainer.isConnected && itemsContainer.ownerDocument === currentDoc) {
        return;
      }

      console.log('[UnifiedChat] #items container was detached or iframe reloaded (Theater mode?). Re-attaching...');

      // The old container is gone or iframe reloaded — find the new one
      var newContainer = currentDoc.querySelector('yt-live-chat-item-list-renderer #items');
      if (newContainer) {
        bindToItemsContainer(newContainer, currentDoc);
        console.log('[UnifiedChat] Successfully re-attached to new #items container.');
      } else {
        // Not ready yet — the poll will try again
        itemsContainer = null;
        chatScroller = null;
      }
    } catch (e) {
      // iframe might not be accessible yet
    }
  }

  // ==========================================
  // INJECT STYLES INTO IFRAME
  // ==========================================
  function injectIframeStyles(doc) {
    if (doc.getElementById('uc-iframe-styles')) return;
    iframeStylesInjected = true;

    var style = doc.createElement('style');
    style.id = 'uc-iframe-styles';
    style.textContent = [
      /* Injected message wrapper */
      '.uc-inj-msg {',
      '  display: block;',
      '  padding: 4px 16px 4px 12px;',
      '  border-left: 3px solid transparent;',
      '  box-sizing: border-box;',
      '  animation: ucFadeIn 0.25s ease-out;',
      '}',
      '.uc-inj-msg.platform-twitch { border-left-color: #9146FF; }',
      '.uc-inj-msg.platform-kick   { border-left-color: #53FC18; }',

      '@keyframes ucFadeIn {',
      '  from { opacity: 0; transform: translateY(6px); }',
      '  to   { opacity: 1; transform: translateY(0); }',
      '}',

      /* Author row */
      '.uc-inj-author {',
      '  display: inline;',
      '  font-size: 13px;',
      '  font-weight: 700;',
      '  line-height: 1.5;',
      '}',

      /* Links */
      '.uc-link {',
      '  color: var(--yt-live-chat-primary-text-color, #e1e1e1);',
      '  text-decoration: underline;',
      '  word-break: break-all;',
      '}',
      '.uc-link:hover {',
      '  color: var(--yt-live-chat-secondary-text-color, #fff);',
      '}',

      /* Platform badge (tiny pill) */
      '.uc-inj-badge {',
      '  display: inline-block;',
      '  font-size: 9px;',
      '  font-weight: 800;',
      '  letter-spacing: 0.4px;',
      '  text-transform: uppercase;',
      '  padding: 1px 5px;',
      '  border-radius: 3px;',
      '  margin-right: 5px;',
      '  vertical-align: middle;',
      '  line-height: 14px;',
      '}',
      '.uc-inj-badge.badge-twitch { background: #9146FF; color: #fff; }',
      '.uc-inj-badge.badge-kick   { background: #53FC18; color: #000; }',

      /* Message text */
      '.uc-inj-text {',
      '  display: inline;',
      '  font-size: 13px;',
      '  line-height: 1.5;',
      '  word-break: break-word;',
      '  color: var(--yt-live-chat-primary-text-color, #e0e0e0);',
      '}',

      /* Emote images */
      '.uc-inj-text .uc-emote, .uc-inj-msg .uc-emote {',
      '  height: 24px;',
      '  width: auto;',
      '  vertical-align: middle;',
      '  margin: 0 1px;',
      '}',

      /* Separator line between injected & native messages (subtle) */
      '.uc-inj-msg + yt-live-chat-text-message-renderer,',
      'yt-live-chat-text-message-renderer + .uc-inj-msg {',
      '  /* no extra styling needed — just flows naturally */',
      '}',
    ].join('\n');

    (doc.head || doc.documentElement).appendChild(style);
  }

  // ==========================================
  // INJECT SETTINGS BUTTON INTO CHAT HEADER
  // ==========================================
  function injectSettingsButton(iframeDoc) {
    var headerContextMenu = iframeDoc.querySelector('#live-chat-header-context-menu');
    if (!headerContextMenu) return;
    
    // Check if we already injected it; if so, remove them to re-render fresh
    var existingBtn = iframeDoc.getElementById('uc-settings-btn');
    if (existingBtn) existingBtn.remove();
    
    var existingStatus = iframeDoc.getElementById('uc-header-status');
    if (existingStatus) existingStatus.remove();


    var container = headerContextMenu.parentElement;

    // ----- STATUS BADGE IN HEADER -----
    var statusSpan = iframeDoc.createElement('div');
    statusSpan.id = 'uc-header-status';
    statusSpan.style.display = 'flex';
    statusSpan.style.alignItems = 'center';
    statusSpan.style.gap = '8px';
    statusSpan.style.marginRight = '12px';
    statusSpan.style.fontSize = '12px';
    statusSpan.style.fontWeight = '500';
    statusSpan.style.fontFamily = 'var(--yt-live-chat-font-family, "Roboto", "Arial", sans-serif)';
    // Use the native YouTube secondary text color variable so it adapts to dark/light mode automatically
    statusSpan.style.color = 'var(--yt-live-chat-secondary-text-color)';
    
    if (currentTwitchName) {
      var t = iframeDoc.createElement('span');
      t.textContent = '● Twitch';
      t.style.color = '#bf94ff'; // Modern Lighter twitch purple suitable for dark/light mode
      statusSpan.appendChild(t);
    }
    if (currentKickName) {
      var k = iframeDoc.createElement('span');
      k.textContent = '● Kick';
      // Kick green looks decent on both, soften slightly for readability
      k.style.color = '#5ceb2a'; 
      statusSpan.appendChild(k);
    }

    container.insertBefore(statusSpan, headerContextMenu);

    // ----- SETTINGS BUTTON -----
    var btn = iframeDoc.createElement('button');
    btn.id = 'uc-settings-btn';
    btn.title = 'Unified Chat Settings';
    // Link icon SVG
    btn.innerHTML = '<svg fill="currentColor" width="24" height="24" viewBox="0 0 24 24"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.06-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.73,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.06,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.49-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"></path></svg>';
    
    btn.style.background = 'transparent';
    btn.style.border = 'none';
    btn.style.color = 'var(--yt-live-chat-header-button-color, #909090)';
    btn.style.cursor = 'pointer';
    btn.style.padding = '8px';
    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.marginRight = '8px';
    
    btn.onmouseover = function() { btn.style.color = 'var(--yt-spec-text-primary, #fff)'; };
    btn.onmouseout = function() { btn.style.color = 'var(--yt-live-chat-header-button-color, #909090)'; };

    btn.onclick = function() {
      toggleSettingsOverlay(iframeDoc);
    };
    
    container.insertBefore(btn, headerContextMenu);
  }

  function toggleSettingsOverlay(iframeDoc) {
    var existing = iframeDoc.getElementById('uc-settings-overlay');
    if (existing) {
      existing.remove();
      return;
    }
    
    var overlay = iframeDoc.createElement('div');
    overlay.id = 'uc-settings-overlay';
    overlay.style.position = 'absolute';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
    overlay.style.zIndex = '999999';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    
    var iframe = iframeDoc.createElement('iframe');
    
    // Auto-fill youtube channel name by passing it in URL
    var currentYt = getYouTubeChannelHandle() || '';
    iframe.src = chrome.runtime.getURL('popup.html?yt=' + encodeURIComponent(currentYt));
    
    iframe.style.width = '340px';
    iframe.style.height = '480px';
    iframe.style.border = '1px solid rgba(255,255,255,0.2)';
    iframe.style.borderRadius = '12px';
    iframe.style.background = '#18181b';
    iframe.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
    
    // Close when clicking empty space
    overlay.onclick = function(e) {
      if (e.target === overlay) overlay.remove();
    };
    
    var closeBtn = iframeDoc.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.position = 'absolute';
    closeBtn.style.top = '10px';
    closeBtn.style.right = '10px';
    closeBtn.style.background = 'transparent';
    closeBtn.style.border = 'none';
    closeBtn.style.color = '#fff';
    closeBtn.style.fontSize = '24px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.onclick = function() { overlay.remove(); };
    
    overlay.appendChild(closeBtn);
    overlay.appendChild(iframe);
    iframeDoc.body.appendChild(overlay);
  }

  // ==========================================
  // APPEND MESSAGE → inject into YT #items
  // ==========================================
  function appendMessage(platform, authorName, contentHtml, authorColor) {
    // Catch messages attempting to append while container is stale
    try {
      if (!itemsContainer || !itemsContainer.isConnected ||
          (chatIframe && itemsContainer.ownerDocument !== (chatIframe.contentDocument || chatIframe.contentWindow.document))) {
        checkForStaleContainer();
      }
    } catch (e) {}

    if (!itemsContainer) return;

    var doc = itemsContainer.ownerDocument;

    var el = doc.createElement('div');
    el.className = 'uc-inj-msg platform-' + platform;

    // Author name
    var authorSpan = doc.createElement('span');
    authorSpan.className = 'uc-inj-author';
    authorSpan.textContent = authorName + ': ';
    if (authorColor) authorSpan.style.color = authorColor;

    // Message text
    var textSpan = doc.createElement('span');
    textSpan.className = 'uc-inj-text';
    textSpan.innerHTML = contentHtml;

    el.appendChild(authorSpan);
    el.appendChild(textSpan);

    // Apply strict chronological order before appending
    el.style.order = globalMessageCounter++;

    itemsContainer.appendChild(el);

    // Trim ONLY our injected messages to keep memory manageable
    // (We must never delete native YT nodes or Polymer's array map will desync and crash)
    var injectedMsgs = itemsContainer.querySelectorAll('.uc-inj-msg');
    if (injectedMsgs.length > 200) {
      injectedMsgs[0].remove();
    }

    // Only auto-scroll if user is near the bottom — never force-jump their position
    scrollIfAtBottom();
  }

  function scrollIfAtBottom() {
    try {
      if (!chatScroller) return;

      var distFromBottom = chatScroller.scrollHeight - chatScroller.scrollTop - chatScroller.clientHeight;
      // Only auto-scroll if user is within 200px of the bottom
      if (distFromBottom < 200) {
        chatScroller.scrollTop = chatScroller.scrollHeight;
      }
    } catch (e) {
      // Swallow
    }
  }

  // ==========================================
  // YOUTUBE CHANNEL DETECTION
  // ==========================================
  function getYouTubeChannelHandle() {
    var anchor = document.querySelector('ytd-video-owner-renderer a.yt-simple-endpoint');
    if (anchor && anchor.href) {
      var match = anchor.href.match(/youtube\.com\/@([^\/\?]+)/);
      if (match) return match[1].toLowerCase();

      match = anchor.href.match(/youtube\.com\/channel\/([^\/\?]+)/);
      if (match) {
        var nameEl = document.querySelector('ytd-video-owner-renderer #channel-name yt-formatted-string');
        if (nameEl) return nameEl.textContent.trim().toLowerCase();
        return match[1].toLowerCase();
      }
    }
    var channelName = document.querySelector('ytd-video-owner-renderer #channel-name yt-formatted-string');
    if (channelName) return channelName.textContent.trim().toLowerCase();
    return null;
  }

  // ==========================================
  // STORAGE
  // ==========================================
  function getChannelLinks() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(['channelLinks'], function (result) {
        resolve(result.channelLinks || {});
      });
    });
  }

  // ==========================================
  // UTILITY
  // ==========================================
  function waitForElement(parent, selector, timeout) {
    return new Promise(function (resolve) {
      var el = parent.querySelector(selector);
      if (el) { resolve(el); return; }

      var timer = setTimeout(function () {
        observer.disconnect();
        resolve(null);
      }, timeout);

      var observer = new MutationObserver(function () {
        var el = parent.querySelector(selector);
        if (el) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(parent, { childList: true, subtree: true });
    });
  }

  // ==========================================
  // TWITCH CHAT (WebSocket IRC)
  // ==========================================
  function startTwitchConnection(channelName) {
    if (twitchWs) twitchWs.close();

    twitchWs = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

    twitchWs.onopen = function () {
      console.log('[UnifiedChat] Connected to Twitch IRC.');
      twitchWs.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      twitchWs.send('PASS SCHMOOPIIE');
      var anonId = Math.floor(Math.random() * 1000000);
      twitchWs.send('NICK justinfan' + anonId);
      twitchWs.send('JOIN #' + channelName);
    };

    twitchWs.onmessage = function (event) {
      var lines = event.data.split('\r\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        if (line.startsWith('PING')) {
          twitchWs.send('PONG :tmi.twitch.tv');
          continue;
        }
        if (line.includes('PRIVMSG')) parseTwitchMessage(line);
      }
    };

    twitchWs.onerror = function (err) {
      console.error('[UnifiedChat] Twitch WebSocket error:', err);
    };

    twitchWs.onclose = function () {
      console.log('[UnifiedChat] Twitch WebSocket closed.');
    };
  }

  function parseTwitchMessage(rawStr) {
    try {
      var authorName = 'Unknown';
      var color = null;
      var text = '';
      var emotesTag = null;

      if (rawStr.startsWith('@')) {
        var tagsEnd = rawStr.indexOf(' ');
        if (tagsEnd === -1) return;
        var tagsStr = rawStr.substring(1, tagsEnd);
        rawStr = rawStr.substring(tagsEnd + 1);

        var tags = tagsStr.split(';');
        for (var i = 0; i < tags.length; i++) {
          var eqIdx = tags[i].indexOf('=');
          if (eqIdx === -1) continue;
          var key = tags[i].substring(0, eqIdx);
          var val = tags[i].substring(eqIdx + 1);
          if (key === 'display-name' && val) authorName = val;
          if (key === 'color' && val) color = val;
          if (key === 'emotes' && val) emotesTag = val;
        }
      }

      var privmsgIdx = rawStr.indexOf(' PRIVMSG ');
      if (privmsgIdx === -1) return;

      if (authorName === 'Unknown') {
        var userPart = rawStr.substring(0, privmsgIdx);
        if (userPart.startsWith(':')) {
          var bangIdx = userPart.indexOf('!');
          if (bangIdx !== -1) authorName = userPart.substring(1, bangIdx);
        }
      }

      var afterPrivmsg = rawStr.substring(privmsgIdx + 9);
      var colonIdx = afterPrivmsg.indexOf(' :');
      if (colonIdx === -1) return;
      text = afterPrivmsg.substring(colonIdx + 2);

      var renderedText = renderTwitchEmotes(text, emotesTag);
      appendMessage('twitch', authorName, renderedText, color);
    } catch (err) {
      console.error('[UnifiedChat] Error parsing Twitch message:', err);
    }
  }

  // ==========================================
  // KICK CHAT (Pusher WebSocket)
  // ==========================================
  async function startKickConnection(channelName) {
    if (kickWs) kickWs.close();

    try {
      var res = await fetch('https://kick.com/api/v2/channels/' + channelName);
      if (!res.ok) {
        console.error('[UnifiedChat] Kick API returned ' + res.status);
        return;
      }
      var channelData = await res.json();
      var chatroomId = channelData.chatroom && channelData.chatroom.id;
      if (!chatroomId) {
        console.error('[UnifiedChat] Could not find Kick chatroom ID.');
        return;
      }

      var pusherKey = '32cbd69e4b950bf97679';
      var wsUrl = 'wss://ws-us2.pusher.com/app/' + pusherKey +
        '?protocol=7&client=js&version=7.6.0&flash=false';
      kickWs = new WebSocket(wsUrl);

      kickWs.onopen = function () {
        console.log('[UnifiedChat] Connected to Kick Pusher.');
      };

      kickWs.onmessage = function (event) {
        try {
          var msg = JSON.parse(event.data);

          if (msg.event === 'pusher:connection_established') {
            kickWs.send(JSON.stringify({
              event: 'pusher:subscribe',
              data: { auth: '', channel: 'chatrooms.' + chatroomId + '.v2' }
            }));
          }

          if (msg.event === 'pusher:error') {
            console.error('[UnifiedChat] Pusher error:', msg.data);
          }

          if (msg.event === 'App\\Events\\ChatMessageEvent') {
            var chatData = JSON.parse(msg.data);
            parseKickMessage(chatData);
          }
        } catch (e) {
          console.error('[UnifiedChat] Kick message parse error:', e, event.data);
        }
      };

      kickWs.onerror = function (err) {
        console.error('[UnifiedChat] Kick WebSocket error:', err);
      };

      kickWs.onclose = function () {
        console.log('[UnifiedChat] Kick WebSocket closed.');
      };
    } catch (err) {
      console.error('[UnifiedChat] Failed to connect to Kick:', err);
    }
  }

  function parseKickMessage(data) {
    try {
      var sender = data.sender || {};
      var authorName = sender.username || 'Unknown';
      var color = (sender.identity && sender.identity.color) || '#53FC18';
      var text = data.content || '';

      var rendered = escapeHtml(text);
      // Replace Kick native emotes
      rendered = rendered.replace(/\[emote:(\d+):([^\]]+)\]/g, function (match, id, name) {
        return '<img class="uc-emote" src="https://files.kick.com/emotes/' + id + '/fullsize" alt="' + name + '" title="' + name + '">';
      });
      rendered = replaceThirdPartyEmotes(rendered);
      rendered = linkifyHtml(rendered);

      appendMessage('kick', authorName, rendered, color);
    } catch (err) {
      console.error('[UnifiedChat] Error parsing Kick message:', err);
    }
  }

  // ==========================================
  // THIRD-PARTY EMOTES (FFZ, BTTV, 7TV)
  // ==========================================
  async function loadThirdPartyEmotes(channelName) {
    thirdPartyEmotes = {};

    var twitchId = null;
    try {
      var idRes = await fetch('https://decapi.me/twitch/id/' + channelName);
      if (idRes.ok) {
        var idText = await idRes.text();
        if (!idText.includes('User not found') && !idText.includes('Error')) {
          twitchId = idText.trim();
        }
      }
    } catch (e) { /* silent */ }

    await Promise.allSettled([
      loadFFZGlobal(), loadFFZChannel(channelName),
      loadBTTVGlobal(), loadBTTVChannel(twitchId || channelName),
      load7TVGlobal(), load7TVChannel(twitchId || channelName)
    ]);
    console.log('[UnifiedChat] Loaded ' + Object.keys(thirdPartyEmotes).length + ' third-party emotes.');
  }

  async function loadFFZGlobal() {
    try {
      var res = await fetch('https://api.frankerfacez.com/v1/set/global');
      parseFFZSets((await res.json()).sets);
    } catch (e) {}
  }

  async function loadFFZChannel(channel) {
    try {
      var res = await fetch('https://api.frankerfacez.com/v1/room/' + channel);
      parseFFZSets((await res.json()).sets);
    } catch (e) {}
  }

  function parseFFZSets(sets) {
    if (!sets) return;
    for (var setId in sets) {
      var emotes = sets[setId].emoticons;
      if (!emotes) continue;
      for (var i = 0; i < emotes.length; i++) {
        var e = emotes[i];
        var url = e.urls['4'] || e.urls['2'] || e.urls['1'];
        if (url) {
          if (url.startsWith('//')) url = 'https:' + url;
          thirdPartyEmotes[e.name] = url;
        }
      }
    }
  }

  async function loadBTTVGlobal() {
    try {
      var data = await (await fetch('https://api.betterttv.net/3/cached/emotes/global')).json();
      for (var i = 0; i < data.length; i++) {
        thirdPartyEmotes[data[i].code] = 'https://cdn.betterttv.net/emote/' + data[i].id + '/2x';
      }
    } catch (e) {}
  }

  async function loadBTTVChannel(channel) {
    try {
      var res = await fetch('https://api.betterttv.net/3/cached/users/twitch/' + channel);
      if (!res.ok) return;
      var data = await res.json();
      var all = (data.channelEmotes || []).concat(data.sharedEmotes || []);
      for (var i = 0; i < all.length; i++) {
        thirdPartyEmotes[all[i].code] = 'https://cdn.betterttv.net/emote/' + all[i].id + '/2x';
      }
    } catch (e) {}
  }

  async function load7TVGlobal() {
    try {
      var data = await (await fetch('https://7tv.io/v3/emote-sets/global')).json();
      parse7TVEmotes(data.emotes || []);
    } catch (e) {}
  }

  async function load7TVChannel(channel) {
    try {
      var data = await (await fetch('https://7tv.io/v3/users/twitch/' + channel)).json();
      if (data.emote_set && data.emote_set.emotes) parse7TVEmotes(data.emote_set.emotes);
    } catch (e) {}
  }

  function parse7TVEmotes(emotes) {
    for (var i = 0; i < emotes.length; i++) {
      var e = emotes[i];
      var hostData = e.data && e.data.host;
      if (hostData && hostData.files && hostData.files.length > 0) {
        var file = hostData.files.find(function (f) { return f.name === '2x.webp'; })
                || hostData.files.find(function (f) { return f.name === '1x.webp'; })
                || hostData.files[0];
        if (file) {
          var baseUrl = hostData.url;
          if (baseUrl.startsWith('//')) baseUrl = 'https:' + baseUrl;
          thirdPartyEmotes[e.name] = baseUrl + '/' + file.name;
        }
      }
    }
  }

  function replaceThirdPartyEmotes(html) {
    if (Object.keys(thirdPartyEmotes).length === 0) return html;
    var parts = html.split(/(<[^>]+>)/);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].startsWith('<')) continue;
      parts[i] = parts[i].replace(/\S+/g, function (word) {
        var decoded = word
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        if (thirdPartyEmotes[decoded]) {
          return '<img class="uc-emote" src="' + thirdPartyEmotes[decoded] +
            '" alt="' + word + '" title="' + decoded + '">';
        }
        return word;
      });
    }
    return parts.join('');
  }

  function linkifyHtml(html) {
    var parts = html.split(/(<[^>]+>)/);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].startsWith('<')) continue;
      parts[i] = parts[i].replace(/(https?:\/\/[^\s]+)/gi, function(match) {
        var trailing = '';
        var url = match;
        var lastChar = url.slice(-1);
        if (['.', ',', '!', '?', ')', ']', '"', "'"].indexOf(lastChar) !== -1) {
          trailing = lastChar;
          url = url.slice(0, -1);
        }
        return '<a href="' + url.replace(/"/g, '%22') + '" target="_blank" rel="noopener noreferrer" class="uc-link">' + url + '</a>' + trailing;
      });
    }
    return parts.join('');
  }

  // ==========================================
  // TWITCH NATIVE EMOTE RENDERING
  // ==========================================
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderTwitchEmotes(text, emotesTag) {
    if (!emotesTag) return linkifyHtml(replaceThirdPartyEmotes(escapeHtml(text)));

    var replacements = [];
    var emoteGroups = emotesTag.split('/');
    for (var i = 0; i < emoteGroups.length; i++) {
      var parts = emoteGroups[i].split(':');
      if (parts.length < 2) continue;
      var emoteId = parts[0];
      var positions = parts[1].split(',');
      for (var j = 0; j < positions.length; j++) {
        var range = positions[j].split('-');
        replacements.push({
          start: parseInt(range[0], 10),
          end:   parseInt(range[1], 10),
          id:    emoteId
        });
      }
    }
    replacements.sort(function (a, b) { return a.start - b.start; });

    var html = '';
    var cursor = 0;
    for (var k = 0; k < replacements.length; k++) {
      var r = replacements[k];
      if (cursor < r.start) html += escapeHtml(text.substring(cursor, r.start));
      var emoteName = text.substring(r.start, r.end + 1);
      html += '<img class="uc-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/' +
        r.id + '/default/dark/1.0" alt="' + escapeHtml(emoteName) +
        '" title="' + escapeHtml(emoteName) + '">';
      cursor = r.end + 1;
    }
    if (cursor < text.length) html += escapeHtml(text.substring(cursor));
    return linkifyHtml(replaceThirdPartyEmotes(html));
  }

  // ==========================================
  // BOOTSTRAP
  // ==========================================
  document.addEventListener('yt-navigate-finish', onPageChange);

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'activate-unified-chat') {
      teardown();
      tryActivate();
    }
  });

  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'activate-unified-chat') {
      teardown();
      tryActivate();
    }
  });

  onPageChange();
})();
