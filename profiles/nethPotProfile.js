const BaseCombatProfile = require('./baseProfile');

/**
 * NethPot Combat Profile.
 * 
 * PRIMARY STYLE:
 * - Priority: CRITICALS > SHORT COMBOS > POSITION > POTIONS
 * - Authentic 6-Stage Crit Chaining:
 *   GROUND -> TARGET RANGE -> JUMP -> RISE -> FALL -> ATTACK -> LAND -> REPOSITION -> NEXT CRIT
 * - Low Combo Usage (1-2 hits max before crit transition)
 * - Safe Splash Potion & Gapple Healing with Start-of-Match Buff Awareness
 */
class NethPotProfile extends BaseCombatProfile {
  constructor(context = {}) {
    super('NETHPOT', context);
    this.comboCount = 0;
    this.maxComboBeforeCrit = 0; // Zero combo delay: immediate critical hits in NethPot
    this.critSequence = 'GROUND'; // 'GROUND' | 'JUMP' | 'RISING' | 'FALLING' | 'LAND'
    this.jumpStartTime = 0;
    this.lastY = 0;
    this.peakY = 0;
    this.lastCritTime = 0;
  }

  async preflight() {
    const base = await super.preflight();
    const items = this.bot && this.bot.inventory && typeof this.bot.inventory.items === 'function'
      ? this.bot.inventory.items()
      : [];

    const hasSword = items.some(i => i && i.name && (i.name.includes('sword')));
    const hasHealing = items.some(i => i && i.name && i.name.includes('potion'));

    const missing = [];
    if (!hasSword) missing.push('Sword');
    if (!hasHealing) missing.push('Healing Potions');

    const success = base.success && missing.length === 0;
    return {
      success,
      profile: this.name,
      missing: [...base.missing, ...missing],
      reason: success ? 'NethPot equipment verified' : `NethPot missing items: ${missing.join(', ')}`
    };
  }

