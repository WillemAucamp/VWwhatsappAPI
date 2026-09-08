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

  promotions_body: [
    'Promotions — content coming soon.',
    '',
    'Tap below to return to the main menu, or type *qualify me* to start pre-qualification.',
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
    'I see you need my help.',
    'Could you please summarise what you need and I will be with you ASAP!',
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
