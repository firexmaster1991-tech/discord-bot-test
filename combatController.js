const { Vec3 } = require('vec3');
const {
  detectCombatVersion,
  getWeaponAttackSpeed,
  getWeaponRecoveryMs,
  isAttackReady,
  getCombatProfile
} = require('./combatProfiles');
const CriticalAttackController = require('./criticalAttackController');
const CritChainController = require('./critChainController');
const CombatMovementController = require('./movementController');
const CombatDistanceController = require('./combatDistanceController');
const PotionInventoryManager = require('./potionInventoryManager');
const CrystalPvPController = require('./cpvpController');
const OpponentModel = require('./opponentModel');
const AttackScheduler = require('./attackScheduler');
const BenchmarkManager = require('./benchmarkManager');
const ResourcePredictor = require('./resourcePredictor');
const PvPCombatStateMachine = require('./pvpStateMachine');
const PvPProfileManager = require('./profiles/pvpProfileManager');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Authoritative Central Combat Controller for Minecraft PvP Bot.
 * 
 * Implements the 14-State Combat Machine:
 * IDLE, TARGETING, APPROACH, COMBO, CRIT_SETUP, CRIT_CHAIN, P_CRIT,
 * HEAL_GAPPLE, HEAL_POTION, BUFF_CHECK, BUFF_REFRESH, REPOSITION, RECOVER, FINISH.
 * 
 * Strict Action Locks:
 * - healingActionLock: Active during HEAL_GAPPLE. Forbids sword switches, attacks, combos, crits, S-taps.
 * - critLock: Active during CRIT_CHAIN / P_CRIT. Prevents concurrent grounded hits.
 * - potionLock: Prevents concurrent potion actions.
 * - consumeLock: Prevents item switches while drinking/eating.
 * - attackLock: Mutex over attack calls.
 */
class CombatController {
  constructor(bot = null, options = {}) {
    this.bot = bot;
    this.serverProfile = options.serverProfile || null;
    this.gamemode = options.gamemode || 'Default';

    // Subsystems
    this.movementController = new CombatMovementController(bot);
    this.distanceController = new CombatDistanceController(bot, this.movementController);

    this.combatVersion = detectCombatVersion(bot, this.serverProfile);
    this.currentProfile = getCombatProfile(this.gamemode);

    this.critController = new CriticalAttackController(bot, this.movementController, {
      combatVersion: this.combatVersion,
      debug: options.debug !== false
    });
    this.critChainController = new CritChainController(bot, this.movementController, {
      combatVersion: this.combatVersion,
      debug: options.debug !== false
    });

    this.potionManager = new PotionInventoryManager(bot, {
      healThresholdHP: options.healThresholdHP || 10
    });
    this.cpvpController = new CrystalPvPController(bot, this.movementController);

    // Advanced Subsystems
    this.opponentModel = new OpponentModel(bot);
    this.attackScheduler = new AttackScheduler(bot, this.movementController, {
      combatVersion: this.combatVersion,
      debug: options.debug !== false
    });
    this.stateMachine = new PvPCombatStateMachine({ debug: options.debug !== false });
    this.benchmark = new BenchmarkManager({ debug: options.debug !== false });
    this.resourcePredictor = new ResourcePredictor(bot);

    this.profileManager = new PvPProfileManager({
      bot: this.bot,
      movementController: this.movementController,
      distanceController: this.distanceController,
      attackScheduler: this.attackScheduler,
      potionManager: this.potionManager,
      opponentModel: this.opponentModel,
      stateMachine: this.stateMachine,
      benchmark: this.benchmark
    });
    this.layoutManager = this.profileManager.layoutManager;
    this.profileManager.setActiveProfile(this.gamemode);

    // 14 Combat States
    this.state = 'IDLE';
    this.phase = 'OPENING'; // Mapped legacy phase for backwards compatibility
    this.combatActive = false;
    this.target = null;
    this.prevTargetPos = null;
    this.targetComboHits = this.currentProfile.critComboHitsBeforeChain || 3;
    this.targetCritHits = this.currentProfile.critChainMaxHits || 2;
    this.healingDisengageActive = false;

    // Reset aim smoothing at the start of every fight.
    if (this.movementController) {
      this.movementController.prevTargetPos = null;
      this.movementController.targetVelocity = new Vec3(0, 0, 0);
      this.movementController.lastAimYaw = null;
      this.movementController.lastAimPitch = null;
      this.movementController.lastAimTime = 0;
    }

    // Strict Action Locks
    this.healingActionLock = false;
    this.critLock = false;
    this.potionLock = false;
    this.consumeLock = false;
    this.inventoryLock = false;
    this.attackLock = false;

    // Gapple target health
    this.gappleTargetHP = options.gappleTargetHP || 15;

    // Cadence & Counters
    this.lastAttackTime = 0;
    this.comboCount = 0;
    this.critCount = 0;
    this.targetComboHits = this.currentProfile.critComboHitsBeforeChain || 3;
    this.targetCritHits = this.currentProfile.critChainMaxHits || 2;
    this.healingDisengageActive = false;
    this.isWtapping = false;
    this.prevDistance = null;

    // Periodic Check Timers
    this.lastTotemCheck = 0;
    this.lastReplenishCheck = 0;
    this.lastBuffCheck = 0;

    // Telemetry & Debug
    this.debug = options.debug !== false;
  }

