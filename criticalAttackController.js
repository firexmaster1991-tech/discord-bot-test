const { Vec3 } = require('vec3');

/**
 * Dedicated 9-State Critical Hit Controller for Minecraft PvP.
 * Supports both Modern Java (1.9 - 1.20.4+) and Classic 1.8 / 1.8.9 PvP.
 * 
 * Explicit 9 States:
 * - IDLE: Normal grounded combat / combo mode.
 * - GROUND_READY: Validating ground, distance (1.6m - 3.2m), attack cooldown, and environment.
 * - JUMP_START: Initiating jump impulse. (Modern: release sprint; Classic: keep sprint).
 * - RISING: Ascending upward (vy > 0.05). Attacks strictly suppressed.
 * - APEX: Peak of the jump (|vy| <= 0.04).
 * - FALLING: Descending window (vy < -0.04, y < peakY). Valid critical strike window.
 * - CRIT_ATTACK: Critical hit executed via bot.attack(target).
 * - LANDING: Bot touches ground (onGround === true). Clean landing with 0 sneak.
 * - RECOVERY: 1-tick settling delay before returning to IDLE.
 */
class CriticalAttackController {
  constructor(bot = null, movementController = null, options = {}) {
    this.bot = bot;
    this.movementController = movementController;
    this.combatVersion = options.combatVersion || 'modern'; // 'modern' | 'classic'
    this.state = 'IDLE';
    this.peakY = 0;
    this.lastY = 0;
    this.jumpStartTime = 0;
    this.lastCritTime = 0;
    this.critAttempts = 0;
    this.critSuccesses = 0;
    this.debug = options.debug !== false;
    this.logger = options.logger || console.log;
  }

  log(msg) {
    if (this.debug && typeof this.logger === 'function') {
      this.logger(`[CRIT_DEBUG] ${msg}`);
    }
  }

  /**
   * Logs structured Section 8 Critical Debug Telemetry.
   */
  logTelemetry(target, dist, isCooldownReady, action = 'ATTACK') {
    if (!this.debug || typeof this.logger !== 'function') return;

    const onGround = Boolean(this.bot && this.bot.entity && this.bot.entity.onGround);
    const vy = this.bot && this.bot.entity && this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const isRising = this.state === 'RISING' || vy > 0.05;
    const isFalling = this.state === 'FALLING' || vy < -0.04;
    const weaponName = (this.bot && this.bot.heldItem && this.bot.heldItem.name) || 'unarmed';
    const isSprinting = Boolean(this.movementController && this.movementController.activeControls && this.movementController.activeControls.sprint);
    const targetValid = Boolean(target && target.position);

    const telemetryLines = [
      'CRIT ATTEMPT',
      `Version: ${this.combatVersion}`,
      `Weapon: ${weaponName}`,
      `Target Distance: ${dist.toFixed(1)}m`,
      `Grounded: ${onGround}`,
      `Vertical Velocity: ${vy.toFixed(3)}`,
      `Rising: ${isRising}`,
      `Falling: ${isFalling}`,
      `Attack Ready: ${isCooldownReady}`,
      `Sprint: ${isSprinting}`,
      `Target Valid: ${targetValid}`,
      `RESULT: ${action}`
    ];

    this.logger(telemetryLines.join('\n'));
  }

  /**
   * Returns true if a critical jump/attack sequence is currently underway.
   */
  isInCritSequence() {
    return this.state !== 'IDLE' && this.state !== 'CRIT_IDLE';
  }

  /**
   * Resets the controller back to IDLE cleanly.
   */
  reset() {
    this.state = 'IDLE';
    this.peakY = 0;
    this.lastY = 0;
    this.jumpStartTime = 0;
  }

  /**
   * Aborts an in-progress crit sequence and restores normal controls.
   */
  abort(reason = 'Unknown') {
    this.log(`Crit aborted: ${reason} (from state ${this.state})`);
    if (this.movementController) {
      this.movementController.setControl('sprint', true);
      this.movementController.setControl('sneak', false);
    }
    this.reset();
  }

