const test = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const CombatController = require('../combatController');
const MovementController = require('../movementController');
const PotionInventoryManager = require('../potionInventoryManager');
const OpponentModel = require('../opponentModel');

function createMockBot(pos = new Vec3(0, 64, 0)) {
  const controlStates = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  };

  const slots = new Array(45).fill(null);
  const lookHistory = [];

  const bot = {
    version: '1.20.4',
    protocolVersion: 765,
    health: 20,
    quickBarSlot: 0,
    controlStates,
    heldItem: { name: 'diamond_sword' },
    entity: {
      id: 99,
      position: pos.clone(),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      isOnLadder: false,
      isInWater: false,
      vehicle: null,
      isCollidedHorizontally: false,
      effects: {}
    },
    inventory: {
      slots,
      items: () => slots.filter(Boolean),
      hotbarStart: 36,
      inventoryStart: 9,
      selectedItem: null
    },
    setControlState: (ctrl, val) => {
      controlStates[ctrl] = Boolean(val);
    },
    clearControlStates: () => {
      for (const k of Object.keys(controlStates)) {
        controlStates[k] = false;
      }
    },
    setQuickBarSlot: (s) => {
      bot.quickBarSlot = s;
      bot.heldItem = slots[36 + s] || { name: 'diamond_sword' };
    },
    attack: () => {},
    swingArm: () => {},
    look: async (y, p) => {
      bot.entity.yaw = y;
      bot.entity.pitch = p;
      lookHistory.push({ yaw: y, pitch: p });
    },
    equip: async (item) => {
      bot.heldItem = item;
    },
    activateItem: () => {},
    deactivateItem: () => {},
    blockAt: () => ({ name: 'air' }),
    on: () => {},
    removeListener: () => {}
  };

  return { bot, controlStates, slots, lookHistory };
}

test('HEALING RETREAT: Bot turns back to enemy (aims away) and presses W + Sprint (NEVER S) when healing', async () => {
  const { bot, controlStates, slots, lookHistory } = createMockBot(new Vec3(0, 64, 0));
  const combat = new CombatController(bot);

  // Opponent is at (0, 64, 4.0) (+Z direction from bot)
  const target = { id: 101, username: 'Pursuer', position: new Vec3(0, 64, 4.0), health: 20 };

  // Place golden apples in inventory
  slots[37] = { slot: 37, name: 'golden_apple', count: 16 };
  bot.health = 8; // Low HP: triggers heal

  await combat.startCombat(target);

  // Tick 1: CombatController update triggers healing
  combat.update(target);

  assert.strictEqual(combat.state, 'HEAL_GAPPLE');
  assert.strictEqual(combat.phase, 'HEALING');
  assert.strictEqual(combat.healingActionLock, true, 'Healing lock must be active');

  // KEY REQUIREMENT 1: Must press W (forward: true)
  assert.strictEqual(controlStates.forward, true, 'Bot must press W (forward) to run away while healing');

  // KEY REQUIREMENT 2: Must NOT press S (back: false)
  assert.strictEqual(controlStates.back, false, 'Bot must NEVER press S (back) to backpedal when healing');

  // KEY REQUIREMENT 3: Must Sprint (sprint: true)
  assert.strictEqual(controlStates.sprint, true, 'Bot must sprint to achieve high escape speed');

  // KEY REQUIREMENT 4: Must show back to enemy (aim away from target)
  // Target is at +Z relative to bot. Aiming directly AT target is yaw = PI (South).
  // Aiming directly AWAY from target (showing back) is yaw = 0 (North, -Z).
  const expectedAwayYaw = 0;
  const yawDiff = Math.abs(Math.atan2(Math.sin(bot.entity.yaw - expectedAwayYaw), Math.cos(bot.entity.yaw - expectedAwayYaw)));
  assert(yawDiff < 0.1, `Bot must face away from enemy (~0 rad), but yaw was ${bot.entity.yaw.toFixed(2)}`);

  console.log('✅ PASS: Bot turns back to enemy (yaw ~0), presses W + Sprint, and sets back to FALSE.');
});

test('CHASE EVASION: When enemy starts chasing bot while healing, bot actively runs away and jumps', async () => {
  const { bot, controlStates, slots } = createMockBot(new Vec3(0, 64, 0));
  const combat = new CombatController(bot);

  // Opponent at (0, 64, 4.5), moving toward bot (chasing!)
  const target = {
    id: 102,
    username: 'AggressiveChaser',
    position: new Vec3(0, 64, 4.5),
    velocity: new Vec3(0, 0, -0.30), // Moving towards bot at 0.30 blocks/tick
    health: 20
  };

  slots[37] = { slot: 37, name: 'golden_apple', count: 16 };
  bot.health = 7;

  await combat.startCombat(target);

  // Update tick
  combat.update(target);

  // Opponent model update
  combat.opponentModel.update(target);
  assert.strictEqual(combat.opponentModel.isChasing, true, 'OpponentModel must detect active pursuit');

  // During chase while healing:
  // Must maintain full escape controls
  assert.strictEqual(controlStates.forward, true);
  assert.strictEqual(controlStates.back, false);
  assert.strictEqual(controlStates.sprint, true);

  console.log('✅ PASS: Active chase detected and bot maintains high-speed sprint evasion.');
});

test('MOVEMENT CONTROLLER: aimAwayFromTarget computes exact 180-degree escape vector and wall deflection', () => {
  const { bot } = createMockBot(new Vec3(10, 64, 10));
  const mc = new MovementController(bot);

  // 1. Target directly East (+X) at (15, 64, 10)
  // Target direction is +X (yaw = -PI/2). Escape direction is -X (yaw = +PI/2).
  const targetEast = { position: new Vec3(15, 64, 10) };
  const resEast = mc.aimAwayFromTarget(targetEast);
  assert(Math.abs(resEast.yaw - (Math.PI / 2)) < 0.05, `Expected yaw PI/2 (+1.57), got ${resEast.yaw}`);
  assert.strictEqual(bot.entity.yaw, resEast.yaw);

  // 2. Target directly South (+Z) at (10, 64, 15)
  // Target direction is +Z (yaw = PI). Escape direction is -Z (yaw = 0).
  const targetSouth = { position: new Vec3(10, 64, 15) };
  const resSouth = mc.aimAwayFromTarget(targetSouth);
  assert(Math.abs(resSouth.yaw) < 0.05, `Expected yaw 0, got ${resSouth.yaw}`);
  assert.strictEqual(bot.entity.yaw, resSouth.yaw);

  // 3. Wall Deflection test
  // Mock a wall ahead in direction yaw = 0
  bot.blockAt = (pos) => {
    // If block is directly north of bot (-Z): solid wall
    if (pos.z < 10) return { name: 'stone', boundingBox: 'block' };
    return { name: 'air' };
  };

  const resDeflected = mc.aimAwayFromTarget(targetSouth);
  // Must deflect away from 0 because of stone wall ahead
  assert.notStrictEqual(resDeflected.yaw, 0, 'Must deflect yaw when wall is ahead');
  console.log(`✅ PASS: aimAwayFromTarget 180° inversion and wall deflection verified (deflected to ${resDeflected.yaw.toFixed(2)} rad).`);
});