  /**
   * Initializes or updates the bot reference and propagates across subsystems.
   */
  setBot(bot, serverProfile = null) {
    this.bot = bot;
    if (serverProfile) this.serverProfile = serverProfile;
    this.combatVersion = detectCombatVersion(bot, this.serverProfile);

    if (this.movementController) this.movementController.bot = bot;
    if (this.distanceController) this.distanceController.setBot(bot, this.movementController);

    if (this.critController) {
      this.critController.bot = bot;
      this.critController.movementController = this.movementController;
      this.critController.combatVersion = this.combatVersion;
    }
    if (this.critChainController) {
      this.critChainController.setBot(bot, this.movementController);
      this.critChainController.combatVersion = this.combatVersion;
    }
    if (this.potionManager) {
      this.potionManager.bot = bot;
    }
    if (this.cpvpController) {
      this.cpvpController.setBot(bot, this.movementController);
    }
    if (this.opponentModel) this.opponentModel.setBot(bot);
    if (this.attackScheduler) this.attackScheduler.setBot(bot, this.movementController);
    if (this.resourcePredictor) this.resourcePredictor.setBot(bot);
    if (this.profileManager) {
      this.profileManager.setContext({
        bot: this.bot,
        movementController: this.movementController,
        distanceController: this.distanceController,
        attackScheduler: this.attackScheduler,
        potionManager: this.potionManager,
        opponentModel: this.opponentModel,
        stateMachine: this.stateMachine,
        benchmark: this.benchmark
      });
    }
  }

  setGamemode(gamemode) {
    this.gamemode = gamemode;
    this.currentProfile = getCombatProfile(gamemode);
    if (this.profileManager) {
      this.profileManager.setActiveProfile(gamemode);
    }
  }

  setProfile(gamemode) {
    return this.setGamemode(gamemode);
  }

  /**
   * Starts combat engagement against a target with start-of-fight buff check.
   */
  async startCombat(targetEntity) {
    this.stopCombat();
    this.target = targetEntity;
    this.combatActive = true;
    this.state = 'TARGETING';
    this.phase = 'PRESSURE';
    this.comboCount = 0;
    this.critCount = 0;
    this.lastAttackTime = 0;
    this.prevTargetPos = null;
    this.targetComboHits = this.currentProfile.critComboHitsBeforeChain || 3;
    this.targetCritHits = this.currentProfile.critChainMaxHits || 2;
    this.healingDisengageActive = false;

    if (this.opponentModel) this.opponentModel.setTarget(targetEntity);
    if (this.benchmark) this.benchmark.reset();
    if (this.resourcePredictor) this.resourcePredictor.scanResources();
    if (this.profileManager) this.profileManager.startCombat(targetEntity);

    // Sync subsystems
    this.combatVersion = detectCombatVersion(this.bot, this.serverProfile);
    this.critController.combatVersion = this.combatVersion;
    this.critController.reset();
    this.critChainController.combatVersion = this.combatVersion;
    this.critChainController.maxChainHits = this.currentProfile.critChainMaxHits || 4;
    this.critChainController.reset();

    // Release all locks
    this.healingActionLock = false;
    this.critLock = false;
    this.potionLock = false;
    this.consumeLock = false;
    this.attackLock = false;

    if (this.movementController) {
      this.movementController.clearAllControls();
      this.movementController.setState('APPROACH');
    }

    console.log(`⚔️ [COMBAT] Started 14-state combat against ${targetEntity.username || targetEntity.name || 'target'} [Version: ${this.combatVersion}]`);

    // SECTION 3 & 24: START-OF-FIGHT BUFF CHECK
    // If Strength or Speed is already in effect from the server/kit, strictly prevent throwing!
    if (this.potionManager) {
      this.state = 'BUFF_CHECK';
      this.potionManager.checkStartOfMatchBuffs();
      this.potionManager.preStagePotions().catch(() => {});
      this.state = 'APPROACH';
    }
  }

