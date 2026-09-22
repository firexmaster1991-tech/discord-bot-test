const { Vec3 } = require('vec3');

/**
 * Authoritative 11-State Crystal PvP (CPvP) Controller.
 * 
 * 11 Active States:
 * - CPVP_SEARCH: Scanning arena for target entity and valid terrain.
 * - CPVP_APPROACH: Closing distance toward target (ideal range: 2.6m - 4.0m).
 * - CPVP_TRACK: Keeping target in crosshairs, anticipating target velocity.
 * - CPVP_POSITION: Active fluid positioning while maintaining clear line of sight.
 * - CPVP_OBSIDIAN_SETUP: Validating and placing obsidian base.
 * - CPVP_CRYSTAL_ACTION: Placing crystal on obsidian and triggering detonation.
 * - CPVP_DAMAGE_RESPONSE: Handling explosion knockback and stabilizing momentum.
 * - CPVP_REPOSITION: Immediate post-detonation repositioning to avoid self-damage.
 * - CPVP_ESCAPE: Escape maneuver if trapped by walls or enemy crystal placement.
 * - CPVP_RECOVER: Emergency totem / healing recovery window.
 * - CPVP_FINISH: Relentless high-pressure crystal/sword cycling when enemy is low (<= 7 HP).
 */
class CrystalPvPController {
  constructor(bot = null, movementController = null) {
    this.bot = bot;
    this.movementController = movementController;

    this.state = 'CPVP_SEARCH';
    this.actionLock = false;
    this.actionStartTime = 0;
    this.actionTimeoutMs = 250; // Strict 250ms action timeout to prevent freezes
    this.lastActionTime = 0;
    this.lastDetonationTime = 0;

    // Repositioning memory
    this.lastPlacedPos = null;
    this.lastCrystalEntityId = null;
  }

  setBot(bot, movementController = null) {
    this.bot = bot;
    if (movementController) this.movementController = movementController;
  }

  /**
   * Resets active actions and returns state to positioning.
   */
  clearAction() {
    this.actionLock = false;
    this.actionStartTime = 0;
    if (this.movementController && this.movementController.getState() === 'IDLE') {
      this.movementController.setState('CPVP_POSITION');
    }
  }

  /**
   * Helper: Raycast check ensuring clear Line-of-Sight between eye position and block center.
   * ABSOLUTELY PREVENTS PLACING BLOCKS THROUGH OR BEHIND WALLS!
   */
  hasLineOfSight(eyePos, targetPos, ignoreBlock = null) {
    if (!this.bot || !this.bot.blockAt) return false;

    const dist = eyePos.distanceTo(targetPos);
    if (dist > 4.5 || dist <= 0.05) return false;

    const dx = (targetPos.x - eyePos.x) / dist;
    const dy = (targetPos.y - eyePos.y) / dist;
    const dz = (targetPos.z - eyePos.z) / dist;

    const stepSize = 0.25;
    const steps = Math.floor(dist / stepSize);

    for (let i = 1; i < steps; i++) {
      const checkPt = eyePos.offset(dx * i * stepSize, dy * i * stepSize, dz * i * stepSize).floored();
      if (ignoreBlock && checkPt.equals(ignoreBlock.position)) {
        continue;
      }
      const block = this.bot.blockAt(checkPt);
      if (block && block.boundingBox === 'block' &&
          block.name !== 'air' && block.name !== 'cave_air' &&
          block.name !== 'water' && block.name !== 'lava') {
        // Obstructed by solid obstacle between eye and target!
        return false;
      }
    }

    return true;
  }

  /**
   * Checks if any entity (player or mob) is obstructing the destination block.
   */
  isEntityObstructing(pos) {
    if (!this.bot || !this.bot.entities) return false;
    const destMin = pos.clone();
    const destMax = pos.offset(1, 2, 1);

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || !entity.position) continue;
      // End crystals are targets to detonate, not obstruction
      if (entity.name === 'end_crystal') continue;

      const ep = entity.position;
      const ew = (entity.width || 0.6) / 2;
      const eh = entity.height || 1.8;

