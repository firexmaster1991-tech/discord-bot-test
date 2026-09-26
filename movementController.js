const { Vec3 } = require('vec3');

/**
 * Authoritative Centralized Combat Movement Controller for Mineflayer PvP Bot.
 * 
 * Sole authority over bot.setControlState() and bot.clearControlStates().
 * All other combat subsystems must REQUEST movement from this controller.
 * 
 * 11 Strict Movement Modes:
 * - IDLE: Neutral/stopped, all controls cleared.
 * - APPROACH: Moving diagonally toward target into striking range.
 * - CHASE: High-speed forward sprint pursuing a retreating opponent.
 * - STRAFE_LEFT: Lateral orbit to the left around opponent.
 * - STRAFE_RIGHT: Lateral orbit to the right around opponent.
 * - REPOSITION: Dynamic angled flanking to reset positioning and find openings.
 * - RETREAT: Controlled spacing backpedal (strictly blocked if a wall is behind!).
 * - CRIT_SETUP: Pacing into ideal jump-strike distance (1.6m - 3.1m).
 * - CPVP_POSITION: Active non-blocking fluid movement for Crystal PvP.
 * - RECOVER: Momentum stabilization after knockback or landing.
 * - ESCAPE: Active obstacle/corner escape vectoring away from walls and corners.
 */
class CombatMovementController {
  constructor(bot = null) {
    this.bot = bot;
    this.currentState = 'IDLE';
    this.previousState = 'IDLE';
    this.stateStartTime = Date.now();
    this.combatJumpingEnabled = true;
    this.combatAutoJumpEnabled = true;

    // State of all 7 tracked controls (only this controller may mutate)
    this.activeControls = {
      forward: false,
      back: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      sneak: false,
    };

    // Anti-stuck watchdog & diagnostics
    this.lastPosition = null;
    this.stuckTicks = 0;
    this.isUnstucking = false;
    this.unstuckTicksRemaining = 0;
    this.unstuckDirection = 'left';
    this.lastSuccessfulMovementTime = Date.now();
    this.lastAttackTime = 0;
    this.lastBlockAction = 'none';

    // Strafe cadence
    this.strafeTicks = 0;
    this.strafeChangeInterval = 7;
    this.currentStrafeDirection = 'left';

    // Jump timing (controlled, non-spam)
    this.lastJumpTime = 0;
    this.jumpCooldown = 250; // ms - fast enough for chained jump timing

    // Target velocity estimation
    this.prevTargetPos = null;
    this.targetVelocity = new Vec3(0, 0, 0);
    this.smoothedTargetVelocity = new Vec3(0, 0, 0);

    // Aim smoothing / deadband. Calling bot.look() every 20 TPS with tiny
    // prediction changes causes visible micro head jitter.
    this.lastAimTime = 0;
    this.lastAimYaw = null;
    this.lastAimPitch = null;
    this.aimUpdateIntervalMs = 40;
    this.aimDeadbandRad = 0.009;
    this.aimSmoothing = 0.45;

    // Diagnostics & logging
    this.debug = false;
  }

  /**
   * Safe setter for individual controls. Avoids redundant packet emissions.
   */
  setControl(controlName, value) {
    const boolValue = Boolean(value);
    // Keep the local cache and Mineflayer's actual control state synchronized.
    // Other systems (pathfinder/clearControlStates) can clear Mineflayer directly,
    // so a cached "true" must not prevent us from re-sending the input.
    this.activeControls[controlName] = boolValue;
    if (this.bot && typeof this.bot.setControlState === 'function') {
      try {
        this.bot.setControlState(controlName, boolValue);
      } catch {}
    }
  }

  /**
   * Resets all control states cleanly on both controller and Mineflayer bot.
   * Preserves active jump impulse if currently executing a jump within 80ms.
   */
  clearAllControls(preserveJump = false) {
    const shouldPreserveJump = preserveJump || (Date.now() - this.lastJumpTime < 80);
    for (const key of Object.keys(this.activeControls)) {
      if (key === 'jump' && shouldPreserveJump) continue;
      this.activeControls[key] = false;
    }
    if (this.bot && typeof this.bot.clearControlStates === 'function') {
      try {
        this.bot.clearControlStates();
        if (shouldPreserveJump && typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('jump', true);
        }
      } catch {}
    }
  }

