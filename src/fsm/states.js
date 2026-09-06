'use strict';

/**
 * VW Melrose FSM — from VW_Melrose_WhatsApp_Bot_Flow.pdf.
 *
 * Interactive menus (Cloud API):
 *   optionTitles  WhatsApp button / list row titles (≤20 chars for buttons)
 *   options       reply id (option key) → next state
 *   optionLabels  free-text fallback synonyms
 *
 * Greeting has 4 options → list message (reply buttons max out at 3).
 * Stocklist: any selection → employment_check (dynamic car_id list TBD;
 *   Continue stands in until live vehicle rows are wired).
 */

/** @type {Record<string, object>} */
const STATES = {
  GREETING: {
    id: 'GREETING',
    promptKey: 'greeting_prompt',
    type: 'choice',
    options: {
      see_cars: 'STOCKLIST_CAROUSEL',
      qualify_me: 'EMPLOYMENT_CHECK',
      promotions: 'PROMOTIONS',
      opt_out: 'HUMAN_HANDOVER',
    },
    optionTitles: {
      see_cars: 'See our cars',
      qualify_me: 'Qualify Me',
      promotions: 'Promotions',
      opt_out: 'Opt-Out',
    },
    optionLabels: {
      see_cars: ['see our cars', 'cars', 'stock', 'see_cars', '1'],
      qualify_me: ['qualify me', 'qualify', 'qualify_me', '2'],
      promotions: ['promotions', 'specials', 'promo', '3'],
      opt_out: ['opt-out', 'opt out', 'optout', 'unsubscribe', '4'],
    },
  },

  STOCKLIST_CAROUSEL: {
    id: 'STOCKLIST_CAROUSEL',
    promptKey: 'stocklist_body',
    type: 'choice',
    sendLink: 'stock',
    mediaSlot: 'stock_list',
    // PDF: any car_id → employment_check. Until dynamic stock is wired,
    // Continue (and future car_* ids) all route there.
    options: {
      any_car: 'EMPLOYMENT_CHECK',
    },
    optionTitles: {
      any_car: 'Continue',
    },
    optionLabels: {
      any_car: [
        'continue',
        'ok',
        'yes',
        'next',
        '1',
        'any_car',
        'select',
      ],
    },
  },

  PROMOTIONS: {
    id: 'PROMOTIONS',
    promptKey: 'promotions_body',
    type: 'choice',
    options: {
      back: 'GREETING',
    },
    optionTitles: {
      back: 'Main menu',
    },
    optionLabels: {
      back: ['back', 'main menu', 'menu', '1'],
    },
  },

  EMPLOYMENT_CHECK: {
    id: 'EMPLOYMENT_CHECK',
    promptKey: 'employment_check_prompt',
    type: 'choice',
    options: {
      employed_yes: 'AFFORDABILITY_CHECK',
      employed_no: 'END_CHAT_EMPLOYED_NO',
    },
    optionTitles: {
      employed_yes: 'Yes',
      employed_no: 'No',
    },
    optionLabels: {
      employed_yes: ['yes', 'y', '1', 'employed_yes', 'employed'],
      employed_no: ['no', 'n', '2', 'employed_no'],
    },
  },

  END_CHAT_EMPLOYED_NO: {
    id: 'END_CHAT_EMPLOYED_NO',
    promptKey: 'employed_no_end',
    type: 'terminal',
    terminal: true,
    exitReason: 'employed_no',
    softDecline: true,
    notifyAgent: false,
  },

  AFFORDABILITY_CHECK: {
    id: 'AFFORDABILITY_CHECK',
    promptKey: 'affordability_check_prompt',
    type: 'choice',
    options: {
      income_over_15k: 'LICENSE_CHECK',
      income_over_9k: 'LICENSE_CHECK',
      income_under_5k: 'END_CHAT_INCOME',
    },
    optionTitles: {
      income_over_15k: 'More than R15k',
      income_over_9k: 'More than R9k',
      income_under_5k: 'Less than R5k',
    },
    optionLabels: {
      income_over_15k: [
        'more than r15k',
        'over 15k',
        'above 15k',
        'income_over_15k',
        '1',
      ],
      income_over_9k: [
        'more than r9k',
        'over 9k',
        'above 9k',
        'income_over_9k',
        '2',
      ],
      income_under_5k: [
        'less than r5k',
        'under 5k',
        'below 5k',
        'income_under_5k',
        '3',
      ],
    },
  },

  END_CHAT_INCOME: {
    id: 'END_CHAT_INCOME',
    promptKey: 'income_under_5k_end',
    type: 'terminal',
    terminal: true,
    exitReason: 'income_under_5k',
    softDecline: true,
    notifyAgent: false,
  },

  LICENSE_CHECK: {
    id: 'LICENSE_CHECK',
    promptKey: 'license_check_prompt',
    type: 'choice',
    options: {
      license_yes: 'CREDIT_CHECK',
      license_no: 'LICENSE_NO_HANDOVER',
    },
    optionTitles: {
      license_yes: 'Yes',
      license_no: 'No',
    },
    optionLabels: {
      license_yes: ['yes', 'y', '1', 'license_yes'],
      license_no: ['no', 'n', '2', 'license_no'],
    },
  },

  LICENSE_NO_HANDOVER: {
    id: 'LICENSE_NO_HANDOVER',
    promptKey: 'human_handover_body',
    type: 'terminal',
    terminal: true,
    exitReason: 'no_license',
    softDecline: false,
    quiet: true,
    notifyAgent: true,
  },

  CREDIT_CHECK: {
    id: 'CREDIT_CHECK',
    promptKey: 'credit_check_prompt',
    type: 'choice',
    options: {
      credit_good: 'FINAL_CONSENT',
      credit_bad: 'CREDIT_BAD_HANDOVER',
    },
    optionTitles: {
      credit_good: 'Good',
      credit_bad: 'Bad',
    },
    optionLabels: {
      credit_good: ['good', 'great', 'excellent', '1', 'credit_good'],
      credit_bad: ['bad', 'poor', '2', 'credit_bad'],
    },
  },

  CREDIT_BAD_HANDOVER: {
    id: 'CREDIT_BAD_HANDOVER',
    promptKey: 'human_handover_body',
    type: 'terminal',
    terminal: true,
    exitReason: 'credit_bad',
    softDecline: false,
    quiet: true,
    notifyAgent: true,
  },

  FINAL_CONSENT: {
    id: 'FINAL_CONSENT',
    promptKey: 'final_consent_prompt',
    type: 'choice',
    options: {
      consent_yes: 'SEND_LINK',
      consent_no: 'CONSENT_NO_HANDOVER',
    },
    optionTitles: {
      consent_yes: 'Yes, send it',
      consent_no: 'Not right now',
    },
    optionLabels: {
      consent_yes: ['yes', 'y', '1', 'yes, send it', 'consent_yes', 'send'],
      consent_no: ['no', 'n', '2', 'not right now', 'consent_no'],
    },
  },

  SEND_LINK: {
    id: 'SEND_LINK',
    promptKey: 'send_link_body',
    type: 'terminal',
    terminal: true,
    exitReason: 'qualified_self_serve',
    softDecline: true,
    sendLink: 'application',
    notifyAgent: false,
  },

  CONSENT_NO_HANDOVER: {
    id: 'CONSENT_NO_HANDOVER',
    promptKey: 'human_handover_body',
    type: 'terminal',
    terminal: true,
    exitReason: 'declined_self_serve',
    softDecline: false,
    quiet: true,
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
