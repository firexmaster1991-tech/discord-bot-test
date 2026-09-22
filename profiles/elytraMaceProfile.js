const { Vec3 } = require('vec3');
const BaseCombatProfile = require('./baseProfile');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Elytra Mace Dedicated Combat Profile with full ElytraMaceController.
 * 
 * 11 Discrete States:
 * - PREFLIGHT: Verifying Elytra, Rockets, Mace, Chestplate, and Food.
 * - GROUND: Initial ground stance before takeoff or after landing.
 * - TAKEOFF: Equipping Elytra, jump, and rocket boost initiation.
 * - FLIGHT: Sustained high-speed glide tracking opponent position and trajectory.
 * - TARGET_LOCK: Locking crosshairs onto target with velocity lead compensation.
 * - ROCKET_APPROACH: Controlled rocket propulsion for velocity / altitude gain.
 * - EQUIPMENT_SWAP: Swapping Elytra to Chestplate during dive approach.
 * - FALL: Unpowered descent with Mace equipped for maximum smash multiplier.
 * - MACE_ATTACK: Executing falling mace smash on opponent contact.
 * - RECOVER: Post-impact velocity stabilization and damage evaluation.
 * - REPEAT: Transitioning back to flight for consecutive aerial runs if target survives.
 */
class ElytraMaceProfile extends BaseCombatProfile {
  constructor(context = {}) {
    super('ELYTRA_MACE', context);

    this.elytraState = 'GROUND'; // 11 states
    this.lastRocketTime = 0;
    this.rocketCooldownMs = 2500;
    this.takeoffStartTime = 0;
    this.diveStartTime = 0;

    // Aerial flight & smash parameters
    this.rocketAscendMinDist = 6.0;
    this.diveSmashMinFall = 2.5;
    this.maceEquipped = false;
    this.chestplateEquipped = false;

    // 11 Controller States
    this.states = [
      'PREFLIGHT', 'GROUND', 'TAKEOFF', 'FLIGHT', 'TARGET_LOCK',
      'ROCKET_APPROACH', 'EQUIPMENT_SWAP', 'FALL', 'MACE_ATTACK', 'RECOVER', 'REPEAT'
    ];
  }

  async preflight() {
    const base = await super.preflight();
    const items = this.bot && this.bot.inventory && typeof this.bot.inventory.items === 'function'
      ? this.bot.inventory.items()
      : [];

    const hasElytra = items.some(i => i && i.name && i.name.includes('elytra'));
    const hasRockets = items.some(i => i && i.name && i.name.includes('firework'));
    const hasMace = items.some(i => i && i.name && i.name.includes('mace'));
    const hasChestplate = items.some(i => i && i.name && i.name.includes('chestplate'));

    const missing = [];
    if (!hasElytra) missing.push('Elytra');
    if (!hasRockets) missing.push('Firework Rockets');
    if (!hasMace) missing.push('Mace');
    if (!hasChestplate) missing.push('Chestplate');

    const success = base.success && missing.length === 0;
    return {
      success,
      profile: this.name,
      missing: [...base.missing, ...missing],
      reason: success ? 'Elytra-Mace equipment verified' : `Elytra-Mace missing required items: ${missing.join(', ')}`
    };
  }

  startCombat(target) {
    super.startCombat(target);
    this.elytraState = 'GROUND';
    this.equipArmor('elytra');
    this.recordMeaningfulAction('START');
  }

  /**
   * Equips Elytra or Chestplate on the torso slot (slot 6 in vanilla Mineflayer).
   */
  async equipArmor(type = 'elytra') {
    if (!this.bot || !this.bot.inventory) return false;
    const items = this.bot.inventory.items();
    const item = items.find(i => i && i.name && i.name.includes(type));
    if (item && typeof this.bot.equip === 'function') {
      try {
        await this.bot.equip(item, 'torso');
        if (type === 'chestplate') this.chestplateEquipped = true;
        if (type === 'elytra') this.chestplateEquipped = false;
        return true;
      } catch (err) {
        this.reportFailure('SWAP', `Failed to equip ${type}: ${err.message}`);
      }
    }
    return false;
  }

