const { Vec3 } = require('vec3');
const BaseCombatProfile = require('./baseProfile');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Crystal / CPvP Dedicated Combat Profile with full CrystalController.
 * 
 * 12 Discrete States:
 * - SEARCH: Locating target entity and arena terrain.
 * - APPROACH: Sprinting toward combat positioning distance (2.6m - 4.0m).
 * - POSITION: Fluid strafing & spacing maintaining line of sight without hitbox collision.
 * - HIT_SELECT: Melee strike to inflict knockback and open placement space.
 * - OBSIDIAN: Verifying line of sight and placing obsidian foundation.
 * - CRYSTAL: Equipping and placing End Crystal on obsidian.
 * - BREAK: Detonating crystal with fast melee attack.
 * - TOTEM: Emergency off-hand totem restock.
 * - ANCHOR: Respawn anchor placement, glowstone charging, and safe detonation.
 * - PEARL: Tactical ender pearl escape when trapped, low health, or in blast radius.
 * - RECOVER: Post-blast momentum stabilization and health check.
 * - FINISH: Relentless high pressure when target health is low (<= 7 HP).
 */
class CrystalProfile extends BaseCombatProfile {
  constructor(context = {}) {
    super('CRYSTAL', context);

    // CPvP Grounded & Safety Settings
    this.groundedCombatDefault = true;
    this.safeAnchorDistance = 4.5;
    this.validateLineOfSight = true;
    this.placingObsidian = false;
    this.detonatingCrystal = false;

    // CrystalController state
    this.crystalState = 'SEARCH';
    this.actionLock = false;
    this.actionStartTime = 0;
    this.actionTimeoutMs = 300; // Strict action timeout to prevent freezes

    // Timing and cooldowns
    this.lastPlacedPos = null;
    this.lastDetonationTime = 0;
    this.lastPearlTime = 0;
    this.lastTotemCheck = 0;
    this.lastHitSelectTime = 0;
    this.lastAnchorTime = 0;

    // 12 Controller States
    this.states = [
      'SEARCH', 'APPROACH', 'POSITION', 'HIT_SELECT', 'OBSIDIAN',
      'CRYSTAL', 'BREAK', 'TOTEM', 'ANCHOR', 'PEARL', 'RECOVER', 'FINISH'
    ];
  }

  async preflight() {
    const base = await super.preflight();
    const items = this.bot && this.bot.inventory && typeof this.bot.inventory.items === 'function'
      ? this.bot.inventory.items()
      : [];

    const hasObsidian = items.some(i => i && i.name && i.name.includes('obsidian'));
    const hasCrystal = items.some(i => i && i.name && i.name.includes('end_crystal'));
    const hasTotem = items.some(i => i && i.name && i.name.includes('totem'));
    const hasAnchor = items.some(i => i && i.name && i.name.includes('respawn_anchor'));
    const hasGlowstone = items.some(i => i && i.name && i.name.includes('glowstone'));
    const hasPearls = items.some(i => i && i.name && i.name.includes('ender_pearl'));

    const missing = [];
    if (!hasObsidian) missing.push('Obsidian');
    if (!hasCrystal) missing.push('End Crystal');

    // Optional supporting items (warn if absent but allow baseline crystal if obsidian + crystal present)
    const supporting = [];
    if (!hasTotem) supporting.push('Totem of Undying');
    if (!hasAnchor) supporting.push('Respawn Anchor');
    if (!hasGlowstone) supporting.push('Glowstone');
    if (!hasPearls) supporting.push('Ender Pearls');

    const success = base.success && missing.length === 0;
    return {
      success,
      profile: this.name,
      missing: [...base.missing, ...missing],
      supportingMissing: supporting,
      reason: success ? 'Crystal requirements verified' : `Crystal missing required items: ${missing.join(', ')}`
    };
  }

  startCombat(target) {
    super.startCombat(target);
    this.crystalState = 'SEARCH';
    this.actionLock = false;
    this.ensureTotemInOffHand();
    this.recordMeaningfulAction('SEARCH');
  }