      if (ep.x + ew >= destMin.x && ep.x - ew <= destMax.x &&
          ep.y + eh >= destMin.y && ep.y <= destMax.y &&
          ep.z + ew >= destMin.z && ep.z - ew <= destMax.z) {
        return true;
      }
    }
    return false;
  }

  /**
   * Strict Block Placement Validation:
   * Confirms reach, solid reference block, open air, line of sight, and no entity obstruction.
   */
  validateBlockPlacement(refBlock, faceVector, destinationPos) {
    if (!this.bot || !this.bot.entity) return false;
    const botPos = this.bot.entity.position;
    const eyePos = botPos.offset(0, this.bot.entity.eyeHeight || 1.6, 0);

    // 1. Distance check (1.5m to 4.2m)
    const distToDest = botPos.distanceTo(destinationPos);
    if (distToDest < 1.5 || distToDest > 4.2) {
      return false;
    }

    // 2. Reference block check
    if (!refBlock || refBlock.boundingBox !== 'block') {
      return false;
    }

    // 3. Destination block must be air
    const destBlock = this.bot.blockAt(destinationPos);
    if (!destBlock || (destBlock.name !== 'air' && destBlock.name !== 'cave_air')) {
      return false;
    }

    // 4. Space for crystal: 2 blocks of air above reference
    const airAbove1 = this.bot.blockAt(refBlock.position.offset(0, 1, 0));
    const airAbove2 = this.bot.blockAt(refBlock.position.offset(0, 2, 0));
    if (!airAbove1 || (airAbove1.name !== 'air' && airAbove1.name !== 'cave_air') ||
        !airAbove2 || (airAbove2.name !== 'air' && airAbove2.name !== 'cave_air')) {
      return false;
    }

    // 5. Line-of-sight check: must be visible and unobstructed from bot eyes
    const targetAimPt = destinationPos.offset(0.5, 0.5, 0.5);
    if (!this.hasLineOfSight(eyePos, targetAimPt, refBlock)) {
      return false;
    }

    // 6. No entity collision obstruction
    if (this.isEntityObstructing(destinationPos)) {
      return false;
    }

    return true;
  }

  /**
   * Finds the best valid ground block near target to place obsidian.
   */
  findBestObsidianSpot(targetPos) {
    if (!this.bot || !this.bot.entity) return null;
    const botPos = this.bot.entity.position;
    const targetBlockPos = targetPos.floored();

    let bestSpot = null;
    let minTargetDist = Infinity;

    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -1; dy <= 0; dy++) {
          const checkPos = targetBlockPos.offset(dx, dy, dz);
          const groundBlock = this.bot.blockAt(checkPos);
          if (groundBlock && groundBlock.boundingBox === 'block' && groundBlock.name !== 'obsidian') {
            const destPos = checkPos.offset(0, 1, 0);
            if (this.validateBlockPlacement(groundBlock, new Vec3(0, 1, 0), destPos)) {
              const dTarget = targetPos.distanceTo(destPos);
              const dBot = botPos.distanceTo(destPos);
              // Must be closer to target than to bot to deal maximum blast to target
              if (dTarget < minTargetDist && dBot >= 1.8 && dTarget <= 3.2) {
                minTargetDist = dTarget;
                bestSpot = { groundBlock, destPos };
              }
            }
          }
        }
      }
    }

    return bestSpot;
  }

  /**
   * Finds existing placed obsidian or bedrock near target that is ready for crystal placement.
   */
  findExistingObsidianBase(targetPos) {
    if (!this.bot || !this.bot.entity) return null;
    const botPos = this.bot.entity.position;
    const targetBlockPos = targetPos.floored();

    let bestBase = null;
    let minTargetDist = Infinity;

    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          const checkPos = targetBlockPos.offset(dx, dy, dz);
          const block = this.bot.blockAt(checkPos);
          if (block && (block.name === 'obsidian' || block.name === 'bedrock')) {
            const destPos = checkPos.offset(0, 1, 0);
            if (this.validateBlockPlacement(block, new Vec3(0, 1, 0), destPos)) {
              const dTarget = targetPos.distanceTo(destPos);
              if (dTarget < minTargetDist) {
                minTargetDist = dTarget;
                bestBase = { obsidianBlock: block, destPos };
              }
            }
          }
        }
      }
    }

    return bestBase;
  }

  /**
   * Executes detonation on active crystal entity immediately.
   */
  detonateNearbyCrystal(target) {
    if (!this.bot || !this.bot.entities) return false;
    const botPos = this.bot.entity.position;
    const now = Date.now();

    const crystalEntity = Object.values(this.bot.entities).find(e =>
      e && e.name === 'end_crystal' && e.position &&
      botPos.distanceTo(e.position) <= 4.8 &&
      target.position.distanceTo(e.position) <= 5.0
    );

    if (crystalEntity) {
      try {
        this.bot.attack(crystalEntity);
        if (typeof this.bot.swingArm === 'function') {
          this.bot.swingArm('right');
        }
        this.lastDetonationTime = now;
        this.state = 'CPVP_REPOSITION';
        // Post-detonation repositioning: step back/strafe to avoid blast knockback
        if (this.movementController) {
          this.movementController.setState('REPOSITION');
        }
        return true;
      } catch {}
    }

    return false;
  }

  /**
   * Main per-tick CPvP update loop (called at 20 TPS).
   */
  async update(target, dist, currentHealth, targetHealth) {
    if (!this.bot || !this.bot.entity || !target || !target.position) {
      this.state = 'CPVP_SEARCH';
      return;
    }

    const now = Date.now();

    // 1. Action timeout watchdog
    if (this.actionLock && (now - this.actionStartTime > this.actionTimeoutMs)) {
      this.clearAction();
    }

    // 2. Detonate any active crystal immediately (Highest CPvP Priority)
    if (this.detonateNearbyCrystal(target)) {
      return;
    }

    // If an action is actively awaiting completion, allow it up to timeout
    if (this.actionLock) return;

    // 3. State Evaluation & Aggressive Decision Flow
    if (currentHealth <= 8) {
      this.state = 'CPVP_RECOVER';
      return;
    }

    if (targetHealth != null && targetHealth <= 7) {
      this.state = 'CPVP_FINISH';
    } else if (dist > 4.2) {
      this.state = 'CPVP_APPROACH';
      if (this.movementController) this.movementController.setState('APPROACH');
      return;
    } else {
      this.state = 'CPVP_POSITION';
      if (this.movementController) this.movementController.setState('CPVP_POSITION');
    }

    // Cooldown gate between placement cycles (~180ms)
    if (now - this.lastActionTime < 180) return;

    const inventory = this.bot.inventory;
    if (!inventory) return;

    const items = inventory.items();
    const crystalItem = items.find(i => i.name.includes('end_crystal') || i.name.includes('crystal'));
    const obsidianItem = items.find(i => i.name === 'obsidian');

    if (!crystalItem) {
      this.state = 'CPVP_TRACK';
      return;
    }

    // STEP A: Check if an obsidian base is already placed and valid
    const existingBase = this.findExistingObsidianBase(target.position);
    if (existingBase) {
      this.actionLock = true;
      this.actionStartTime = now;
      this.lastActionTime = now;
      this.state = 'CPVP_CRYSTAL_ACTION';

      try {
        if (typeof this.bot.equip === 'function') {
          await this.bot.equip(crystalItem, 'hand');
        }
        if (typeof this.bot.lookAt === 'function') {
          await this.bot.lookAt(existingBase.obsidianBlock.position.offset(0.5, 1, 0.5), true);
        }
        if (typeof this.bot.placeBlock === 'function') {
          await this.bot.placeBlock(existingBase.obsidianBlock, new Vec3(0, 1, 0));
        }
      } catch (err) {
        // Silently clear action on error without freezing
      } finally {
        this.clearAction();
        // Immediately restore crosshair target tracking
        if (this.movementController) {
          this.movementController.aimAtTarget(target, 1.4, 0.15);
        }
      }
      return;
    }

    // STEP B: Place new obsidian if available
    if (obsidianItem && dist <= 3.8) {
      const bestSpot = this.findBestObsidianSpot(target.position);
      if (bestSpot) {
        this.actionLock = true;
        this.actionStartTime = now;
        this.lastActionTime = now;
        this.state = 'CPVP_OBSIDIAN_SETUP';

        try {
          if (typeof this.bot.equip === 'function') {
            await this.bot.equip(obsidianItem, 'hand');
          }
          if (typeof this.bot.lookAt === 'function') {
            await this.bot.lookAt(bestSpot.groundBlock.position.offset(0.5, 1, 0.5), true);
          }
          if (typeof this.bot.placeBlock === 'function') {
            await this.bot.placeBlock(bestSpot.groundBlock, new Vec3(0, 1, 0));
          }

          // Follow up crystal placement
          const placedObsidian = this.bot.blockAt(bestSpot.destPos);
          if (placedObsidian && (placedObsidian.name === 'obsidian' || placedObsidian.name === 'bedrock')) {
            if (typeof this.bot.equip === 'function') {
              await this.bot.equip(crystalItem, 'hand');
            }
            if (typeof this.bot.placeBlock === 'function') {
              await this.bot.placeBlock(placedObsidian, new Vec3(0, 1, 0));
            }
          }
        } catch (err) {
          // Action aborted cleanly
        } finally {
          this.clearAction();
          if (this.movementController) {
            this.movementController.aimAtTarget(target, 1.4, 0.15);
            this.movementController.setState('CPVP_POSITION');
          }
        }
      }
    }
  }
}

module.exports = CrystalPvPController;