  /**
   * Predicts flight interception coordinates for moving opponent.
   */
  predictInterceptionPoint(target, lookaheadSeconds = 1.0) {
    if (!target || !target.position) return this.bot ? this.bot.entity.position.clone() : new Vec3(0, 0, 0);
    const vel = target.velocity || new Vec3(0, 0, 0);
    return target.position.offset(vel.x * lookaheadSeconds * 20, vel.y * lookaheadSeconds * 20, vel.z * lookaheadSeconds * 20);
  }

  /**
   * Ensures specific armor is equipped in the torso slot.
   */
  async ensureTorsoArmor(type = 'elytra') {
    const res = await this.equipArmor(type);
    this.equippedTorso = type;
    return res;
  }

  /**
   * Equips weapon (mace or sword) in the main hand.
   */
  async equipWeapon(type = 'mace') {
    if (!this.bot || !this.bot.inventory) return false;
    const items = this.bot.inventory.items();
    const item = items.find(i => i && i.name && i.name.includes(type));
    if (item && (!this.bot.heldItem || !this.bot.heldItem.name.includes(type))) {
      try {
        if (typeof this.bot.equip === 'function') {
          await this.bot.equip(item, 'hand');
          this.maceEquipped = (type === 'mace');
          return true;
        }
      } catch {}
    }
    return false;
  }

  /**
   * Triggers firework rocket propulsion during flight.
   */
  async triggerRocketBoost() {
    const now = Date.now();
    if (now - this.lastRocketTime < this.rocketCooldownMs) return false;
    this.lastRocketTime = now;

    if (!this.bot || !this.bot.inventory) return false;
    const items = this.bot.inventory.items();
    const rocket = items.find(i => i && i.name && i.name.includes('firework'));
    if (!rocket) {
      this.reportFailure('ROCKET', 'Firework rockets missing');
      return false;
    }

    try {
      if (typeof this.bot.equip === 'function') {
        await this.bot.equip(rocket, 'hand');
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem();
      }
      this.recordMeaningfulAction('ROCKET_BOOST');
      await sleep(40);
      return true;
    } catch (err) {
      this.reportFailure('ROCKET', err.message);
      return false;
    }
  }

  /**
   * Takeoff sequence: jump and ignite rocket while airborne.
   */
  async initiateTakeoff() {
    this.takeoffStartTime = Date.now();
    this.elytraState = 'TAKEOFF';

    await this.equipArmor('elytra');
    if (this.movementController) {
      this.movementController.requestJump(true);
    }
    await sleep(80);
    const boosted = await this.triggerRocketBoost();
    if (boosted) {
      this.elytraState = 'FLIGHT';
      this.recordMeaningfulAction('FLIGHT_ACTIVE');
    } else {
      this.elytraState = 'GROUND';
    }
  }

