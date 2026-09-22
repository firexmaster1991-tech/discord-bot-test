/**
 * Base Combat Profile defining standard interface and lifecycle for all gamemode profiles.
 */
class BaseCombatProfile {
  constructor(name, context = {}) {
    this.name = name;
    this.bot = context.bot || null;
    this.movementController = context.movementController || null;
    this.distanceController = context.distanceController || null;
    this.attackScheduler = context.attackScheduler || null;
    this.potionManager = context.potionManager || null;
    this.opponentModel = context.opponentModel || null;
    this.stateMachine = context.stateMachine || null;
    this.benchmark = context.benchmark || null;
    this.layoutManager = context.layoutManager || null;

    // Tactical parameters
    this.idealMinRange = 1.8;
    this.idealMaxRange = 2.85;
    this.chaseDistance = 3.5;
    this.allowJumpCrits = true;
    this.jumpCritOnlyWhileFalling = true;
    this.healThresholdHP = 10;

    // Watchdog & Failsafe Timers
    this.lastActionTime = Date.now();
    this.lastMeaningfulActionTime = Date.now();
    this.lastActionName = 'NONE';
    this.stuckTimeoutMs = 2500; // 2.5s without meaningful action -> PROFILE_STUCK
    this.stuckTicks = 0;
    this.currentState = 'SEARCH';
    this.state = 'SEARCH';
    this.lastMovementState = 'IDLE';
    this.lastAttackType = 'NONE';
    this.lastFailureStage = null;
    this.failureHistory = [];
    this.target = null;
  }

  setTarget(target) {
    this.target = target;
  }

  setContext(context) {
    if (context.bot) this.bot = context.bot;
    if (context.movementController) this.movementController = context.movementController;
    if (context.distanceController) this.distanceController = context.distanceController;
    if (context.attackScheduler) this.attackScheduler = context.attackScheduler;
    if (context.potionManager) this.potionManager = context.potionManager;
    if (context.opponentModel) this.opponentModel = context.opponentModel;
    if (context.stateMachine) this.stateMachine = context.stateMachine;
    if (context.benchmark) this.benchmark = context.benchmark;
    if (context.layoutManager) this.layoutManager = context.layoutManager;
  }

  /**
   * Preflight health check before combat begins.
   * Overridden by child profiles to verify profile-specific items and systems.
   */
  async preflight() {
    const checks = {
      targetTracker: Boolean(this.opponentModel || (this.bot && this.bot.entities)),
      movementController: Boolean(this.movementController || (this.bot && typeof this.bot.setControlState === 'function')),
      attackSystem: Boolean(this.attackScheduler || (this.bot && typeof this.bot.attack === 'function'))
    };

    const missing = Object.entries(checks).filter(([_, ok]) => !ok).map(([k]) => k);
    const success = missing.length === 0;

    return {
      success,
      profile: this.name,
      missing,
      reason: success ? 'All baseline systems ready' : `Baseline systems unavailable: ${missing.join(', ')}`
    };
  }

  /**
   * Records that a meaningful combat action took place.
   */
  recordMeaningfulAction(actionName) {
    this.lastActionTime = Date.now();
    this.lastMeaningfulActionTime = Date.now();
    this.lastActionName = actionName || this.currentState;
    this.currentState = actionName || this.currentState;
    this.state = this.currentState;
    this.stuckTicks = 0;
  }

  /**
   * Profile Stuck Watchdog:
   * Ensures the bot never stands idle during combat.
   */
  checkStuckWatchdog(target = null, now = Date.now()) {
    if (target) this.target = target;
    this.stuckTicks++;
    const elapsed = now - this.lastMeaningfulActionTime;
    if (elapsed > this.stuckTimeoutMs || this.stuckTicks >= 30) {
      this.triggerProfileStuck(target, elapsed);
      return true;
    }
    return false;
  }

  /**
   * Handles stuck event: logs debug info and recovers movement.
   */
  triggerProfileStuck(target, elapsedMs) {
    const debug = this.getDebugStatus(target);
    console.warn(`⚠️ [PROFILE_STUCK] Profile ${this.name} stuck in state ${this.currentState} for ${elapsedMs}ms (stuckTicks: ${this.stuckTicks})!`);
    this.recoverFromStuck(target);
  }

