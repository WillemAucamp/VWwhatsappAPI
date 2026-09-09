'use strict';

/**
 * VW Melrose FSM — from VW_Melrose_WhatsApp_Bot_Flow.pdf.
 *
 * Interactive menus (Cloud API):
 *   optionTitles  WhatsApp button / list row titles (≤20 chars for buttons)
 *   options       reply id (option key) → next state
 *   optionLabels  free-text fallback synonyms
 *
 * Greeting shows Qualify Me + I saw a special (See our cars temporarily hidden).
 * Opt-Out stays text-matchable. Stocklist state kept for later catalogue work.
 */

/** @type {Record<string, object>} */
const STATES = {
  GREETING: {
    id: 'GREETING',
    promptKey: 'greeting_prompt',
    type: 'choice',
    // No interactiveHeader — main menu should not show "VW Melrose" above the buttons.
    // WhatsApp allows max 3 reply buttons. Opt-Out stays text-matchable
    // ("opt out" / "unsubscribe") without forcing a list menu.
    // See our cars temporarily removed from the menu (catalogue work paused).
    // Routing + STOCKLIST_CAROUSEL remain so we can re-enable later without a rewrite.
    interactiveOptions: ['qualify_me', 'saw_special'],
    options: {
      qualify_me: 'EMPLOYED_INCOME_CHECK',
      saw_special: 'SPECIALS_MENU',
      promotions: 'SPECIALS_MENU',
      see_cars: 'STOCKLIST_CAROUSEL',
      opt_out: 'HUMAN_HANDOVER',
    },
    optionTitles: {
      qualify_me: 'Qualify Me',
      saw_special: 'I saw a special',
      promotions: 'I saw a special',
      see_cars: 'See our cars',
      opt_out: 'Opt-Out',
    },
    optionLabels: {
      qualify_me: ['qualify me', 'qualify', 'qualify_me', '1'],
      saw_special: [
        'i saw a special',
        'saw a special',
        'special',
        'specials',
        'saw_special',
        '2',
      ],
      promotions: ['promotions', 'promo'],
      // Not shown on the menu; kept for leftover old buttons / later re-enable.
      see_cars: ['see our cars', 'see cars', 'cars', 'stock', 'see_cars'],
      opt_out: ['opt-out', 'opt out', 'optout', 'unsubscribe', '3'],
    },
  },

  STOCKLIST_CAROUSEL: {
    id: 'STOCKLIST_CAROUSEL',
    promptKey: 'stocklist_body',
    // Shown when catalog is empty / Graph catalog fetch fails.
    fallbackPromptKey: 'stocklist_fallback_body',
    type: 'choice',
    interactiveHeader: 'Our cars',
    catalogSectionTitle: 'Available now',
    // Live Meta catalog product_list (see src/catalog/products.js).
    catalogProductList: true,
    // Fallback only when catalog products cannot be sent.
    sendLink: 'stock',
    mediaSlot: 'stock_list',
    options: {
      // Product inquiry / order maps here after storing selectedProductRetailerId.
      any_car: 'EMPLOYED_INCOME_CHECK',
    },
    optionTitles: {
      any_car: 'Check if I qualify',
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
        'check if i qualify',
        'qualify',
      ],
    },
  },

  SPECIALS_MENU: {
    id: 'SPECIALS_MENU',
    promptKey: 'specials_menu_prompt',
    type: 'choice',
    interactiveHeader: 'Specials',
    interactiveOptions: ['payment_holiday', 'lower_rate', 'discount'],
    options: {
      payment_holiday: 'PAYMENT_HOLIDAY_INFO',
      lower_rate: 'LOWER_RATE_INFO',
      discount: 'DISCOUNT_INFO',
    },
    optionTitles: {
      payment_holiday: 'Payment Holiday',
      lower_rate: 'Lower Interest Rate',
      discount: 'Discount',
    },
    optionLabels: {
      payment_holiday: [
        'payment holiday',
        'holiday',
        'payment_holiday',
        '1',
      ],
      lower_rate: [
        'lower interest rate',
        'lower rate',
        'interest',
        'lower_rate',
        '2',
      ],
      discount: [
        'discount',
        'deposit',
        'deposit assistance',
        '3',
      ],
    },
  },

  // Kept as an alias id for older sessions still pointing at PROMOTIONS.
  PROMOTIONS: {
    id: 'PROMOTIONS',
    promptKey: 'specials_menu_prompt',
    type: 'choice',
    interactiveHeader: 'Specials',
    interactiveOptions: ['payment_holiday', 'lower_rate', 'discount'],
    options: {
      payment_holiday: 'PAYMENT_HOLIDAY_INFO',
      lower_rate: 'LOWER_RATE_INFO',
      discount: 'DISCOUNT_INFO',
      back: 'GREETING',
    },
    optionTitles: {
      payment_holiday: 'Payment Holiday',
      lower_rate: 'Lower Interest Rate',
      discount: 'Discount',
      back: 'Main menu',
    },
    optionLabels: {
      payment_holiday: [
        'payment holiday',
        'holiday',
        'payment_holiday',
        '1',
      ],
      lower_rate: [
        'lower interest rate',
        'lower rate',
        'interest',
        'lower_rate',
        '2',
      ],
      discount: [
        'discount',
        'deposit',
        'deposit assistance',
        '3',
      ],
      back: ['back', 'main menu', 'menu'],
    },
  },

  PAYMENT_HOLIDAY_INFO: {
    id: 'PAYMENT_HOLIDAY_INFO',
    promptKey: 'payment_holiday_body',
    type: 'info',
    autoAdvanceTo: 'EMPLOYED_INCOME_CHECK',
  },

  LOWER_RATE_INFO: {
    id: 'LOWER_RATE_INFO',
    promptKey: 'lower_rate_body',
    type: 'info',
    autoAdvanceTo: 'EMPLOYED_INCOME_CHECK',
  },

  DISCOUNT_INFO: {
    id: 'DISCOUNT_INFO',
    promptKey: 'discount_body',
    type: 'info',
    autoAdvanceTo: 'EMPLOYED_INCOME_CHECK',
  },

  // Legacy: older sessions still on the removed consent step see the
  // employment+income question instead (same Yes/No buttons).
  QUALIFY_CONSENT: {
    id: 'QUALIFY_CONSENT',
    promptKey: 'employed_income_prompt',
    type: 'choice',
    interactiveHeader: 'Quick check',
    interactiveOptions: ['employed_income_yes', 'employed_income_no'],
    options: {
      employed_income_yes: 'LICENSE_CHECK',
      employed_income_no: 'END_CHAT_NOT_READY',
      consent_yes: 'LICENSE_CHECK',
      consent_no: 'END_CHAT_NOT_READY',
    },
    optionTitles: {
      employed_income_yes: 'Yes',
      employed_income_no: 'No',
      consent_yes: 'Yes',
      consent_no: 'No',
    },
    optionLabels: {
      employed_income_yes: ['yes', 'y', '1', 'employed_income_yes'],
      employed_income_no: ['no', 'n', '2', 'employed_income_no'],
      consent_yes: ['consent_yes'],
      consent_no: ['consent_no'],
    },
  },

  QUALIFY_CONSENT_NO: {
    id: 'QUALIFY_CONSENT_NO',
    promptKey: 'qualify_consent_no_prompt',
    type: 'choice',
    interactiveHeader: 'VW Melrose',
    interactiveOptions: ['human_handover', 'main_menu'],
    options: {
      human_handover: 'HUMAN_HANDOVER',
      main_menu: 'GREETING',
    },
    optionTitles: {
      human_handover: 'Human-Handover',
      main_menu: 'Main-Menu',
    },
    optionLabels: {
      human_handover: [
        'human-handover',
        'human handover',
        'handover',
        'human',
        'agent',
        'speak to me',
        'talk to me',
        '1',
      ],
      main_menu: [
        'main-menu',
        'main menu',
        'menu',
        'back',
        'start over',
        '2',
      ],
    },
  },

  EMPLOYED_INCOME_CHECK: {
    id: 'EMPLOYED_INCOME_CHECK',
    promptKey: 'employed_income_prompt',
    type: 'choice',
    interactiveHeader: 'Quick check',
    options: {
      employed_income_yes: 'LICENSE_CHECK',
      employed_income_no: 'END_CHAT_NOT_READY',
    },
    optionTitles: {
      employed_income_yes: 'Yes',
      employed_income_no: 'No',
    },
    optionLabels: {
      employed_income_yes: ['yes', 'y', '1', 'employed_income_yes'],
      employed_income_no: ['no', 'n', '2', 'employed_income_no'],
    },
  },

  END_CHAT_NOT_READY: {
    id: 'END_CHAT_NOT_READY',
    promptKey: 'not_ready_end',
    type: 'terminal',
    terminal: true,
    exitReason: 'not_ready_income_employment',
    softDecline: true,
    notifyAgent: false,
  },

  // Legacy aliases so older in-progress sessions can still resume after deploy.
  EMPLOYMENT_CHECK: {
    id: 'EMPLOYMENT_CHECK',
    promptKey: 'employed_income_prompt',
    type: 'choice',
    interactiveHeader: 'Quick check',
    interactiveOptions: ['employed_income_yes', 'employed_income_no'],
    options: {
      employed_income_yes: 'LICENSE_CHECK',
      employed_income_no: 'END_CHAT_NOT_READY',
      employed_yes: 'LICENSE_CHECK',
      employed_no: 'END_CHAT_NOT_READY',
      consent_yes: 'LICENSE_CHECK',
      consent_no: 'END_CHAT_NOT_READY',
    },
    optionTitles: {
      employed_income_yes: 'Yes',
      employed_income_no: 'No',
      employed_yes: 'Yes',
      employed_no: 'No',
      consent_yes: 'Yes',
      consent_no: 'No',
    },
    optionLabels: {
      employed_income_yes: ['yes', 'y', '1', 'employed_income_yes'],
      employed_income_no: ['no', 'n', '2', 'employed_income_no'],
      employed_yes: ['employed_yes'],
      employed_no: ['employed_no'],
      consent_yes: ['consent_yes'],
      consent_no: ['consent_no'],
    },
  },

  END_CHAT_EMPLOYED_NO: {
    id: 'END_CHAT_EMPLOYED_NO',
    promptKey: 'not_ready_end',
    type: 'terminal',
    terminal: true,
    exitReason: 'employed_no',
    softDecline: true,
    notifyAgent: false,
  },

  AFFORDABILITY_CHECK: {
    id: 'AFFORDABILITY_CHECK',
    promptKey: 'employed_income_prompt',
    type: 'choice',
    interactiveHeader: 'Quick check',
    interactiveOptions: ['employed_income_yes', 'employed_income_no'],
    options: {
      employed_income_yes: 'LICENSE_CHECK',
      employed_income_no: 'END_CHAT_NOT_READY',
      income_over_15k: 'LICENSE_CHECK',
      income_over_9k: 'LICENSE_CHECK',
      income_under_5k: 'END_CHAT_NOT_READY',
    },
    optionTitles: {
      employed_income_yes: 'Yes',
      employed_income_no: 'No',
      income_over_15k: 'Yes',
      income_over_9k: 'Yes',
      income_under_5k: 'No',
    },
    optionLabels: {
      employed_income_yes: ['yes', 'y', '1', 'employed_income_yes'],
      employed_income_no: ['no', 'n', '2', 'employed_income_no'],
      income_over_15k: ['income_over_15k', 'more than r15k'],
      income_over_9k: ['income_over_9k', 'more than r9k'],
      income_under_5k: ['income_under_5k', 'less than r5k'],
    },
  },

  END_CHAT_INCOME: {
    id: 'END_CHAT_INCOME',
    promptKey: 'not_ready_end',
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
    interactiveHeader: 'Licence',
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
    promptKey: 'license_no_plan',
    type: 'terminal',
    terminal: true,
    exitReason: 'no_license',
    softDecline: false,
    quiet: true,
    notifyAgent: true,
    agentTakeover: true,
  },

  CREDIT_CHECK: {
    id: 'CREDIT_CHECK',
    promptKey: 'credit_check_prompt',
    type: 'choice',
    interactiveHeader: 'Credit',
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
    promptKey: 'credit_bad_plan',
    type: 'terminal',
    terminal: true,
    exitReason: 'credit_bad',
    softDecline: false,
    quiet: true,
    notifyAgent: true,
    agentTakeover: true,
  },

  FINAL_CONSENT: {
    id: 'FINAL_CONSENT',
    promptKey: 'final_consent_prompt',
    type: 'choice',
    interactiveHeader: 'Next step',
    options: {
      consent_yes: 'SEND_LINK',
      consent_no: 'CONSENT_NO_HANDOVER',
    },
    optionTitles: {
      consent_yes: 'Yes, send it',
      consent_no: 'Not right now',
    },
    optionLabels: {
      consent_yes: [
        'yes',
        'y',
        '1',
        'yes, send it',
        'yes send it',
        'send it',
        'send it now',
        'yes send it now',
        'yes, send it now',
        'consent_yes',
        'send',
      ],
      consent_no: [
        'no',
        'n',
        '2',
        'not right now',
        'consent_no',
        'later',
        'not now',
      ],
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
    agentTakeover: true,
  },

  /**
   * Opt-out from a no-reply follow-up menu → soft close + manual (quiet) mode.
   */
  FOLLOW_UP_OPT_OUT: {
    id: 'FOLLOW_UP_OPT_OUT',
    promptKey: 'follow_up_opt_out_body',
    type: 'terminal',
    terminal: true,
    exitReason: 'opted_out',
    softDecline: true,
    quiet: true,
    notifyAgent: true,
    agentTakeover: true,
  },

  /**
   * Shown when the customer replies outside the buttons on any choice menu.
   * Main-Menu → GREETING; Human-Handover → quiet agent handoff.
   */
  OFF_MENU_RECOVERY: {
    id: 'OFF_MENU_RECOVERY',
    promptKey: 'off_menu_recovery_prompt',
    type: 'choice',
    interactiveOptions: ['human_handover', 'main_menu'],
    options: {
      human_handover: 'HUMAN_HANDOVER',
      main_menu: 'GREETING',
    },
    optionTitles: {
      human_handover: 'Human-Handover',
      main_menu: 'Main-Menu',
    },
    optionLabels: {
      human_handover: [
        'human-handover',
        'human handover',
        'handover',
        'human',
        'agent',
        'speak to me',
        'talk to me',
        '1',
      ],
      main_menu: [
        'main-menu',
        'main menu',
        'menu',
        'back',
        'start over',
        '2',
      ],
    },
  },
};

const ENTRY_STATE = 'GREETING';

module.exports = {
  STATES,
  ENTRY_STATE,
};
