'use strict';

/**
 * VW Melrose WhatsApp bot — customer copy from
 * VW_Melrose_WhatsApp_Bot_Flow.pdf (wording preserved, spacing tuned for WhatsApp).
 *
 * Button titles live in src/fsm/states.js (optionTitles).
 * Placeholders: {{APPLICATION_LINK}} {{STOCK_LINK}}
 */
module.exports = {
  greeting_prompt: [
    'Hello',
    '',
    'This is *Willem Aucamp* from *VW Melrose*.',
    'I work alongside Migael.',
    '',
    "I'll ask a few quick questions — about 5 minutes.",
    "If you get stuck, I'm watching closely and I'll step in.",
    '',
    'You may opt out at any time.',
    '',
    'What can I help you with?',
  ].join('\n'),

  stocklist_body: [
    'Here is our current stock.',
    '',
    'Browse the link below, then tap to continue with a quick finance check.',
  ].join('\n'),

  specials_menu_prompt: [
    'Great — which special caught your eye?',
    '',
    'Tap an option below and I’ll explain it, then we’ll do a quick finance check.',
  ].join('\n'),

  payment_holiday_body: [
    'With our Payment Holiday promotion, we provide a helpful financial allowance toward your new car to give you a head start!',
    '',
    "Since every car has a unique allowance and bank installments depend on your personal financing plan, we take your car's total allowance and divide it by your monthly installment to see how many months we can cover.",
    '',
    'For instance, if your car comes with a *R15,000* allowance and your installment is *R5,000* per month, we’ll take care of your first *3 payments* so you can enjoy your new ride worry-free!',
  ].join('\n'),

  lower_rate_body: [
    'Every car comes with a dedicated assistance allowance—a lump sum of money we can use to make your deal much more affordable!',
    '',
    'With our *Lower Interest Rate Promotion*, we use that allowance to buy down your interest rate directly with the bank. This drops your monthly repayment and saves you serious money on total interest over time.',
    '',
    '*Just a quick note:* The bank sets your starting interest rate based on your credit history. We don’t set the rate ourselves—we just use your car’s allowance to lower whatever rate the bank gives you!',
  ].join('\n'),

  discount_body: [
    'Every car comes with a dedicated assistance allowance—a lump sum of money we can use to make your new ride even more affordable!',
    '',
    'With our Deposit Assistance Special, we apply that allowance directly as a cash deposit on your behalf. This knocks down the total purchase price right away, giving you lower monthly repayments and helping you owe less overall!',
  ].join('\n'),

  promotions_body: [
    'Great — which special caught your eye?',
    '',
    'Tap an option below and I’ll explain it, then we’ll do a quick finance check.',
  ].join('\n'),

  employment_check_prompt: [
    'Good choice.',
    '',
    'A few background questions first.',
    'Are you currently employed?',
  ].join('\n'),

  employed_no_end: [
    'Understood.',
    '',
    'Our finance partners require proof of steady income.',
    "I'm unable to proceed today.",
    '',
    'Please reach out again once this changes.',
    'Thank you for your time.',
  ].join('\n'),

  affordability_check_prompt: [
    'Thank you.',
    '',
    'What is your approximate monthly income?',
  ].join('\n'),

  income_under_5k_end: [
    'Thank you for the honest answer.',
    '',
    "Based on this, finance approval isn't possible on our current stock.",
    'Please check back in future.',
    '',
    'Thank you for your time.',
  ].join('\n'),

  license_check_prompt: [
    'Almost done.',
    '',
    "Do you hold a valid driver's license?",
  ].join('\n'),

  credit_check_prompt: [
    'One final question.',
    '',
    'How would you describe your credit standing?',
  ].join('\n'),

  final_consent_prompt: [
    "You're in a strong position to proceed.",
    '',
    'Next step: a short application form.',
    "It only asks for what's needed.",
    '',
    'Shall I send it?',
  ].join('\n'),

  send_link_body: [
    'Here is the link:',
    '{{APPLICATION_LINK}}',
    '',
    'Complete it at your convenience.',
    "I'll review it personally.",
  ].join('\n'),

  human_handover_body: [
    "I've got you — I'm taking over from here.",
    '',
    'Please share a short summary of what you need, and I\'ll be with you as soon as I can.',
  ].join('\n'),

  off_menu_recovery_prompt: [
    "Hi I see you haven't chosen an option on the menu?",
    'Do you want to talk to me directly, or should I take you back to the main menu?',
    '',
    '(Remember you can *Opt-Out* at any time)',
  ].join('\n'),

  invalid_input_reprompt:
    'Please tap one of the buttons below (or type a matching answer).',

  session_restart_notice: 'Starting fresh — here’s the main menu.',

  quiet_thread_notice:
    'This chat is with our team right now. Type *restart* when you want the menu again.',

  follow_up_first:
    'Just checking in — still there? Tap a button below to continue.',

  follow_up_repeat:
    "We're still here if you'd like to continue. Tap a button below, or type *help* for a person.",
};
