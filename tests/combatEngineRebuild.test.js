const assert = require('assert');
const { Vec3 } = require('vec3');
const CombatMovementController = require('../movementController');
const CombatController = require('../combatController');
const CrystalPvPController = require('../cpvpController');
const CriticalAttackController = require('../criticalAttackController');
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

  const blocks = new Map();
  const entities = {};
  let attacks = [];
  let swings = [];
  let placements = [];
  let looks = [];

  const bot = {
    entity: {
      id: 99,
      position: initialPos.clone(),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      eyeHeight: 1.6,
      onGround: true,
      isOnLadder: false,
      isInWater: false,
      vehicle: null,
      isCollidedHorizontally: false,
    },
    heldItem: { name: 'diamond_sword' },
    health: 20,
    controlStates,
    entities,
    inventory: {
      items: () => [
        { name: 'diamond_sword', slot: 36 },
        { name: 'obsidian', slot: 37, count: 64 },
        { name: 'end_crystal', slot: 38, count: 64 }
      ]
    },
    setControlState: (control, val) => {
      controlStates[control] = Boolean(val);
    },
    clearControlStates: () => {
      for (const k of Object.keys(controlStates)) {
        controlStates[k] = false;
      }
    },
    attack: (target) => {
      attacks.push({ target, time: Date.now(), onGround: bot.entity.onGround, vy: bot.entity.velocity.y, sprint: controlStates.sprint });
    },
    swingArm: (hand) => {
      swings.push({ hand, time: Date.now() });
    },
    look: async (y, p) => {
      bot.entity.yaw = y;
      bot.entity.pitch = p;
      looks.push({ y, p, time: Date.now() });
    },
    lookAt: async (pt) => {
      looks.push({ pt, time: Date.now() });
    },
    equip: async (item, hand) => {
      bot.heldItem = item;
    },
    placeBlock: async (refBlock, faceVec) => {
      placements.push({ refBlock, faceVec, time: Date.now() });
    },
    blockAt: (pos) => {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      if (blocks.has(key)) return blocks.get(key);
      // Default: ground below y=64 is bedrock/stone; above is air
      if (pos.y < 64) {
        return { name: 'stone', boundingBox: 'block', position: pos.floored() };
      }
      return { name: 'air', boundingBox: 'empty', position: pos.floored() };
    },
    setBlock: (pos, name, boundingBox = 'block') => {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      blocks.set(key, { name, boundingBox, position: pos.floored() });
    },
    pathfinder: {
      isMoving: () => false,
      stop: () => { bot.pathfinderStopped = true; }
    },
    on: () => {},
    removeListener: () => {},
    activateItem: () => {},
    deactivateItem: () => {},
    moveSlotItem: async () => true,
    quickBarSlot: 0,
    setQuickBarSlot: (slot) => { bot.quickBarSlot = slot; },
    attacks,
    swings,
    placements,
    looks,
    pathfinderStopped: false,
  };

  return { bot, controlStates, attacks, swings, placements, looks };
}