  /**
   * Evaluates conditions and initiates a controlled critical hit sequence.
   */
  startCrit(target, dist, isCooldownReady, now = Date.now()) {
    if (this.isInCritSequence()) {
      return false;
    }

    this.state = 'GROUND_READY';

    if (!this.bot || !this.bot.entity) {
      this.abort('Bot entity not available');
      return false;
    }

    const onGround = Boolean(this.bot.entity.onGround);
    const notClimbing = !this.bot.entity.isOnLadder;
    const notSwimming = !this.bot.entity.isInWater;
    const notRiding = !this.bot.entity.vehicle;
    const validEnvironment = notClimbing && notSwimming && notRiding;

    // 1. Must be on solid ground before jump
    if (!onGround) {
      this.abort('Ground check failed: bot is not on ground');
      return false;
    }

    // 2. Cooldown check: In Modern Java, attack must be ready or near ready (>= 250ms elapsed)
    const elapsedSinceLastAttack = now - (this.lastCritTime || 0);
    if (this.combatVersion === 'modern' && !isCooldownReady && elapsedSinceLastAttack < 250) {
      this.abort('Ground check failed: weapon cooldown not ready');
      return false;
    }

    // 3. Spacing check: must be in useful striking range (1.4m - 3.25m)
    if (dist < 1.2 || dist > 3.3) {
      this.abort(`Ground check failed: target distance (${dist.toFixed(2)}m) outside range [1.2, 3.3]`);
      return false;
    }

    // 4. Environmental conditions
    if (!validEnvironment) {
      this.abort('Ground check failed: invalid environment (swimming/climbing/riding)');
      return false;
    }

    // All conditions passed -> JUMP_START
    this.state = 'JUMP_START';
    this.critAttempts++;
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
    } else if (typeof this.bot.setControlState === 'function') {
      if (this.combatVersion === 'modern') {
        this.bot.setControlState('sprint', false);
      }
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('jump', true);
      setTimeout(() => {
        try { this.bot.setControlState('jump', false); } catch {}
      }, 80);
    }

