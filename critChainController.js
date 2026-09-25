const { Vec3 } = require('vec3');

/**
 * Dedicated Crit Chain & Reactive P-Crit Controller.
 * 
 * Features:
 * 1. Sustained Crit Chains (up to 4 legitimate falling critical strikes with rapid repositioning).
 * 2. Reactive P-Crits: Uses incoming opponent knockback to convert vertical airtime into a legitimate critical counter-strike.
 * 3. Dynamic abort triggers:
 *    - Target moves away (> 3.4m) -> Aborts immediately to CHASE.
 *    - Target inside hitbox (< 1.5m) -> Aborts jump to maintain attack and establish spacing.
 * 4. Modern Java sprint hygiene: sprint is strictly released during airborne jump/fall to prevent sprint-knockback overrides.
 * 5. Full Section 8 Critical Telemetry logging.
 */
class CritChainController {
  constructor(bot = null, movementController = null, options = {}) {
    this.bot = bot;
    this.movementController = movementController;
    this.combatVersion = options.combatVersion || 'modern'; // 'modern' | 'classic'

    // Mode: 'IDLE' | 'CRIT_CHAIN' | 'P_CRIT'
    this.mode = 'IDLE';

    // State within a crit sequence:
    // 'IDLE' -> 'GROUND_READY' -> 'JUMP_START' -> 'RISING' -> 'APEX' -> 'FALLING' -> 'CRIT_ATTACK' -> 'LAND' -> 'REPOSITION'
    this.state = 'IDLE';

    // Chain metrics
    this.chainCount = 0;
    this.maxChainHits = options.maxChainHits || 4; // Up to 4 consecutive crits
    this.repositionTicks = 0;
    this.repositionDuration = 2; // 2 ticks (~100ms) rapid repositioning between jumps

    // Motion tracking
    this.peakY = 0;
    this.lastY = 0;
    this.jumpStartTime = 0;
    this.lastCritTime = 0;

    // Reactive P-crit tracking
    this.lastDamageTime = 0;
    this.pCritTriggered = false;

    this.debug = options.debug !== false;
    this.logger = options.logger || console.log;

    if (this.bot) {
      this.attachBotListeners();
    }
  }

  setBot(bot, movementController = null) {
    this.bot = bot;
    if (movementController) {
      this.movementController = movementController;
    }
    if (this.bot) {
      this.attachBotListeners();
    }
  }

  attachBotListeners() {
    if (!this.bot || typeof this.bot.on !== 'function') return;

    this.bot.on('entityHurt', (entity) => {
      if (this.bot && this.bot.entity && entity.id === this.bot.entity.id) {
        this.handleBotDamaged();
      }
    });
  }

  logTelemetry(target, dist, isCooldownReady, action = 'ATTACK') {
    if (!this.debug || typeof this.logger !== 'function') return;

    const onGround = Boolean(this.bot && this.bot.entity && this.bot.entity.onGround);
    const vy = this.bot && this.bot.entity && this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const isRising = this.state === 'RISING' || vy > 0.05;
    const isFalling = this.state === 'FALLING' || vy < -0.01;
    const weaponName = (this.bot && this.bot.heldItem && this.bot.heldItem.name) || 'unarmed';
    const isSprinting = Boolean(this.movementController && this.movementController.activeControls && this.movementController.activeControls.sprint);

    const telemetryLines = [
      `[CRIT_TELEMETRY] Action: ${action} | Mode: ${this.mode} | Chain: ${this.chainCount}/${this.maxChainHits}`,
      `Version: ${this.combatVersion} | Weapon: ${weaponName} | Target Dist: ${dist.toFixed(2)}m`,
      `Grounded: ${onGround} | Vertical Velocity: ${vy.toFixed(3)} | Rising: ${isRising} | Falling: ${isFalling}`,
      `Cooldown Ready: ${isCooldownReady} | Sprint: ${isSprinting} | Result: ${action}`
    ];

    this.logger(telemetryLines.join(' | '));
  }

  /**
   * Detects incoming melee knockback to trigger a reactive P-Crit.
   */
  handleBotDamaged() {
    this.lastDamageTime = Date.now();
    this.pCritTriggered = true;

    // If bot was launched into the air by opponent knockback
    if (this.bot && this.bot.entity && !this.bot.entity.onGround) {
      const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
      if (vy > 0.08 && this.mode === 'IDLE') {
        this.mode = 'P_CRIT';
        this.state = 'RISING';
        this.peakY = this.bot.entity.position.y;
        this.lastY = this.bot.entity.position.y;
        if (this.movementController && this.combatVersion === 'modern') {
          this.movementController.setControl('sprint', false);
        }
        if (this.debug) console.log('💥 [P-CRIT] Reactive critical mode triggered from opponent knockback airtime!');
      }
    }
  }

