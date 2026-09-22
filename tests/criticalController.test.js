const assert = require('assert');
const { Vec3 } = require('vec3');
const CriticalAttackController = require('../criticalAttackController');
const MovementController = require('../movementController');
const { MinecraftBotManager } = require('../minecraftBot');

function createMockBot(initialPos = new Vec3(0, 64, 0)) {
  const controlStates = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false,
  };

  let attacks = [];
  let swings = [];

  const bot = {
    entity: {
      id: 99,
      position: initialPos.clone(),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      isOnLadder: false,
      isInWater: false,
      vehicle: null,
      isCollidedHorizontally: false,
    },
    heldItem: { name: 'diamond_sword' },
    health: 20,
    controlStates,
    setControlState: (control, val) => {
      controlStates[control] = Boolean(val);
    },
    clearControlStates: () => {
      for (const k of Object.keys(controlStates)) {
        controlStates[k] = false;
      }
    },
    attack: (target) => {
      attacks.push({ target, time: Date.now(), sprint: controlStates.sprint, onGround: bot.entity.onGround, vy: bot.entity.velocity.y });
    },
    swingArm: (hand) => {
      swings.push({ hand, time: Date.now() });
    },
    look: async (y, p) => {
      bot.entity.yaw = y;
      bot.entity.pitch = p;
    },
    attacks,
    swings
  };

  return { bot, controlStates, attacks, swings };
}

