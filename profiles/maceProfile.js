const { Vec3 } = require('vec3');
const BaseCombatProfile = require('./baseProfile');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Mace Dedicated Combat Profile with full MaceController.
 * 
 * 10 Discrete States:
 * - SEARCH: Locating target entity and arena boundary.
 * - APPROACH: Closing distance toward target.
 * - SETUP: Establishing positioning and checking ceiling clearance.
 * - WIND_CHARGE: Triggering downward wind charge impulse + jump input.
 * - ASCEND: Tracking upward vertical velocity (vy > 0.20).
 * - TRACK: Maintaining crosshair lock onto target during apex.
 * - FALL: Falling downward with Mace equipped under MACE_EQUIP_LOCK.
 * - SMASH: Landing devastating falling smash attack.
 * - LAND: Stabilizing ground landing and resetting velocity.
 * - REPOSITION: Lateral movement to prepare next attack or disengage.
 */
class MaceProfile extends BaseCombatProfile {
  constructor(context = {}) {
    super('MACE', context);

    this.maceState = 'SEARCH'; // 10 states
    this.launchStartTime = 0;
    this.peakY = 0;
    this.lastY = 0;
    this.launchCooldownMs = 2800;
    this.lastLaunchTime = 0;

    // Smash & launch thresholds
    this.minFallDistanceForSmash = 1.5;
    this.windChargeLaunchVelocity = 0.65;
    this.maceEquipLock = false; // MACE_EQUIP_LOCK
    this.ceilingClear = true;

    // 10 Controller States
    this.states = [
      'SEARCH', 'APPROACH', 'SETUP', 'WIND_CHARGE', 'ASCEND',
      'TRACK', 'FALL', 'SMASH', 'LAND', 'REPOSITION'
    ];
  }

  async preflight() {
    const base = await super.preflight();
    const items = this.bot && this.bot.inventory && typeof this.bot.inventory.items === 'function'
      ? this.bot.inventory.items()
      : [];

    const hasMace = items.some(i => i && i.name && i.name.includes('mace'));
    const hasWindCharges = items.some(i => i && i.name && i.name.includes('wind_charge'));
    const hasGapples = items.some(i => i && i.name && i.name.includes('golden_apple'));
    const hasTotem = items.some(i => i && i.name && i.name.includes('totem'));

    const missing = [];
    if (!hasMace) missing.push('Mace');
    if (!hasWindCharges) missing.push('Wind Charges');

    const success = base.success && missing.length === 0;
    return {
      success,
      profile: this.name,
      missing: [...base.missing, ...missing],
      hasGapples,
      hasTotem,
      reason: success ? 'Mace equipment verified' : `Mace missing required items: ${missing.join(', ')}`
    };
  }

  startCombat(target) {
    super.startCombat(target);
    this.maceState = 'SEARCH';
    this.maceEquipLock = false;
    this.equipWeapon('sword');
    this.recordMeaningfulAction('SEARCH');
  }

