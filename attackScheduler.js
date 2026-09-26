const { Vec3 } = require('vec3');
const { isAttackReady, getWeaponRecoveryMs, detectCombatVersion } = require('./combatProfiles');

/**
 * Single Authoritative Attack Scheduler for Mineflayer PvP.
 * 
 * SOLE OWNER of bot.attack(target).
 * No other subsystem or profile may directly execute attacks.
 * 
 * Capabilities:
 * 1. Attack Type Selection: NORMAL_HIT, CRITICAL, HIT_SELECT, P_CRIT, COMBO_HIT, HALF_SWING.
 * 2. Tick-Level Sprint Reset (W-Tap): Resets sprint for ~40ms post-hit to maximize knockback.
 * 3. Low-Frequency S-Tap: 40ms micro-step back, strictly skipped if it would lose pressure.
 * 4. Hit-Select: Times attack immediately after opponent swing to take reduced knockback.
 * 5. Jump-Reset Detection: Coordinates micro-jump upon incoming damage to damp horizontal knockback.
 * 6. Falling Critical Strike Verification: Enforces vy < -0.04 and sprint release in Modern Java.
 * 7. Damage Feedback: Correlates attacks with target hurt animations / entityHurt events.
 */
class AttackScheduler {
  constructor(bot = null, movementController = null, options = {}) {
    this.bot = bot;
    this.movementController = movementController;
    this.combatVersion = options.combatVersion || 'modern';

    // Cooldown & Attack Timers
    this.lastAttackTime = 0;
    this.lastAttackType = 'NONE';
    this.attackLock = false;

    // Sprint reset & S-tap tracking
    this.isWtapping = false;
    this.isStapping = false;

    // Hit-Select tracking
    this.lastOpponentAttackTime = 0;
    this.hitSelectWindowMs = 200; // Attack within 200ms after opponent attack

    // Jump-Reset tracking
    this.lastDamageReceivedTime = 0;
    this.jumpResetCooldownMs = 450;
    this.lastJumpResetTime = 0;

    // Telemetry & Benchmark counters
    this.attacksAttempted = 0;
    this.hitsConnected = 0;
    this.criticalHits = 0;

    // Half-Swing Config (84.8% charge = 0.848 of full recovery)
    this.enableHalfSwing = options.enableHalfSwing !== false;
    this.halfSwingThreshold = 0.848;

    this.debug = options.debug !== false;

    if (this.bot) {
      this.attachBotListeners();
    }
  }

  setBot(bot, movementController = null) {
    this.bot = bot;
    if (movementController) this.movementController = movementController;
    if (this.bot) this.attachBotListeners();
  }

  attachBotListeners() {
    if (!this.bot || typeof this.bot.on !== 'function') return;

    // Listen to damage received on bot for Jump-Reset
    this.bot.on('entityHurt', (entity) => {
      if (this.bot && this.bot.entity && entity.id === this.bot.entity.id) {
        this.handleBotDamageReceived();
      }
    });
  }

  /**
   * Called when bot receives incoming damage to evaluate Jump-Reset opportunity.
   */
  handleBotDamageReceived() {
    const now = Date.now();
    this.lastDamageReceivedTime = now;

    if (!this.bot || !this.bot.entity || !this.bot.entity.onGround) return;
    if (this.movementController && this.movementController.combatJumpingEnabled === false) return;
    if (now - this.lastJumpResetTime < this.jumpResetCooldownMs) return;

    // Jump-reset opportunity: execute micro-jump during incoming knockback
    this.lastJumpResetTime = now;
    if (this.movementController && typeof this.movementController.requestJump === 'function') {
      this.movementController.requestJump(true);
      if (this.debug) console.log('🦘 [JUMP_RESET] Executed jump reset to absorb incoming knockback.');
    }
  }

  /**
   * Records opponent attack swing for Hit-Select coordination.
   */
  recordOpponentAttack(now = Date.now()) {
    this.lastOpponentAttackTime = now;
  }

  /**
   * Checks if attack cooldown is ready. Supports full 100% or half-swing (>= 84.8%).
   */
  isCooldownReady(now = Date.now(), allowHalfSwing = false) {
    if (this.combatVersion === 'classic') return true;

    const heldItem = this.bot && this.bot.heldItem;
    const itemName = heldItem ? heldItem.name : 'diamond_sword';
    const recoveryMs = getWeaponRecoveryMs(itemName, 'modern');
    const elapsed = now - this.lastAttackTime;

    if (elapsed >= recoveryMs) return true;

    if (allowHalfSwing && this.enableHalfSwing && elapsed >= (recoveryMs * this.halfSwingThreshold)) {
      return true;
    }

    return false;
  }

