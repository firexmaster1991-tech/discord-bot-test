/**
 * Explicit 15-State PvP Combat State Machine for Mineflayer Bot.
 * 
 * 15 Distinct States:
 * - SEARCH: Locating target entity and analyzing terrain.
 * - APPROACH: Closing distance (> 3.5m) with forward sprint.
 * - OUTSPACE: Pacing at the edge of melee reach (2.4m - 2.9m) to hit without being hit.
 * - COMBO: Chained rapid attacks timed with opponent landing/recovery.
 * - CRIT_SETUP: Aligning position, vertical velocity, and ground contact before jump.
 * - CRIT_ATTACK: Executing falling critical strike (vy < -0.04).
 * - HIT_SELECT: Counter-striking immediately after opponent swing to take less knockback.
 * - JUMP_RESET: Micro-jump during incoming melee hit to damp horizontal knockback.
 * - P_CRIT: Counter-striking during descent from opponent-induced knockback airtime.
 * - REPOSITION: Lateral micro-step (100ms) to reset angle and spacing.
 * - HEAL: Consuming golden apple or splash health pot under healing lock.
 * - BUFF: Refreshing Strength / Speed potions in a safe micro-window.
 * - ESCAPE: Active obstacle/corner avoidance or Ender Pearl escape.
 * - FINISH: Relentless high pressure when opponent health is low (<= 7 HP).
 * - RECOVER: Post-knockback / post-landing stabilization with 0% sneak.
 */
class PvPCombatStateMachine {
  constructor(options = {}) {
    this.currentState = 'SEARCH';
    this.previousState = 'SEARCH';
    this.stateStartTime = Date.now();
    this.stateTimeoutMs = options.stateTimeoutMs || 3000; // 3s default timeout

    // Define state handlers
    this.states = [
      'SEARCH', 'APPROACH', 'OUTSPACE', 'COMBO', 'CRIT_SETUP', 'CRIT_ATTACK',
      'HIT_SELECT', 'JUMP_RESET', 'P_CRIT', 'REPOSITION', 'HEAL', 'BUFF',
      'ESCAPE', 'FINISH', 'RECOVER'
    ];

    this.debug = options.debug !== false;
  }

  getState() {
    return this.currentState;
  }

  transitionTo(newState, context = {}) {
    if (!this.states.includes(newState)) {
      console.warn(`[STATE_MACHINE] Unknown state: ${newState}`);
      return false;
    }

    if (this.currentState === newState && !context.force) {
      return false;
    }

    const now = Date.now();
    this.previousState = this.currentState;
    this.currentState = newState;
    this.stateStartTime = now;

    if (this.debug && context.logTransition !== false) {
      // console.log(`[STATE] ${this.previousState} -> ${this.currentState}`);
    }

    return true;
  }

  get STATES() {
    return PvPCombatStateMachine.STATES;
  }

  getCurrentState() {
    return this.getState();
  }

  evaluateWatchdog(target, dist, recoveryState = 'APPROACH') {
    return this.checkTimeout(recoveryState);
  }

  /**
   * Watchdog check ensuring no state permanently traps the bot.
   */
  checkTimeout(recoveryState = 'REPOSITION') {
    const elapsed = Date.now() - this.stateStartTime;
    if (elapsed > this.stateTimeoutMs && this.currentState !== 'SEARCH' && this.currentState !== 'APPROACH') {
      if (this.debug) console.warn(`⚠️ [STATE_TIMEOUT] State ${this.currentState} timed out after ${elapsed}ms! Resetting to ${recoveryState}.`);
      this.transitionTo(recoveryState, { force: true });
      return true;
    }
    return false;
  }
}

PvPCombatStateMachine.STATES = {
  SEARCH: 'SEARCH',
  APPROACH: 'APPROACH',
  OUTSPACE: 'OUTSPACE',
  COMBO: 'COMBO',
  CRIT_SETUP: 'CRIT_SETUP',
  CRIT_ATTACK: 'CRIT_ATTACK',
  HIT_SELECT: 'HIT_SELECT',
  JUMP_RESET: 'JUMP_RESET',
  P_CRIT: 'P_CRIT',
  REPOSITION: 'REPOSITION',
  HEAL: 'HEAL',
  BUFF: 'BUFF',
  ESCAPE: 'ESCAPE',
  FINISH: 'FINISH',
  RECOVER: 'RECOVER'
};

module.exports = PvPCombatStateMachine;
