const BaseCombatProfile = require('./baseProfile');

/**
 * Sword Combat Profile.
 * 
 * PRIMARY STYLE:
 * - Strategy: COMBOS > SPACING > STRAFING (NO CRITS)
 * - Continuous Grounded Aggressive Pressure (no constant jumping)
 * - Dynamic 45-degree Strafing & Edge of Reach Outspacing (2.4m - 2.85m)
 * - Tick-level Sprint Resets (W-Tap) & Spacing S-Taps
 * - Hit-Select Counter Attacks within 200ms
 * - Never jumps for crits; every attack is part of grounded combo pressure
 */
class SwordProfile extends BaseCombatProfile {
  constructor(context = {}) {
    super('SWORD', context);
    this.comboCount = 0;

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
    // Sword mode: grounded combo pressure.
    // Automatic/attack jumping is OFF, but jump-reset remains ON after incoming damage.
    if (this.movementController && typeof this.movementController.setCombatJumpingEnabled === 'function') {
      this.movementController.setCombatJumpingEnabled(true, { autoJump: false });
    }
    this.recordMeaningfulAction('START');
  }

  update(target, dist, currentHealth, targetHealth, isCooldownReady, now = Date.now()) {
    if (!this.bot || !this.bot.entity || !target) return;

    // Check stuck watchdog
    this.checkStuckWatchdog(target, now);

    const onGround = Boolean(this.bot.entity.onGround);
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
    }

    // 3. Hit-Select Opportunity (counter attack without leaving the ground)
    if (onGround && dist <= 3.15 && this.attackScheduler && typeof this.attackScheduler.canHitSelect === 'function' && this.attackScheduler.canHitSelect(now)) {
      if (this.attackScheduler.isCooldownReady(now, true)) {
        this.comboCount++;
        this.attackScheduler.executeAttack(target, 'HIT_SELECT', { triggerSprintReset: true });
        if (this.stateMachine) this.stateMachine.transitionTo('HIT_SELECT');
        this.recordMeaningfulAction('HIT_SELECT');
        return;
      }
    }

    // 4. Grounded Combo Hit (PRIMARY DRIVER)
    // Full sword cooldown is enforced by AttackScheduler. Never jump for the attack.
    if (onGround && dist <= 3.15 && isCooldownReady) {
      this.comboCount++;

      // Use S-tap periodically at close range; all other combo hits use W-tap.
      // This keeps both techniques active without stacking their timers on one hit.
      const shouldSTap =
        dist < 2.15 &&
        (!this.opponentModel || !this.opponentModel.isRetreating) &&
        (this.comboCount % 3 === 0 || dist < 1.9);

      this.attackScheduler.executeAttack(target, 'NORMAL_HIT', {
        triggerSprintReset: !shouldSTap,
        triggerSTap: shouldSTap,
        sTapDuration: 40
      });

      if (this.stateMachine) this.stateMachine.transitionTo('COMBO');
      this.recordMeaningfulAction(shouldSTap ? 'COMBO_S_TAP' : 'COMBO_W_TAP');
    }

    // 5. Dynamic Movement Spacing (2.4m - 2.85m Outspacing + Lateral Strafing)
    if (this.distanceController) {
      this.distanceController.applySpacingMovement(target, dist, {
        allowSprint: true,
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
    if (this.movementController && typeof this.movementController.setCombatJumpingEnabled === 'function') {
      this.movementController.setCombatJumpingEnabled(true, { autoJump: true });
    }
    super.stopCombat();
    this.comboCount = 0;
  }
}

module.exports = SwordProfile;
