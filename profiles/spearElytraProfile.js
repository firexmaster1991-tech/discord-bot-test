const { Vec3 } = require('vec3');
const BaseCombatProfile = require('./baseProfile');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Spear Elytra Dedicated Combat Profile.
 * 
 * PRIMARY STYLE:
 * - Aerial Glide & Kinetic Thrust Attacks
 * - Trident / Spear Ranged Thrust or Dive Poke
 * - Firework Rocket Velocity Control
 * - Preflight validation of Spear, Elytra, Rockets
 */
class SpearElytraProfile extends BaseCombatProfile {
  constructor(context = {}) {
    super('SPEAR_ELYTRA', context);

    this.spearState = 'GROUND'; // 'GROUND' | 'TAKEOFF' | 'GLIDE' | 'AIM' | 'THRUST' | 'RECOVER'
    this.lastRocketTime = 0;
    this.rocketCooldownMs = 2500;
  }

  async preflight() {
    const base = await super.preflight();
    const items = this.bot && this.bot.inventory && typeof this.bot.inventory.items === 'function'
      ? this.bot.inventory.items()
      : [];

    const hasSpear = items.some(i => i && i.name && (i.name.includes('spear') || i.name.includes('trident')));
    const hasElytra = items.some(i => i && i.name && i.name.includes('elytra'));
    const hasRockets = items.some(i => i && i.name && i.name.includes('firework'));

    const missing = [];
    if (!hasSpear) missing.push('Spear/Trident');
    if (!hasElytra) missing.push('Elytra');
    if (!hasRockets) missing.push('Firework Rockets');

    const success = base.success && missing.length === 0;
    return {
      success,
      profile: this.name,
      missing: [...base.missing, ...missing],
      reason: success ? 'Spear-Elytra equipment verified' : `Spear-Elytra missing required items: ${missing.join(', ')}`
    };
  }

  startCombat(target) {
    super.startCombat(target);
    this.spearState = 'GROUND';
    this.equipWeapon();
    this.recordMeaningfulAction('START');
  }

  async equipWeapon() {
    if (!this.bot || !this.bot.inventory) return false;
    const items = this.bot.inventory.items();
    const spear = items.find(i => i && i.name && (i.name.includes('spear') || i.name.includes('trident')));
    if (spear && typeof this.bot.equip === 'function') {
      try {
        await this.bot.equip(spear, 'hand');
        return true;
      } catch {}
    }
    return false;
  }

  async triggerRocket() {
    const now = Date.now();
    if (now - this.lastRocketTime < this.rocketCooldownMs) return false;
    this.lastRocketTime = now;

    if (!this.bot || !this.bot.inventory) return false;
    const items = this.bot.inventory.items();
    const rocket = items.find(i => i && i.name && i.name.includes('firework'));
    if (!rocket) return false;

    try {
      if (typeof this.bot.equip === 'function') await this.bot.equip(rocket, 'hand');
      if (typeof this.bot.activateItem === 'function') this.bot.activateItem();
      await sleep(40);
      await this.equipWeapon();
      this.recordMeaningfulAction('ROCKET_BOOST');
      return true;
    } catch {
      return false;
    }
  }

  update(target, dist, currentHealth, targetHealth, isCooldownReady, now = Date.now()) {
    if (!this.bot || !this.bot.entity || !target) return;

    this.checkStuckWatchdog(target, now);
    const onGround = Boolean(this.bot.entity.onGround);

    // Ground approach or glide thrust
    if (dist <= 3.3 && isCooldownReady) {
      this.equipWeapon();
      this.attackScheduler.executeAttack(target, 'NORMAL_HIT', { triggerSprintReset: true });
      this.recordMeaningfulAction('SPEAR_THRUST');
    }

    if (dist > 7.0 && !onGround) {
      this.triggerRocket();
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
    this.spearState = 'GROUND';
  }
}

module.exports = SpearElytraProfile;
