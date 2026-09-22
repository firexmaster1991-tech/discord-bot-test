const { Vec3 } = require('vec3');

/**
 * Dedicated Real Spacing & Outspacing Combat Distance Controller.
 * 
 * Responsibilities:
 * 1. Outspacing Engine: Attacking around the useful edge of legitimate 3-block reach (2.4m - 2.9m)
 *    so bot attacks connect while opponent attacks miss.
 * 2. Hitbox Overlap Prevention: If distance < minSafeDistance (< 1.6m), immediately applies outward
 *    backpedal + lateral strafe WHILE CONTINUING TO ATTACK! The bot never turns 180 or ceases hitting.
 * 3. Anti-Circle Loop Watchdog: Detects when the bot orbits endlessly without distance improving.
 *    Breaks the circle by stepping outward/forward and inverting strafe direction.
 * 4. Anti-Corner & Safe Open Space: Evaluates arena geometry to maintain escape routes.
 * 5. Decouples AIM VECTOR (crosshair tracking) from MOVEMENT VECTOR (WASD).
 */
class CombatDistanceController {
  constructor(bot = null, movementController = null, options = {}) {
    this.bot = bot;
    this.movementController = movementController;

    // Configurable distance boundaries (in blocks)
    // Outspacing targets 2.4m - 2.85m (edge of vanilla 3.0m reach)
    this.idealMinDistance = options.idealMinDistance || 2.2;
    this.idealMaxDistance = options.idealMaxDistance || 2.85;
    this.minSafeDistance = options.minSafeDistance || 1.6;
    this.maxAttackDistance = options.maxAttackDistance || 3.15;
    this.chaseDistance = options.chaseDistance || 3.5;

    // Circle loop detection history
    this.orbitHistory = [];
    this.circleLoopDetected = false;
    this.lastCircleBreakTime = 0;
    this.circleBreakTicksRemaining = 0;

    // Strafe cadence & intelligence
    this.currentStrafeDirection = 'left';
    this.strafeTicks = 0;
    this.strafeChangeInterval = 10;
    this.lastStrafeBreakTime = 0;

    // Open space & escape vector
    this.escapeVector = new Vec3(0, 0, 0);
  }

  setBot(bot, movementController = null) {
    this.bot = bot;
    if (movementController) {
      this.movementController = movementController;
    }
  }

  /**
   * Determines if spacing and health permit a safe buff splash window.
   */
  isSafeBuffWindow(target, dist, currentHealth) {
    if (!target) return true;
    if (dist < 2.5) return false;
    if (currentHealth !== undefined && currentHealth <= 10) return false;
    return true;
  }

  /**
   * Evaluates distance and relative angle to detect circle looping.
   * If the bot is orbiting without closing/improving distance over 8 ticks, triggers anti-circle recovery.
   */
  updateCircleWatchdog(dist, target) {
    if (!this.bot || !this.bot.entity || !target || !target.position) return false;
    const now = Date.now();

    if (this.circleBreakTicksRemaining > 0) {
      this.circleBreakTicksRemaining--;
      return true;
    }

    const botPos = this.bot.entity.position;
    const targetPos = target.position;
    const dx = botPos.x - targetPos.x;
    const dz = botPos.z - targetPos.z;
    const currentAngle = Math.atan2(dz, dx);

    this.orbitHistory.push({ angle: currentAngle, dist, time: now });
    if (this.orbitHistory.length > 10) {
      this.orbitHistory.shift();
    }

    if (this.orbitHistory.length >= 8) {
      const first = this.orbitHistory[0];
      const last = this.orbitHistory[this.orbitHistory.length - 1];

      let angleDiff = Math.abs(last.angle - first.angle);
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;

      const distDiff = Math.abs(last.dist - first.dist);

      // Condition: Rotating around target (angle changed > 0.8 rad ~ 45 deg)
      // while radial distance remained nearly constant (distDiff < 0.35m)
      if (angleDiff > 0.8 && distDiff < 0.35 && now - this.lastCircleBreakTime > 1800) {
        this.circleLoopDetected = true;
        this.lastCircleBreakTime = now;
        this.circleBreakTicksRemaining = 6; // 300ms correction
        this.currentStrafeDirection = this.currentStrafeDirection === 'left' ? 'right' : 'left';
        this.strafeTicks = 0;
        return true;
      }
    }

    this.circleLoopDetected = false;
    return false;
  }

