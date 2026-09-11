'use strict';

/**
 * Agent-desk chat-list filters and status pills.
 * Loaded in the browser via /agent/static/deskListFilters.js and required by tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    Object.keys(api).forEach((key) => {
      root[key] = api[key];
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
  }

  /**
   * Staff type 064…, 64…, or 2764… for the same SA mobile.
   * Keep every variant so Postgres LIKE and the client list agree.
   */
  function searchDigitCandidates(query) {
    const d = digitsOnly(query);
    const out = [];
    const add = (value) => {
      if (value && value.length >= 4 && out.indexOf(value) === -1) out.push(value);
    };
    add(d);
    if (!d) return out;
    if (d.charAt(0) === '0' && d.length > 4) {
      add(d.slice(1));
      add('27' + d.slice(1));
    }
    if (d.indexOf('27') === 0 && d.length > 6) {
      add(d.slice(2));
      add('0' + d.slice(2));
    }
    if (d.charAt(0) !== '0' && d.indexOf('27') !== 0 && d.length >= 7) {
      add('27' + d);
      add('0' + d);
    }
    return out;
  }

  function searchLikePatterns(query) {
    return searchDigitCandidates(query).map((d) => '%' + d + '%');
  }

  function waNumberMatchesQuery(waNumber, query) {
    const wa = digitsOnly(waNumber);
    const q = String(query || '').trim();
    if (!q) return true;
    const qDigits = digitsOnly(q);
    if (!qDigits) {
      return ('+' + wa).toLowerCase().includes(q.toLowerCase());
    }
    if (qDigits.length < 4) return wa.includes(qDigits);
    const candidates = searchDigitCandidates(qDigits);
    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i];
      if (wa.includes(c) || c.includes(wa)) return true;
    }
    if (qDigits.length >= 7 && wa.length >= 7) {
      const n = Math.min(9, qDigits.length, wa.length);
      if (wa.slice(-n) === qDigits.slice(-n)) return true;
    }
    return false;
  }

  function deskChatHasLabel(chat, labelId) {
    if (!labelId || labelId === 'all') return true;
    if ((chat && chat.labelIds ? chat.labelIds : []).includes(labelId)) return true;
    return (chat && chat.labels ? chat.labels : []).some((l) => l.id === labelId);
  }

  function deskChatMatchesSearch(chat, query) {
    return waNumberMatchesQuery(chat && chat.waNumber, query);
  }

  /**
   * Who/what to show next to the phone number.
   * Takeover (or last agent message) wins. Missing sessions used to be
   * labelled `unknown`; those are bot-handled chats.
   * Never display the string "unknown".
   */
  function deskStatusBadge(chat) {
    if (chat && chat.agentTakenOver) return { text: 'agent', cls: 'takeover' };
    if (chat && chat.lastSource === 'agent') return { text: 'agent', cls: 'takeover' };
    const status = chat && chat.status ? String(chat.status) : '';
    if (status === 'quiet') return { text: 'quiet', cls: 'quiet' };
    if (status === 'soft_closed') return { text: 'soft_closed', cls: '' };
    if (status === 'unknown' || status === 'bot' || !status) {
      return { text: 'bot', cls: 'bot' };
    }
    if (status === 'new' || status === 'active') return { text: 'bot', cls: 'bot' };
    return { text: status, cls: '' };
  }

  function deskChatMatchesFilters(chat, filters, unreadCount) {
    const filterUnread = Boolean(filters && filters.filterUnread);
    const filterAgent = Boolean(filters && filters.filterAgent);
    const filterLabelId = (filters && filters.filterLabelId) || 'all';
    const search = (filters && filters.chatSearch) || '';
    const searchDigits = digitsOnly(search);
    // A number lookup is global (WhatsApp-style): do not hide the hit behind Unread / Agent / label.
    if (searchDigits.length >= 4) {
      return deskChatMatchesSearch(chat, search);
    }
    if (filterUnread && !(Number(unreadCount) > 0)) return false;
    if (filterAgent && !(chat && chat.agentTakenOver)) return false;
    if (filterLabelId !== 'all' && !deskChatHasLabel(chat, filterLabelId)) return false;
    if (!deskChatMatchesSearch(chat, search)) return false;
    return true;
  }

  function deskFilterEmptyMessage(filters) {
    const search = String((filters && filters.chatSearch) || '').trim();
    const unread = Boolean(filters && filters.filterUnread);
    const agent = Boolean(filters && filters.filterAgent);
    const labelId = (filters && filters.filterLabelId) || 'all';
    const hasLabel = Boolean(labelId && labelId !== 'all');
    if (search) {
      return 'No stored chat for that number. Use + to message them anyway.';
    }
    if (unread && agent && hasLabel) return 'No unread agent chats with this label.';
    if (unread && agent) return 'No unread chats handed over to an agent.';
    if (agent && hasLabel) return 'No chats with this label handed over to an agent.';
    if (unread && hasLabel) return 'No unread chats with this label.';
    if (agent) return 'No chats handed over to an agent.';
    if (unread) return 'No unread chats.';
    if (hasLabel) return 'No chats with this label.';
    return 'No chats match these filters.';
  }

  function mergeDeskSearchHits(inboxChats, searchResults, filters, unreadCountOf) {
    const search = (filters && filters.chatSearch) || '';
    const searching = digitsOnly(search).length >= 4;
    const unreadOf = typeof unreadCountOf === 'function' ? unreadCountOf : function () { return 0; };
    const inboxHits = (inboxChats || []).filter((chat) =>
      deskChatMatchesFilters(chat, filters, unreadOf(chat))
    );
    if (!searching) return inboxHits;
    const extra = Array.isArray(searchResults)
      ? searchResults.filter((chat) => deskChatMatchesFilters(chat, filters, unreadOf(chat)))
      : [];
    const byWa = {};
    inboxHits.concat(extra).forEach((chat) => {
      if (chat && chat.waNumber && !byWa[chat.waNumber]) byWa[chat.waNumber] = chat;
    });
    const out = [];
    Object.keys(byWa).forEach((wa) => out.push(byWa[wa]));
    return out;
  }

  return {
    digitsOnly,
    searchDigitCandidates,
    searchLikePatterns,
    waNumberMatchesQuery,
    mergeDeskSearchHits,
    deskChatHasLabel,
    deskChatMatchesSearch,
    deskStatusBadge,
    deskChatMatchesFilters,
    deskFilterEmptyMessage,
  };
});