  /**
   * Stops combat cleanly, resets controls, and releases all action locks.
   */
  stopCombat() {
    this.combatActive = false;
    this.target = null;
    this.state = 'IDLE';
    this.phase = 'IDLE';

    if (this.opponentModel) this.opponentModel.reset();
    if (this.profileManager) this.profileManager.stopCombat();

    // Release all action locks
    this.healingActionLock = false;
    this.critLock = false;
    this.potionLock = false;
    this.consumeLock = false;
    this.attackLock = false;

    if (this.critController) {
      this.critController.reset();
    }
    if (this.critChainController) {
      this.critChainController.reset();
    }
    if (this.movementController) {
      this.movementController.setState('IDLE');
      this.movementController.clearAllControls();
      this.movementController.lastAimYaw = null;
      this.movementController.lastAimPitch = null;
    }
    if (this.potionManager) {
      this.potionManager.potionOperationLock = false;
      this.potionManager.isUsingPotion = false;
      this.potionManager.isEating = false;
      this.potionManager.healingActionLock = false;
    }
    if (this.cpvpController) {
      this.cpvpController.clearAction();
    }
  }

  isWeaponCooldownReady(now = Date.now()) {
    if (this.combatVersion === 'classic') {
      return isAttackReady(this.lastAttackTime, 'sword', 'classic', now);
    }
    const heldItem = this.bot && this.bot.heldItem;
    const itemName = heldItem ? heldItem.name : 'hand';
    return isAttackReady(this.lastAttackTime, itemName, 'modern', now);
  }

  /**
   * Ultra-short W-tap (35-50ms) to reset sprint knockback without creating combat delay.
   */
  triggerWTap() {
    if (this.isWtapping || !this.movementController) return;
    this.isWtapping = true;

    this.movementController.setControl('sprint', false);
    setTimeout(() => {
      if (this.combatActive && this.movementController) {
        this.movementController.setControl('sprint', true);
      }
      this.isWtapping = false;
    }, 45);
  }

  /**
   * Ultra-short S-tap (35-45ms).
   * Strict priority: HIT > POSITION > SPRINT_RESET. Never delays attack.
   */
  triggerSTap(durationMs = 40) {
    if (this.isWtapping || !this.movementController) return;
    this.isWtapping = true;

    this.movementController.setControl('sprint', false);
    this.movementController.setControl('forward', false);
    this.movementController.setControl('back', true);

    setTimeout(() => {
      if (this.combatActive && this.movementController) {
        this.movementController.setControl('back', false);
        this.movementController.setControl('forward', true);
        this.movementController.setControl('sprint', true);
      }
      this.isWtapping = false;
    }, durationMs);
  }

