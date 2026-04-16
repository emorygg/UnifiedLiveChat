// Content Script for Unified Chat
// Runs on the MAIN YouTube page, accesses the chat iframe from the parent.

(function () {
  // Ensure this only runs once
  if (window.unifiedChatInjected) return;
  window.unifiedChatInjected = true;

  // ==========================================
  // ENTRY POINT
  // ==========================================
  async function initUnifiedChat() {
    console.log("[UnifiedChat] Initializing...");

    // 1. Find the chat frame container on the main YouTube page
    const chatFrame = document.querySelector('ytd-live-chat-frame');
    if (!chatFrame) {
      alert("No live chat found on this page. Make sure the live chat is visible.");
      window.unifiedChatInjected = false;
      return;
    }

    // 2. Find the iframe inside it
    const chatIframe = chatFrame.querySelector('iframe');
    if (!chatIframe) {
      alert("Could not find the chat iframe. Is this a live stream?");
      window.unifiedChatInjected = false;
      return;
    }

    // 3. Get YouTube channel name for storage key
    const videoId = new URLSearchParams(window.location.search).get('v') || window.location.pathname;

    // 4. Fetch or prompt for Twitch Username
    let twitchName = await getStoredTwitchName(videoId);
    if (!twitchName) {
      twitchName = prompt("Enter the Twitch username to merge into this chat:");
      if (twitchName) {
        twitchName = twitchName.trim().toLowerCase();
        await saveStoredTwitchName(videoId, twitchName);
      } else {
        console.log("[UnifiedChat] No Twitch username provided. Exiting.");
        window.unifiedChatInjected = false;
        return;
      }
    }

    twitchName = twitchName.trim().toLowerCase();
    console.log("[UnifiedChat] Twitch channel: " + twitchName);

    // 5. Fetch third-party emotes (FFZ, BTTV, 7TV)
    await loadThirdPartyEmotes(twitchName);

    // 6. Inject our UI into the chat frame container
    injectUnifiedUI(chatFrame, chatIframe, twitchName);

    // 7. Start YouTube observer on the iframe content (same-origin access)
    startYouTubeObserver(chatIframe);

    // 8. Start Twitch WebSocket
    startTwitchConnection(twitchName);
  }

  // ==========================================
  // STORAGE
  // ==========================================
  function getStoredTwitchName(videoId) {
    return new Promise((resolve) => {
      chrome.storage.local.get([videoId], (result) => {
        resolve(result[videoId]);
      });
    });
  }

  function saveStoredTwitchName(videoId, twitchName) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [videoId]: twitchName }, resolve);
    });
  }

  // ==========================================
  // UNIFIED UI
  // ==========================================
  let ucMessageList = null;
  let autoScroll = true;

  function injectUnifiedUI(chatFrame, chatIframe, twitchName) {
    // Prevent duplicate injection
    if (document.getElementById('unified-chat-layer')) return;

    // Save original styles so we can restore on close
    var origIframeStyle = chatIframe.getAttribute('style') || '';
    var origFrameStyle = chatFrame.getAttribute('style') || '';

    // Capture the original height of the chat frame BEFORE modifying anything.
    // YouTube's layout engine already sets the correct height on ytd-live-chat-frame.
    var originalHeight = chatFrame.offsetHeight;

    // Hide the iframe but keep it alive for the MutationObserver
    chatIframe.style.cssText = 'visibility:hidden !important; position:absolute !important; width:1px !important; height:1px !important; overflow:hidden !important;';

    // Set explicit dimensions on ytd-live-chat-frame, using the original height
    chatFrame.style.height = originalHeight + 'px';
    chatFrame.style.display = 'flex';
    chatFrame.style.flexDirection = 'column';

    // Build our container
    var container = document.createElement('div');
    container.id = 'unified-chat-layer';

    // Header
    var header = document.createElement('div');
    header.id = 'uc-header';

    var title = document.createElement('div');
    title.className = 'uc-title';
    title.innerHTML = '<span>YT</span><span style="margin:0 6px;opacity:0.4">+</span><span style="color:#9146FF">' + twitchName + '</span>';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'uc-close-btn';
    closeBtn.id = 'uc-close';
    closeBtn.title = 'Close Unified Chat';
    closeBtn.textContent = '\u2716';

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Message list
    var messageList = document.createElement('div');
    messageList.id = 'uc-message-list';

    container.appendChild(header);
    container.appendChild(messageList);

    // Prepend into ytd-live-chat-frame (proven to work by the reference extension)
    chatFrame.prepend(container);

    ucMessageList = messageList;

    // Auto-scroll logic
    ucMessageList.addEventListener('scroll', function () {
      var isAtBottom = ucMessageList.scrollHeight - ucMessageList.scrollTop <= ucMessageList.clientHeight + 50;
      autoScroll = isAtBottom;
    });

    // Close handler — restore original chat
    closeBtn.addEventListener('click', function () {
      container.remove();
      chatIframe.setAttribute('style', origIframeStyle);
      chatFrame.setAttribute('style', origFrameStyle);
      if (twitchWs) twitchWs.close();
      window.unifiedChatInjected = false;
    });
  }

  function appendMessage(platform, authorName, text, authorColor) {
    if (!ucMessageList) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = 'uc-message platform-' + platform;

    // Author row
    const authorRow = document.createElement('div');
    authorRow.className = 'uc-author-row';

    const authorSpan = document.createElement('span');
    authorSpan.className = 'uc-author-name';
    authorSpan.textContent = authorName;
    if (authorColor) {
      authorSpan.style.color = authorColor;
    }

    authorRow.appendChild(authorSpan);

    // Text
    const textDiv = document.createElement('div');
    textDiv.className = 'uc-text';
    // Both YouTube and Twitch messages now contain safe HTML (emote imgs)
    textDiv.innerHTML = text;

    msgDiv.appendChild(authorRow);
    msgDiv.appendChild(textDiv);
    ucMessageList.appendChild(msgDiv);

    // Keep max 300 messages to prevent lag
    if (ucMessageList.children.length > 300) {
      ucMessageList.removeChild(ucMessageList.firstChild);
    }

    if (autoScroll) {
      ucMessageList.scrollTop = ucMessageList.scrollHeight;
    }
  }

  // ==========================================
  // YOUTUBE CHAT OBSERVER
  // ==========================================
  function startYouTubeObserver(chatIframe) {
    // We need to wait for the iframe to be fully loaded and accessible
    const tryObserve = setInterval(() => {
      try {
        const iframeDoc = chatIframe.contentDocument || chatIframe.contentWindow.document;
        if (!iframeDoc) return;

        const itemsContainer = iframeDoc.querySelector('yt-live-chat-item-list-renderer #items');
        if (!itemsContainer) return;

        clearInterval(tryObserve);
        console.log("[UnifiedChat] Attached YouTube chat observer.");

        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.tagName && node.tagName.toLowerCase() === 'yt-live-chat-text-message-renderer') {
                parseYouTubeMessage(node);
              }
            }
          }
        });

        observer.observe(itemsContainer, { childList: true });
      } catch (e) {
        // iframe may not be ready yet, or cross-origin (unlikely, but safe)
        console.log("[UnifiedChat] Waiting for chat iframe to be accessible...");
      }
    }, 1000);
  }

  function parseYouTubeMessage(node) {
    try {
      const authorSpan = node.querySelector('#author-name');
      const messageSpan = node.querySelector('#message');

      if (authorSpan && messageSpan) {
        const author = authorSpan.textContent.trim();
        const text = messageSpan.innerHTML; // preserves emoji imgs
        appendMessage('yt', author, text);
      }
    } catch (err) {
      console.error("[UnifiedChat] Error parsing YouTube message:", err);
    }
  }

  // ==========================================
  // TWITCH CHAT (WebSocket IRC)
  // ==========================================
  let twitchWs = null;

  function startTwitchConnection(channelName) {
    if (twitchWs) {
      twitchWs.close();
    }

    twitchWs = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

    twitchWs.onopen = () => {
      console.log("[UnifiedChat] Connected to Twitch IRC.");
      twitchWs.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      twitchWs.send('PASS SCHMOOPIIE');
      var anonId = Math.floor(Math.random() * 1000000);
      twitchWs.send('NICK justinfan' + anonId);
      twitchWs.send('JOIN #' + channelName);
    };

    twitchWs.onmessage = (event) => {
      var lines = event.data.split('\r\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;

        if (line.startsWith('PING')) {
          twitchWs.send('PONG :tmi.twitch.tv');
          continue;
        }

        if (line.includes('PRIVMSG')) {
          parseTwitchMessage(line);
        }
      }
    };

    twitchWs.onerror = (err) => {
      console.error("[UnifiedChat] Twitch WebSocket error:", err);
    };

    twitchWs.onclose = () => {
      console.log("[UnifiedChat] Twitch WebSocket closed.");
    };
  }

  // ==========================================
  // THIRD-PARTY EMOTES (FFZ, BTTV, 7TV)
  // ==========================================
  var thirdPartyEmotes = {}; // name -> url

  async function loadThirdPartyEmotes(channelName) {
    var fetches = [
      loadFFZGlobal(),
      loadFFZChannel(channelName),
      loadBTTVGlobal(),
      loadBTTVChannel(channelName),
      load7TVGlobal(),
      load7TVChannel(channelName)
    ];
    await Promise.allSettled(fetches);
    console.log('[UnifiedChat] Loaded ' + Object.keys(thirdPartyEmotes).length + ' third-party emotes.');
  }

  async function loadFFZGlobal() {
    try {
      var res = await fetch('https://api.frankerfacez.com/v1/set/global');
      var data = await res.json();
      parseFFZSets(data.sets);
    } catch (e) { console.warn('[UnifiedChat] FFZ global fetch failed:', e); }
  }

  async function loadFFZChannel(channel) {
    try {
      var res = await fetch('https://api.frankerfacez.com/v1/room/' + channel);
      var data = await res.json();
      parseFFZSets(data.sets);
    } catch (e) { console.warn('[UnifiedChat] FFZ channel fetch failed:', e); }
  }

  function parseFFZSets(sets) {
    if (!sets) return;
    for (var setId in sets) {
      var emotes = sets[setId].emoticons;
      if (!emotes) continue;
      for (var i = 0; i < emotes.length; i++) {
        var e = emotes[i];
        // Use highest available resolution
        var url = e.urls['4'] || e.urls['2'] || e.urls['1'];
        if (url) {
          // FFZ urls may be protocol-relative
          if (url.startsWith('//')) url = 'https:' + url;
          thirdPartyEmotes[e.name] = url;
        }
      }
    }
  }

  async function loadBTTVGlobal() {
    try {
      var res = await fetch('https://api.betterttv.net/3/cached/emotes/global');
      var data = await res.json();
      for (var i = 0; i < data.length; i++) {
        thirdPartyEmotes[data[i].code] = 'https://cdn.betterttv.net/emote/' + data[i].id + '/2x';
      }
    } catch (e) { console.warn('[UnifiedChat] BTTV global fetch failed:', e); }
  }

  async function loadBTTVChannel(channel) {
    try {
      // BTTV needs the Twitch user ID. Try fetching from their API that accepts login name.
      var res = await fetch('https://api.betterttv.net/3/cached/users/twitch/' + channel);
      if (!res.ok) return;
      var data = await res.json();
      var allEmotes = (data.channelEmotes || []).concat(data.sharedEmotes || []);
      for (var i = 0; i < allEmotes.length; i++) {
        thirdPartyEmotes[allEmotes[i].code] = 'https://cdn.betterttv.net/emote/' + allEmotes[i].id + '/2x';
      }
    } catch (e) { console.warn('[UnifiedChat] BTTV channel fetch failed:', e); }
  }

  async function load7TVGlobal() {
    try {
      var res = await fetch('https://7tv.io/v3/emote-sets/global');
      var data = await res.json();
      parse7TVEmotes(data.emotes || []);
    } catch (e) { console.warn('[UnifiedChat] 7TV global fetch failed:', e); }
  }

  async function load7TVChannel(channel) {
    try {
      var res = await fetch('https://7tv.io/v3/users/twitch/' + channel);
      var data = await res.json();
      if (data.emote_set && data.emote_set.emotes) {
        parse7TVEmotes(data.emote_set.emotes);
      }
    } catch (e) { console.warn('[UnifiedChat] 7TV channel fetch failed:', e); }
  }

  function parse7TVEmotes(emotes) {
    for (var i = 0; i < emotes.length; i++) {
      var e = emotes[i];
      var hostData = e.data && e.data.host;
      if (hostData && hostData.files && hostData.files.length > 0) {
        // Pick a reasonable size (2x or 1x)
        var file = hostData.files.find(function(f) { return f.name === '2x.webp'; })
                || hostData.files.find(function(f) { return f.name === '1x.webp'; })
                || hostData.files[0];
        if (file) {
          var baseUrl = hostData.url;
          if (baseUrl.startsWith('//')) baseUrl = 'https:' + baseUrl;
          thirdPartyEmotes[e.name] = baseUrl + '/' + file.name;
        }
      }
    }
  }

  // Replace third-party emote words in an HTML string.
  // Only replaces text that is NOT inside an HTML tag.
  function replaceThirdPartyEmotes(html) {
    if (Object.keys(thirdPartyEmotes).length === 0) return html;

    // Split HTML into tags and text segments
    var parts = html.split(/(<[^>]+>)/);
    for (var i = 0; i < parts.length; i++) {
      // Skip HTML tags
      if (parts[i].startsWith('<')) continue;
      // Replace emote words in text segments
      parts[i] = parts[i].replace(/\S+/g, function (word) {
        // Decode HTML entities for lookup
        var decoded = word.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        if (thirdPartyEmotes[decoded]) {
          return '<img class="uc-emote" src="' + thirdPartyEmotes[decoded] + '" alt="' + word + '" title="' + decoded + '">';
        }
        return word;
      });
    }
    return parts.join('');
  }

  // Escape HTML special characters to prevent XSS in non-emote text
  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Render Twitch emotes into a message string.
  // emotesTag format: "emoteId:start-end,start-end/emoteId:start-end"
  function renderTwitchEmotes(text, emotesTag) {
    if (!emotesTag) return replaceThirdPartyEmotes(escapeHtml(text));

    // Parse emote positions
    var replacements = [];
    var emoteGroups = emotesTag.split('/');
    for (var i = 0; i < emoteGroups.length; i++) {
      var parts = emoteGroups[i].split(':');
      if (parts.length < 2) continue;
      var emoteId = parts[0];
      var positions = parts[1].split(',');
      for (var j = 0; j < positions.length; j++) {
        var range = positions[j].split('-');
        var start = parseInt(range[0], 10);
        var end = parseInt(range[1], 10);
        replacements.push({ start: start, end: end, id: emoteId });
      }
    }

    // Sort by position descending so we can replace from end to start
    replacements.sort(function (a, b) { return b.start - a.start; });

    // Build the result by replacing emote ranges with img tags
    var result = text;
    for (var k = 0; k < replacements.length; k++) {
      var r = replacements[k];
      var emoteName = text.substring(r.start, r.end + 1);
      var img = '<img class="uc-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/' + r.id + '/default/dark/1.0" alt="' + escapeHtml(emoteName) + '" title="' + escapeHtml(emoteName) + '">';
      result = result.substring(0, r.start) + img + result.substring(r.end + 1);
    }

    // Escape HTML in the non-emote parts. Since we already injected img tags,
    // we need a different approach: build from segments.
    // Let's redo this properly with forward iteration.
    return buildEmoteHtml(text, replacements);
  }

  function buildEmoteHtml(text, replacements) {
    // Sort ascending for forward iteration
    replacements.sort(function (a, b) { return a.start - b.start; });

    var html = '';
    var cursor = 0;
    for (var i = 0; i < replacements.length; i++) {
      var r = replacements[i];
      // Escape the text between cursor and emote start
      if (cursor < r.start) {
        html += escapeHtml(text.substring(cursor, r.start));
      }
      var emoteName = text.substring(r.start, r.end + 1);
      html += '<img class="uc-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/' + r.id + '/default/dark/1.0" alt="' + escapeHtml(emoteName) + '" title="' + escapeHtml(emoteName) + '">';
      cursor = r.end + 1;
    }
    // Remaining text after last emote
    if (cursor < text.length) {
      html += escapeHtml(text.substring(cursor));
    }
    return replaceThirdPartyEmotes(html);
  }

  function parseTwitchMessage(rawStr) {
    try {
      // Format: @tags :user!user@user.tmi.twitch.tv PRIVMSG #channel :message text
      var authorName = "Unknown";
      var color = null;
      var text = "";
      var emotesTag = null;

      // Extract tags if present
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

      // Find PRIVMSG
      var privmsgIdx = rawStr.indexOf(' PRIVMSG ');
      if (privmsgIdx === -1) return;

      // Fallback author from :username!...
      if (authorName === "Unknown") {
        var userPart = rawStr.substring(0, privmsgIdx);
        if (userPart.startsWith(':')) {
          var bangIdx = userPart.indexOf('!');
          if (bangIdx !== -1) {
            authorName = userPart.substring(1, bangIdx);
          }
        }
      }

      // Extract message text after #channel :
      var afterPrivmsg = rawStr.substring(privmsgIdx + 9);
      var colonIdx = afterPrivmsg.indexOf(' :');
      if (colonIdx === -1) return;
      text = afterPrivmsg.substring(colonIdx + 2);

      // Render emotes into HTML
      var renderedText = renderTwitchEmotes(text, emotesTag);

      appendMessage('twitch', authorName, renderedText, color);
    } catch (err) {
      console.error("[UnifiedChat] Error parsing Twitch message:", err);
    }
  }

  // ==========================================
  // RUN
  // ==========================================
  initUnifiedChat();
})();