  isInCritSequence() {
    return this.mode !== 'IDLE' && this.state !== 'IDLE';
  }

  reset() {
    this.mode = 'IDLE';
    this.state = 'IDLE';
    this.chainCount = 0;
    this.peakY = 0;
    this.lastY = 0;
    this.jumpStartTime = 0;
    this.repositionTicks = 0;
    this.pCritTriggered = false;
  }

  abort(reason = 'Unknown') {
    if (this.debug) console.log(`[CRIT_CHAIN] Aborted: ${reason} (mode: ${this.mode}, state: ${this.state})`);
    if (this.movementController) {
      this.movementController.setControl('sprint', true);
      this.movementController.setControl('sneak', false);
    }
    this.reset();
  }

  /**
   * Starts a new sustained Crit Chain.
   */
  startChain(target, dist, isCooldownReady, now = Date.now()) {
    if (this.isInCritSequence()) return false;
    if (!this.bot || !this.bot.entity) return false;

    const onGround = Boolean(this.bot.entity.onGround);
    if (!onGround) return false;
    if (dist < 1.2 || dist > 3.3) return false;

    // Respect the actual weapon cooldown on modern combat. The jump itself
    // provides the repositioning window; an artificial timer here only makes
    // the bot feel slow or causes mistimed swings. Classic combat has no such
    // cooldown gate in this controller.

    this.mode = 'CRIT_CHAIN';
    this.state = 'JUMP_START';
    this.chainCount = 1;
    this.jumpStartTime = now;
    this.peakY = this.bot.entity.position.y;
    this.lastY = this.bot.entity.position.y;

    if (this.movementController) {
      this.movementController.setControl('forward', true);
      this.movementController.setControl('back', false);
      if (this.combatVersion === 'modern') {
        this.movementController.setControl('sprint', false);
      } else {
        this.movementController.setControl('sprint', true);
      }
      this.movementController.setControl('sneak', false);
      this.movementController.requestJump(true);
    }

    if (this.debug) console.log(`⚔️ [CRIT_CHAIN] Started crit chain (Strike #1/${this.maxChainHits}) at dist ${dist.toFixed(2)}m`);
    return true;
  }