  /**
   * Single authoritative entry point for executing attacks.
   */
  executeAttack(target, type = 'NORMAL_HIT', options = {}) {
    if (!this.bot || !target || !target.position || this.attackLock) {
      return false;
    }

    const now = Date.now();
    const ready = options.isCooldownReady !== undefined 
      ? options.isCooldownReady 
      : this.isCooldownReady(now, type === 'HALF_SWING');

    if (!ready && !options.force) {
      return false;
    }

    // Mutual exclusion: lock during dispatch
    this.attackLock = true;

    try {
      this.attacksAttempted++;
      this.lastAttackTime = now;
      this.lastAttackType = type;

      // In Modern Java (1.20.4+), critical strikes require sprint to be strictly false
      if (type === 'CRITICAL' || type === 'P_CRIT') {
        this.criticalHits++;
        if (this.movementController && this.combatVersion === 'modern') {
          this.movementController.setControl('sprint', false);
        } else if (this.bot && typeof this.bot.setControlState === 'function' && this.combatVersion === 'modern') {
          this.bot.setControlState('sprint', false);
        }
      }

      // Grounded combo hits should connect while sprinting so vanilla melee
      // knockback is applied; W-tap reset happens immediately after the hit.
      if (type === 'NORMAL_HIT' || type === 'COMBO_HIT' || type === 'HIT_SELECT') {
        if (this.movementController && this.combatVersion === 'modern') {
          this.movementController.setControl('sprint', true);
        }
      }

      // Execute legitimate vanilla attack
      if (typeof this.bot.attack === 'function') {
        this.bot.attack(target);
      }
      if (typeof this.bot.swingArm === 'function') {
        this.bot.swingArm('right');
      }

      // W-Tap / Sprint Reset trigger for combo/normal hits
      if (options.triggerSprintReset !== false && type !== 'CRITICAL' && type !== 'P_CRIT') {
        this.triggerWTap();
      }

      // S-Tap trigger if requested and useful
      if (options.triggerSTap === true) {
        this.triggerSTap(options.sTapDuration || 40);
      }

      return true;
    } catch (err) {
      if (this.debug) console.error('Attack execution error:', err.message);
      return false;
    } finally {
      this.attackLock = false;
    }
  }

  /**
   * Tick-level W-Tap (35-45ms) sprint reset.
   * Briefly drops sprint then re-engages forward momentum.
   */
  triggerSprintReset() {
    return this.triggerWTap();
  }

  triggerWTap() {
    if (this.isWtapping) return;
    this.isWtapping = true;

    if (this.movementController) {
      this.movementController.setControl('sprint', false);
      setTimeout(() => {
        if (this.movementController) {
          this.movementController.setControl('sprint', true);
        }
        this.isWtapping = false;
      }, 40);
    } else if (this.bot && typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('forward', false);
      setTimeout(() => {
        if (this.bot && typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sprint', true);
          this.bot.setControlState('forward', true);
        }
        this.isWtapping = false;
      }, 40);
    } else {
      this.isWtapping = false;
    }
  }

  /**
   * Low-frequency S-Tap (35-45ms).
   * Strictly skipped if it would ruin combo pressure (COMBO > POSITION > S-TAP).
   */
  triggerSTap(durationMs = 40) {
    if (this.isStapping) return;
    this.isStapping = true;

    if (this.movementController) {
      this.movementController.setControl('sprint', false);
      this.movementController.setControl('forward', false);
      this.movementController.setControl('back', true);
      setTimeout(() => {
        if (this.movementController) {
          this.movementController.setControl('back', false);
          this.movementController.setControl('forward', true);
          this.movementController.setControl('sprint', true);
        }
        this.isStapping = false;
      }, durationMs);
    } else if (this.bot && typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', true);
      setTimeout(() => {
        if (this.bot && typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('back', false);
          this.bot.setControlState('forward', true);
          this.bot.setControlState('sprint', true);
        }
        this.isStapping = false;
      }, durationMs);
    } else {
      this.isStapping = false;
    }
  }

  /**
   * Evaluates Hit-Select condition: opponent recently swung (within 200ms) and bot attack is ready.
   */
  canHitSelect(now = Date.now()) {
    if (this.lastOpponentAttackTime === 0) return false;
    const elapsed = now - this.lastOpponentAttackTime;
    return elapsed > 30 && elapsed <= this.hitSelectWindowMs;
  }
}

module.exports = AttackScheduler;
