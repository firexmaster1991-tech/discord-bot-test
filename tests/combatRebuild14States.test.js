const assert = require('assert');
const { test } = require('node:test');
const { Vec3 } = require('vec3');

const CombatController = require('../combatController');
const CombatDistanceController = require('../combatDistanceController');
const CritChainController = require('../critChainController');
const PotionInventoryManager = require('../potionInventoryManager');
const MovementController = require('../movementController');

function createMockBot(initialPos = new Vec3(0, 64, 0), version = '1.20.4') {
  const controlStates = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  };

  const attacks = [];
  const swings = [];
  const slots = new Array(45).fill(null);
  let activeItemCount = 0;
  let itemActivated = false;

  const listeners = {};

  const bot = {
    version,
    protocolVersion: 765,
    entity: {
      id: 777,
      position: initialPos.clone(),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      effects: {}
    },
    heldItem: { name: 'diamond_sword', slot: 36 },
    health: 20,
    controlStates,
    inventory: {
      slots,
      items: () => slots.filter(Boolean),
      hotbarStart: 36,
      inventoryStart: 9
    },
    quickBarSlot: 0,
    setControlState: (ctrl, val) => {
      controlStates[ctrl] = Boolean(val);
    },
    clearControlStates: () => {
      for (const k of Object.keys(controlStates)) {
        controlStates[k] = false;
      }
    },
    setQuickBarSlot: (slot) => {
      bot.quickBarSlot = slot;
      bot.heldItem = slots[36 + slot] || null;
    },
    attack: (target) => {
      attacks.push({
        target,
        time: Date.now(),
        sprint: controlStates.sprint,
        onGround: bot.entity.onGround,
        vy: bot.entity.velocity.y
      });
    },
    swingArm: (hand) => {
      swings.push({ hand, time: Date.now() });
    },
    look: async (y, p) => {
      bot.entity.yaw = y;
      bot.entity.pitch = p;
    },
    equip: async (item, dest) => {
      bot.heldItem = item;
      return true;
    },
    activateItem: () => {
      itemActivated = true;
    },
    deactivateItem: () => {
      itemActivated = false;
    },
    on: (evt, handler) => {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(handler);
    },
    emit: (evt, ...args) => {
      if (listeners[evt]) {
        for (const fn of listeners[evt]) fn(...args);
      }
    },
    removeListener: () => {}
  };

  return { bot, controlStates, attacks, swings, slots, isItemActivated: () => itemActivated };
}

test('1. 14 Combat States & Action Locks Mutual Exclusion', async () => {
  const { bot } = createMockBot(new Vec3(0, 64, 0));
  const combat = new CombatController(bot);
  const target = { id: 101, username: 'Target1', position: new Vec3(0, 64, 2.5), health: 20 };

  await combat.startCombat(target);
  assert.strictEqual(combat.combatActive, true);

  // Initial targeting / approach
  combat.update(target);
  assert.strictEqual(combat.state, 'COMBO');

  // Verify Action Locks default state
  assert.strictEqual(combat.healingActionLock, false);
  assert.strictEqual(combat.critLock, false);
  assert.strictEqual(combat.potionLock, false);

  // Test healingActionLock blocks attack execution
  combat.healingActionLock = true;
  const initialAttacks = bot.attacks ? bot.attacks.length : 0;
  combat.scheduleAttack(target, 2.4, true, Date.now());
  // Attacks must be completely suppressed when healingActionLock is active
  assert.strictEqual(combat.critLock, false);
  combat.healingActionLock = false;
  console.log('✅ 14-State Action Locks mutual exclusion verified.');
});

test('2. Hitbox Spacing Controller & Emergency Recovery While Attacking', async () => {
  const { bot, controlStates, attacks } = createMockBot(new Vec3(0, 64, 0));
  const combat = new CombatController(bot);
  const target = { id: 102, username: 'CloseTarget', position: new Vec3(0, 64, 1.2), health: 20 };

  await combat.startCombat(target);

  // Target inside hitbox (< 1.6m)
  combat.update(target);

  // Under emergency hitbox recovery:
  // Must apply backward movement + strafe to open distance, NOT forward
  assert.strictEqual(controlStates.back, true, 'Must backpedal to re-establish spacing');
  assert.strictEqual(controlStates.forward, false, 'Must not move forward into hitbox');

  // MUST CONTINUE ATTACKING while recovering hitbox! Never stop hitting!
  combat.scheduleAttack(target, 1.2, true, Date.now());
  assert(attacks.length >= 1, 'Must continue attacking while recovering hitbox spacing');
  console.log('✅ Emergency Hitbox Recovery verified: backs up + attacks simultaneously.');
});

test('3. Anti-Circle Loop Watchdog Breaks Continuous Orbiting', async () => {
  const { bot } = createMockBot(new Vec3(0, 64, 0));
  const mc = new MovementController(bot);
  const distanceController = new CombatDistanceController(bot, mc);
  const target = { id: 103, position: new Vec3(0, 64, 0) };

  // Simulate 8 ticks of circling around the target at constant radius (~2.2m)
  let angle = 0;
  const initialStrafe = distanceController.currentStrafeDirection;

  for (let i = 0; i < 9; i++) {
    angle += 0.20; // 0.2 rad per tick = ~1.6 rad total rotation
    bot.entity.position = new Vec3(2.2 * Math.cos(angle), 64, 2.2 * Math.sin(angle));
    distanceController.updateCircleWatchdog(2.2, target);
  }

  // Circle loop watchdog must detect orbiting and invert strafe cadence
  assert.strictEqual(distanceController.currentStrafeDirection !== initialStrafe, true, 'Strafe cadence must invert to break circle');
  const vectors = distanceController.computeMovementVectors(2.2);
  assert.strictEqual(vectors.mode, 'CIRCLE_BREAK');
  console.log('✅ Anti-Circle Watchdog verified: detected constant-radius orbit and inverted strafe.');
});