  /**
   * Main per-tick update for crit chain & P-crit state machine.
   */
  update(target, dist, isCooldownReady, now = Date.now()) {
    if (this.mode === 'IDLE' && this.pCritTriggered && (now - this.lastDamageTime < 400)) {
      const onGround = Boolean(this.bot && this.bot.entity && this.bot.entity.onGround);
      const vy = (this.bot && this.bot.entity && this.bot.entity.velocity) ? this.bot.entity.velocity.y : 0;
      if (!onGround && vy > 0.08) {
        this.mode = 'P_CRIT';
        this.state = 'RISING';
        this.peakY = this.bot.entity.position.y;
        this.lastY = this.bot.entity.position.y;
        this.jumpStartTime = now;
        if (this.movementController && this.combatVersion === 'modern') {
          this.movementController.setControl('sprint', false);
        }
        if (this.debug) console.log('💥 [P-CRIT] Reactive critical mode triggered from knockback airtime in update()!');
      }
    }

    if (!this.isInCritSequence()) {
      return { attacked: false, mode: this.mode, state: this.state };
    }

    if (!this.bot || !this.bot.entity || !target || !target.position) {
      this.abort('Target or bot unavailable');
      return { attacked: false, mode: 'IDLE', state: 'IDLE' };
    }

    // Safety watchdog: timeout after 1200ms
    if (this.state !== 'REPOSITION' && now - this.jumpStartTime > 1200) {
      this.abort('Jump sequence timed out (> 1200ms)');
      return { attacked: false, mode: 'IDLE', state: 'IDLE' };
    }

    const currentPos = this.bot.entity.position;
    const currentY = currentPos.y;
    const onGround = Boolean(this.bot.entity.onGround);
    const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : (currentY - this.lastY);

    if (currentY > this.peakY) {
      this.peakY = currentY;
    }

    let attacked = false;

    switch (this.state) {
      case 'JUMP_START':
        if (!onGround) {
          if (vy > 0.05 || currentY > this.lastY) {
            this.state = 'RISING';
          } else if (Math.abs(vy) <= 0.04) {
            this.state = 'APEX';
          } else if (vy < -0.01 || currentY < this.peakY - 0.01) {
            this.state = 'FALLING';
          }
        } else if (now - this.jumpStartTime > 250) {
          this.abort('Failed to become airborne within 250ms');
        }
        if (this.state !== 'FALLING') break;

      case 'RISING':
        if (onGround) {
          this.state = 'LAND';
        } else if (Math.abs(vy) <= 0.04) {
          this.state = 'APEX';
        } else if (vy < -0.01 || currentY < this.peakY - 0.01) {
          this.state = 'FALLING';
        }
        if (this.state !== 'FALLING') break;

      case 'APEX':
        if (onGround) {
          this.state = 'LAND';
        } else if (vy < -0.01 || currentY < this.peakY - 0.01) {
          this.state = 'FALLING';
        }
        if (this.state !== 'FALLING') break;

      case 'FALLING':
        if (onGround) {
          this._handleLanding(now, currentY, dist);
          break;
        } else if (dist > 3.4) {
          // Dynamic abort: target escaped reach -> immediately abort chain and transition to chase
          this.abort(`Target escaped reach (${dist.toFixed(2)}m > 3.4m)`);
          return { attacked: false, mode: 'IDLE', state: 'IDLE' };
        } else if ((this.combatVersion === 'classic' || isCooldownReady) && dist <= 3.25) {
          // EXECUTE LEGITIMATE CRITICAL ATTACK WHILE DESCENDING!
          this.state = 'CRIT_ATTACK';
          this.lastCritTime = now;
          attacked = true;

          this.logTelemetry(target, dist, true, this.mode === 'P_CRIT' ? 'P_CRIT_HIT' : 'CRIT_CHAIN_HIT');

          try {
            this.bot.attack(target);
            if (typeof this.bot.swingArm === 'function') {
              this.bot.swingArm('right');
            }
          } catch (err) {
            console.error('Crit chain attack error:', err.message);
          }
        }
        break;

      case 'CRIT_ATTACK':
        if (onGround) {
          this._handleLanding(now, currentY, dist);
        }
        break;

      case 'LAND':
        this._handleLanding(now, currentY, dist);
        break;

      case 'REPOSITION':
        // Smooth fallback if reposition is ever set
        if (dist <= 3.3 && this.chainCount < this.maxChainHits) {
          this.chainCount++;
          this.state = 'JUMP_START';
          this.jumpStartTime = now;
          this.peakY = currentY;
          this.lastY = currentY;
          if (this.movementController) {
            this.movementController.setControl('forward', true);
            this.movementController.setControl('back', false);
            if (this.combatVersion === 'modern') {
              this.movementController.setControl('sprint', false);
            }
            this.movementController.requestJump(true);
          }
        } else {
          this.reset();
        }
        break;

      default:
        this.reset();
        break;
    }

    this.lastY = currentY;
    return { attacked, mode: this.mode, state: this.state };
  }

  /**
   * Handle landing event with zero ground delay.
   * Immediately resets sneak, maintains forward momentum, and re-launches jump if chain active.
   */
  _handleLanding(now, currentY, dist) {
    this.state = 'LAND';
    // Clean landing with 0 sneak
    if (this.movementController) {
      this.movementController.setControl('sneak', false);
      this.movementController.setControl('forward', true);
      this.movementController.setControl('back', false);
    }

    if (this.mode === 'P_CRIT') {
      // Reactive P-crit completes upon landing
      if (this.movementController) this.movementController.setControl('sprint', true);
      if (this.debug) console.log('✅ [P-CRIT] Landed cleanly after reactive P-crit. Returning to COMBO.');
      this.reset();
      return;
    }

    // Crit Chain progression:
    // ZERO DELAY CHAINING: If target is within reach, IMMEDIATELY launch next crit jump!
    if (this.chainCount < this.maxChainHits && dist <= 3.3) {
      this.chainCount++;
      this.state = 'JUMP_START';
      this.jumpStartTime = now;
      this.peakY = currentY;
      this.lastY = currentY;

      if (this.movementController) {
        this.movementController.setControl('forward', true);
        this.movementController.setControl('back', false);
        if (this.combatVersion === 'modern') {
          this.movementController.setControl('sprint', false);
        } else {
          this.movementController.setControl('sprint', true);
        }
        this.movementController.requestJump(true);
      }
      if (this.debug) console.log(`⚔️ [CRIT_CHAIN] Zero-delay chain jump (#${this.chainCount}/${this.maxChainHits}) at dist ${dist.toFixed(2)}m!`);
    } else {
      if (this.movementController) {
        this.movementController.setControl('sprint', true);
      }
      if (this.debug) console.log(`🏁 [CRIT_CHAIN] Completed ${this.chainCount} consecutive critical hits. Returning to COMBO.`);
      this.reset();
    }
  }
}

module.exports = CritChainController;