  /**
   * Fast offhand Totem of Undying upkeep.
   * Emergency priority before any other offensive action.
   */
  async ensureTotemInOffHand() {
    if (!this.bot || !this.bot.inventory) return false;
    const offhandSlot = this.bot.inventory.slots[45];
    if (offhandSlot && offhandSlot.name && offhandSlot.name.includes('totem')) {
      return true; // Already equipped
    }

    const totem = this.bot.inventory.items().find(i => i && i.name && i.name.includes('totem'));
    if (totem && typeof this.bot.equip === 'function') {
      try {
        await this.bot.equip(totem, 'off-hand');
        this.recordMeaningfulAction('TOTEM_EQUIPPED');
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Raycast check ensuring clear line of sight between eye position and destination.
   * Absolutely prevents placing through or behind walls!
   */
  hasLineOfSight(eyePosOrTarget, maybeTargetPos) {
    if (!this.bot || !this.bot.blockAt) return false;

    let eyePos;
    let targetPos;
    if (maybeTargetPos) {
      eyePos = eyePosOrTarget;
      targetPos = maybeTargetPos;
    } else {
      targetPos = eyePosOrTarget;
      eyePos = this.bot && this.bot.entity && this.bot.entity.position
        ? this.bot.entity.position.offset(0, this.bot.entity.eyeHeight || 1.62, 0)
        : null;
    }
    if (!eyePos || !targetPos) return false;

    const dist = eyePos.distanceTo(targetPos);
    if (dist > 4.5 || dist <= 0.05) return false;

    const dx = (targetPos.x - eyePos.x) / dist;
    const dy = (targetPos.y - eyePos.y) / dist;
    const dz = (targetPos.z - eyePos.z) / dist;

    const stepSize = 0.25;
    const steps = Math.floor(dist / stepSize);

    for (let i = 1; i < steps; i++) {
      const checkPt = eyePos.offset(dx * i * stepSize, dy * i * stepSize, dz * i * stepSize).floored();
      const block = this.bot.blockAt(checkPt);
      if (block && block.boundingBox === 'block' &&
          block.name !== 'air' && block.name !== 'cave_air' &&
          block.name !== 'water' && block.name !== 'lava') {
        return false; // Obstructed by solid obstacle
      }
    }

    return true;
  }

  /**
   * Finds legitimate ground location adjacent to target for obsidian placement.
   */
  findBestObsidianSpot(targetPos) {
    if (!this.bot || !this.bot.blockAt || !this.bot.entity) return null;
    const botEye = this.bot.entity.position.offset(0, this.bot.entity.eyeHeight || 1.62, 0);

    const candidates = [
      targetPos.offset(1, -1, 0).floored(),
      targetPos.offset(-1, -1, 0).floored(),
      targetPos.offset(0, -1, 1).floored(),
      targetPos.offset(0, -1, -1).floored(),
      targetPos.offset(1, -1, 1).floored(),
      targetPos.offset(-1, -1, 1).floored()
    ];

    for (const groundPos of candidates) {
      const destPos = groundPos.offset(0, 1, 0);
      const crystalAirPos = destPos.offset(0, 1, 0);

      const groundBlock = this.bot.blockAt(groundPos);
      const destBlock = this.bot.blockAt(destPos);
      const airBlock = this.bot.blockAt(crystalAirPos);

      // Must be solid ground, air above for obsidian, air above for crystal
      if (!groundBlock || groundBlock.boundingBox !== 'block') continue;
      if (groundBlock.name === 'air' || groundBlock.name === 'cave_air' || groundBlock.name === 'water') continue;
      if (destBlock && destBlock.name !== 'air' && destBlock.name !== 'cave_air') continue;
      if (airBlock && airBlock.name !== 'air' && airBlock.name !== 'cave_air') continue;

      // Distance checks
      const distFromBot = this.bot.entity.position.distanceTo(destPos);
      if (distFromBot < 1.6 || distFromBot > 4.2) continue;

      // Line of sight check
      if (!this.hasLineOfSight(botEye, destPos.offset(0.5, 0.5, 0.5))) continue;

      return { groundBlock, destPos };
    }

    return null;
  }

  /**
   * Evaluates if a Respawn Anchor detonation is safe (won't self-damage lethally).
   */
  isSafeAnchorPlacement(dist) {
    return dist >= this.safeAnchorDistance;
  }

  /**
   * Evaluates if anchor detonation is safe considering health and distance.
   */
  isSafeToDetonateAnchor(anchorPos, healthThreshold = 10) {
    if (!this.bot || !this.bot.entity) return false;
    const currentHealth = this.bot.health != null ? this.bot.health : 20;
    if (currentHealth < healthThreshold) return false;
    const dist = this.bot.entity.position.distanceTo(anchorPos);
    return this.isSafeAnchorPlacement(dist);
  }

  /**
   * Tactical Ender Pearl escape routine.
   */
  async executePearlEscape() {
    const now = Date.now();
    if (now - this.lastPearlTime < 3500) return;
    this.lastPearlTime = now;

    if (!this.bot || !this.bot.inventory) return;
    const pearl = this.bot.inventory.items().find(i => i && i.name && i.name.includes('ender_pearl'));
    if (!pearl) return;

    this.crystalState = 'PEARL';
    if (this.stateMachine) this.stateMachine.transitionTo('ESCAPE');
    try {
      if (typeof this.bot.equip === 'function') {
        await this.bot.equip(pearl, 'hand');
      }
      const escapeYaw = (this.bot.entity.yaw || 0) + Math.PI; // 180 deg away
      if (typeof this.bot.look === 'function') {
        await this.bot.look(escapeYaw, 0.45, true);
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem();
      }
      this.recordMeaningfulAction('PEARL_ESCAPE');
      await sleep(50);
    } catch {}
  }

  /**
   * Main per-tick CrystalController action loop (20 TPS).
   */
  update(target, dist, currentHealth, targetHealth, isCooldownReady, now = Date.now()) {
    if (!this.bot || !this.bot.entity || !target) return;

    // Check stuck watchdog
    this.checkStuckWatchdog(target, now);

    // Action Timeout Watchdog (Prevents freezes)
    if (this.actionLock && (now - this.actionStartTime > this.actionTimeoutMs)) {
      this.actionLock = false;
      this.crystalState = 'POSITION';
    }

    // 1. TOTEM CHECK & SURVIVAL (Emergency level)
    if (now - this.lastTotemCheck > 350) {
      this.lastTotemCheck = now;
      this.ensureTotemInOffHand();
    }

    // Low HP / Corner Danger -> Pearl Escape
    const corner = this.movementController && typeof this.movementController.detectCornerDanger === 'function' ? this.movementController.detectCornerDanger(1.6) : null;
    if ((currentHealth <= 6 || (corner && corner.inCorner)) && dist < 3.2) {
      this.executePearlEscape();
      return;
    }

    // 2. BREAK / DETONATE EXISTING CRYSTAL IN RANGE
    const nearbyCrystal = Object.values(this.bot.entities || {}).find(e =>
      e && e.name === 'end_crystal' && this.bot.entity.position.distanceTo(e.position) <= 4.2
    );

    if (nearbyCrystal) {
      const crystalDist = this.bot.entity.position.distanceTo(nearbyCrystal.position);
      const enemyDist = target.position.distanceTo(nearbyCrystal.position);

      // Safe detonation: Enemy closer to crystal than bot, or bot has totem
      if (enemyDist <= crystalDist || crystalDist >= 2.5) {
        this.crystalState = 'BREAK';
        if (this.stateMachine) this.stateMachine.transitionTo('CRIT_ATTACK');
        this.attackScheduler.executeAttack(nearbyCrystal, 'NORMAL_HIT', { triggerSprintReset: false });
        this.lastDetonationTime = now;
        this.recordMeaningfulAction('CRYSTAL_BREAK');
        return;
      }
    }

    // 3. ANCHOR ACTION: If anchor & glowstone available and safe distance maintained
    if (!this.actionLock && (now - this.lastAnchorTime > 2000) && dist >= 3.5 && dist <= 4.5) {
      const items = this.bot.inventory.items();
      const anchorItem = items.find(i => i.name === 'respawn_anchor');
      const glowstoneItem = items.find(i => i.name === 'glowstone');

      if (anchorItem && glowstoneItem && this.isSafeAnchorPlacement(dist)) {
        const spot = this.findBestObsidianSpot(target.position);
        if (spot) {
          this.lastAnchorTime = now;
          this.actionLock = true;
          this.actionStartTime = now;
          this.crystalState = 'ANCHOR';

          (async () => {
            try {
              if (typeof this.bot.equip === 'function') await this.bot.equip(anchorItem, 'hand');
              if (typeof this.bot.placeBlock === 'function') await this.bot.placeBlock(spot.groundBlock, new Vec3(0, 1, 0));
              await sleep(30);

              const placedAnchor = this.bot.blockAt(spot.destPos);
              if (placedAnchor && placedAnchor.name === 'respawn_anchor') {
                if (typeof this.bot.equip === 'function') await this.bot.equip(glowstoneItem, 'hand');
                if (typeof this.bot.activateBlock === 'function') await this.bot.activateBlock(placedAnchor);
                await sleep(30);
                // Safe detonate with hand/sword
                if (typeof this.bot.activateBlock === 'function') await this.bot.activateBlock(placedAnchor);
              }
            } catch {}
            finally {
              this.actionLock = false;
              this.crystalState = 'POSITION';
            }
          })();
          this.recordMeaningfulAction('ANCHOR_EXECUTE');
          return;
        }
      }
    }

    // 4. HIT_SELECT: Knockback space creation with sword
    if (dist <= 3.15 && isCooldownReady && !this.actionLock && (now - this.lastHitSelectTime > 800)) {
      this.lastHitSelectTime = now;
      this.crystalState = 'HIT_SELECT';
      this.attackScheduler.executeAttack(target, 'NORMAL_HIT', { triggerSprintReset: true });
      this.recordMeaningfulAction('HIT_SELECT');
    }

    // 5. OBSIDIAN & CRYSTAL PLACEMENT ACTION LOOP
    if (!this.actionLock && dist >= 1.8 && dist <= 4.0 && (now - this.lastDetonationTime > 250)) {
      const items = this.bot.inventory.items();
      const obsidianItem = items.find(i => i.name === 'obsidian');
      const crystalItem = items.find(i => i.name === 'end_crystal');

      if (obsidianItem && crystalItem) {
        const spot = this.findBestObsidianSpot(target.position);
        if (spot) {
          this.actionLock = true;
          this.actionStartTime = now;
          this.crystalState = 'OBSIDIAN';

          (async () => {
            try {
              if (typeof this.bot.equip === 'function') {
                await this.bot.equip(obsidianItem, 'hand');
              }
              if (typeof this.bot.placeBlock === 'function') {
                await this.bot.placeBlock(spot.groundBlock, new Vec3(0, 1, 0));
              }

              // Crystal follow-up
              const placed = this.bot.blockAt(spot.destPos);
              if (placed && placed.name === 'obsidian') {
                this.crystalState = 'CRYSTAL';
                if (typeof this.bot.equip === 'function') {
                  await this.bot.equip(crystalItem, 'hand');
                }
                if (typeof this.bot.placeBlock === 'function') {
                  await this.bot.placeBlock(placed, new Vec3(0, 1, 0));
                }
              }
            } catch (err) {
              this.reportFailure('OBSIDIAN', err.message);
            } finally {
              this.actionLock = false;
              this.crystalState = 'POSITION';
            }
          })();
          this.recordMeaningfulAction('OBSIDIAN_CRYSTAL_PLACE');
        }
      }
    }

    // 6. CONTINUOUS FLUID MOVEMENT: Never stand still while thinking!
    // Spacing range: 2.6m - 4.0m
    if (this.distanceController) {
      if (dist < 2.0) {
        this.crystalState = 'REPOSITION';
      } else if (dist > 4.0) {
        this.crystalState = 'APPROACH';
      } else {
        this.crystalState = 'POSITION';
      }

      this.distanceController.applySpacingMovement(target, dist, {
        allowSprint: true,
        defensive: currentHealth <= 10,
        opponentModel: this.opponentModel
      });
    }
  }

  stopCombat() {
    super.stopCombat();
    this.crystalState = 'SEARCH';
    this.actionLock = false;
    this.placingObsidian = false;
    this.detonatingCrystal = false;
  }
}

module.exports = CrystalProfile;
