const BaseCombatProfile = require('./baseProfile');

/**
 * Sword Combat Profile.
 * 
 * PRIMARY STYLE:
 * - Strategy: COMBOS > SPACING > STRAFING > OCCASIONAL CRIT
 * - Continuous Grounded Aggressive Pressure (no constant jumping)
 * - Dynamic 45-degree Strafing & Edge of Reach Outspacing (2.4m - 2.85m)
 * - Tick-level Sprint Resets (W-Tap) & Spacing S-Taps
 * - Hit-Select Counter Attacks within 200ms
 * - Crits are Secondary and Opportunistic (only after 3+ combo hits)
 */
class SwordProfile extends BaseCombatProfile {
  constructor(context = {}) {
    super('SWORD', context);
    this.comboCount = 0;
    this.isAirborneCrit = false;
    this.critCooldown = 1800; // Occasional crits without interrupting grounded pressure
    this.lastCritTime = 0;

    // Tactical ranges
    this.idealMinRange = 2.05;
    this.idealMaxRange = 2.85;
    this.allowJumpCrits = false; // Primary style is grounded combo pressure
  }

  async preflight() {
    const base = await super.preflight();
    const items = this.bot && this.bot.inventory && typeof this.bot.inventory.items === 'function'
      ? this.bot.inventory.items()
      : [];

    const hasSword = items.some(i => i && i.name && i.name.includes('sword'));
    const missing = [];
    if (!hasSword) missing.push('Sword');

    const success = base.success && missing.length === 0;
    return {
      success,
      profile: this.name,
      missing: [...base.missing, ...missing],
      reason: success ? 'Sword equipment verified' : `Sword missing items: ${missing.join(', ')}`
    };
  }

  startCombat(target) {
    super.startCombat(target);
    this.comboCount = 0;
    this.isAirborneCrit = false;
    this.recordMeaningfulAction('START');
  }

  update(target, dist, currentHealth, targetHealth, isCooldownReady, now = Date.now()) {
    if (!this.bot || !this.bot.entity || !target) return;

    // Check stuck watchdog
    this.checkStuckWatchdog(target, now);

    const onGround = Boolean(this.bot.entity.onGround);
    const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;

    // 1. Survival Check: Golden Apple / Health Pot at <= 10 HP
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
    if (currentHealth <= 10 && this.potionManager) {
      if (this.potionManager.hasPotion('HEALING')) {
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
      } else if (this.potionManager.hasGoldenApples() && !this.potionManager.isEating) {
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
    }

    // 2. Finish Phase: Relentless combo barrage when opponent is low (<= 7 HP)
    if (targetHealth != null && targetHealth <= 7 && dist <= 3.5) {
      if (this.stateMachine) this.stateMachine.transitionTo('FINISH');
      if (isCooldownReady && dist <= 3.1) {
        this.attackScheduler.executeAttack(target, 'COMBO_HIT', { triggerSprintReset: true });
        this.recordMeaningfulAction('FINISH_COMBO');
      }
      return;
    }    // 3. Opportunistic Critical Strike:
    // Only used when target spacing is good, attack is ready, and it won't ruin combo momentum!
    if (this.isAirborneCrit) {
      if (onGround) {
        this.isAirborneCrit = false;
        if (this.movementController) this.movementController.setControl('sprint', true);
      } else if (vy < -0.04 && dist <= 3.15 && isCooldownReady) {
        // Execute falling crit
        this.attackScheduler.executeAttack(target, 'CRITICAL');
        this.lastCritTime = now;
        this.isAirborneCrit = false;
        if (this.stateMachine) this.stateMachine.transitionTo('CRIT_ATTACK');
        this.recordMeaningfulAction('CRIT_HIT');
        return;
      }
    }

    // 4. Hit-Select Opportunity (Counter attack immediately after opponent attack)
    if (onGround && dist <= 3.15 && this.attackScheduler && typeof this.attackScheduler.canHitSelect === 'function' && this.attackScheduler.canHitSelect(now)) {
      if (this.attackScheduler.isCooldownReady(now, true)) {
        this.comboCount++;
        this.attackScheduler.executeAttack(target, 'HIT_SELECT', { triggerSprintReset: true });
        if (this.stateMachine) this.stateMachine.transitionTo('HIT_SELECT');
        this.recordMeaningfulAction('HIT_SELECT');
        return;
      }
    }

    // 5. Grounded Combo Hit (Primary Combat Driver)
    if (onGround && dist <= 3.15 && isCooldownReady && (!this.attackScheduler || (now - this.attackScheduler.lastAttackTime > 250))) {
      this.comboCount++;

      // Check occasional crit opportunity (after 3+ combo hits, spacing good, not chasing retreating enemy)
      const canOccasionalCrit = this.comboCount >= 3 && (now - this.lastCritTime > this.critCooldown) && dist >= 2.0 && dist <= 2.8;
      if (canOccasionalCrit && (!this.opponentModel || !this.opponentModel.isRetreating)) {
        this.isAirborneCrit = true;
        this.lastCritTime = now;
        if (this.movementController) {
          this.movementController.setControl('sprint', false);
          this.movementController.requestJump(true);
        }
        if (this.stateMachine) this.stateMachine.transitionTo('CRIT_SETUP');
        this.recordMeaningfulAction('CRIT_SETUP');
        return;
      }

      // S-Tap decision: Only use if opponent is close (< 2.2m) to re-establish spacing without losing pressure
      const shouldSTap = dist < 2.0 && (!this.opponentModel || !this.opponentModel.isRetreating);

      this.attackScheduler.executeAttack(target, 'NORMAL_HIT', {
        triggerSprintReset: true,
        triggerSTap: shouldSTap,
        sTapDuration: 35
      });

      if (this.stateMachine) this.stateMachine.transitionTo('COMBO');
      this.recordMeaningfulAction('COMBO_HIT');
    }

    // 6. Dynamic Movement Spacing (2.4m - 2.85m Outspacing + Lateral Strafing)
    if (this.distanceController) {
      this.distanceController.applySpacingMovement(target, dist, {
        allowSprint: !this.isAirborneCrit,
        aggressive: true,
        opponentModel: this.opponentModel
      });
    }
  }

  stopCombat() {
    if (this.bot && this.bot.swordpvp && typeof this.bot.swordpvp.stop === 'function') {
      try {
        this.bot.swordpvp.stop();
      } catch {}
    }
    super.stopCombat();
    this.comboCount = 0;
    this.isAirborneCrit = false;
  }
}

module.exports = SwordProfile;