  /**
   * Safe weapon swapping between sword (ground) and mace (airborne smash).
   * Strictly blocked when MACE_EQUIP_LOCK is active!
   */
  async equipWeapon(type = 'sword') {
    if (this.maceEquipLock && type !== 'mace') {
      return false; // FORBIDDEN by MACE_EQUIP_LOCK
    }
    if (!this.bot || !this.bot.inventory) return false;
    const items = this.bot.inventory.items();
    const item = items.find(i => i.name && i.name.includes(type));
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

  /**
   * Enforces MACE_EQUIP_LOCK according to vertical movement phase:
   * Holding wind charge while rising, mace strictly during descent.
   */
  enforceMaceEquipLock(phase) {
    if (phase === 'ASCENDING' || phase === 'WIND_CHARGE') {
      this.maceEquipLock = false;
      this.equipWeapon('wind_charge');
      this.maceEquipLock = true;
    } else if (phase === 'FALLING' || phase === 'SMASH') {
      this.maceEquipLock = false;
      this.equipWeapon('mace');
      this.maceEquipLock = true;
    }
  }

  /**
   * Checks if space above the bot is clear of ceiling obstructions.
   */
  checkCeilingClearance() {
    if (!this.bot || typeof this.bot.blockAt !== 'function' || !this.bot.entity) return true;
    const pos = this.bot.entity.position;
    for (let dy = 2; dy <= 5; dy++) {
      const b = this.bot.blockAt(pos.offset(0, dy, 0));
      if (b && b.boundingBox === 'block') {
        return false;
      }
    }
    return true;
  }

  /**
   * Coordinated Wind Charge Launch:
   * Throws wind charge downward while jumping to launch the bot upward.
   */
  async triggerWindChargeLaunch() {
    if (!this.bot || !this.bot.inventory) return false;
    const items = this.bot.inventory.items();
    const windCharge = items.find(i => i.name && i.name.includes('wind_charge'));
    if (!windCharge) {
      this.reportFailure('WIND_CHARGE', 'Wind charge missing in inventory');
      return false;
    }

    this.launchStartTime = Date.now();
    this.lastLaunchTime = this.launchStartTime;
    this.maceState = 'WIND_CHARGE';

    try {
      if (typeof this.bot.equip === 'function') {
        await this.bot.equip(windCharge, 'hand');
      }
      // Pitch down directly at feet (-1.5 rad)
      if (typeof this.bot.look === 'function') {
        await this.bot.look(this.bot.entity.yaw || 0, -1.5, true);
      }
      // Jump and activate wind charge concurrently
      if (this.movementController) {
        this.movementController.requestJump(true);
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem();
      }
      this.recordMeaningfulAction('WIND_CHARGE_LAUNCH');
      await sleep(40);
      return true;
    } catch (err) {
      this.reportFailure('WIND_CHARGE', err.message);
      this.maceState = 'REPOSITION';
      return false;
    }
  }

  /**
   * Main per-tick MaceController action loop (20 TPS).
   */
  update(target, dist, currentHealth, targetHealth, isCooldownReady, now = Date.now()) {
    if (!this.bot || !this.bot.entity || !target) return;

    // Check stuck watchdog
    this.checkStuckWatchdog(target, now);

    const onGround = Boolean(this.bot.entity.onGround);
    const currentY = this.bot.entity.position.y;
    const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : (currentY - this.lastY);

    if (currentY > this.peakY) this.peakY = currentY;

    // 1. SURVIVAL CHECK: Golden Apple / Health Pot at <= 10 HP
    if (this.potionManager && this.potionManager.healingActionLock) {
      this.maceState = 'REPOSITION';
      return;
    }
    if (currentHealth <= 10 && this.potionManager && !this.maceEquipLock) {
      if (this.potionManager.hasPotion('HEALING')) {
        this.potionManager.usePotion('HEALING', target);
        return;
      } else if (this.potionManager.hasGoldenApples() && !this.potionManager.isEating) {
        this.potionManager.eatGoldenApple();
        return;
      }
    }

    // 2. MACE STATE MACHINE PROGRESSION
    switch (this.maceState) {
      case 'SEARCH':
        if (target && target.position) {
          this.maceState = dist > 4.5 ? 'APPROACH' : 'SETUP';
          this.recordMeaningfulAction(this.maceState);
        }
        break;

      case 'APPROACH':
        if (dist <= 4.0) {
          this.maceState = 'SETUP';
          this.recordMeaningfulAction('SETUP');
        }
        break;

      case 'SETUP':
        this.ceilingClear = this.checkCeilingClearance();
        // Ready for launch if on ground, cooldown ready, ceiling clear, and distance 2.0m - 3.8m
        if (onGround && this.ceilingClear && (now - this.lastLaunchTime > this.launchCooldownMs) && dist >= 1.8 && dist <= 3.8) {
          this.triggerWindChargeLaunch();
        } else if (dist <= 3.0 && isCooldownReady && onGround) {
          // Ground melee poke while waiting for wind charge cooldown
          this.equipWeapon('sword');
          this.attackScheduler.executeAttack(target, 'NORMAL_HIT', { triggerSprintReset: true });
          this.recordMeaningfulAction('GROUND_POKE');
        }
        break;

      case 'WIND_CHARGE':
        if (!onGround && vy > 0.15) {
          this.maceState = 'ASCEND';
          this.peakY = currentY;
          // Equip Mace and lock it
          this.maceEquipLock = true;
          this.equipWeapon('mace');
          this.recordMeaningfulAction('ASCEND');
        } else if (now - this.launchStartTime > 350) {
          // Launch failed
          this.reportFailure('ASCEND', 'Upward velocity not achieved');
          this.maceState = 'REPOSITION';
          this.maceEquipLock = false;
          this.equipWeapon('sword');
        }
        break;

      case 'ASCEND':
        if (onGround) {
          this.maceState = 'LAND';
          this.maceEquipLock = false;
        } else if (Math.abs(vy) <= 0.05) {
          this.maceState = 'TRACK';
          this.recordMeaningfulAction('TRACK');
        } else if (vy < -0.04) {
          this.maceState = 'FALL';
          this.recordMeaningfulAction('FALL');
        }
        break;

      case 'TRACK':
        if (onGround) {
          this.maceState = 'LAND';
          this.maceEquipLock = false;
        } else if (vy < -0.04 || currentY < this.peakY - 0.05) {
          this.maceState = 'FALL';
          this.recordMeaningfulAction('FALL');
        }
        break;

      case 'FALL':
        if (onGround) {
          this.maceState = 'LAND';
          this.maceEquipLock = false;
          this.equipWeapon('sword');
        } else if (dist <= 3.2 && isCooldownReady) {
          // EXECUTE MACE SMASH ATTACK!
          this.maceState = 'SMASH';
          this.attackScheduler.executeAttack(target, 'CRITICAL');
          this.recordMeaningfulAction('MACE_SMASH');

          // Check Wind Burst: If launched back up by enchantment
          setTimeout(() => {
            if (this.bot && this.bot.entity && !this.bot.entity.onGround && this.bot.entity.velocity && this.bot.entity.velocity.y > 0.3) {
              this.maceState = 'ASCEND';
              this.peakY = this.bot.entity.position.y;
            } else {
              this.maceState = 'LAND';
            }
          }, 80);
        } else if (dist > 3.6) {
          // Target escaped smash reach -> Cancel smash and prepare chase
          this.maceEquipLock = false;
          this.maceState = 'APPROACH';
          this.recordMeaningfulAction('CHASE');
        }
        break;

      case 'SMASH':
        if (onGround) {
          this.maceState = 'LAND';
          this.maceEquipLock = false;
        }
        break;

      case 'LAND':
        this.maceEquipLock = false;
        this.equipWeapon('sword');
        this.maceState = 'REPOSITION';
        this.recordMeaningfulAction('REPOSITION');
        break;

      case 'REPOSITION':
        this.maceEquipLock = false;
        if (now - this.lastLaunchTime > 1000) {
          this.maceState = dist > 4.0 ? 'APPROACH' : 'SETUP';
        }
        break;

      default:
        this.maceState = 'SETUP';
        break;
    }

    // 3. CONTINUOUS MOVEMENT & TARGET TRACKING: Mace profile must never stand still!
    if (this.distanceController) {
      const allowSprint = onGround && this.maceState !== 'WIND_CHARGE';
      this.distanceController.applySpacingMovement(target, dist, {
        allowSprint,
        opponentModel: this.opponentModel
      });
    }

    this.lastY = currentY;
  }

  stopCombat() {
    super.stopCombat();
    this.maceState = 'SEARCH';
    this.maceEquipLock = false;
  }
}

module.exports = MaceProfile;