  /**
   * Main per-tick ElytraMaceController action loop (20 TPS).
   */
  update(target, dist, currentHealth, targetHealth, isCooldownReady, now = Date.now()) {
    if (!this.bot || !this.bot.entity || !target) return;

    // Check stuck watchdog
    this.checkStuckWatchdog(target, now);

    const onGround = Boolean(this.bot.entity.onGround);
    const currentY = this.bot.entity.position.y;
    const targetY = target.position.y;
    const altitudeDiff = currentY - targetY;

    // 1. SURVIVAL CHECK: Emergency Gapple / Pot
    if (currentHealth <= 8 && this.potionManager && !this.potionManager.isEating) {
      this.potionManager.eatGoldenApple();
    }

    // 2. ELYTRA STATE MACHINE PROGRESSION
    switch (this.elytraState) {
      case 'PREFLIGHT':
        this.elytraState = onGround ? 'GROUND' : 'FLIGHT';
        break;

      case 'GROUND':
        if (target && target.position) {
          if (dist > this.rocketAscendMinDist) {
            this.initiateTakeoff();
          } else if (dist <= 3.2 && isCooldownReady) {
            // Ground attack fallback
            this.equipWeapon('mace');
            this.attackScheduler.executeAttack(target, 'NORMAL_HIT', { triggerSprintReset: true });
            this.recordMeaningfulAction('GROUND_MACE_HIT');
          }
        }
        break;

      case 'TAKEOFF':
        if (!onGround) {
          this.elytraState = 'FLIGHT';
          this.recordMeaningfulAction('FLIGHT');
        } else if (now - this.takeoffStartTime > 400) {
          this.elytraState = 'GROUND';
        }
        break;

      case 'FLIGHT':
        if (onGround) {
          this.elytraState = 'GROUND';
        } else {
          this.elytraState = 'TARGET_LOCK';
          this.recordMeaningfulAction('TARGET_LOCK');
        }
        break;

      case 'TARGET_LOCK':
        if (onGround) {
          this.elytraState = 'GROUND';
          break;
        }

        // Aim leading trajectory: factor in opponent velocity and flight velocity
        const leadPos = this.opponentModel ? this.opponentModel.getPredictedPosition(0.18) : target.position;
        if (this.movementController && typeof this.movementController.aimAtTarget === 'function') {
          this.movementController.aimAtTarget({ position: leadPos }, 1.0, 0.15);
        }

        // Use rocket if far or losing altitude
        if (dist > 8.0 || altitudeDiff < 1.5) {
          this.elytraState = 'ROCKET_APPROACH';
          this.triggerRocketBoost().then(() => {
            this.elytraState = 'TARGET_LOCK';
          });
        }

        // If high above and closing in -> transition to dive & equipment swap
        if (altitudeDiff >= this.diveSmashMinFall && dist <= 6.0) {
          this.elytraState = 'EQUIPMENT_SWAP';
          this.recordMeaningfulAction('EQUIPMENT_SWAP');
        }
        break;

      case 'ROCKET_APPROACH':
        if (dist <= 6.0) {
          this.elytraState = 'EQUIPMENT_SWAP';
        }
        break;

      case 'EQUIPMENT_SWAP':
        // Swap Elytra to Chestplate and equip Mace for falling smash
        this.diveStartTime = now;
        (async () => {
          await this.equipArmor('chestplate');
          await this.equipWeapon('mace');
          this.elytraState = 'FALL';
          this.recordMeaningfulAction('FALL');
        })();
        break;

      case 'FALL':
        if (onGround) {
          this.elytraState = 'RECOVER';
          break;
        }

        // Within smash reach during falling descent
        if (dist <= 3.25 && isCooldownReady) {
          this.elytraState = 'MACE_ATTACK';
          this.attackScheduler.executeAttack(target, 'CRITICAL');
          this.recordMeaningfulAction('AERIAL_SMASH_HIT');
          this.elytraState = 'RECOVER';
        }
        break;

      case 'MACE_ATTACK':
        this.elytraState = 'RECOVER';
        break;

      case 'RECOVER':
        this.elytraState = 'REPEAT';
        this.recordMeaningfulAction('RECOVER');
        break;

      case 'REPEAT':
        // If target is still alive, re-equip Elytra and takeoff for consecutive run!
        if (target && target.health > 0) {
          this.equipArmor('elytra').then(() => {
            this.initiateTakeoff();
          });
        } else {
          this.elytraState = 'GROUND';
        }
        break;

      default:
        this.elytraState = 'GROUND';
        break;
    }

    // 3. FLIGHT DIRECTION & MOVEMENT
    if (this.movementController && onGround) {
      this.movementController.setControl('forward', dist > 2.5);
      this.movementController.setControl('sprint', true);
    }
  }

  stopCombat() {
    super.stopCombat();
    this.elytraState = 'GROUND';
    this.maceEquipped = false;
  }
}

module.exports = ElytraMaceProfile;