  /**
   * Evaluates the 14 Combat States & maps backwards-compatible phases.
   */
  evaluatePhase(dist, currentHealth, targetHealth) {
    // 1. Golden Apple Healing Lock
    if (this.healingActionLock || (this.potionManager && this.potionManager.isEating)) {
      this.state = 'HEAL_GAPPLE';
      return 'HEALING';
    }

    // 2. Health Potion Mode (HP <= 5)
    if (currentHealth <= 5 && this.potionManager && this.potionManager.hasPotion('HEALING')) {
      this.state = 'HEAL_POTION';
      return 'HEALING';
    }

    // 3. Golden Apple Mode (HP <= 10)
    if (currentHealth <= this.potionManager.healThresholdHP && this.potionManager && this.potionManager.hasGoldenApples()) {
      this.state = 'HEAL_GAPPLE';
      return 'HEALING';
    }

    // 4. Low Health General
    if (currentHealth <= this.potionManager.healThresholdHP) {
      this.state = 'HEAL_GAPPLE';
      return 'HEALING';
    }

    // 5. Opponent Low: FINISH (relentless aggressive pressure!)
    if (targetHealth != null && targetHealth <= 7 && dist <= 4.0) {
      this.state = 'FINISH';
      return 'FINISH';
    }

    // 6. Airborne Crit Chain or Reactive P-Crit
    if (this.critChainController && this.critChainController.isInCritSequence()) {
      this.state = this.critChainController.mode === 'P_CRIT' ? 'P_CRIT' : 'CRIT_CHAIN';
      return 'CRITICAL_ATTACK';
    }

    // 7. Airborne Single Crit
    if (this.critController && this.critController.isInCritSequence()) {
      this.state = 'CRIT_CHAIN';
      return 'CRITICAL_ATTACK';
    }

    // 8. Crit Setup
    if (this.state === 'CRIT_SETUP' || this.phase === 'CRITICAL_SETUP') {
      this.state = 'CRIT_SETUP';
      return 'CRITICAL_SETUP';
    }

    // 9. Hitbox Intrusion (< 1.6m): Emergency Reposition while continuing attacks!
    if (dist < (this.distanceController ? this.distanceController.minSafeDistance : 1.6)) {
      this.state = 'REPOSITION';
      return 'REPOSITION';
    }

    // 10. Long Distance: APPROACH / PRESSURE
    if (dist > this.currentProfile.chaseDistance) {
      this.state = 'APPROACH';
      return 'PRESSURE';
    }

    // 11. Close Engagement: COMBO
    if (dist >= this.currentProfile.idealMinRange && dist <= this.currentProfile.idealMaxRange) {
      this.state = 'COMBO';
      return 'COMBO';
    }

    this.state = 'COMBO';
    return 'PRESSURE';
  }

  /**
   * Single Centralized Attack Scheduler:
   * Sole authority over all player attack execution.
   * Guarantees strict mutual exclusion between combos, crits, and healing actions.
   */
  scheduleAttack(target, dist, isCooldownReady, now = Date.now()) {
    if (!this.bot || !this.bot.entity || !target || !target.position) return;

    // STRICT ACTION LOCK: Forbids attacks during golden apple eating or potion use!
    if (this.healingActionLock || (this.potionManager && (this.potionManager.isEating || this.potionManager.isUsingPotion))) {
      return;
    }
    if (this.attackLock) return;

    const onGround = Boolean(this.bot.entity.onGround);

    // 1. Crit Chain / Reactive P-Crit priority
    if (this.critChainController && this.critChainController.isInCritSequence()) {
      this.critLock = true;
      const res = this.critChainController.update(target, dist, isCooldownReady, now);
      if (this.critController) {
        this.critController.state = this.critChainController.state;
      }
      if (res.attacked) {
        this.lastAttackTime = now;
        this.critCount++;
        this.phase = 'CRITICAL_ATTACK';
      }
      return;
    }

    // 2. Single-Crit fallback
    if (this.critController && this.critController.isInCritSequence()) {
      this.critLock = true;
      const res = this.critController.update(target, dist, isCooldownReady, now, this);
      if (res.attacked) {
        this.lastAttackTime = now;
        this.critCount++;
        this.phase = 'CRITICAL_ATTACK';
      }
      return;
    }

    this.critLock = false;

    // 3. Fallback check: if target escaped (> 3.4m), maintain grounded COMBO/PRESSURE
    if ((this.state === 'CRIT_SETUP' || this.phase === 'CRITICAL_SETUP') && dist > 3.4) {
      this.state = 'COMBO';
      this.phase = 'PRESSURE';
      this.comboCount = 0;
    }

    // 4. Critical Strike Initiation
    const isNethPot = this.gamemode && String(this.gamemode).toLowerCase().includes('nethpot');
    const canCrit = this.currentProfile.allowJumpCrits &&
                    (this.bot.health == null || this.bot.health > 10) &&
                    onGround &&
                    dist >= 1.2 && dist <= 3.25;

    const shouldCrit = canCrit && (
      isNethPot ||
      this.currentProfile.name === 'NoDebuff' ||
      this.state === 'CRIT_SETUP' ||
      this.phase === 'CRITICAL_SETUP' ||
      this.comboCount >= this.targetComboHits
    );

    if (shouldCrit) {
      this.state = 'CRIT_CHAIN';
      this.phase = 'CRITICAL_ATTACK';

      let started = false;
      if (this.critChainController) {
        started = this.critChainController.startChain(target, dist, isCooldownReady, now);
      }
      if (!started && this.critController) {
        started = this.critController.startCrit(target, dist, isCooldownReady, now);
      }

      if (started) {
        if (this.critController) {
          this.critController.state = this.critChainController ? this.critChainController.state : 'JUMP_START';
        }
        this.critCount = 0;
        this.critLock = true;
        return;
      }
      return;
    }

    // 5. Grounded Combo Hit Execution
    // Fires only when grounded, cooldown ready, within reach, and not in crit sequence
    // Also executes during REPOSITION (hitbox recovery) so the bot NEVER ceases attacking!
    if (onGround && dist <= 3.2 && isCooldownReady) {
      // Route grounded attacks through the authoritative AttackScheduler.
      // This prevents multiple combat subsystems from independently dispatching
      // attacks/sprint resets and keeps attack timing centralized.
      const attacked = this.attackScheduler
        ? this.attackScheduler.executeAttack(target, 'NORMAL_HIT', {
            isCooldownReady: true,
            triggerSprintReset: true
          })
        : false;

      if (attacked) {
        this.lastAttackTime = now;
        this.comboCount++;
        if (this.state !== 'FINISH') {
          this.state = 'COMBO';
          this.phase = 'COMBO';
        }

        // Transition to critical setup when target combo count reached
        if (this.state !== 'FINISH' &&
            this.comboCount >= this.targetComboHits &&
            this.currentProfile.allowJumpCrits) {
          this.state = 'CRIT_SETUP';
          this.phase = 'CRITICAL_SETUP';
          this.critCount = 0;
        }
      }
    }
  }