  /**
   * Normalizes requested state names and aliases into the 11 strict modes.
   */
  normalizeState(state) {
    if (!state) return 'IDLE';
    const s = String(state).toUpperCase().trim();
    if (s === 'CRITICAL_SETUP') return 'CRIT_SETUP';
    if (s === 'COMBO_PRESSURE') return 'REPOSITION';
    if (s === 'CIRCLE') return 'REPOSITION';
    if (s === 'DISENGAGE') return 'RETREAT';
    return s;
  }

  /**
   * Changes the movement state cleanly.
   * STRICT RULE: Obsolete controls are cleared first on every state transition.
   */
  setState(newState, options = {}) {
    const normalized = this.normalizeState(newState);
    if (this.currentState === normalized && !options.force) {
      // A profile may update movement parameters without changing the state
      // (for example CPVP_POSITION pressForward/spacing). Re-apply the
      // current state's controls so those tactical changes are not ignored.
      this.applyStateControls(options);
      return;
    }

    this.previousState = this.currentState;
    this.currentState = normalized;
    this.stateStartTime = Date.now();

    // 1. CLEAR ALL OBSOLETE CONTROLS FIRST
    this.clearAllControls();

    // 2. APPLY FRESH CONTROLS FOR NEW STATE
    this.applyStateControls(options);
  }

  getState() {
    return this.currentState;
  }

  /**
   * Applies the exact keyboard control states corresponding to the current state.
   */
  applyStateControls(options = {}) {
    // If currently executing an anti-stuck maneuver, let watchdog drive
    if (this.isUnstucking) return;

    // Strict sneak purge: sneak is FALSE for normal combat, only true for edge preservation
    if (!options.sneak) {
      this.setControl('sneak', false);
    }

    switch (this.currentState) {
      case 'IDLE':
        this.clearAllControls();
        break;

      case 'CHASE':
        this.setControl('forward', true);
        this.setControl('back', false);
        this.setControl('left', false);
        this.setControl('right', false);
        this.setControl('sprint', true);
        this.setControl('sneak', false);
        break;

      case 'APPROACH':
        this.setControl('forward', true);
        this.setControl('back', false);
        if (options.strafeDirection === 'left') {
          this.setControl('left', true);
          this.setControl('right', false);
        } else if (options.strafeDirection === 'right') {
          this.setControl('left', false);
          this.setControl('right', true);
        } else {
          this.setControl('left', false);
          this.setControl('right', false);
        }
        this.setControl('sprint', true);
        this.setControl('sneak', false);
        break;

      case 'STRAFE_LEFT':
        this.setControl('left', true);
        this.setControl('right', false);
        this.setControl('back', false);
        this.setControl('forward', options.pressForward !== false);
        this.setControl('sprint', options.sprint !== false);
        this.setControl('sneak', false);
        break;

      case 'STRAFE_RIGHT':
        this.setControl('left', false);
        this.setControl('right', true);
        this.setControl('back', false);
        this.setControl('forward', options.pressForward !== false);
        this.setControl('sprint', options.sprint !== false);
        this.setControl('sneak', false);
        break;

      case 'RETREAT':
        // Wall check: NEVER retreat backwards into a wall or corner!
        if (this.isWallBehind(1.8)) {
          // Divert retreat into lateral strafe / escape
          this.setControl('forward', false);
          this.setControl('back', false);
          this.setControl('left', this.currentStrafeDirection === 'left');
          this.setControl('right', this.currentStrafeDirection === 'right');
          this.setControl('sprint', true);
        } else {
          this.setControl('forward', false);
          this.setControl('back', true);
          this.setControl('sprint', false);
          this.setControl('left', this.currentStrafeDirection === 'left');
          this.setControl('right', this.currentStrafeDirection === 'right');
        }
        this.setControl('sneak', false);
        break;

      case 'REPOSITION':
        // Angled flanking: forward + alternating strafe with sprint
        this.setControl('forward', true);
        this.setControl('back', false);
        this.setControl('left', this.currentStrafeDirection === 'left');
        this.setControl('right', this.currentStrafeDirection === 'right');
        this.setControl('sprint', true);
        this.setControl('sneak', false);
        break;

      case 'CRIT_SETUP':
        // Paces forward at ideal spacing, aligns with target
        this.setControl('forward', true);
        this.setControl('back', false);
        this.setControl('left', options.strafeDirection === 'left');
        this.setControl('right', options.strafeDirection === 'right');
        this.setControl('sprint', true);
        this.setControl('sneak', false);
        break;

      case 'CPVP_POSITION':
        // Crystal PvP uses an active orbit: keep lateral movement on and
        // periodically close distance instead of standing still.
        this.setControl('forward', options.pressForward === true);

        this.setControl('back', options.maintainSpacing ? true : false);
        this.setControl('left', this.currentStrafeDirection === 'left');
        this.setControl('right', this.currentStrafeDirection === 'right');
        this.setControl('sprint', true);
        this.setControl('sneak', false);
        break;

      case 'ESCAPE':
        // Active corner/wall escape: forward + lateral strafe away from boundary + sprint
        this.setControl('forward', true);
        this.setControl('back', false);
        this.setControl('left', options.escapeLeft !== false);
        this.setControl('right', options.escapeLeft === false);
        this.setControl('sprint', true);
        this.setControl('sneak', false);
        break;

      case 'RECOVER':
        this.clearAllControls();
        break;

      default:
        this.clearAllControls();
        break;
    }
  }

