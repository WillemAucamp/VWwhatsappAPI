'use strict';

/**
 * FSM state table — data only, no branching logic.
 *
 * Each state:
 *   id            unique state id
 *   promptKey     key into content/copy.js (resolved as {{COPY.*}})
 *   type          'choice' | 'info' | 'terminal'
 *   options       valid inputs → next state (choice states)
 *   next          fixed next state (info states that always continue)
 *   terminal      true if conversation ends for this path
 *   exitReason    lead-logger reason for terminal states
 *   softDecline   if true, next inbound message may restart the session
 *   quiet         if true, bot stays silent until reopen keywords / TTL
 *   notifyAgent   if true, agent notification fires on enter
 *   sendLink      optional link slot: 'application' | 'stock'
 *   mediaSlot     optional media slot id for transport (e.g. stock list)
 */

/** @typedef {'choice'|'info'|'terminal'} StateType */

/** @type {Record<string, object>} */
const STATES = {
  GREETING: {
    id: 'GREETING',
    promptKey: 'greeting_prompt',
    type: 'choice',
    options: {
      '1': 'SPECIAL_INFO',
      '2': 'STOCK_LIST',
      '3': 'LICENSE_CHECK',
    },
    // Human-readable labels for matching (normalized). Numbers also accepted.
    optionLabels: {
      '1': ['1', 'i saw a special', 'special'],
      '2': ['2', 'let me see your cars', 'cars', 'stock'],
      '3': ['3', 'qualify me', 'qualify'],
    },
  },

  SPECIAL_INFO: {
    id: 'SPECIAL_INFO',
    promptKey: 'special_info_body',
    continuePromptKey: 'special_info_continue',
    type: 'info',
    next: 'LICENSE_CHECK',
    // Any non-help input advances; labels listed for re-prompt clarity
    options: {
      '1': 'LICENSE_CHECK',
    },
    optionLabels: {
      '1': ['1', 'continue', 'ok', 'yes', 'next'],
    },
  },

  STOCK_LIST: {
    id: 'STOCK_LIST',
    promptKey: 'stock_list_body',
    continuePromptKey: 'stock_list_continue',
    type: 'info',
    next: 'LICENSE_CHECK',
    sendLink: 'stock',
    mediaSlot: 'stock_list',
    options: {
      '1': 'LICENSE_CHECK',
    },
    optionLabels: {
      '1': ['1', 'continue', 'ok', 'yes', 'next'],
    },
  },

  LICENSE_CHECK: {
    id: 'LICENSE_CHECK',
    promptKey: 'license_check_prompt',
    type: 'choice',
    options: {
      yes: 'INCOME_CHECK',
      no: 'NO_LICENSE_ADVICE',
    },
    optionLabels: {
      yes: ['yes', 'y', '1'],
      no: ['no', 'n', '2'],
    },
  },

  NO_LICENSE_ADVICE: {
    id: 'NO_LICENSE_ADVICE',
    promptKey: 'no_license_advice',
    type: 'terminal',
    terminal: true,
    exitReason: 'no_license',
    softDecline: true,
    notifyAgent: false,
  },

  INCOME_CHECK: {
    id: 'INCOME_CHECK',
    promptKey: 'income_check_prompt',
    type: 'choice',
    options: {
      below: 'AFFORDABILITY_DECLINE',
      mid: 'CREDIT_CHECK',
      above: 'CREDIT_CHECK',
    },
    optionLabels: {
      below: ['1', 'below', 'below r8500', 'below r8,500', 'under 8500'],
      mid: ['2', 'r8500-r15000', 'r8,500–r15,000', '8500-15000', 'mid'],
      above: ['3', 'above', 'above r15000', 'above r15,000', 'over 15000'],
    },
  },

  AFFORDABILITY_DECLINE: {
    id: 'AFFORDABILITY_DECLINE',
    promptKey: 'affordability_decline_advice',
    type: 'terminal',
    terminal: true,
    exitReason: 'affordability_decline',
    softDecline: true,
    notifyAgent: false,
  },

  CREDIT_CHECK: {
    id: 'CREDIT_CHECK',
    promptKey: 'credit_check_prompt',
    type: 'choice',
    options: {
      poor: 'CREDIT_DECLINE',
      average: 'CONFIRM_QUALIFY',
      great: 'CONFIRM_QUALIFY',
    },
    optionLabels: {
      poor: ['1', 'poor'],
      average: ['2', 'average', 'avg'],
      great: ['3', 'great', 'good', 'excellent'],
    },
  },

  CREDIT_DECLINE: {
    id: 'CREDIT_DECLINE',
    promptKey: 'credit_decline_advice',
    type: 'terminal',
    terminal: true,
    exitReason: 'credit_decline',
    softDecline: true,
    notifyAgent: false,
  },

  CONFIRM_QUALIFY: {
    id: 'CONFIRM_QUALIFY',
    promptKey: 'confirm_qualify_prompt',
    type: 'choice',
    options: {
      yes: 'QUALIFIED_LINK',
      no: 'AGENT_SOFT_HANDOVER',
    },
    optionLabels: {
      yes: ['yes', 'y', '1'],
      no: ['no', 'n', '2'],
    },
  },

  QUALIFIED_LINK: {
    id: 'QUALIFIED_LINK',
    promptKey: 'qualified_link_body',
    type: 'terminal',
    terminal: true,
    exitReason: 'qualified_self_serve',
    softDecline: true,
    sendLink: 'application',
    notifyAgent: false,
  },

  AGENT_SOFT_HANDOVER: {
    id: 'AGENT_SOFT_HANDOVER',
    promptKey: 'agent_soft_handover_body',
    type: 'terminal',
    terminal: true,
    exitReason: 'declined_self_serve',
    softDecline: true,
    notifyAgent: true,
  },

  HUMAN_HANDOVER: {
    id: 'HUMAN_HANDOVER',
    promptKey: 'human_handover_body',
    type: 'terminal',
    terminal: true,
    exitReason: 'human_requested',
    softDecline: false,
    quiet: true,
    notifyAgent: true,
  },
};

const ENTRY_STATE = 'GREETING';

module.exports = {
  STATES,
  ENTRY_STATE,
};
