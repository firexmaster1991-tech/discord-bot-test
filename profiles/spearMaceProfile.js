const { Vec3 } = require('vec3');
const BaseCombatProfile = require('./baseProfile');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Spear Mace Dedicated Combat Profile.
 * 
 * PRIMARY STYLE:
 * - Hybrid Polearm & Impact Combat
 * - Spear Opening Poke / Spacing (2.6m - 3.5m)
 * - Wind Charge Ascent into Falling Mace Smash
 * - Preflight validation of Spear, Mace, Wind Charges
 */
class SpearMaceProfile extends BaseCombatProfile {
  constructor(context = {}) {
    super('SPEAR_MACE', context);

    this.spearMaceState = 'SPEAR_POKE'; // 'SPEAR_POKE' | 'WIND_CHARGE' | 'MACE_SMASH' | 'REPOSITION'
    this.lastLaunchTime = 0;
    this.launchCooldownMs = 3000;
  }

  async preflight() {
    const base = await super.preflight();
    const items = this.bot && this.bot.inventory && typeof this.bot.inventory.items === 'function'
      ? this.bot.inventory.items()
      : [];

    const hasSpear = items.some(i => i && i.name && (i.name.includes('spear') || i.name.includes('trident')));
    const hasMace = items.some(i => i && i.name && i.name.includes('mace'));
    const hasWindCharges = items.some(i => i && i.name && i.name.includes('wind_charge'));

    const missing = [];
    if (!hasSpear) missing.push('Spear/Trident');
    if (!hasMace) missing.push('Mace');

    const success = base.success && missing.length === 0;
    return {
      success,
      profile: this.name,
      missing: [...base.missing, ...missing],
      hasWindCharges,
      reason: success ? 'Spear-Mace equipment verified' : `Spear-Mace missing required items: ${missing.join(', ')}`
    };
  }

  startCombat(target) {
    super.startCombat(target);
    this.spearMaceState = 'SPEAR_POKE';
    this.equipWeapon('spear');
    this.recordMeaningfulAction('START');
  }

  async equipWeapon(type = 'spear') {
    if (!this.bot || !this.bot.inventory) return false;
    const items = this.bot.inventory.items();
    const item = items.find(i => {
      if (!i || !i.name) return false;
      if (type === 'spear') return i.name.includes('spear') || i.name.includes('trident');
      if (type === 'mace') return i.name.includes('mace');
      return false;
    });

    if (item && (!this.bot.heldItem || !this.bot.heldItem.name.includes(type))) {
      try {
        if (typeof this.bot.equip === 'function') {
          await this.bot.equip(item, 'hand');
          return true;
        }
      } catch {}
    }
    return false;
  }

  async triggerWindLaunch() {
    if (!this.bot || !this.bot.inventory) return false;
    const items = this.bot.inventory.items();
    const wc = items.find(i => i && i.name && i.name.includes('wind_charge'));
    if (!wc) return false;

    this.lastLaunchTime = Date.now();
    try {
      if (typeof this.bot.equip === 'function') await this.bot.equip(wc, 'hand');
      if (typeof this.bot.look === 'function') await this.bot.look(this.bot.entity.yaw || 0, -1.5, true);
      if (this.movementController) this.movementController.requestJump(true);
      if (typeof this.bot.activateItem === 'function') this.bot.activateItem();
      await sleep(40);
      await this.equipWeapon('mace');
      this.spearMaceState = 'MACE_SMASH';
      this.recordMeaningfulAction('WIND_LAUNCH');
      return true;
    } catch {
      return false;
    }
  }

  update(target, dist, currentHealth, targetHealth, isCooldownReady, now = Date.now()) {
    if (!this.bot || !this.bot.entity || !target) return;

    this.checkStuckWatchdog(target, now);
    const onGround = Boolean(this.bot.entity.onGround);

    // If airborne and falling -> Mace smash!
    if (!onGround && this.bot.entity.velocity && this.bot.entity.velocity.y < -0.04 && dist <= 3.25 && isCooldownReady) {
      this.equipWeapon('mace');
      this.attackScheduler.executeAttack(target, 'CRITICAL');
      this.recordMeaningfulAction('MACE_SMASH');
      this.spearMaceState = 'REPOSITION';
      return;
    }

    // Ground: Spear poke
    if (onGround) {
      if (dist >= 1.8 && dist <= 3.8 && (now - this.lastLaunchTime > this.launchCooldownMs)) {
        this.triggerWindLaunch();
      } else if (dist <= 3.2 && isCooldownReady) {
        this.equipWeapon('spear');
        this.attackScheduler.executeAttack(target, 'NORMAL_HIT', { triggerSprintReset: true });
        this.recordMeaningfulAction('SPEAR_POKE');
      }
    }

    if (this.distanceController && onGround) {
      this.distanceController.applySpacingMovement(target, dist, {
        allowSprint: true,
        opponentModel: this.opponentModel
      });
    }
  }

  stopCombat() {
    super.stopCombat();
    this.spearMaceState = 'SPEAR_POKE';
  }
}

module.exports = SpearMaceProfile;