  /**
   * Computes decoupled RADIAL (inward/outward) and TANGENTIAL (left/right strafe) controls.
   * Factoring in opponent velocity and outspacing edge.
   */
  computeMovementVectors(dist, options = {}) {
    this.strafeTicks++;

    // Controlled strafe cadence variation (8-14 ticks)
    if (this.strafeTicks >= this.strafeChangeInterval) {
      this.strafeTicks = 0;
      this.currentStrafeDirection = this.currentStrafeDirection === 'left' ? 'right' : 'left';
      this.strafeChangeInterval = 8 + Math.floor(Math.random() * 6);
    }

    // Adapt strafe direction if opponent model provides strafe feedback
    if (options.opponentModel) {
      // If opponent is strafing into bot's strafe, break strafe to avoid collision
      if (options.opponentModel.isStrafingLeft && this.currentStrafeDirection === 'right') {
        const now = Date.now();
        if (now - this.lastStrafeBreakTime > 1000) {
          this.lastStrafeBreakTime = now;
          this.currentStrafeDirection = 'left';
        }
      }
    }

    // 1. Circle Break Override: apply short outward/forward impulse with inverted strafe
    if (this.circleBreakTicksRemaining > 0) {
      return {
        forward: dist > this.idealMinDistance,
        back: dist < this.minSafeDistance,
        left: this.currentStrafeDirection === 'left',
        right: this.currentStrafeDirection === 'right',
        sprint: true,
        sneak: false,
        mode: 'CIRCLE_BREAK'
      };
    }

    // 2. Emergency Hitbox Recovery: Distance is inside minSafeDistance (< 1.6m)
    // Never turn around! Never stop attacking! Move backward + strafe to re-establish spacing!
    if (dist < this.minSafeDistance) {
      const wallBehind = Boolean(this.movementController && typeof this.movementController.isWallBehind === 'function' && this.movementController.isWallBehind(1.8));
      const corner = this.movementController && typeof this.movementController.detectCornerDanger === 'function' ? this.movementController.detectCornerDanger(1.8) : null;

      if (wallBehind || (corner && corner.inCorner)) {
        // Wall behind or corner detected: DO NOT WALK BACKWARD INTO THE WALL!
        const strafeLeft = corner ? corner.escapeLeft : (this.currentStrafeDirection === 'left');
        return {
          forward: false,
          back: false,
          left: strafeLeft,
          right: !strafeLeft,
          sprint: true,
          sneak: false,
          mode: 'ESCAPE'
        };
      }

      return {
        forward: false,
        back: true,
        left: this.currentStrafeDirection === 'left',
        right: this.currentStrafeDirection === 'right',
        sprint: false, // Don't sprint backward
        sneak: false,
        mode: 'HITBOX_RECOVERY'
      };
    }

    // 3. Outspacing Zone (idealMinDistance <= dist <= idealMaxDistance, ~2.2m - 2.85m):
    // Attacks connect while keeping opponent at maximum melee disadvantage!
    if (dist >= this.idealMinDistance && dist <= this.idealMaxDistance) {
      // Micro-radial pacing to maintain outspacing edge
      const targetRetreating = Boolean(options.opponentModel && options.opponentModel.isRetreating);
      return {
        forward: targetRetreating || dist > (this.idealMinDistance + this.idealMaxDistance) / 2,
        back: !targetRetreating && dist < this.idealMinDistance + 0.15,
        left: this.currentStrafeDirection === 'left',
        right: this.currentStrafeDirection === 'right',
        sprint: true,
        sneak: false,
        mode: 'IDEAL_SPACING'
      };
    }

    // 4. In Approach Zone (idealMaxDistance < dist <= chaseDistance):
    if (dist > this.idealMaxDistance && dist <= this.chaseDistance) {
      return {
        forward: true,
        back: false,
        left: this.currentStrafeDirection === 'left',
        right: this.currentStrafeDirection === 'right',
        sprint: true,
        sneak: false,
        mode: 'APPROACH'
      };
    }

    // 5. Far Target (dist > chaseDistance): Relentless forward sprint chase
    return {
      forward: true,
      back: false,
      left: false,
      right: false,
      sprint: true,
      sneak: false,
      mode: 'CHASE'
    };
  }