async function runTests() {
  console.log('🧪 Starting 10 Authorized Combat Engine & Corner Bug Rebuild Tests...\n');

  // =========================================================================
  // TEST 1: Enemy directly ahead -> Bot approaches and attacks
  // =========================================================================
  console.log('--- TEST 1: Enemy Directly Ahead ---');
  {
    const { bot, controlStates, attacks } = createMockBot(new Vec3(0, 64, 0));
    const combat = new CombatController(bot);
    const target = { id: 101, username: 'Enemy1', position: new Vec3(0, 64, 4.0), health: 20 };

    await combat.startCombat(target);
    assert.strictEqual(combat.movementController.getState(), 'APPROACH');
    assert.strictEqual(controlStates.forward, true, 'Bot must move forward towards target');
    assert.strictEqual(controlStates.sprint, true, 'Bot must sprint when approaching');

    // Close in to strike range (2.4m)
    bot.entity.position = new Vec3(0, 64, 1.6);
    combat.update(target);
    assert(attacks.length >= 1, 'Bot must attack when target is in strike range');
    assert.strictEqual(attacks[0].target, target);
    console.log('✅ TEST 1 PASSED: Bot aggressively approaches and attacks enemy directly ahead.');
  }

  // =========================================================================
  // TEST 2: Enemy strafes left/right -> Bot tracks and strafes
  // =========================================================================
  console.log('\n--- TEST 2: Enemy Strafes Left/Right ---');
  {
    const { bot, controlStates } = createMockBot(new Vec3(0, 64, 0));
    const combat = new CombatController(bot);
    const target = { id: 102, username: 'Enemy2', position: new Vec3(2.5, 64, 2.5), health: 20 };

    await combat.startCombat(target);
    bot.entity.position = new Vec3(0, 64, 0);

    // Enemy strafes right (+X)
    target.position = new Vec3(3.0, 64, 1.0);
    combat.update(target);

    // Bot yaw must rotate towards target
    assert(bot.entity.yaw !== 0, 'Bot yaw must track target rotation');
    assert(controlStates.left || controlStates.right || controlStates.forward, 'Bot must dynamically strafe/track');
    console.log('✅ TEST 2 PASSED: Bot tracks and matches enemy lateral strafe.');
  }

  // =========================================================================
  // TEST 3: Enemy retreats -> Bot chases
  // =========================================================================
  console.log('\n--- TEST 3: Enemy Retreats ---');
  {
    const { bot, controlStates } = createMockBot(new Vec3(0, 64, 0));
    const combat = new CombatController(bot);
    const target = { id: 103, username: 'Runner', position: new Vec3(0, 64, 3.0), health: 20 };

    await combat.startCombat(target);
    combat.update(target);

    // Enemy retreats to 6.0m
    target.position = new Vec3(0, 64, 6.0);
    combat.update(target);

    assert.strictEqual(combat.phase, 'PRESSURE');
    assert.strictEqual(combat.movementController.getState(), 'CHASE');
    assert.strictEqual(controlStates.forward, true);
    assert.strictEqual(controlStates.sprint, true);
    assert.strictEqual(controlStates.back, false, 'Must not move backwards while chasing');
    console.log('✅ TEST 3 PASSED: Bot immediately shifts into sprinting CHASE when enemy retreats.');
  }

  // =========================================================================
  // TEST 4: Bot reaches a wall / corner -> Changes angle instead of staying in corner
  // =========================================================================
  console.log('\n--- TEST 4: Bot Reaches Wall / Corner (Corner Bug Fix) ---');
  {
    const { bot, controlStates } = createMockBot(new Vec3(0, 64, 0));
    const combat = new CombatController(bot);
    const target = { id: 104, username: 'CornerOpponent', position: new Vec3(0, 64, 1.2), health: 20 };

    // Place solid walls behind the bot (-Z) and to the right (+X) to form a corner
    bot.setBlock(new Vec3(0, 64, -1), 'stone');
    bot.setBlock(new Vec3(0, 65, -1), 'stone');
    bot.setBlock(new Vec3(1, 64, 0), 'stone');
    bot.setBlock(new Vec3(1, 65, 0), 'stone');

    await combat.startCombat(target);
    // Opponent is close (1.2m). The old bug would return 'RETREAT' and walk backward into the corner!
    combat.update(target);

    // Under new engine:
    assert.notStrictEqual(controlStates.back, true, 'Bot MUST NOT walk backward into the wall!');
    assert.strictEqual(combat.movementController.isWallBehind(1.8), true, 'Wall behind must be detected');
    assert(combat.movementController.getState() === 'ESCAPE' || combat.movementController.getState() === 'REPOSITION',
      `State must be ESCAPE or REPOSITION, got ${combat.movementController.getState()}`);
    console.log('✅ TEST 4 PASSED: Bot detected corner and wall hazard; successfully escaped and refused to trap itself.');
  }

  // =========================================================================
  // TEST 5: Pathfinder fails -> Direct combat movement fallback
  // =========================================================================
  console.log('\n--- TEST 5: Pathfinder Fails -> Direct Movement Fallback ---');
  {
    const { bot, controlStates } = createMockBot(new Vec3(0, 64, 0));
    const combat = new CombatController(bot);
    const target = { id: 105, username: 'Enemy5', position: new Vec3(0, 64, 5.0), health: 20 };

    bot.pathfinder.isMoving = () => true;
    await combat.startCombat(target);

    // In close-quarters combat (< 15m), combat controller cancels pathfinder and drives direct WASD
    combat.update(target);
    assert.strictEqual(bot.pathfinderStopped, true, 'Pathfinder must be stopped in combat');
    assert.strictEqual(controlStates.forward, true, 'Direct WASD must drive movement');
    assert.strictEqual(controlStates.sprint, true);
    console.log('✅ TEST 5 PASSED: Pathfinder stopped and direct combat WASD took over.');
  }

  // =========================================================================
  // TEST 6: Bot receives knockback -> Recovery and re-engagement
  // =========================================================================
  console.log('\n--- TEST 6: Knockback Recovery & Re-engagement ---');
  {
    const mcManager = new MinecraftBotManager();
    const { bot, controlStates } = createMockBot(new Vec3(0, 64, 0));
    mcManager.bot = bot;
    mcManager.combatController.setBot(bot);
    mcManager.pvpActive = true;

    // Simulate taking knockback
    bot.entity.velocity = new Vec3(-0.8, 0.4, -0.8);
    mcManager.movementController.handleKnockbackRecovery();

    assert.strictEqual(controlStates.sneak, false, 'Knockback recovery must NOT activate sneak!');
    // Strafe direction flipped to counter-balance knockback
    assert.strictEqual(mcManager.movementController.currentStrafeDirection, 'right');
    console.log('✅ TEST 6 PASSED: Knockback recovered cleanly without sneak; strafe counter-balanced.');
  }

  // =========================================================================
  // TEST 7: Critical opportunity -> Jump -> Fall -> Attack
  // =========================================================================
  console.log('\n--- TEST 7: Critical Opportunity (Jump -> Fall -> Attack) ---');
  {
    const { bot, attacks, controlStates } = createMockBot(new Vec3(0, 64, 0));
    const mc = new CombatMovementController(bot);
    const crit = new CriticalAttackController(bot, mc, { combatVersion: 'modern' });
    const target = { username: 'CritTarget', position: new Vec3(0, 64, 2.4), health: 20 };

    const started = crit.startCrit(target, 2.4, true, Date.now());
    assert.strictEqual(started, true);
    assert.strictEqual(crit.state, 'JUMP_START');
    assert.strictEqual(controlStates.sprint, false, 'Sprint must be dropped for 1.20.4 crit');

    // Rising: suppressed
    bot.entity.onGround = false;
    bot.entity.velocity.y = 0.35;
    bot.entity.position.y = 64.35;
    crit.update(target, 2.4, true);
    assert.strictEqual(attacks.length, 0, 'No attacks during rise');

    // Falling: execute
    bot.entity.velocity.y = -0.15;
    bot.entity.position.y = 64.25;
    const res = crit.update(target, 2.4, true);
    assert.strictEqual(res.attacked, true);
    assert.strictEqual(attacks.length, 1);
    assert.strictEqual(attacks[0].sprint, false);
    console.log('✅ TEST 7 PASSED: Critical attack executed strictly during falling descent.');
  }

  // =========================================================================
  // TEST 8: CPvP enemy approaches -> Bot moves, tracks and acts
  // =========================================================================
  console.log('\n--- TEST 8: CPvP Active Movement & Crystal Action ---');
  {
    const { bot, controlStates, placements } = createMockBot(new Vec3(0, 64, 0));
    const mc = new CombatMovementController(bot);
    const cpvp = new CrystalPvPController(bot, mc);
    const target = { username: 'CPvPOpponent', position: new Vec3(0, 64, 3.0), health: 20 };

    // Place an obsidian block on ground ready for crystal
    bot.setBlock(new Vec3(0, 63, 2), 'obsidian');

    await cpvp.update(target, 3.0, 20, 20);
    assert.strictEqual(cpvp.state, 'CPVP_CRYSTAL_ACTION');
    assert.strictEqual(placements.length, 1, 'Crystal must be placed on obsidian');
    console.log('✅ TEST 8 PASSED: CPvP controller actively tracked, positioned, and placed crystal.');
  }

  // =========================================================================
  // TEST 9: CPvP block position is invalid/behind obstruction -> NO BLOCK PLACED
  // =========================================================================
  console.log('\n--- TEST 9: CPvP Block Obstructed Behind Wall (Line-of-Sight Check) ---');
  {
    const { bot, placements } = createMockBot(new Vec3(0, 64, 0));
    const mc = new CombatMovementController(bot);
    const cpvp = new CrystalPvPController(bot, mc);
    const target = { username: 'WallHider', position: new Vec3(0, 64, 3.0), health: 20 };

    // Put a solid stone wall across the entire corridor at z=1 (x: -3 to 3, y: 64 to 66)
    for (let wx = -3; wx <= 3; wx++) {
      for (let wy = 64; wy <= 66; wy++) {
        bot.setBlock(new Vec3(wx, wy, 1), 'stone');
      }
    }
    bot.setBlock(new Vec3(0, 63, 3), 'obsidian');

    await cpvp.update(target, 3.0, 20, 20);

    // Because a complete stone wall separates the bot from the target,
    // line-of-sight fails for all points behind the wall and ZERO blocks may be placed!
    assert.strictEqual(placements.length, 0, 'MUST NOT place blocks through or behind walls!');
    console.log('✅ TEST 9 PASSED: Line-of-sight raycasting successfully rejected obstructed placement.');
  }

  // =========================================================================
  // TEST 10: CPvP action fails -> Action timeout triggers, movement resumes
  // =========================================================================
  console.log('\n--- TEST 10: CPvP Action Timeout (No Freezing) ---');
  {
    const { bot } = createMockBot(new Vec3(0, 64, 0));
    const mc = new CombatMovementController(bot);
    const cpvp = new CrystalPvPController(bot, mc);

    // Simulate an action that was locked 300ms ago (exceeding 250ms timeout)
    cpvp.actionLock = true;
    cpvp.actionStartTime = Date.now() - 350;

    const target = { username: 'Enemy10', position: new Vec3(0, 64, 3.0), health: 20 };
    await cpvp.update(target, 3.0, 20, 20);

    assert.strictEqual(cpvp.actionLock, false, 'Action lock must be released on timeout');
    assert.strictEqual(mc.getState(), 'CPVP_POSITION', 'Movement must resume in CPVP_POSITION');
    console.log('✅ TEST 10 PASSED: Action timeout cleared stalled action; movement resumed without freeze.');
  }

  console.log('\n======================================================');
  console.log('🎉 ALL 10 AUTHORIZED COMBAT REBUILD TESTS PASSED (10/10)!');
  console.log('======================================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('❌ Combat Rebuild test failed:', err);
  process.exit(1);
});
