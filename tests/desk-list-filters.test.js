'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  deskStatusBadge,
  deskChatMatchesFilters,
  deskFilterEmptyMessage,
  deskChatHasLabel,
  waNumberMatchesQuery,
  mergeDeskSearchHits,
  waLookupKeys,
} = require('../public/agent/deskListFilters');

function testStatusBadges() {
  assert.deepStrictEqual(deskStatusBadge({ agentTakenOver: true, status: 'quiet' }), {
    text: 'agent',
    cls: 'takeover',
  });
  assert.deepStrictEqual(deskStatusBadge({ lastSource: 'agent', status: 'unknown' }), {
    text: 'agent',
    cls: 'takeover',
  });
  assert.deepStrictEqual(deskStatusBadge({ status: 'quiet' }), { text: 'quiet', cls: 'quiet' });
  assert.deepStrictEqual(deskStatusBadge({ status: 'unknown' }), { text: 'bot', cls: 'bot' });
  assert.deepStrictEqual(deskStatusBadge({ status: 'bot' }), { text: 'bot', cls: 'bot' });
  assert.deepStrictEqual(deskStatusBadge({}), { text: 'bot', cls: 'bot' });
  assert.deepStrictEqual(deskStatusBadge({ status: 'soft_closed' }), {
    text: 'soft_closed',
    cls: '',
  });
  assert.deepStrictEqual(deskStatusBadge({ status: 'active' }), { text: 'bot', cls: 'bot' });
  assert.deepStrictEqual(deskStatusBadge({ status: 'new' }), { text: 'bot', cls: 'bot' });
  // eslint-disable-next-line no-console
  console.log('✓ unknown/missing/active session displays as bot; never unknown');
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
  assert.ok(html.includes('searchMessageBtn'), 'empty search must offer Message +number');
  assert.ok(html.includes('/api/stored/'), 'empty search must probe stored chats');
  assert.ok(html.includes('transcriptAppendFailures'), 'desk must surface save failures');
  assert.ok(html.includes('min-width: 0'), 'filter bar must be able to shrink so chips scroll');
  assert.ok(html.includes('chatListStatusBadge'), 'chat list must use chatListStatusBadge');
  assert.ok(
    html.includes("toLowerCase() !== 'unknown'"),
    'chat list must refuse to paint unknown pills'
  );
  assert.ok(
    !/escapeHtml\(c\.status\)/.test(html),
    'raw session status must not be shown as the pill text'
  );
  // eslint-disable-next-line no-console
  console.log('✓ agent desk HTML uses shared bot/agent list helpers');
}

function testNumberSearchVariants() {
  assert.ok(waNumberMatchesQuery('27648411242', '648411242'));
  assert.ok(waNumberMatchesQuery('27648411242', '0648411242'));
  assert.ok(waNumberMatchesQuery('27648411242', '27648411242'));
  assert.ok(waNumberMatchesQuery('27821234567', '0821234567'));
  assert.ok(waNumberMatchesQuery('27821234567', '821234567'));
  assert.ok(
    deskChatMatchesFilters(
      { waNumber: '27648411242', agentTakenOver: false },
      { chatSearch: '648411242', filterUnread: true, filterLabelId: 'all' },
      0
    ),
    'number search ignores unread filter'
  );
  assert.strictEqual(
    deskFilterEmptyMessage({ chatSearch: '648411242' }).includes('Use +'),
    true
  );
  assert.ok(!waNumberMatchesQuery('27821234567', '648411242'));
  const merged = mergeDeskSearchHits(
    [{ waNumber: '27648411242', lastText: 'hi' }],
    [],
    { chatSearch: '+27648411242', filterLabelId: 'all' },
    () => 0
  );
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].waNumber, '27648411242');
  assert.ok(waLookupKeys('648411242').includes('27648411242'));
  assert.ok(waLookupKeys('0648411242').includes('27648411242'));
  assert.ok(waLookupKeys('820002222').includes('+27820002222'));
  // eslint-disable-next-line no-console
  console.log('✓ stored numbers match 27 / 0 / suffix search');
}

testStatusBadges();
testAgentFilter();
testDeskHtmlWiresHelper();
testNumberSearchVariants();
console.log('\ndesk list filter tests passed.');