  /** Enable/disable profile-controlled combat jumping. */
  setCombatJumpingEnabled(enabled = true, options = {}) {
    this.combatJumpingEnabled = Boolean(enabled);
    if (options.autoJump !== undefined) this.combatAutoJumpEnabled = Boolean(options.autoJump);
    if (!this.combatJumpingEnabled) this.setControl('jump', false);
  }

  /**
   * Human-like Jump Controller: Controlled, non-spam jumping.
   */
  requestJump(force = false, reason = 'manual') {
    if (!this.bot || !this.bot.entity || !this.combatJumpingEnabled) return false;
    if (reason !== 'jump_reset' && !this.combatAutoJumpEnabled) return false;
    const now = Date.now();
    if (!force && now - this.lastJumpTime < this.jumpCooldown) return false;
    if (!this.bot.entity.onGround) return false;

    this.lastJumpTime = now;
    this.setControl('jump', true);

    setTimeout(() => {
      this.setControl('jump', false);
    }, 80);

    return true;
  }

  /**
   * Controlled sneak/shift tap: used strictly for edge-holding or platform preservation.
   */
  triggerSneakTap(durationMs = 80) {
    if (!this.bot) return;
    this.setControl('sneak', true);
    setTimeout(() => {
      this.setControl('sneak', false);
    }, durationMs);
  }

  /**
   * Manages knockback recovery after taking damage:
   * Realigns strafe momentum without shifting/sneaking.
   */
  handleKnockbackRecovery() {
    this.currentStrafeDirection = this.currentStrafeDirection === 'left' ? 'right' : 'left';
    this.strafeTicks = 0;
    this.setControl('sneak', false);
  }