    this.log(`Crit Attempt #${this.critAttempts} | Grounded: true | Jump: started | Range: ${dist.toFixed(2)}m | Target: ${target.username || target.name || 'target'}`);
    return true;
  }

  /**
   * Main per-tick update for the 9-state critical hit machine.
   * Synchronized directly with Mineflayer physics tick (20 TPS).
   */
  update(target, dist, isCooldownReady, now = Date.now(), botManager = null) {
    if (!this.isInCritSequence()) {
      return { attacked: false, state: this.state };
    }

    if (!this.bot || !this.bot.entity) {
      this.abort('Bot entity disconnected or missing');
      return { attacked: false, state: this.state };
    }

    // Watchdog: timeout after 1200ms
    if (now - this.jumpStartTime > 1200) {
      this.abort('Jump sequence timed out (> 1200ms)');
      return { attacked: false, state: this.state };
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
      case 'CRIT_JUMP':
        // Wait for bot to leave ground
        if (!onGround) {
          if (vy > 0.05 || currentY > this.lastY) {
            this.state = 'RISING';
            this.log(`State: RISING | vy: +${vy.toFixed(3)} | y: ${currentY.toFixed(2)} | Attack: WAIT (suppressed)`);
          } else if (Math.abs(vy) <= 0.04) {
            this.state = 'APEX';
          } else if (vy < -0.04 || currentY < this.peakY - 0.02) {
            this.state = 'FALLING';
            this.log(`State: FALLING | vy: ${vy.toFixed(3)} | Apex reached`);
          }
        } else if (now - this.jumpStartTime > 250) {
          this.abort('Failed to become airborne within 250ms');
        }
        break;

      case 'RISING':
      case 'CRIT_RISING':
        // Attacks are STRICTLY suppressed while rising!
        if (onGround) {
          this.state = 'LANDING';
          this.log(`State: LANDING | Landed prematurely during rise`);
        } else if (Math.abs(vy) <= 0.04) {
          this.state = 'APEX';
        } else if (vy < -0.04 || currentY < this.peakY - 0.02) {
          this.state = 'FALLING';
          this.log(`State: FALLING | vy: ${vy.toFixed(3)} | Apex: ${this.peakY.toFixed(2)} | Descending into strike window`);
        }
        if (this.state !== 'FALLING' && this.state !== 'CRIT_FALLING') {
          break;
        }
        // Fall-through into FALLING evaluation to strike at earliest opportunity

      case 'APEX':
        if (onGround) {
          this.state = 'LANDING';
        } else if (vy < -0.04 || currentY < this.peakY - 0.02) {
          this.state = 'FALLING';
        }
        if (this.state !== 'FALLING' && this.state !== 'CRIT_FALLING') {
          break;
        }

      case 'FALLING':
      case 'CRIT_FALLING':
        // Valid Critical Attack Window:
        // - airborne (!onGround)
        // - falling downward (vy < -0.04 and y < peakY)
        // - target in reach (<= 3.2m)
        // - cooldown ready (in Modern Java)
        if (onGround) {
          this.state = 'LANDING';
          this.log(`State: LANDING | Landed before attack connected | Dist: ${dist.toFixed(2)}m`);
        } else if (dist > 3.3) {
          // Target escaped outside reach while airborne -> Abort attack, reposition, land cleanly!
          this.log(`State: FALLING | Target escaped reach (${dist.toFixed(2)}m > 3.3m). Aborting crit to reposition.`);
          this.logTelemetry(target, dist, isCooldownReady, 'ABORT (OUT_OF_RANGE)');
        } else if ((this.combatVersion === 'classic' || isCooldownReady || (now - this.lastCritTime >= 520)) && dist <= 3.25) {
          // EXECUTE FALLING CRITICAL ATTACK!
          this.state = 'CRIT_ATTACK';
          this.lastCritTime = now;
          this.critSuccesses++;
          attacked = true;

          this.logTelemetry(target, dist, isCooldownReady, 'ATTACK');

          // Execute attack
          if (this.bot && typeof this.bot.attack === 'function') {
            try {
              this.bot.attack(target);
              if (typeof this.bot.swingArm === 'function') {
                this.bot.swingArm('right');
              }
            } catch (err) {
              this.log(`Attack dispatch error: ${err.message}`);
            }
          }

          if (botManager) {
            botManager.lastAttackTime = now;
            if (typeof botManager.triggerWTap === 'function') {
              botManager.triggerWTap();
            }
          }
        }
        break;

      case 'CRIT_ATTACK':
        if (onGround) {
          this.state = 'LANDING';
        }
        if (this.state !== 'LANDING' && this.state !== 'CRIT_LANDING') {
          break;
        }

      case 'LANDING':
      case 'CRIT_LANDING':
        // Clean landing on solid ground.
        // STRICT SNEAK PURGE: Zero sneak on landing.
        if (this.movementController) {
          this.movementController.setControl('sneak', false);
          this.movementController.setControl('sprint', true); // Re-engage sprint
        }
        this.log(`State: LANDING -> Clean landing. Sprint restored. Sneak: FALSE.`);
        this.state = 'RECOVERY';
        break;

      case 'RECOVERY':
      case 'CRIT_COOLDOWN':
        // 1 tick settling delay
        this.state = 'IDLE';
        this.log(`State: RECOVERY -> Returned to IDLE. Critical cycle completed.`);
        break;

      default:
        this.reset();
        break;
    }

    this.lastY = currentY;
    return { attacked, state: this.state };
  }
}

module.exports = CriticalAttackController;
