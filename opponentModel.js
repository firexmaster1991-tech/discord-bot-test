const { Vec3 } = require('vec3');

/**
 * Advanced Opponent Modeling & Predictive Tracking Engine for Mineflayer PvP.
 * 
 * Responsibilities:
 * 1. Continuously tracks position, velocity, acceleration trend, yaw, and distance.
 * 2. Detects opponent state: airborne, sprinting, blocking (shield), retreating, strafing left/right.
 * 3. Tracks approximate health where observable via metadata or damage feedback.
 * 4. Maintains a rolling history of recent behaviors (last 10 attacks, movements, hits).
 * 5. Dynamic playstyle classification:
 *    - AGGRESSIVE | RETREATING | STRAFER | CRIT-HEAVY | COMBO-HEAVY | PASSIVE | UNPREDICTABLE
 * 6. Predictive future position extrapolation with safe clamping.
 */
class OpponentModel {
  constructor(bot = null) {
    this.bot = bot;
    this.target = null;

    // Current State Metrics
    this.position = new Vec3(0, 0, 0);
    this.prevPosition = null;
    this.velocity = new Vec3(0, 0, 0);
    this.prevVelocity = new Vec3(0, 0, 0);
    this.acceleration = new Vec3(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.distance = 0;
    this.approximateHealth = 20;

    // State Flags
    this.isAirborne = false;
    this.isSprinting = false;
    this.isBlocking = false;
    this.isRetreating = false;
    this.isStrafingLeft = false;
    this.isStrafingRight = false;

    // Rolling History (last 10 entries)
    this.history = {
      positions: [],
      velocities: [],
      attacks: [],
      hitsReceived: [],
      strafeDirections: []
    };
    this.maxHistory = 10;

    // Playstyle Classification
    this.classification = 'UNPREDICTABLE';
    this.lastClassificationTime = 0;
    this.classificationIntervalMs = 500; // Recalculate every 500ms (10 ticks)

    // Damage & Attack Tracking
    this.lastAttackTime = 0;
    this.lastHitReceivedTime = 0;
    this.lastKnockbackDir = new Vec3(0, 0, 0);
  }

  setBot(bot) {
    this.bot = bot;
  }

  setTarget(target) {
    if (this.target && target && this.target.id !== target.id) {
      this.reset();
    }
    this.target = target;
  }

  reset() {
    this.prevPosition = null;
    this.prevVelocity = new Vec3(0, 0, 0);
    this.velocity = new Vec3(0, 0, 0);
    this.acceleration = new Vec3(0, 0, 0);
    this.approximateHealth = 20;
    this.history.positions = [];
    this.history.velocities = [];
    this.history.attacks = [];
    this.history.hitsReceived = [];
    this.history.strafeDirections = [];
    this.classification = 'UNPREDICTABLE';
    this.lastAttackTime = 0;
    this.lastHitReceivedTime = 0;
  }

  /**
   * Main per-tick update (20 TPS).
   */
  update(targetEntity = null) {
    const target = targetEntity || this.target;
    if (!target || !target.position) {
      return null;
    }
    this.target = target;

    const now = Date.now();
    const currentPos = target.position.clone();
    this.position = currentPos;

    const botPos = this.bot && this.bot.entity ? this.bot.entity.position : currentPos;
    this.distance = botPos.distanceTo(currentPos);
    this.yaw = target.yaw || 0;
    this.pitch = target.pitch || 0;

    // 1. Calculate Velocity & Acceleration
    if (this.prevPosition) {
      this.velocity = currentPos.minus(this.prevPosition);
      this.acceleration = this.velocity.minus(this.prevVelocity);
    } else {
      this.velocity = target.velocity ? target.velocity.clone() : new Vec3(0, 0, 0);
      this.acceleration = new Vec3(0, 0, 0);
    }
    this.prevPosition = currentPos.clone();
    this.prevVelocity = this.velocity.clone();

    // 2. Detect State Flags
    const horizSpeed = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
    this.isAirborne = target.onGround === false || Math.abs(this.velocity.y) > 0.08;
    this.isSprinting = horizSpeed > 0.15 || (target.metadata && Boolean(target.metadata[0] & 0x08));

    // Shield blocking detection
    this.isBlocking = Boolean(
      (target.heldItem && target.heldItem.name && target.heldItem.name.includes('shield')) ||
      (target.offHandItem && target.offHandItem.name && target.offHandItem.name.includes('shield')) ||
      (target.metadata && Boolean(target.metadata[0] & 0x10))
    );

    // Relative movement vectors (Bot to Target)
    const toTarget = currentPos.minus(botPos);
    const toTargetHoriz = new Vec3(toTarget.x, 0, toTarget.z);
    const toTargetDist = toTargetHoriz.norm();

    if (toTargetDist > 0.01) {
      const dirToTarget = toTargetHoriz.scaled(1 / toTargetDist);
      // Dot product: > 0 means opponent is moving away (retreating)
      const radialVel = (this.velocity.x * dirToTarget.x + this.velocity.z * dirToTarget.z);
      this.isRetreating = radialVel > 0.06;

      // Cross product (2D): lateral strafe direction
      const lateralVel = (dirToTarget.x * this.velocity.z - dirToTarget.z * this.velocity.x);
      this.isStrafingLeft = lateralVel > 0.04;
      this.isStrafingRight = lateralVel < -0.04;

      if (this.isStrafingLeft) {
        this.pushHistory('strafeDirections', 'left');
      } else if (this.isStrafingRight) {
        this.pushHistory('strafeDirections', 'right');
      }
    }

    // Health tracking from target or metadata
    if (target.health != null) {
      this.approximateHealth = target.health;
    }

    // 3. Update Rolling History
    this.pushHistory('positions', currentPos);
    this.pushHistory('velocities', this.velocity.clone());

    // 4. Dynamic Playstyle Classification
    if (now - this.lastClassificationTime > this.classificationIntervalMs) {
      this.lastClassificationTime = now;
      this.classification = this.classifyPlaystyle();
    }

    return this.getState();
  }

  pushHistory(key, item) {
    if (!this.history[key]) this.history[key] = [];
    this.history[key].push({ item, time: Date.now() });
    if (this.history[key].length > this.maxHistory) {
      this.history[key].shift();
    }
  }

  /**
   * Notifies model that the opponent initiated an attack swing.
   */
  recordOpponentAttack(now = Date.now()) {
    this.lastAttackTime = now;
    this.pushHistory('attacks', { time: now });
  }

  /**
   * Notifies model that the opponent received a hit from the bot.
   */
  recordHitLanded(knockbackDir = null, now = Date.now()) {
    this.lastHitReceivedTime = now;
    if (knockbackDir) this.lastKnockbackDir = knockbackDir.clone();
    this.pushHistory('hitsReceived', { time: now, dir: knockbackDir });
    this.approximateHealth = Math.max(0, this.approximateHealth - 3.5); // Estimate 3.5 dmg if health not synced
  }

  /**
   * Evaluates the rolling history to dynamically classify the opponent's playstyle.
   */
  classifyPlaystyle() {
    const vels = this.history.velocities.map(v => v.item);
    if (vels.length < 4) return 'UNPREDICTABLE';

    // 1. Retreating check
    if (this.isRetreating) {
      return 'RETREATING';
    }

    // 2. Jump/Crit-heavy check: opponent airborne in >= 40% of recent samples
    const airborneCount = vels.filter(v => Math.abs(v.y) > 0.08).length;
    if (airborneCount / vels.length >= 0.4) {
      return 'CRIT-HEAVY';
    }

    // 3. Strafer check: lateral velocity dominant
    const strafes = this.history.strafeDirections;
    if (strafes.length >= 3) {
      return 'STRAFER';
    }

    // 4. Aggressive vs Passive check: radial approach velocity
    const botPos = this.bot && this.bot.entity ? this.bot.entity.position : this.position;
    const toBot = botPos.minus(this.position);
    const toBotDist = Math.sqrt(toBot.x * toBot.x + toBot.z * toBot.z);

    if (toBotDist > 0.1) {
      const approachVels = vels.filter(v => (v.x * toBot.x + v.z * toBot.z) / toBotDist > 0.08);
      if (approachVels.length / vels.length >= 0.5) {
        return this.isSprinting ? 'COMBO-HEAVY' : 'AGGRESSIVE';
      }
    }

    // 5. Passive check: average speed is low
    const avgSpeed = vels.reduce((acc, v) => acc + v.norm(), 0) / vels.length;
    if (avgSpeed < 0.05) {
      return 'PASSIVE';
    }

    return 'UNPREDICTABLE';
  }

  /**
   * Predicts where the opponent will be a short moment from now (lookahead clamped to 50ms - 250ms).
   * P_pred = P + V * dt + 0.5 * A * dt^2
   */
  getPredictedPosition(lookaheadSeconds = 0.12) {
    const dt = Math.max(0.05, Math.min(0.25, lookaheadSeconds)); // Clamped safe window
    const ticks = dt * 20;

    // High acceleration variance drops confidence; fallback to velocity only
    const accNorm = this.acceleration.norm();
    const useAcc = accNorm < 0.25;

    const predX = this.position.x + (this.velocity.x * ticks) + (useAcc ? 0.5 * this.acceleration.x * ticks * ticks : 0);
    const predY = this.position.y + (this.velocity.y * (ticks * 0.6)); // Vertical damping
    const predZ = this.position.z + (this.velocity.z * ticks) + (useAcc ? 0.5 * this.acceleration.z * ticks * ticks : 0);

    return new Vec3(predX, predY, predZ);
  }

  get trackedEntityId() {
    return this.target ? this.target.id : null;
  }

  get positionHistory() {
    return this.history.positions.map(p => p.item);
  }

  get velocityHistory() {
    return this.history.velocities.map(v => v.item);
  }

  get currentVelocity() {
    return this.velocity;
  }

  classifyOpponentStyle(bot = null) {
    if (bot) this.bot = bot;
    return this.classifyPlaystyle();
  }

  getState() {
    return {
      target: this.target,
      position: this.position.clone(),
      velocity: this.velocity.clone(),
      acceleration: this.acceleration.clone(),
      distance: this.distance,
      health: this.approximateHealth,
      classification: this.classification,
      isAirborne: this.isAirborne,
      isSprinting: this.isSprinting,
      isBlocking: this.isBlocking,
      isRetreating: this.isRetreating,
      isStrafingLeft: this.isStrafingLeft,
      isStrafingRight: this.isStrafingRight,
      lastAttackTime: this.lastAttackTime,
      lastHitReceivedTime: this.lastHitReceivedTime,
      predictedPosition: this.getPredictedPosition()
    };
  }
}

module.exports = OpponentModel;