  /**
   * Resets active action lock, restores movement, and resumes approach.
   */
  recoverFromStuck(target) {
    this.lastMeaningfulActionTime = Date.now();
    this.currentState = 'SEARCH';
    this.state = 'SEARCH';
    this.stuckTicks = 0;

    if (this.movementController) {
      this.movementController.clearAllControls();
      this.movementController.setState('APPROACH');
      this.movementController.setControl('forward', true);
      this.movementController.setControl('sprint', true);
    }
  }

  /**
   * Generates comprehensive debug status object for Section 35.
   */
  getDebugStatus(target = null) {
    const activeTarget = target || this.target;
    const dist = (this.bot && this.bot.entity && activeTarget && activeTarget.position)
      ? Number(this.bot.entity.position.distanceTo(activeTarget.position).toFixed(2))
      : null;

    const currentWeapon = this.bot && this.bot.heldItem ? this.bot.heldItem.name : 'empty';
    const movementState = this.movementController ? this.movementController.getState() : 'UNKNOWN';
    const attackReady = this.attackScheduler ? this.attackScheduler.isCooldownReady(Date.now()) : false;
    const now = Date.now();

    return {
      profile: this.name,
      currentState: this.currentState || this.state || 'IDLE',
      state: this.currentState || this.state || 'IDLE',
      lastAction: this.lastActionName || this.currentState,
      lastActionAgeMs: this.lastActionTime > 0 ? (now - this.lastActionTime) : null,
      currentTarget: activeTarget ? (activeTarget.username || activeTarget.name || 'target') : null,
      target: activeTarget ? (activeTarget.username || activeTarget.name || 'target') : 'none',
      distance: dist,
      targetDistance: dist,
      currentWeapon,
      currentItem: currentWeapon,
      movementState,
      action: this.currentState,
      stuckCount: this.stuckTicks || 0,
      recentFailuresCount: this.failureHistory ? this.failureHistory.length : 0,
      inventoryReady: true,
      requiredItemsMissing: [],
      attackReady,
      critState: this.critSequence || 'GROUND',
      lastFailureStage: this.lastFailureStage
    };
  }

  /**
   * Reports exact failure stage.
   */
  reportFailure(stage, reason) {
    this.lastFailureStage = stage;
    const failureEvent = {
      stage,
      message: String(reason || ''),
      time: Date.now()
    };
    if (!this.failureHistory) this.failureHistory = [];
    this.failureHistory.push(failureEvent);
    if (this.failureHistory.length > 20) this.failureHistory.shift();
    console.error(`❌ [${this.name}_FAILURE] ${this.name} FAILED AT: ${stage} (${reason})`);
    return `${this.name} FAILED AT: ${stage}`;
  }

  decideMovementState(dist, health, target, options = {}) {
    if (health != null && health <= this.healThresholdHP && options.hasPotionsToHeal !== false && !options.outOfPotions) {
      if (dist < 3.2) return 'RETREAT';
      return 'DISENGAGE';
    }

    if (dist > this.chaseDistance) return 'CHASE';
    if (dist > this.idealMaxRange) return 'APPROACH';

    if (dist >= this.idealMinRange) {
      if (options.combatPhase === 'CRIT' && this.allowJumpCrits) {
        return 'CRITICAL_SETUP';
      }
      return 'OUTSPACING';
    }

    return 'OVERLAP_ESCAPE';
  }

  startCombat(target) {
    this.recordMeaningfulAction('START');
  }

  update(target, dist, currentHealth, targetHealth, isCooldownReady, now) {}

  stopCombat() {
    this.currentState = 'IDLE';
  }

  onError(err) {
    console.error(`[PROFILE_ERROR] ${this.name} error:`, err.message);
    if (this.movementController) {
      this.movementController.setState('REPOSITION');
    }
  }
}

module.exports = BaseCombatProfile;