  /**
   * Start-of-match and mid-fight active buff inspection.
   */
  hasActiveBuff(buffType) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.effects) return false;
    const effects = this.bot.entity.effects;
    const typeUpper = String(buffType || '').toUpperCase();
    if (typeUpper === 'SPEED') {
      return Boolean(effects[1] || Object.values(effects).some(e => e && (e.id === 1 || String(e.name || '').toLowerCase().includes('speed'))));
    }
    if (typeUpper === 'STRENGTH') {
      return Boolean(effects[5] || Object.values(effects).some(e => e && (e.id === 5 || String(e.name || '').toLowerCase().includes('strength'))));
    }
    return false;
  }

  /**
   * Legitimate Minecraft critical apex detection:
   * Falling downward (vy < -0.04), strictly not on ground, not in water, not on ladder.
   */
  isAtCritFallingApex() {
    if (!this.bot || !this.bot.entity) return false;
    const onGround = Boolean(this.bot.entity.onGround);
    const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    return !onGround && vy < -0.04 && !this.bot.entity.isInWater && !this.bot.entity.isOnLadder;
  }

  startCombat(target) {
    super.startCombat(target);
    this.comboCount = 0;
    this.critSequence = 'GROUND';
    if (this.potionManager) {
      this.potionManager.checkStartOfMatchBuffs();
    }
    this.recordMeaningfulAction('START');
  }

  update(target, dist, currentHealth, targetHealth, isCooldownReady, now = Date.now()) {
    if (!this.bot || !this.bot.entity || !target) return;

    // Check stuck watchdog
    this.checkStuckWatchdog(target, now);

    const onGround = Boolean(this.bot.entity.onGround);
    const currentY = this.bot.entity.position.y;
    const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : (currentY - this.lastY);

    if (currentY > this.peakY) this.peakY = currentY;

    // 1. SURVIVAL & HEALTH PRIORITY (Never interrupted by crits!)
    const isHealing = this.potionManager && (this.potionManager.healingActionLock || this.potionManager.isEating || this.potionManager.isUsingPotion);
    if (isHealing) {
      if (this.stateMachine) this.stateMachine.transitionTo('HEAL');
      if (this.movementController) {
        this.movementController.aimAwayFromTarget(target);
        this.movementController.setState('CHASE');
        this.movementController.setControl('forward', true);
        this.movementController.setControl('back', false);
        this.movementController.setControl('sprint', true);
        this.movementController.setControl('sneak', false);
      }
      this.recordMeaningfulAction('HEAL');
      return;
    }

    if (currentHealth <= 5 && this.potionManager && this.potionManager.hasPotion('HEALING')) {
      if (this.stateMachine) this.stateMachine.transitionTo('HEAL');
      if (this.movementController) {
        this.movementController.aimAwayFromTarget(target);
        this.movementController.setState('CHASE');
        this.movementController.setControl('forward', true);
        this.movementController.setControl('back', false);
        this.movementController.setControl('sprint', true);
        this.movementController.setControl('sneak', false);
      }
      this.potionManager.usePotion('HEALING', target);
      this.recordMeaningfulAction('HEAL_POTION');
      return;
    } else if (currentHealth <= 10 && this.potionManager && this.potionManager.hasGoldenApples() && !this.potionManager.isEating) {
      if (this.stateMachine) this.stateMachine.transitionTo('HEAL');
      if (this.movementController) {
        this.movementController.aimAwayFromTarget(target);
        this.movementController.setState('CHASE');
        this.movementController.setControl('forward', true);
        this.movementController.setControl('back', false);
        this.movementController.setControl('sprint', true);
        this.movementController.setControl('sneak', false);
      }
      this.potionManager.eatGoldenApple();
      this.recordMeaningfulAction('HEAL_GAPPLE');
      return;
    }

    // 2. SAFE MICRO-WINDOW BUFF REFRESH
    if (this.distanceController && this.distanceController.isSafeBuffWindow(target, dist, currentHealth)) {
      if (this.potionManager && !this.potionManager.isUsingPotion && !this.potionManager.isEating) {
        this.potionManager.evaluateBuffMaintenance(target);
      }
    }

    // 3. FINISH MODE (Opponent low HP: relentless pressure)
    if (targetHealth != null && targetHealth <= 7 && dist <= 3.5) {
      if (this.stateMachine) this.stateMachine.transitionTo('FINISH');
      if (isCooldownReady && dist <= 3.1) {
        this.attackScheduler.executeAttack(target, 'COMBO_HIT', { triggerSprintReset: true });
        this.recordMeaningfulAction('FINISH_ATTACK');
      }
      return;
    }

    // 4. CRITICAL SEQUENCE MACHINE
    // GROUND -> JUMP -> RISE -> FALL -> ATTACK -> LAND
    if (this.critSequence === 'JUMP') {
      if (!onGround) {
        if (vy > 0.05) {
          this.critSequence = 'RISING';
          if (this.stateMachine) this.stateMachine.transitionTo('CRIT_SETUP');
          this.recordMeaningfulAction('CRIT_RISING');
        } else if (vy < -0.04) {
          this.critSequence = 'FALLING';
          if (this.stateMachine) this.stateMachine.transitionTo('CRIT_ATTACK');
          this.recordMeaningfulAction('CRIT_FALLING');
        }
      } else if (now - this.jumpStartTime > 250) {
        this.critSequence = 'GROUND';
      }
    } else if (this.critSequence === 'RISING') {
      if (onGround) {
        this.critSequence = 'GROUND';
      } else if (vy < -0.04 || currentY < this.peakY - 0.02) {
        this.critSequence = 'FALLING';
        if (this.stateMachine) this.stateMachine.transitionTo('CRIT_ATTACK');
        this.recordMeaningfulAction('CRIT_FALLING');
      }
    } else if (this.critSequence === 'FALLING') {
      if (onGround) {
        this.critSequence = 'GROUND';
        if (this.movementController) this.movementController.setControl('sprint', true);
      } else if (dist <= 3.25 && (isCooldownReady || (now - this.lastCritTime >= 520))) {
        // EXECUTE FALLING CRITICAL HIT!
        this.attackScheduler.executeAttack(target, 'CRITICAL', { force: true });
        this.critSequence = 'LAND';
        this.comboCount = 0;
        this.lastCritTime = now;
        this.recordMeaningfulAction('CRIT_ATTACK');
      }
    } else if (this.critSequence === 'LAND') {
      if (onGround) {
        if (dist >= 1.2 && dist <= 3.25) {
          // Immediately chain next crit without delay!
          this.critSequence = 'JUMP';
          this.jumpStartTime = now;
          this.peakY = currentY;
          this.lastY = currentY;
          if (this.movementController) {
            this.movementController.setControl('forward', true);
            this.movementController.setControl('back', false);
            this.movementController.setControl('sprint', false);
            this.movementController.requestJump(true);
          }
          if (this.stateMachine) this.stateMachine.transitionTo('CRIT_SETUP');
          this.recordMeaningfulAction('CRIT_JUMP');
          return;
        } else {
          this.critSequence = 'GROUND';
          if (this.movementController) this.movementController.setControl('sprint', true);
        }
      }
    }

    // 5. ATTACK & COMBO LOGIC
    if (this.critSequence === 'GROUND' && onGround) {
      // Opportunity for Critical Jump: Target in range, attack ready (or >= 250ms elapsed)
      if (dist >= 1.2 && dist <= 3.25 && (isCooldownReady || (now - this.lastCritTime >= 250))) {
        this.critSequence = 'JUMP';
        this.jumpStartTime = now;
        this.peakY = currentY;
        this.lastY = currentY;
        if (this.movementController) {
          this.movementController.setControl('forward', true);
          this.movementController.setControl('back', false);
          this.movementController.setControl('sprint', false);
          this.movementController.requestJump(true);
        }
        if (this.stateMachine) this.stateMachine.transitionTo('CRIT_SETUP');
        this.recordMeaningfulAction('CRIT_JUMP');
        return;
      }

      // Small combo hits (1-2 hits max) to create spacing before next crit
      if (dist <= 3.15 && isCooldownReady && (!this.attackScheduler || (now - this.attackScheduler.lastAttackTime > 250))) {
        this.comboCount++;
        this.attackScheduler.executeAttack(target, 'NORMAL_HIT', { triggerSprintReset: true });
        if (this.stateMachine) this.stateMachine.transitionTo('COMBO');
        this.recordMeaningfulAction('COMBO_HIT');
      }
    }

    // 6. MOVEMENT SPACING
    if (this.distanceController) {
      const allowSprint = this.critSequence === 'GROUND';
      this.distanceController.applySpacingMovement(target, dist, {
        allowSprint,
        opponentModel: this.opponentModel
      });
    }

    this.lastY = currentY;
  }

  stopCombat() {
    super.stopCombat();
    this.comboCount = 0;
    this.critSequence = 'GROUND';
  }
}

module.exports = NethPotProfile;
