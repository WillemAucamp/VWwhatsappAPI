'use strict';

/**
 * Drive Melrose FSM to FINAL_CONSENT (ready for consent_yes / consent_no).
 * @param {{ handleInbound: Function }} engine
 * @param {string} wa
 */
async function driveToFinalConsent(engine, wa) {
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  await engine.handleInbound(wa, 'yes'); // employed + income
  await engine.handleInbound(wa, 'yes'); // license_yes
  await engine.handleInbound(wa, 'good'); // credit_good
}

/**
 * Full qualify → SEND_LINK
 */
async function driveToSendLink(engine, wa) {
  await driveToFinalConsent(engine, wa);
  await engine.handleInbound(wa, 'yes'); // consent_yes
}

module.exports = {
  driveToFinalConsent,
  driveToSendLink,
};