  /**
   * Synchronous physics tick update (runs at 20 TPS).
   */
  update(targetEntity = null) {
    if (!this.combatActive || !this.bot || !this.bot.entity) {
      return;
    }

    const target = targetEntity || this.target;
    if (!target || !target.position) {
      this.state = 'IDLE';
      if (this.movementController) this.movementController.setState('IDLE');
      return;
    }

    const now = Date.now();
    if (this.benchmark) this.benchmark.updateTps();
    if (this.opponentModel) this.opponentModel.update(target);

    const currentHealth = this.bot.health != null ? this.bot.health : 20;
    const targetHealth = target.health != null ? target.health : null;
    const botPos = this.bot.entity.position;
    const targetPos = target.position;
    const dist = botPos.distanceTo(targetPos);
    if (this.benchmark) this.benchmark.recordDistance(dist);

    // 0. PATHFINDER FALLBACK GUARD
    if (this.bot.pathfinder && typeof this.bot.pathfinder.isMoving === 'function' && this.bot.pathfinder.isMoving()) {
      if (dist < 15) {
        try { this.bot.pathfinder.stop(); } catch {}
      }
    }

    // 1. HEALING ACTION LOCK: Active eating / potion in progress!
    // Turn back to enemy, press W + Sprint away, actively run away if enemy is chasing! FORBID weapon swaps & attacks!
    const isHealing = this.healingActionLock ||
                      (this.potionManager && (this.potionManager.isEating || this.potionManager.isUsingPotion)) ||
                      this.potionLock;

    if (isHealing) {
      this.state = (this.potionManager && this.potionManager.isUsingPotion) ? 'HEAL_POTION' : 'HEAL_GAPPLE';
      this.phase = 'HEALING';

      // Turn back to enemy (aim away from target into open escape path)
      this.movementController.aimAwayFromTarget(target);

      // Check if enemy is actively chasing the bot:
      // Distance closing, opponent model detecting chase, or opponent within pursuit range (< 6m)
      const enemyClosing = (this.prevDistance != null && (this.prevDistance - dist) > 0.02);
      const isChasing = (this.opponentModel && this.opponentModel.isChasing) ||
                        enemyClosing ||
                        dist < 6.0;

      // STRICT RULE: Press W (forward: true) and SPRINT away! NEVER press S (back: false)!
      this.movementController.setState('CHASE');
      this.movementController.setControl('forward', true);
      this.movementController.setControl('back', false);
      this.movementController.setControl('sprint', true);
      this.movementController.setControl('sneak', false);
      this.movementController.setControl('left', false);
      this.movementController.setControl('right', false);

      // If enemy is chasing or bot encounters a 1-block obstacle, jump-sprint away
      const onGround = Boolean(this.bot.entity.onGround);
      if (this.bot.entity.isCollidedHorizontally) {
        this.movementController.requestJump(true);
      } else if (isChasing && onGround && dist < 5.0) {
        this.movementController.requestJump(false);
      }

      this.prevDistance = dist;

      // Reached target HP (~15 HP)? Resume normal pressure and let the
      // distance controller close the gap again.
      if (currentHealth >= this.gappleTargetHP) {
        this.healingActionLock = false;
        this.healingDisengageActive = false;
        this.comboCount = 0;
        this.state = 'COMBO';
        this.phase = 'COMBO';
      }
      return;
    }

    // 2. SURVIVAL & HEALTH HEALING (Priority #1)
    // Priority: HP <= 5 -> HEAL_POTION; HP <= 10 -> HEAL_GAPPLE
    const hasHealingPotions = this.potionManager && typeof this.potionManager.hasPotion === 'function' ? this.potionManager.hasPotion('HEALING') : false;
    const hasGapples = this.potionManager && typeof this.potionManager.hasGoldenApples === 'function' ? this.potionManager.hasGoldenApples() : false;

    const isNethPot = this.gamemode && String(this.gamemode).toLowerCase().includes('nethpot');
    const healDisengageDistance = this.currentProfile.healDisengageDistance || 4.2;

    // Disengage safely before splash potting: if in NethPot without gapples and too close,
    // turn back to enemy, press W + Sprint to create safe distance without eating melee hits
    if (isNethPot && currentHealth <= 10 && hasHealingPotions && !hasGapples && dist < healDisengageDistance) {
      this.healingDisengageActive = true;
      this.state = 'HEAL_POTION';
      this.phase = 'HEALING';
      this.movementController.aimAwayFromTarget(target);
      this.movementController.setState('CHASE');
      this.movementController.setControl('forward', true);
      this.movementController.setControl('back', false);
      this.movementController.setControl('sprint', true);
      this.movementController.setControl('sneak', false);
      this.movementController.setControl('left', false);
      this.movementController.setControl('right', false);
      if (this.bot.entity.isCollidedHorizontally) {
        this.movementController.requestJump(true);
      }
      this.prevDistance = dist;
      return;
    }

    if (currentHealth <= 5 && hasHealingPotions && !this.potionManager.isUsingPotion) {
      this.healingDisengageActive = false;
      this.state = 'HEAL_POTION';
      this.phase = 'HEALING';
      this.potionLock = true;
      this.movementController.aimAwayFromTarget(target);
      this.movementController.setState('CHASE');
      this.movementController.setControl('forward', true);
      this.movementController.setControl('back', false);
      this.movementController.setControl('sprint', true);
      this.movementController.setControl('sneak', false);
      this.movementController.setControl('left', false);
      this.movementController.setControl('right', false);
      this.potionManager.usePotion('HEALING', target).finally(() => { this.potionLock = false; });
      this.prevDistance = dist;
      return;
    } else if (currentHealth <= 10 && hasGapples && !this.potionManager.isEating && !this.healingActionLock) {
      this.healingDisengageActive = false;
      this.state = 'HEAL_GAPPLE';
      this.phase = 'HEALING';
      this.healingActionLock = true;
      this.movementController.aimAwayFromTarget(target);
      this.movementController.setState('CHASE');
      this.movementController.setControl('forward', true);
      this.movementController.setControl('back', false);
      this.movementController.setControl('sprint', true);
      this.movementController.setControl('sneak', false);
      this.movementController.setControl('left', false);
      this.movementController.setControl('right', false);
      this.potionManager.eatGoldenApple().finally(() => { this.healingActionLock = false; });
      this.prevDistance = dist;
      return;
    } else if (currentHealth <= 10 && hasHealingPotions && !this.potionManager.isUsingPotion) {
      this.healingDisengageActive = false;
      this.state = 'HEAL_POTION';
      this.phase = 'HEALING';
      this.potionLock = true;
      this.movementController.aimAwayFromTarget(target);
      this.movementController.setState('CHASE');
      this.movementController.setControl('forward', true);
      this.movementController.setControl('back', false);
      this.movementController.setControl('sprint', true);
      this.movementController.setControl('sneak', false);
      this.movementController.setControl('left', false);
      this.movementController.setControl('right', false);
      this.potionManager.usePotion('HEALING', target).finally(() => { this.potionLock = false; });
      this.prevDistance = dist;
      return;
    }

    // 3. SAFE MICRO-WINDOW BUFF CHECK (Strength & Speed maintenance)
    // Never interrupt critical sequence or eating for buffs!
    if (now - this.lastBuffCheck > 800 && this.distanceController && this.distanceController.isSafeBuffWindow(target, dist, currentHealth)) {
      this.lastBuffCheck = now;
      this.potionManager.evaluateBuffMaintenance();
    }

    // 4. SAFE MICRO-WINDOW REPLENISHMENT
    const isCritActiveNow = (this.critChainController && this.critChainController.isInCritSequence()) || (this.critController && this.critController.isInCritSequence());
    if (now - this.lastReplenishCheck > 2500 && !isCritActiveNow && dist > 3.4) {
      this.lastReplenishCheck = now;
      this.potionManager.replenishHotbarPotions(true);
    }

    // 5. WEAPON ATTACK COOLDOWN CHECK
    const isCooldownReady = this.isWeaponCooldownReady(now);

    // 6. EXECUTE COMBAT PHASE & DELEGATION
    this.phase = this.evaluatePhase(dist, currentHealth, targetHealth);

    const activeProf = this.profileManager ? this.profileManager.getActiveProfile() : null;

    // Every gamemode is driven by its dedicated profile. Do not split Sword/NethPot
    // into the legacy generic scheduler: doing so bypasses their profile state
    // machines and makes profile-specific movement/attack logic inconsistent.
    if (activeProf && this.profileManager) {
      this.profileManager.update(target, dist, currentHealth, targetHealth, isCooldownReady, now);
      if (activeProf.currentState) {
        this.phase = activeProf.currentState;
      }
    } else {
      // Safe fallback only if the profile manager is unavailable.
      this.scheduleAttack(target, dist, isCooldownReady, now);
    }

    // 7. PREDICTIVE CROSSHAIR AIMING
    const isAirborne = Boolean(!this.bot.entity.onGround);
    const isCritActive = isCritActiveNow || this.state === 'CRIT_SETUP' || this.phase === 'CRITICAL_SETUP';
    const aimHeight = (isAirborne && isCritActive) ? 1.62 : 1.30;

    const predPos = this.opponentModel ? this.opponentModel.getPredictedPosition(0.12) : null;
    const aimTarget = (predPos && predPos.distanceTo(target.position) < 1.5)
      ? { position: predPos, yaw: target.yaw, pitch: target.pitch }
      : target;

    this.movementController.aimAtTarget(aimTarget, aimHeight, 0.12);

    // 8. DECOUPLED DISTANCE & MOVEMENT CONTROL
    if (dist > (this.currentProfile.chaseDistance || 3.5)) {
      this.isWtapping = false;
    }
    const allowSprint = (!this.isWtapping || dist > 3.4) && !isCritActiveNow && this.phase !== 'CRITICAL_ATTACK';
    if (this.distanceController) {
      this.distanceController.applySpacingMovement(target, dist, {
        allowSprint,
        opponentModel: this.opponentModel,
        aggressive: !isCritActiveNow
      });

      // Keep target in reach and maintain forward trajectory during airborne critical hits
      // Strictly prevent mid-air backpedaling or freezing that causes combat fluctuation!
      if (isCritActiveNow) {
        this.movementController.setControl('forward', dist >= 1.0);
        this.movementController.setControl('back', false);
        if (this.combatVersion === 'modern') {
          this.movementController.setControl('sprint', false);
        }
        this.movementController.setControl('sneak', false);
      }
    }
    this.prevDistance = dist;
  }

  /**
   * Preflight health check for Section 6.
   */
  async preflight() {
    if (this.profileManager) {
      return await this.profileManager.preflight();
    }
    return { success: true, reason: 'Ready' };
  }

  /**
   * Section 35: Profile Debug Dashboard.
   */
  getDebugStatus(target = null) {
    if (this.profileManager) {
      return this.profileManager.getDebugStatus(target || this.target);
    }
    return {
      profile: this.gamemode,
      state: this.state,
      target: (target || this.target)?.username || 'none'
    };
  }
}

module.exports = CombatController;
