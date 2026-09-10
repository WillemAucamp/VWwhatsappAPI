'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  deskStatusBadge,
  deskChatMatchesFilters,
  deskFilterEmptyMessage,
  deskChatHasLabel,
} = require('../public/agent/deskListFilters');

function testStatusBadges() {
  assert.deepStrictEqual(deskStatusBadge({ agentTakenOver: true, status: 'quiet' }), {
    text: 'agent',
    cls: 'takeover',
  });
  assert.deepStrictEqual(deskStatusBadge({ status: 'quiet' }), { text: 'quiet', cls: 'quiet' });
  assert.deepStrictEqual(deskStatusBadge({ status: 'unknown' }), { text: 'bot', cls: 'bot' });
  assert.deepStrictEqual(deskStatusBadge({ status: 'soft_closed' }), {
    text: 'soft_closed',
    cls: '',
  });
  assert.deepStrictEqual(deskStatusBadge({ status: 'active' }), { text: 'active', cls: '' });
  assert.deepStrictEqual(deskStatusBadge({ status: 'new' }), { text: 'new', cls: '' });
  assert.strictEqual(deskStatusBadge({}), null);
  // eslint-disable-next-line no-console
  console.log('✓ unknown status displays as bot; other FSM pills unchanged');
}

function testAgentFilter() {
  const botChat = { waNumber: '1', agentTakenOver: false, status: 'unknown', labelIds: [] };
  const agentChat = {
    waNumber: '2',
    agentTakenOver: true,
    status: 'quiet',
    labelIds: ['vip'],
  };
  const labeledBot = {
    waNumber: '3',
    agentTakenOver: false,
    status: 'active',
    labelIds: ['vip'],
  };

  assert.strictEqual(
    deskChatMatchesFilters(botChat, { filterAgent: true, filterLabelId: 'all' }, 0),
    false
  );
  assert.strictEqual(
    deskChatMatchesFilters(agentChat, { filterAgent: true, filterLabelId: 'all' }, 0),
    true
  );
  assert.strictEqual(
    deskChatMatchesFilters(agentChat, { filterAgent: true, filterUnread: true }, 0),
    false
  );
  assert.strictEqual(
    deskChatMatchesFilters(agentChat, { filterAgent: true, filterUnread: true }, 2),
    true
  );
  assert.strictEqual(
    deskChatMatchesFilters(
      agentChat,
      { filterAgent: true, filterLabelId: 'vip' },
      0
    ),
    true
  );
  assert.strictEqual(
    deskChatMatchesFilters(
      labeledBot,
      { filterAgent: true, filterLabelId: 'vip' },
      1
    ),
    false
  );
  assert.ok(deskChatHasLabel(agentChat, 'vip'));
  assert.strictEqual(
    deskFilterEmptyMessage({ filterAgent: true, filterLabelId: 'all' }),
    'No chats handed over to an agent.'
  );
  assert.strictEqual(
    deskFilterEmptyMessage({
      filterAgent: true,
      filterUnread: true,
      filterLabelId: 'all',
    }),
    'No unread chats handed over to an agent.'
  );
  // eslint-disable-next-line no-console
  console.log('✓ agent filter stacks with unread and labels');
}

function testDeskHtmlWiresHelper() {
  const html = fs.readFileSync(
    path.join(__dirname, '../public/agent/index.html'),
    'utf8'
  );
  assert.ok(
    html.includes('/agent/static/deskListFilters.js'),
    'desk UI must load shared filter helper'
  );
  assert.ok(html.includes("kind === 'agent'"), 'Agent chip must be wired');
  assert.ok(html.includes('filterAgent'), 'filterAgent state must exist');
  assert.ok(html.includes('filter-bar-wrap'), 'filter chips must sit in a scroll wrap');
  assert.ok(html.includes('filterScrollRight'), 'overflowing labels need a scroll-right control');
  assert.ok(html.includes('min-width: 0'), 'filter bar must be able to shrink so chips scroll');
  assert.ok(
    !/escapeHtml\(c\.status\)/.test(html),
    'raw session status must not be shown as the pill text'
  );
  // eslint-disable-next-line no-console
  console.log('✓ agent desk HTML uses shared bot/agent list helpers');
}

testStatusBadges();
testAgentFilter();
testDeskHtmlWiresHelper();
console.log('\ndesk list filter tests passed.');