  /**
   * Helper to check if a block at given position is solid terrain / wall.
   */
  isSolidBlock(pos) {
    if (!this.bot || !this.bot.blockAt) return false;
    try {
      const block = this.bot.blockAt(pos);
      if (!block) return false;
      const nonSolids = ['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'grass', 'tall_grass', 'fern'];
      if (nonSolids.includes(block.name)) return false;
      return block.boundingBox === 'block' || Boolean(block.shapes && block.shapes.length > 0);
    } catch {
      return false;
    }
  }

  /**
   * Arena Boundary & Wall Awareness:
   * Checks if a solid wall exists in the specified direction relative to bot yaw.
   */
  checkWallRelative(yawOffset = 0, distance = 1.8) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    const pos = this.bot.entity.position;
    const yaw = (this.bot.entity.yaw || 0) + yawOffset;

    const dirX = -Math.sin(yaw);
    const dirZ = -Math.cos(yaw);

    // Sample along ray at multiple distances (0.8m, 1.4m, distance) to catch adjacent walls
    for (let d = 0.8; d <= distance; d += 0.6) {
      const footPos = pos.offset(dirX * d, 0.2, dirZ * d).floored();
      const torsoPos = pos.offset(dirX * d, 1.2, dirZ * d).floored();
      if (this.isSolidBlock(footPos) || this.isSolidBlock(torsoPos)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Arena Boundary & Wall Awareness for an Absolute Yaw:
   * Checks if a solid wall exists along the ray in the given yaw direction.
   */
  checkWallAtYaw(yaw, distance = 2.0) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    const pos = this.bot.entity.position;
    const dirX = -Math.sin(yaw);
    const dirZ = -Math.cos(yaw);

    for (let d = 0.8; d <= distance; d += 0.6) {
      const footPos = pos.offset(dirX * d, 0.2, dirZ * d).floored();
      const torsoPos = pos.offset(dirX * d, 1.2, dirZ * d).floored();
      if (this.isSolidBlock(footPos) || this.isSolidBlock(torsoPos)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detects if a solid wall is directly behind the bot (within specified distance).
   * Used to prevent blind backward retreats into corners.
   */
  isWallBehind(distance = 1.8) {
    // Relative yaw Math.PI is directly behind
    return this.checkWallRelative(Math.PI, distance) ||
           this.checkWallRelative(Math.PI * 0.85, distance) ||
           this.checkWallRelative(Math.PI * 1.15, distance);
  }

  /**
   * Detects if the bot is in or moving into an arena corner (two adjacent walls meeting).
   */
  detectCornerDanger(distance = 1.6) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) {
      return { inCorner: false, escapeLeft: true };
    }

    const wallAhead = this.checkWallRelative(0, distance);
    const wallBehind = this.checkWallRelative(Math.PI, distance);
    const wallLeft = this.checkWallRelative(Math.PI / 2, distance);
    const wallRight = this.checkWallRelative(-Math.PI / 2, distance);

    const wallCount = (wallAhead ? 1 : 0) + (wallBehind ? 1 : 0) + (wallLeft ? 1 : 0) + (wallRight ? 1 : 0);
    const inCorner = wallCount >= 2;

    // Prefer escaping toward whichever lateral direction is open
    const escapeLeft = !wallLeft;

    return { inCorner, escapeLeft, wallAhead, wallBehind, wallLeft, wallRight };
  }

  /**
   * Anti-Stuck Watchdog:
   * Detects when the bot intends to move but position is not changing.
   * Dispatches Section 30 Diagnostic and executes wall-slide recovery.
   */
  updateWatchdog(target = null) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return;
    const currentPos = this.bot.entity.position;
    const now = Date.now();

    // Handle ongoing unstuck routine
    if (this.isUnstucking) {
      this.unstuckTicksRemaining--;
      if (this.unstuckTicksRemaining <= 0) {
        this.isUnstucking = false;
        this.applyStateControls();
      }
      return;
    }

    if (this.currentState === 'IDLE' || this.currentState === 'RECOVER') {
      this.stuckTicks = 0;
      this.lastPosition = currentPos.clone();
      return;
    }

    if (this.lastPosition) {
      const distanceMoved = currentPos.distanceTo(this.lastPosition);
      if (distanceMoved < 0.08) {
        this.stuckTicks++;
      } else {
        this.stuckTicks = 0;
        this.lastSuccessfulMovementTime = now;
      }

      // If stuck for 6 consecutive checks (~300ms) or collided with wall while trying to move
      if (this.stuckTicks >= 6 || (this.stuckTicks >= 3 && this.bot.entity.isCollidedHorizontally)) {
        this.triggerUnstuck(target);
      }
    }

    this.lastPosition = currentPos.clone();
  }

  /**
   * Unstuck Action: Stops pathfinder, clears invalid controls, logs diagnostic,
   * and dispatches a wall-sliding lateral escape maneuver.
   */
  triggerUnstuck(target = null) {
    const currentPos = this.bot.entity.position;
    const vel = this.bot.entity.velocity || new Vec3(0, 0, 0);

    // Section 30 Diagnostic Logging
    if (this.debug) {
      console.warn(`
[STUCK_DIAGNOSTIC]
STATE: ${this.currentState}
TARGET: ${target ? (target.username || target.name || 'target') : 'none'}
POSITION: (${currentPos.x.toFixed(2)}, ${currentPos.y.toFixed(2)}, ${currentPos.z.toFixed(2)})
VELOCITY: (${vel.x.toFixed(3)}, ${vel.y.toFixed(3)}, ${vel.z.toFixed(3)})
MOVEMENT COMMAND: ${JSON.stringify(this.activeControls)}
PATHFINDER STATE: ${this.bot && this.bot.pathfinder && typeof this.bot.pathfinder.isMoving === 'function' && this.bot.pathfinder.isMoving() ? 'moving' : 'idle'}
CURRENT GOAL: none
CURRENT ACTION: combat_movement
LAST SUCCESSFUL MOVEMENT: ${Math.round((Date.now() - this.lastSuccessfulMovementTime) / 1000)}s ago
LAST BLOCK ACTION: ${this.lastBlockAction}
LAST ATTACK: ${this.lastAttackTime ? Math.round((Date.now() - this.lastAttackTime) / 1000) + 's ago' : 'never'}
ERROR: Displacement stalled under active movement command
      `.trim());
    }

    // 1. Stop any pending pathfinder goal immediately
    if (this.bot && this.bot.pathfinder && typeof this.bot.pathfinder.stop === 'function') {
      try { this.bot.pathfinder.stop(); } catch {}
    }

    // 2. Clear obsolete controls
    this.clearAllControls();

    // 3. Inspect wall/corner obstacles to choose an open escape path
    const cornerInfo = this.detectCornerDanger(1.8);
    this.unstuckDirection = cornerInfo.escapeLeft ? 'left' : 'right';

    this.isUnstucking = true;
    this.unstuckTicksRemaining = 6; // 300ms
    this.stuckTicks = 0;

    // 4. Wall-sliding lateral impulse: move AWAY from the obstacle
    if (this.combatAutoJumpEnabled) this.setControl('jump', true);
    this.setControl('forward', !cornerInfo.wallAhead);
    this.setControl('back', cornerInfo.wallAhead && !cornerInfo.wallBehind);
    this.setControl('sprint', true);
    this.setControl('left', this.unstuckDirection === 'left');
    this.setControl('right', this.unstuckDirection === 'right');

    setTimeout(() => {
      this.setControl('jump', false);
    }, 100);
  }

  /**
   * Edge and Void Awareness:
   * Inspects blocks 1–2 blocks ahead and below the bot to prevent falling into the void or traps.
   */
  checkEdgeAhead(yaw) {
    if (!this.bot || !this.bot.entity || !this.bot.blockAt) return false;
    const pos = this.bot.entity.position;

    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);

    const checkPoint1 = pos.offset(forwardX * 1.2, -1, forwardZ * 1.2);
    const checkPoint2 = pos.offset(forwardX * 2.0, -2, forwardZ * 2.0);

    const b1 = this.bot.blockAt(checkPoint1);
    const b2 = this.bot.blockAt(checkPoint2);

    return (!b1 || b1.name === 'air' || b1.name === 'cave_air') &&
           (!b2 || b2.name === 'air' || b2.name === 'cave_air');
  }

  /**
   * Smooth Predictive Target Aiming:
   * Predicts target position using velocity estimation:
   * p_predicted = p + v * lookahead
   */
  aimAtTarget(targetEntity, aimHeight = 1.4, lookaheadSeconds = 0.15) {
    if (!this.bot || !this.bot.entity || !targetEntity || !targetEntity.position) return;

    const botPos = this.bot.entity.position;
    const targetPos = targetEntity.position;

    if (this.prevTargetPos) {
      const measuredVelocity = targetPos.minus(this.prevTargetPos);
      this.targetVelocity = measuredVelocity;
      // Low-pass the measured velocity so knockback/network packets do not
      // make the crosshair visibly snap from one prediction vector to another.
      this.smoothedTargetVelocity.x = (this.smoothedTargetVelocity.x * 0.70) + (measuredVelocity.x * 0.30);
      this.smoothedTargetVelocity.y = (this.smoothedTargetVelocity.y * 0.70) + (measuredVelocity.y * 0.30);
      this.smoothedTargetVelocity.z = (this.smoothedTargetVelocity.z * 0.70) + (measuredVelocity.z * 0.30);
    }
    this.prevTargetPos = targetPos.clone();

    // Velocity is measured in blocks per physics tick. Clamp prediction so a
    // sudden teleport/knockback packet cannot make the head snap wildly.
    const predictionTicks = Math.max(0, Math.min(lookaheadSeconds * 20, 3.0));
    const predictedVX = Math.max(-0.32, Math.min(0.32, this.smoothedTargetVelocity.x));
    const predictedVY = Math.max(-0.20, Math.min(0.20, this.smoothedTargetVelocity.y));
    const predictedVZ = Math.max(-0.32, Math.min(0.32, this.smoothedTargetVelocity.z));

    const predX = targetPos.x + (predictedVX * predictionTicks);
    const predY = targetPos.y + aimHeight + (predictedVY * 0.5);
    const predZ = targetPos.z + (predictedVZ * predictionTicks);

    const dx = predX - botPos.x;
    const dy = predY - (botPos.y + (this.bot.entity.eyeHeight || 1.6));
    const dz = predZ - botPos.z;

    const groundDist = Math.sqrt(dx * dx + dz * dz);
    const targetYaw = Math.atan2(-dx, -dz);
    const targetPitch = Math.atan2(dy, Math.max(0.1, groundDist));

    // Do not force a head rotation every combat tick. Use a small angular
    // deadband + interpolation so the crosshair stays stable while remaining
    // responsive enough for melee tracking.
    const now = Date.now();
    const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
    const lerpAngle = (from, to, amount) => from + wrapAngle(to - from) * amount;

    if (this.lastAimYaw == null || this.lastAimPitch == null) {
      this.lastAimYaw = targetYaw;
      this.lastAimPitch = targetPitch;
      this.lastAimTime = now;
      if (typeof this.bot.look === 'function') {
        this.bot.look(targetYaw, targetPitch, true).catch(() => {});
      }
    } else {
      const yawDelta = Math.abs(wrapAngle(targetYaw - this.lastAimYaw));
      const pitchDelta = Math.abs(targetPitch - this.lastAimPitch);

      if ((now - this.lastAimTime) >= this.aimUpdateIntervalMs &&
          (yawDelta >= this.aimDeadbandRad || pitchDelta >= this.aimDeadbandRad)) {
        const nextYaw = lerpAngle(this.lastAimYaw, targetYaw, this.aimSmoothing);
        const nextPitch = this.lastAimPitch + ((targetPitch - this.lastAimPitch) * this.aimSmoothing);

        this.lastAimYaw = nextYaw;
        this.lastAimPitch = nextPitch;
        this.lastAimTime = now;

        if (typeof this.bot.look === 'function') {
          this.bot.look(nextYaw, nextPitch, true).catch(() => {});
        }
      }
    }

    return { yaw: targetYaw, pitch: targetPitch, groundDist };
  }

  /**
   * Aim Directly Away From Target (Back to Enemy Escape Yaw):
   * Calculates the exact vector pointing away from target with obstacle deflection.
   * Turns the bot's back to the opponent so pressing W and sprinting moves away from them.
   */
  aimAwayFromTarget(targetEntity, options = {}) {
    if (!this.bot || !this.bot.entity || !targetEntity || !targetEntity.position) return;

    const botPos = this.bot.entity.position;
    const targetPos = targetEntity.position;

    // Vector pointing FROM target TO bot (directly away from target)
    const dx = botPos.x - targetPos.x;
    const dz = botPos.z - targetPos.z;

    let escapeYaw = (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001)
      ? (this.bot.entity.yaw || 0)
      : Math.atan2(-dx, -dz);

    // Wall & Obstacle Avoidance: If escape direction is blocked by a wall, deflect toward open space
    if (typeof this.checkWallAtYaw === 'function') {
      const wallAhead = this.checkWallAtYaw(escapeYaw, 2.0);
      if (wallAhead) {
        const wallLeft45 = this.checkWallAtYaw(escapeYaw + Math.PI / 4, 2.0);
        const wallRight45 = this.checkWallAtYaw(escapeYaw - Math.PI / 4, 2.0);
        if (!wallLeft45) {
          escapeYaw += Math.PI / 4;
        } else if (!wallRight45) {
          escapeYaw -= Math.PI / 4;
        } else {
          const wallLeft90 = this.checkWallAtYaw(escapeYaw + Math.PI / 2, 2.0);
          if (!wallLeft90) escapeYaw += Math.PI / 2;
          else escapeYaw -= Math.PI / 2;
        }
      }
    }

    // Platform edge / void check if applicable
    if (options.preventVoidDrops && typeof this.checkEdgeAhead === 'function' && this.checkEdgeAhead(escapeYaw)) {
      escapeYaw += Math.PI / 2;
    }

    const now = Date.now();
    this.lastAimYaw = escapeYaw;
    this.lastAimPitch = 0;
    this.lastAimTime = now;

    if (this.bot.entity) {
      this.bot.entity.yaw = escapeYaw;
      this.bot.entity.pitch = 0;
    }

    if (typeof this.bot.look === 'function') {
      try {
        const lookPromise = this.bot.look(escapeYaw, 0, true);
        if (lookPromise && typeof lookPromise.catch === 'function') {
          lookPromise.catch(() => {});
        }
      } catch {}
    }

    return { yaw: escapeYaw, pitch: 0 };
  }

  /**
   * Main movement update per combat tick (20 TPS).
   */
  update(target, context = {}) {
    this.updateWatchdog(target);

    if (!target || !target.position || !this.bot || !this.bot.entity) {
      if (this.currentState !== 'IDLE') {
        this.setState('IDLE');
      }
      return;
    }

    const botPos = this.bot.entity.position;
    const targetPos = target.position;
    const dist = botPos.distanceTo(targetPos);

    // 1. Dynamic Strafe Cadence
    this.strafeTicks++;
    if (this.strafeTicks >= this.strafeChangeInterval) {
      this.strafeTicks = 0;
      this.currentStrafeDirection = this.currentStrafeDirection === 'left' ? 'right' : 'left';
      this.strafeChangeInterval = 10 + Math.floor(Math.random() * 5); // 10-14 ticks
    }

    // 2. Corner Danger Mitigation: If corner detected, switch immediately to ESCAPE
    const cornerInfo = this.detectCornerDanger(1.5);
    if (cornerInfo.inCorner && this.currentState !== 'ESCAPE') {
      this.setState('ESCAPE', { escapeLeft: cornerInfo.escapeLeft });
      return;
    }

    // 3. Platform Edge / Void Awareness (Sumo / Bridge)
    if (context.preventVoidDrops && this.bot.entity.yaw != null) {
      const isNearEdge = this.checkEdgeAhead(this.bot.entity.yaw);
      if (isNearEdge) {
        this.setControl('forward', false);
        this.setControl('back', true);
        this.setControl('sprint', false);
        this.currentStrafeDirection = this.currentStrafeDirection === 'left' ? 'right' : 'left';
        this.setControl('left', this.currentStrafeDirection === 'left');
        this.setControl('right', this.currentStrafeDirection === 'right');
        return;
      }
    }

    // 4. Auto-clear 1-block steps during approach
    if (this.combatJumpingEnabled && this.combatAutoJumpEnabled && this.bot.entity.isCollidedHorizontally && (this.currentState === 'CHASE' || this.currentState === 'APPROACH')) {
      this.requestJump(true);
    }

    // 5. Re-apply state controls
    this.applyStateControls({
      strafeDirection: this.currentStrafeDirection,
      maintainSpacing: dist < (context.minSpacing || 1.6),
      pressForward: dist > (context.maxSpacing || 3.0),
      sprint: context.allowSprint !== false,
      escapeLeft: cornerInfo.escapeLeft,
    });
  }
}

// Backwards compatibility alias
CombatMovementController.MovementController = CombatMovementController;

module.exports = CombatMovementController;
