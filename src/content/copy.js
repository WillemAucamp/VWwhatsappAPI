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
    'Browse the cars below, tap one you like, then tap *Message business about this item* so we can continue with a quick finance check.',
  ].join('\n'),

  stocklist_fallback_body: [
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

  // Dead prompts kept so older sessions / health copy counts stay stable.
  // Qualify Me no longer routes here — see EMPLOYED_INCOME_CHECK.
  employment_check_prompt: [
    'First up: Are you currently employed full-time, and is your monthly income above R9,500?',
  ].join('\n'),

  qualify_consent_prompt: [
    'First up: Are you currently employed full-time, and is your monthly income above R9,500?',
  ].join('\n'),

  qualify_consent_no_prompt: [
    'No problem at all.',
    '',
    'Would you like to talk to me directly, or should I take you back to the main menu?',
  ].join('\n'),

  employed_income_prompt: [
    'First up: Are you currently employed full-time, and is your monthly income above R9,500?',
  ].join('\n'),

  not_ready_end: [
    "Ah, unfortunately we wouldn't be able to move forward just yet, but the good news is you can definitely build towards it to get your dream car!",
    '',
    "Here's a quick look at what the banks require:",
    '',
    '*Permanently Employed:* Minimum *R9,500* net income into your account monthly.',
    '',
    '*Self-Employed:* Average monthly earnings of around *R25,000*.',
    '',
    "*Starting a New Role?* You don't have to wait! As long as it's a permanent position, you can apply right away using your signed employment contract.",
    '',
    "Keep pushing and working hard—you've got this, and we'd love to help you as soon as you hit that mark!",
  ].join('\n'),

  employed_no_end: [
    "Ah, unfortunately we wouldn't be able to move forward just yet, but the good news is you can definitely build towards it to get your dream car!",
    '',
    "Here's a quick look at what the banks require:",
    '',
    '*Permanently Employed:* Minimum *R9,500* net income into your account monthly.',
    '',
    '*Self-Employed:* Average monthly earnings of around *R25,000*.',
    '',
    "*Starting a New Role?* You don't have to wait! As long as it's a permanent position, you can apply right away using your signed employment contract.",
    '',
    "Keep pushing and working hard—you've got this, and we'd love to help you as soon as you hit that mark!",
  ].join('\n'),

  affordability_check_prompt: [
    'First up: Are you currently employed full-time, and is your monthly income above R9,500?',
  ].join('\n'),

  income_under_5k_end: [
    "Ah, unfortunately we wouldn't be able to move forward just yet, but the good news is you can definitely build towards it to get your dream car!",
    '',
    "Here's a quick look at what the banks require:",
    '',
    '*Permanently Employed:* Minimum *R9,500* net income into your account monthly.',
    '',
    '*Self-Employed:* Average monthly earnings of around *R25,000*.',
    '',
    "*Starting a New Role?* You don't have to wait! As long as it's a permanent position, you can apply right away using your signed employment contract.",
    '',
    "Keep pushing and working hard—you've got this, and we'd love to help you as soon as you hit that mark!",
  ].join('\n'),

  license_check_prompt: [
    'Almost done.',
    '',
    "Do you hold a valid driver's license?",
  ].join('\n'),

  license_no_plan: [
    "Unfortunately a license is a must for vehicle finance — the only times you can use someone else's license would be for the following reasons:",
    '',
    "1) A medical reason why you can't have a license, with a letter from a specialist",
    '2) If you are married in community of property, you can use your spouse\'s license',
    '3) You can use a parent\'s license should you live in the same house with the same surname and the same proof of address',
    '',
    'Even with the above mentioned reasons the deal might be declined, as only one bank is willing to consider these.',
  ].join('\n'),

  credit_check_prompt: [
    'One final question.',
    '',
    'How would you describe your credit standing?',
  ].join('\n'),

  credit_bad_plan: [
    'Here is the quick plan to get your score where it needs to be:',
    '',
    '*What to do:*',
    '',
    '*Settle any arrears:* Pay off any outstanding balances.',
    '',
    '*Build a track record:* Maintain consistent payments for 3–6 months. If you lack credit history, open a store account (like clothing) and pay it on time.',
    '',
    "*Track progress:* Sign up for ClearScore (it's 100% free) for monthly score updates.",
    '',
    '*What NOT to do:*',
    '',
    "Don't take out personal or micro loans.",
    '',
    "Don't apply for more vehicle finance for now.",
    "(Note: Cellphone/internet bills don't build credit for vehicle finance).",
    '',
    "I've saved your details! Save my number and feel free to reach out anytime with questions 💪🏼",
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
    'Click on the link below to see what you qualify for, calculate your estimated repayments, and explore the best current specials for you:',
    '',
    '👉 https://forms.gle/eZq13HF91GpGqivU9',
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

  session_resume_notice: 'Welcome back — let’s pick up where we left off.',

  quiet_thread_notice:
    'This chat is with our team right now. Type *restart* when you want the menu again.',

  follow_up_first:
    'Just checking in — still there? Tap a button below to continue.',

  follow_up_repeat:
    "We're still here if you'd like to continue. Tap a button below, or type *help* for a person.",
};