  /**
   * Applies calculated radial and tangential vectors to the authoritative movement controller.
   */
  applySpacingMovement(target, dist, options = {}) {
    if (!this.movementController) return;

    this.updateCircleWatchdog(dist, target);
    const vectors = this.computeMovementVectors(dist, options);

    if (vectors.mode === 'CHASE') {
      this.movementController.setState('CHASE');
    } else if (vectors.mode === 'APPROACH') {
      this.movementController.setState('APPROACH');
    } else if (vectors.mode === 'HITBOX_RECOVERY') {
      this.movementController.setState('REPOSITION');
    } else if (vectors.mode === 'ESCAPE') {
      this.movementController.setState('ESCAPE');
    } else if (vectors.mode === 'IDEAL_SPACING') {
      this.movementController.setState('STRAFE');
    }

    // Apply directly via authoritative movement controller
    this.movementController.setControl('forward', vectors.forward);
    this.movementController.setControl('back', vectors.back);
    this.movementController.setControl('left', vectors.left);
    this.movementController.setControl('right', vectors.right);
    this.movementController.setControl('sprint', options.allowSprint !== false && vectors.sprint);
    this.movementController.setControl('sneak', false);

    return vectors;
  }

  /**
   * High-level distance decision evaluation (for profiles and testing).
   */
  calculateDistanceAction(target, dist, health = 20, options = {}) {
    if (this.updateCircleWatchdog(dist, target)) {
      return { state: 'CIRCLE_BREAK', mode: 'CIRCLE_BREAK' };
    }
    const vec = this.computeMovementVectors(dist, options);
    let state = 'OUTSPACING';
    if (vec.mode === 'HITBOX_RECOVERY' || vec.mode === 'ESCAPE') state = 'OVERLAP_ESCAPE';
    else if (vec.mode === 'CHASE') state = 'CHASE';
    else if (vec.mode === 'APPROACH') state = 'APPROACH';
    else if (vec.mode === 'CIRCLE_BREAK') state = 'CIRCLE_BREAK';
    else if (vec.mode === 'IDEAL_SPACING') state = 'OUTSPACING';

    return { ...vec, state };
  }

  get antiCircleWatchdog() {
    return {
      recordAngle: (targetPos, botPos) => {
        const dx = botPos.x - targetPos.x;
        const dz = botPos.z - targetPos.z;
        const currentAngle = Math.atan2(dz, dx);
        const dist = Math.sqrt(dx * dx + dz * dz);
        this.orbitHistory.push({ angle: currentAngle, dist, time: Date.now() });
        if (this.orbitHistory.length > 10) this.orbitHistory.shift();
      },
      isCircling: () => {
        if (this.orbitHistory.length < 8) return false;
        const first = this.orbitHistory[0];
        const last = this.orbitHistory[this.orbitHistory.length - 1];
        let angleDiff = Math.abs(last.angle - first.angle);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        const distDiff = Math.abs(last.dist - first.dist);
        return angleDiff > 0.8 && distDiff < 0.35;
      }
    };
  }
}

module.exports = CombatDistanceController;