async function runTests() {
  console.log('🧪 Starting Critical Hit Controller & Sneak Purge Test Suite...\n');

  // =========================================================================
  // TEST 1: Full 8-State Critical Hit Trajectory Sequence
  // =========================================================================
  console.log('--- TEST 1: 8-State Critical Progression ---');
  {
    const { bot, controlStates, attacks } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    const controller = new CriticalAttackController(bot, mc, { debug: true });

    assert.strictEqual(controller.state, 'IDLE', 'Initial state must be IDLE');

    const target = {
      id: 101,
      username: 'Opponent',
      position: new Vec3(0, 64, 2.5),
      health: 20
    };

    const dist = 2.5;
    const now = Date.now();

    // 1. Start crit from ground
    const started = controller.startCrit(target, dist, true, now);
    assert.strictEqual(started, true, 'startCrit should succeed when grounded with cooldown ready');
    assert.strictEqual(controller.state, 'JUMP_START', 'State must advance to JUMP_START');
    assert.strictEqual(controlStates.sprint, false, 'Sprint MUST be disengaged during jump for 1.20.4 crit');
    assert.strictEqual(controlStates.sneak, false, 'Sneak must NOT be pressed during jump');
    assert.strictEqual(controller.isInCritSequence(), true, 'isInCritSequence must be true');

    // 2. Ascending in air (vy = +0.38, y = 64.38) -> RISING
    bot.entity.onGround = false;
    bot.entity.position.y = 64.38;
    bot.entity.velocity.y = 0.38;
    let tickResult = controller.update(target, dist, true, now + 50);
    assert.strictEqual(controller.state, 'RISING', 'State must advance to RISING');
    assert.strictEqual(tickResult.attacked, false, 'Attack MUST be suppressed while rising');
    assert.strictEqual(attacks.length, 0, 'No attacks dispatched during rise');

    // 3. Peak of jump (vy = +0.05, y = 64.80) -> still rising
    bot.entity.position.y = 64.80;
    bot.entity.velocity.y = 0.05;
    tickResult = controller.update(target, dist, true, now + 100);
    assert.strictEqual(controller.state, 'RISING', 'State should remain RISING near apex');
    assert.strictEqual(attacks.length, 0, 'No attacks dispatched near apex');

    // 4. Apex crossed, descending (vy = -0.15, y = 64.65) -> FALLING -> CRIT_ATTACK
    bot.entity.position.y = 64.65;
    bot.entity.velocity.y = -0.15;
    tickResult = controller.update(target, dist, true, now + 150);
    // When falling with cooldown ready and in range, update immediately triggers CRIT_ATTACK!
    assert.strictEqual(tickResult.attacked, true, 'Attack MUST execute during falling descent');
    assert.strictEqual(controller.state, 'CRIT_ATTACK', 'State transitions to CRIT_ATTACK upon strike execution');
    assert.strictEqual(attacks.length, 1, 'Exactly one attack executed');

    // Check critical hit validity conditions:
    const critHit = attacks[0];
    assert.strictEqual(critHit.onGround, false, 'Crit hit must connect while airborne');
    assert(critHit.vy < -0.04, `Crit hit must connect while descending (vy = ${critHit.vy})`);
    assert.strictEqual(critHit.sprint, false, 'Crit hit must NOT be sprinting in 1.20.4!');

    // 5. Landing on ground (onGround = true) -> LANDING -> RECOVERY
    bot.entity.onGround = true;
    bot.entity.velocity.y = 0;
    bot.entity.position.y = 64.0;
    tickResult = controller.update(target, dist, true, now + 200);
    assert.strictEqual(controller.state, 'RECOVERY', 'LANDING immediately transitions to RECOVERY');
    assert.strictEqual(controlStates.sneak, false, 'LANDING must NOT activate sneak (sneak purge verified)');
    assert.strictEqual(controlStates.sprint, true, 'LANDING must restore sprint on solid ground');

    // 6. Cooldown tick settling -> IDLE
    tickResult = controller.update(target, dist, true, now + 250);
    assert.strictEqual(controller.state, 'IDLE', 'State must return to IDLE');
    assert.strictEqual(controller.isInCritSequence(), false, 'isInCritSequence must be false');

    console.log('✅ TEST 1 PASSED: 8-State critical progression verified with descent check and sprint release.');
  }

  // =========================================================================
  // TEST 2: Ground & Cooldown Gating
  // =========================================================================
  console.log('\n--- TEST 2: Ground and Cooldown Gating ---');
  {
    const { bot } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    const controller = new CriticalAttackController(bot, mc);
    const target = { username: 'Enemy', position: new Vec3(0, 64, 2.5) };

    // A. Rejection if already airborne
    bot.entity.onGround = false;
    const rejectAirborne = controller.startCrit(target, 2.5, true);
    assert.strictEqual(rejectAirborne, false, 'Must reject crit jump if bot is not on ground');
    assert.strictEqual(controller.state, 'IDLE');

    // B. Rejection if weapon cooldown is NOT ready
    bot.entity.onGround = true;
    const rejectCooldown = controller.startCrit(target, 2.5, false);
    assert.strictEqual(rejectCooldown, false, 'Must reject crit jump if weapon cooldown is not ready');
    assert.strictEqual(controller.state, 'IDLE');

    // C. Rejection if target is too far away (> 3.2m)
    const rejectFar = controller.startCrit(target, 4.0, true);
    assert.strictEqual(rejectFar, false, 'Must reject crit jump if target is out of range');

    // D. Rejection if target is too close (< 1.6m, risk of hitting into opponent hitbox before apex)
    const rejectTooClose = controller.startCrit(target, 1.2, true);
    assert.strictEqual(rejectTooClose, false, 'Must reject crit jump if target is inside 1.6m');

    console.log('✅ TEST 2 PASSED: Ground check, cooldown readiness, and distance boundaries strictly enforced.');
  }

  // =========================================================================
  // TEST 3: Target Escaped While Airborne -> Attack Suppressed, Clean Landing
  // =========================================================================
  console.log('\n--- TEST 3: Opponent Escaping During Jump ---');
  {
    const { bot, attacks, controlStates } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    const controller = new CriticalAttackController(bot, mc);
    const target = { username: 'Runner', position: new Vec3(0, 64, 2.5) };

    controller.startCrit(target, 2.5, true);
    bot.entity.onGround = false;
    bot.entity.position.y = 64.4;
    bot.entity.velocity.y = 0.3;
    controller.update(target, 2.5, true); // Rising

    // Target suddenly sprints away to 4.5m while bot is airborne
    bot.entity.position.y = 64.3;
    bot.entity.velocity.y = -0.15; // Falling!
    const farDist = 4.5;
    const tickResult = controller.update(target, farDist, true);

    assert.strictEqual(tickResult.attacked, false, 'Attack must NOT execute if target escaped reach');
    assert.strictEqual(attacks.length, 0, 'Zero attacks dispatched');

    // Bot lands
    bot.entity.onGround = true;
    bot.entity.velocity.y = 0;
    controller.update(target, farDist, true);
    assert.strictEqual(controlStates.sneak, false, 'No sneak on landing');

    console.log('✅ TEST 3 PASSED: Opponent escape safely aborts attack; cleanly lands with 0 sneak.');
  }

  // =========================================================================
  // TEST 4: Centralized Attack Scheduler Mutual Exclusion
  // =========================================================================
  console.log('\n--- TEST 4: Centralized Attack Scheduler Mutual Exclusion ---');
  {
    const mcManager = new MinecraftBotManager();
    const { bot, attacks } = createMockBot(new Vec3(0, 64, 0));
    mcManager.bot = bot;
    mcManager.movementController.bot = bot;
    mcManager.status = 'online';
    mcManager.pvpActive = true;
    mcManager.combatPhase = 'COMBO';
    mcManager.comboHitsCount = 0;
    mcManager.targetComboHits = 3;

    const target = { username: 'Rival', position: new Vec3(0, 64, 2.4) };
    let now = Date.now();

    // Hit 1: Grounded combo hit
    mcManager.scheduleAttack(target, 2.4, true, now);
    assert.strictEqual(attacks.length, 1, 'First combo hit executed');
    assert.strictEqual(mcManager.comboHitsCount, 1);
    assert.strictEqual(mcManager.combatPhase, 'COMBO');

    // Hit 2: Grounded combo hit
    now += 700;
    mcManager.scheduleAttack(target, 2.4, true, now);
    assert.strictEqual(attacks.length, 2, 'Second combo hit executed');
    assert.strictEqual(mcManager.comboHitsCount, 2);

    // Hit 3: Grounded combo hit -> reaches target combo hits (3)
    now += 700;
    mcManager.scheduleAttack(target, 2.4, true, now);
    assert.strictEqual(attacks.length, 3, 'Third combo hit executed');
    assert(mcManager.combatPhase === 'CRIT' || mcManager.combatPhase === 'CRITICAL_SETUP', 'Phase transitioned to CRIT/CRITICAL_SETUP after 3 combo hits');

    // Next attack tick: CRIT Phase starts crit sequence
    now += 700;
    mcManager.scheduleAttack(target, 2.4, true, now);
    assert.strictEqual(mcManager.critController.state, 'JUMP_START', 'CRIT phase triggered critController.startCrit');

    // While airborne and rising: scheduler must NOT fire grounded combo hits!
    bot.entity.onGround = false;
    bot.entity.position.y = 64.4;
    bot.entity.velocity.y = 0.35;
    now += 50;
    mcManager.scheduleAttack(target, 2.4, true, now);
    assert.strictEqual(attacks.length, 3, 'Grounded combo attacks strictly blocked during crit sequence');

    // Falling window: scheduler executes the falling crit
    bot.entity.position.y = 64.3;
    bot.entity.velocity.y = -0.15;
    now += 50;
    mcManager.scheduleAttack(target, 2.4, true, now);
    assert.strictEqual(attacks.length, 4, 'Falling critical attack executed via scheduler');
    assert.strictEqual(mcManager.critHitsCount, 1);

    console.log('✅ TEST 4 PASSED: Centralized Attack Scheduler successfully ensures mutual exclusion between combos and crits.');
  }

  // =========================================================================
  // TEST 5: Sneak Usage Frequency Verification (Must be 0% in normal combat)
  // =========================================================================
  console.log('\n--- TEST 5: Sneak Purge (0% Sneak Across 100 Combat Ticks) ---');
  {
    const { bot, controlStates } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    const statesToTest = ['CHASE', 'APPROACH', 'STRAFE_LEFT', 'STRAFE_RIGHT', 'RETREAT', 'REPOSITION', 'CIRCLE', 'DISENGAGE', 'CRITICAL_SETUP', 'COMBO_PRESSURE', 'RECOVER', 'IDLE'];
    const target = { position: new Vec3(0, 64, 2.5) };

    let sneakActiveCount = 0;
    const totalTicks = 100;

    for (let i = 0; i < totalTicks; i++) {
      const state = statesToTest[i % statesToTest.length];
      mc.setState(state);
      mc.update(target, { preventVoidDrops: false });

      // Trigger damage knockback every 10 ticks
      if (i % 10 === 0) {
        mc.handleKnockbackRecovery();
      }

      if (controlStates.sneak === true) {
        sneakActiveCount++;
      }
    }

    assert.strictEqual(sneakActiveCount, 0, `Sneak must be 0% in combat, got ${sneakActiveCount}/${totalTicks}`);
    console.log(`✅ TEST 5 PASSED: Sneak state remained strictly FALSE across all ${totalTicks} ticks (0.0% usage).`);
  }

  console.log('\n======================================================');
  console.log('🎉 ALL CRITICAL HIT & SNEAK PURGE TESTS PASSED (5/5)!');
  console.log('======================================================\n');
}

runTests().catch(err => {
  console.error('❌ Critical Controller test failed:', err);
  process.exit(1);
});
