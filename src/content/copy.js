'use strict';

/**
 * Customer-facing copy for interactive menu turns.
 * Body text is shown above WhatsApp reply buttons / list rows.
 * Button titles live in src/fsm/states.js (optionTitles) — keep bodies free of “reply 1/2/3”.
 *
 * Placeholders: {{APPLICATION_LINK}} {{STOCK_LINK}} {{FOOTER.help}} {{COPY.*}}
 */
module.exports = {
  help_footer:
    'Need a person? Type help anytime and we’ll connect you with the team.',

  greeting_prompt:
    'Welcome to our Volkswagen dealership WhatsApp assistant.\n\nHow can we help you today? Tap an option below.',

  special_info_body:
    'Current specials change often. A sales consultant can confirm what’s available on your preferred model and finance package.',

  special_info_continue: 'Ready to check if you may qualify for finance?',

  stock_list_body:
    'Browse our latest stock online. When you’re ready, continue to a quick finance pre-check.',

  stock_list_continue: 'Tap Continue to see if you may qualify.',

  stock_list_media_caption: 'Current stock',

  license_check_prompt:
    'Do you hold a valid South African driver’s licence?',

  no_license_advice:
    'Thanks for your honesty. A valid driver’s licence is required before we can continue with vehicle finance. Message us again when you have your licence and we’ll pick this up.',

  income_check_prompt:
    'What is your approximate gross monthly income?',

  affordability_decline_advice:
    'Based on what you shared, we may not be able to assist with finance right now. You’re welcome to message us again if your situation changes, or ask for help to speak to someone.',

  credit_check_prompt:
    'How would you describe your credit record?',

  credit_decline_advice:
    'Thank you for sharing. With a poor credit record we typically cannot proceed with a standard finance application. Type help if you’d like a consultant to advise on next steps.',

  confirm_qualify_prompt:
    'Great — you look like a fit for a self-serve application. Would you like the application link now?',

  qualified_link_body:
    'You’re pre-qualified to continue. Open your application here:\n{{APPLICATION_LINK}}\n\nA consultant can still help if you get stuck — just type help.',

  agent_soft_handover_body:
    'No problem. We’ve flagged this chat for a consultant who will follow up with you shortly.',

  human_handover_body:
    'Connecting you with a team member. Someone will reply in this chat as soon as they can. You can type restart later to use the menu again.',

  invalid_input_reprompt:
    'Please tap one of the options below (or type a matching answer).',

  session_restart_notice: 'Starting fresh — here’s the main menu.',

  quiet_thread_notice:
    'This chat is with our team right now. Type restart when you want the menu again.',

  follow_up_first:
    'Just checking in — still there? Tap an option below to continue.',

  follow_up_repeat:
    'We’re still here if you’d like to continue. Tap an option below, or type help for a person.',
};