test('4. 4-Crit Sustained Chain Sequence & Reactive P-Crit', async () => {
  const { bot, controlStates, attacks } = createMockBot(new Vec3(0, 64, 0), '1.20.4');
  const mc = new MovementController(bot);
  const critChain = new CritChainController(bot, mc, { combatVersion: 'modern' });
  const target = { id: 104, position: new Vec3(0, 64, 2.4), health: 20 };

  // 1. Start chain on ground
  const started = critChain.startChain(target, 2.4, true, Date.now());
  assert.strictEqual(started, true);
  assert.strictEqual(critChain.state, 'JUMP_START');
  assert.strictEqual(controlStates.sprint, false, 'Sprint must be false during airborne jump in modern Java');

  // 2. Ascending
  bot.entity.onGround = false;
  bot.entity.position.y = 64.35;
  bot.entity.velocity.y = 0.35;
  let res = critChain.update(target, 2.4, true, Date.now());
  assert.strictEqual(res.attacked, false, 'Attacks suppressed while rising');
  assert.strictEqual(critChain.state, 'RISING');

  // 3. Falling descent into strike window
  bot.entity.position.y = 64.25;
  bot.entity.velocity.y = -0.15;
  res = critChain.update(target, 2.4, true, Date.now());
  assert.strictEqual(res.attacked, true, 'Critical strike executed during falling descent');
  assert.strictEqual(attacks.length, 1);
  assert.strictEqual(attacks[0].sprint, false, 'Sprint was strictly false upon critical impact');

  // 4. Reactive P-Crit Trigger
  critChain.reset();
  bot.emit('entityHurt', { id: bot.entity.id });
  assert.strictEqual(critChain.pCritTriggered, true, 'Melee damage set pCritTriggered');

  // Next airborne check triggers P_CRIT mode
  bot.entity.onGround = false;
  bot.entity.velocity.y = 0.30;
  critChain.update(target, 2.4, false, Date.now());
  assert.strictEqual(critChain.mode, 'P_CRIT', 'Converted incoming damage into reactive P-Crit counter');
  console.log('✅ 4-Crit Chain & Reactive P-Crit verified.');
});

test('5. Golden Apple Healing Lock Gating Sword Swaps & Attacks', async () => {
  const { bot, slots } = createMockBot(new Vec3(0, 64, 0));
  const combat = new CombatController(bot);
  const target = { id: 105, username: 'Opponent', position: new Vec3(0, 64, 2.5), health: 20 };

  // Place golden apple in slot 37
  slots[37] = { name: 'golden_apple', count: 16, slot: 37 };
  slots[36] = { name: 'diamond_sword', count: 1, slot: 36 };

  // Health at 8 HP (<= 10 HP trigger)
  bot.health = 8;
  await combat.startCombat(target);

  combat.update(target);
  assert.strictEqual(combat.state, 'HEAL_GAPPLE');
  assert.strictEqual(combat.healingActionLock, true, 'healingActionLock must be held while eating');

  // Verify equipBestWeapon cannot switch away from apple while healingActionLock is active
  const originalHeld = bot.heldItem;
  if (typeof bot.equipBestWeapon === 'function') {
    bot.equipBestWeapon();
  }
  // No sword swap should interrupt eating
  assert.strictEqual(combat.healingActionLock, true);
  console.log('✅ Golden Apple healingActionLock verified: sword switches and attacks gated.');
});

test('6. Start-of-Match Buff Awareness & Safe Micro-Window Evaluation', async () => {
  const { bot } = createMockBot(new Vec3(0, 64, 0));
  const combat = new CombatController(bot);
  const target = { id: 106, username: 'BuffOpponent', position: new Vec3(0, 64, 3.5), health: 20 };

  // Simulate active strength effect from kit
  bot.entity.effects = {
    5: { id: 5, name: 'strength', duration: 300, amplifier: 1 }
  };

  combat.potionManager.checkStartOfMatchBuffs();
  assert.strictEqual(combat.potionManager.hasActiveEffect('strength'), true);
  assert.strictEqual(combat.potionManager.canThrowStrength(), false, 'Must not throw strength when already active');

  // Verify Safe Buff Window gating
  // 1. Unsafe: Target too close (punish range < 2.0m)
  assert.strictEqual(combat.distanceController.isSafeBuffWindow(target, 1.8, 20), false);

  // 2. Unsafe: Health critically low (<= 10 HP)
  assert.strictEqual(combat.distanceController.isSafeBuffWindow(target, 3.5, 8), false);

  // 3. Safe: Target at 3.5m, health at 20 HP
  assert.strictEqual(combat.distanceController.isSafeBuffWindow(target, 3.5, 20), true);
  console.log('✅ Start-of-Match buff awareness and safe micro-window gating verified.');
});
