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

  function deskChatHasLabel(chat, labelId) {
    if (!labelId || labelId === 'all') return true;
    if ((chat && chat.labelIds ? chat.labelIds : []).includes(labelId)) return true;
    return (chat && chat.labels ? chat.labels : []).some((l) => l.id === labelId);
  }

  function deskChatMatchesSearch(chat, query) {
    const q = String(query || '').trim();
    if (!q) return true;
    const wa = String((chat && chat.waNumber) || '');
    const qDigits = digitsOnly(q);
    if (qDigits) return wa.includes(qDigits);
    return ('+' + wa).toLowerCase().includes(q.toLowerCase());
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
    if (search) return 'No chats match that number.';
    if (unread && agent && hasLabel) return 'No unread agent chats with this label.';
    if (unread && agent) return 'No unread chats handed over to an agent.';
    if (agent && hasLabel) return 'No chats with this label handed over to an agent.';
    if (unread && hasLabel) return 'No unread chats with this label.';
    if (agent) return 'No chats handed over to an agent.';
    if (unread) return 'No unread chats.';
    if (hasLabel) return 'No chats with this label.';
    return 'No chats match these filters.';
  }

  return {
    digitsOnly,
    deskChatHasLabel,
    deskChatMatchesSearch,
    deskStatusBadge,
    deskChatMatchesFilters,
    deskFilterEmptyMessage,
  };
});
