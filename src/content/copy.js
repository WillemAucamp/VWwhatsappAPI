'use strict';

/**
 * Customer-facing copy stubs.
 * Every key the FSM references lives here, blank until a human writes real content.
 * Do not put advice, sales language, or persuasive text in this file during the build.
 *
 * Placeholder convention in FSM prompts: {{COPY.key_name}}
 * Runtime also injects {{FOOTER.help}} and link placeholders from config.
 */
module.exports = {
  // Global footer appended by the engine on every bot turn
  help_footer: '',

  // GREETING
  greeting_prompt: '',

  // SPECIAL_INFO (advice/content — human-owned; leave blank)
  special_info_body: '',
  special_info_continue: '',

  // STOCK_LIST (stock media/link slot — human-owned; leave blank)
  stock_list_body: '',
  stock_list_continue: '',
  stock_list_media_caption: '',

  // LICENSE_CHECK
  license_check_prompt: '',

  // NO_LICENSE_ADVICE (terminal decline — advice placeholder only)
  no_license_advice: '',

  // INCOME_CHECK
  income_check_prompt: '',

  // AFFORDABILITY_DECLINE (terminal decline — advice placeholder only)
  affordability_decline_advice: '',

  // CREDIT_CHECK
  credit_check_prompt: '',

  // CREDIT_DECLINE (terminal decline — advice placeholder only)
  credit_decline_advice: '',

  // CONFIRM_QUALIFY
  confirm_qualify_prompt: '',

  // QUALIFIED_LINK (terminal — application link placeholder)
  qualified_link_body: '',

  // AGENT_SOFT_HANDOVER (terminal — declined self-serve)
  agent_soft_handover_body: '',

  // HUMAN_HANDOVER (global interrupt)
  human_handover_body: '',

  // Engine system messages (still stubbed; no advice)
  invalid_input_reprompt: '',
  session_restart_notice: '',
  quiet_thread_notice: '',

  // No-reply follow-ups (human-owned; blank until written)
  // Sent when the customer has not answered the last bot question.
  follow_up_first: '', // after FOLLOW_UP_FIRST_MS (default 30 min)
  follow_up_repeat: '', // each subsequent FOLLOW_UP_INTERVAL_MS (default 4 h)
};
