// Content Script for Unified Chat
// Auto-runs on YouTube pages via content_scripts in manifest.
// Detects YouTube channel, checks for a stored Twitch link, and auto-activates.

(function () {
  // ==========================================
  // STATE
  // ==========================================
  var ucMessageList = null;
  var autoScroll = true;
  var twitchWs = null;
  var kickWs = null;
  var thirdPartyEmotes = {};
  var currentActivation = null; // track active channel to avoid duplicate activation

  // ==========================================
  // ENTRY POINT — SPA-aware page watcher
  // ==========================================
  function onPageChange() {
    // Clean up any previous activation if we navigated away
    teardown();

    // Only run on watch pages
    if (!window.location.pathname.startsWith('/watch')) return;

    // Wait for the page to settle, then try to activate
    setTimeout(function () { tryActivate(); }, 2000);
  }

  async function tryActivate() {
    // 1. Detect the YouTube channel handle from the page
    var ytChannel = getYouTubeChannelHandle();
    if (!ytChannel) {
      console.log('[UnifiedChat] Could not detect YouTube channel.');
      return;
    }

    // 2. Check if this channel has a linked entry
    var links = await getChannelLinks();
    var entry = links[ytChannel];

    if (!entry) {
      entry = links[ytChannel.replace('@', '')];
    }
    if (!entry) {
      console.log('[UnifiedChat] No link for channel: ' + ytChannel);
      return;
    }

    // Handle legacy string format
    if (typeof entry === 'string') {
      entry = { twitch: entry };
    }

    var twitchName = entry.twitch ? entry.twitch.trim().toLowerCase() : null;
    var kickName = entry.kick ? entry.kick.trim().toLowerCase() : null;

    if (!twitchName && !kickName) {
      console.log('[UnifiedChat] Entry has no channels configured.');
      return;
    }

    // 3. Find the live chat frame
    var chatFrame = document.querySelector('ytd-live-chat-frame');
    if (!chatFrame) {
      console.log('[UnifiedChat] No live chat frame found (not a live stream?).');
      return;
    }

    // 4. Wait for the iframe inside the chat frame
    var chatIframe = await waitForElement(chatFrame, 'iframe', 10000);
    if (!chatIframe) {
      console.log('[UnifiedChat] Chat iframe did not load.');
      return;
    }

    // Prevent duplicate activation for the same channel
    if (currentActivation === ytChannel) return;
    currentActivation = ytChannel;

    var platformLabels = [];
    if (twitchName) platformLabels.push(twitchName);
    if (kickName) platformLabels.push(kickName);
    console.log('[UnifiedChat] Auto-activating for ' + ytChannel + ' → ' + platformLabels.join(', '));

    // 5. Load third-party emotes (based on Twitch channel for FFZ/BTTV/7TV)
    if (twitchName) {
      await loadThirdPartyEmotes(twitchName);
    }

    // 6. Build header label
    var headerParts = ['YT'];
    if (twitchName) headerParts.push(twitchName);
    if (kickName) headerParts.push(kickName);
    var headerLabel = headerParts.join(' + ');

    // 7. Inject UI
    injectUnifiedUI(chatFrame, chatIframe, headerLabel);

    // 8. Start observers
    startYouTubeObserver(chatIframe);

    // 9. Connect to platforms
    if (twitchName) startTwitchConnection(twitchName);
    if (kickName) startKickConnection(kickName);
  }

  function teardown() {
    var existing = document.getElementById('unified-chat-layer');
    if (existing) existing.remove();
    if (twitchWs) {
      twitchWs.close();
      twitchWs = null;
    }
    if (kickWs) {
      kickWs.close();
      kickWs = null;
    }
    ucMessageList = null;
    currentActivation = null;
  }

  // ==========================================
  // YOUTUBE CHANNEL DETECTION
  // ==========================================
  function getYouTubeChannelHandle() {
    // Try to get the channel handle from the owner link
    var anchor = document.querySelector(
      'ytd-video-owner-renderer a.yt-simple-endpoint'
    );
    if (anchor && anchor.href) {
      // href is like https://www.youtube.com/@ChannelName
      var match = anchor.href.match(/youtube\.com\/@([^\/\?]+)/);
      if (match) return match[1].toLowerCase();

      // Fallback: /channel/UC... format — use the text content instead
      match = anchor.href.match(/youtube\.com\/channel\/([^\/\?]+)/);
      if (match) {
        // Use the visible channel name text as the key
        var nameEl = document.querySelector('ytd-video-owner-renderer #channel-name yt-formatted-string');
        if (nameEl) return nameEl.textContent.trim().toLowerCase();
        return match[1].toLowerCase();
      }
    }

    // Fallback: try channel name text
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
  // UNIFIED UI
  // ==========================================
  function injectUnifiedUI(chatFrame, chatIframe, headerLabel) {
    if (document.getElementById('unified-chat-layer')) return;

    var origIframeStyle = chatIframe.getAttribute('style') || '';
    var origFrameStyle = chatFrame.getAttribute('style') || '';

    var originalHeight = chatFrame.offsetHeight;

    chatIframe.style.cssText = 'visibility:hidden !important; position:absolute !important; width:1px !important; height:1px !important; overflow:hidden !important;';

    chatFrame.style.height = originalHeight + 'px';
    chatFrame.style.display = 'flex';
    chatFrame.style.flexDirection = 'column';

    var container = document.createElement('div');
    container.id = 'unified-chat-layer';

    var header = document.createElement('div');
    header.id = 'uc-header';

    var title = document.createElement('div');
    title.className = 'uc-title';
    title.textContent = headerLabel;

    var closeBtn = document.createElement('button');
    closeBtn.className = 'uc-close-btn';
    closeBtn.id = 'uc-close';
    closeBtn.title = 'Close Unified Chat';
    closeBtn.textContent = '\u2716';

    header.appendChild(title);
    header.appendChild(closeBtn);

    var messageList = document.createElement('div');
    messageList.id = 'uc-message-list';

    container.appendChild(header);
    container.appendChild(messageList);

    chatFrame.prepend(container);

    ucMessageList = messageList;

    ucMessageList.addEventListener('scroll', function () {
      var isAtBottom = ucMessageList.scrollHeight - ucMessageList.scrollTop <= ucMessageList.clientHeight + 50;
      autoScroll = isAtBottom;
    });

    closeBtn.addEventListener('click', function () {
      container.remove();
      chatIframe.setAttribute('style', origIframeStyle);
      chatFrame.setAttribute('style', origFrameStyle);
      if (twitchWs) { twitchWs.close(); twitchWs = null; }
      if (kickWs) { kickWs.close(); kickWs = null; }
      ucMessageList = null;
      currentActivation = null;
    });
  }

  function appendMessage(platform, authorName, text, authorColor) {
    if (!ucMessageList) return;

    var msgDiv = document.createElement('div');
    msgDiv.className = 'uc-message platform-' + platform;

    var authorRow = document.createElement('div');
    authorRow.className = 'uc-author-row';

    var authorSpan = document.createElement('span');
    authorSpan.className = 'uc-author-name';
    authorSpan.textContent = authorName;
    if (authorColor) {
      authorSpan.style.color = authorColor;
    }

    authorRow.appendChild(authorSpan);

    var textDiv = document.createElement('div');
    textDiv.className = 'uc-text';
    textDiv.innerHTML = text;

    msgDiv.appendChild(authorRow);
    msgDiv.appendChild(textDiv);
    ucMessageList.appendChild(msgDiv);

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
    var tryObserve = setInterval(function () {
      try {
        var iframeDoc = chatIframe.contentDocument || chatIframe.contentWindow.document;
        if (!iframeDoc) return;

        var itemsContainer = iframeDoc.querySelector('yt-live-chat-item-list-renderer #items');
        if (!itemsContainer) return;

        clearInterval(tryObserve);
        console.log('[UnifiedChat] Attached YouTube chat observer.');

        var observer = new MutationObserver(function (mutations) {
          for (var m = 0; m < mutations.length; m++) {
            for (var n = 0; n < mutations[m].addedNodes.length; n++) {
              var node = mutations[m].addedNodes[n];
              if (node.tagName && node.tagName.toLowerCase() === 'yt-live-chat-text-message-renderer') {
                parseYouTubeMessage(node);
              }
            }
          }
        });

        observer.observe(itemsContainer, { childList: true });
      } catch (e) {
        // iframe not ready yet
      }
    }, 1000);
  }

  function parseYouTubeMessage(node) {
    try {
      var authorSpan = node.querySelector('#author-name');
      var messageSpan = node.querySelector('#message');

      if (authorSpan && messageSpan) {
        var author = authorSpan.textContent.trim();
        var text = messageSpan.innerHTML;
        appendMessage('yt', author, text);
      }
    } catch (err) {
      console.error('[UnifiedChat] Error parsing YouTube message:', err);
    }
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
        if (line.includes('PRIVMSG')) {
          parseTwitchMessage(line);
        }
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
      // 1. Get chatroom ID from Kick API
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

      // 2. Connect to Pusher WebSocket
      var pusherKey = '32cbd69e4b950bf97679';
      var wsUrl = 'wss://ws-us2.pusher.com/app/' + pusherKey + '?protocol=7&client=js&version=7.6.0&flash=false';
      kickWs = new WebSocket(wsUrl);

      kickWs.onopen = function () {
      };

      kickWs.onmessage = function (event) {
        try {
          var msg = JSON.parse(event.data);

          // Handle Pusher connection established
          if (msg.event === 'pusher:connection_established') {
            kickWs.send(JSON.stringify({
              event: 'pusher:subscribe',
              data: { auth: '', channel: 'chatrooms.' + chatroomId + '.v2' }
            }));
          }

          if (msg.event === 'pusher:error') {
            console.error('[UnifiedChat] Pusher returned error:', msg.data);
          }

          // Handle chat messages
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

      // Escape HTML in the message text
      var rendered = escapeHtml(text);
      
      // Replace Kick native emotes: [emote:ID:Name]
      rendered = rendered.replace(/\[emote:(\d+):([^\]]+)\]/g, function (match, id, name) {
        var url = 'https://files.kick.com/emotes/' + id + '/fullsize';
        return '<img class="uc-emote" src="' + url + '" alt="' + name + '" title="' + name + '">';
      });

      // Apply third-party emote replacement (some Kick channels use BTTV/7TV)
      rendered = replaceThirdPartyEmotes(rendered);

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
      // Fastest way: use decapi.me to translate name to Twitch ID (required for BTTV/7TV v3 APIs)
      var idRes = await fetch('https://decapi.me/twitch/id/' + channelName);
      if (idRes.ok) {
        var idText = await idRes.text();
        if (!idText.includes('User not found') && !idText.includes('Error')) {
          twitchId = idText.trim();
        }
      }
    } catch (e) { /* silent */ }

    var fetches = [
      loadFFZGlobal(), loadFFZChannel(channelName),
      loadBTTVGlobal(), loadBTTVChannel(twitchId || channelName),
      load7TVGlobal(), load7TVChannel(twitchId || channelName)
    ];
    await Promise.allSettled(fetches);
    console.log('[UnifiedChat] Loaded ' + Object.keys(thirdPartyEmotes).length + ' third-party emotes.');
  }

  async function loadFFZGlobal() {
    try {
      var res = await fetch('https://api.frankerfacez.com/v1/set/global');
      var data = await res.json();
      parseFFZSets(data.sets);
    } catch (e) { /* silent */ }
  }

  async function loadFFZChannel(channel) {
    try {
      var res = await fetch('https://api.frankerfacez.com/v1/room/' + channel);
      var data = await res.json();
      parseFFZSets(data.sets);
    } catch (e) { /* silent */ }
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
      var res = await fetch('https://api.betterttv.net/3/cached/emotes/global');
      var data = await res.json();
      for (var i = 0; i < data.length; i++) {
        thirdPartyEmotes[data[i].code] = 'https://cdn.betterttv.net/emote/' + data[i].id + '/2x';
      }
    } catch (e) { /* silent */ }
  }

  async function loadBTTVChannel(channel) {
    try {
      var res = await fetch('https://api.betterttv.net/3/cached/users/twitch/' + channel);
      if (!res.ok) return;
      var data = await res.json();
      var allEmotes = (data.channelEmotes || []).concat(data.sharedEmotes || []);
      for (var i = 0; i < allEmotes.length; i++) {
        thirdPartyEmotes[allEmotes[i].code] = 'https://cdn.betterttv.net/emote/' + allEmotes[i].id + '/2x';
      }
    } catch (e) { /* silent */ }
  }

  async function load7TVGlobal() {
    try {
      var res = await fetch('https://7tv.io/v3/emote-sets/global');
      var data = await res.json();
      parse7TVEmotes(data.emotes || []);
    } catch (e) { /* silent */ }
  }

  async function load7TVChannel(channel) {
    try {
      var res = await fetch('https://7tv.io/v3/users/twitch/' + channel);
      var data = await res.json();
      if (data.emote_set && data.emote_set.emotes) {
        parse7TVEmotes(data.emote_set.emotes);
      }
    } catch (e) { /* silent */ }
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
        var decoded = word.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        if (thirdPartyEmotes[decoded]) {
          return '<img class="uc-emote" src="' + thirdPartyEmotes[decoded] + '" alt="' + word + '" title="' + decoded + '">';
        }
        return word;
      });
    }
    return parts.join('');
  }

  // ==========================================
  // NATIVE TWITCH EMOTE RENDERING
  // ==========================================
  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderTwitchEmotes(text, emotesTag) {
    if (!emotesTag) return replaceThirdPartyEmotes(escapeHtml(text));

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

    replacements.sort(function (a, b) { return a.start - b.start; });

    var html = '';
    var cursor = 0;
    for (var k = 0; k < replacements.length; k++) {
      var r = replacements[k];
      if (cursor < r.start) {
        html += escapeHtml(text.substring(cursor, r.start));
      }
      var emoteName = text.substring(r.start, r.end + 1);
      html += '<img class="uc-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/' + r.id + '/default/dark/1.0" alt="' + escapeHtml(emoteName) + '" title="' + escapeHtml(emoteName) + '">';
      cursor = r.end + 1;
    }
    if (cursor < text.length) {
      html += escapeHtml(text.substring(cursor));
    }
    return replaceThirdPartyEmotes(html);
  }

  // ==========================================
  // BOOTSTRAP — Listen for YouTube SPA navigation
  // ==========================================
  // YouTube fires 'yt-navigate-finish' on SPA page transitions
  document.addEventListener('yt-navigate-finish', onPageChange);

  // Listen for messages from the popup (e.g. when a new link is added)
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'activate-unified-chat') {
      teardown();
      currentActivation = null;
      tryActivate();
    }
  });

  // Also run on initial load in case the page is already a watch page
  onPageChange();
})();
