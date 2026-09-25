const test = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const CombatController = require('../combatController');
const PotionInventoryManager = require('../potionInventoryManager');
const CriticalAttackController = require('../criticalAttackController');
const MovementController = require('../movementController');

function createMockBot(pos = new Vec3(0, 64, 0), version = '1.20.4') {
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
  const attacks = [];
  const swings = [];
  let itemActivated = false;

  const bot = {
    version,
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
    attack: (t) => {
      attacks.push({
        target: t,
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
    equip: async (item, hand) => {
      bot.heldItem = item;
    },
    activateItem: () => {
      itemActivated = true;
    },
    deactivateItem: () => {
      itemActivated = false;
    },
    blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
    on: () => {},
    removeListener: () => {}
  };

  return { bot, controlStates, attacks, swings, slots, isItemActivated: () => itemActivated };
}

test('FIX 1: Bot does not freeze when potions are exhausted and moves in target direction', async () => {
  const { bot, controlStates, attacks } = createMockBot(new Vec3(0, 64, 0));
  const combat = new CombatController(bot);
  const target = { id: 101, username: 'Enemy', position: new Vec3(0, 64, 4.0), health: 20 };

  // Set health low (6 HP) but have ZERO potions in inventory
  bot.health = 6;
  assert.strictEqual(combat.potionManager.hasPotion('HEALING'), false, 'Bot has 0 healing potions');
  assert.strictEqual(combat.potionManager.hasGoldenApples(), false, 'Bot has 0 golden apples');

  await combat.startCombat(target);

  // Run update: bot must NOT freeze! It must move in the target's direction!
  combat.update(target);

  assert.strictEqual(controlStates.forward, true, 'Bot must move forward towards target when out of potions');
  assert.notStrictEqual(combat.movementController.getState(), 'IDLE', 'Bot must not be IDLE');
  assert.notStrictEqual(combat.movementController.getState(), 'RETREAT', 'Bot must not RETREAT into walls when out of potions');

  // Move inside striking distance (2.4m)
  target.position.z = 2.4;
  bot.entity.position = new Vec3(0, 64, 0);
  combat.update(target);

  // Bot must swing/attack rather than freezing
  assert(attacks.length >= 1, 'Bot must attack when target is in reach even when out of potions');
  console.log('✅ TEST PASSED: No freeze on potion exhaustion; bot aggressively presses target direction.');
});

test('FIX 2: Critical Hit Controller releases sprint during entire airborne phase for legitimate crits', async () => {
  const { bot, controlStates, attacks } = createMockBot(new Vec3(0, 64, 0), '1.20.4');
  const mc = new MovementController(bot);
  const critController = new CriticalAttackController(bot, mc, { combatVersion: 'modern' });
  const target = { id: 102, username: 'Rival', position: new Vec3(0, 64, 2.5), health: 20 };

  // Start crit on solid ground
  const started = critController.startCrit(target, 2.5, true);
  assert.strictEqual(started, true, 'startCrit must succeed');
  assert.strictEqual(controlStates.sprint, false, 'Sprint MUST be false upon crit jump start');

  // Rising phase
  bot.entity.onGround = false;
  bot.entity.position.y = 64.35;
  bot.entity.velocity.y = 0.35;
  critController.update(target, 2.5, true);
  assert.strictEqual(controlStates.sprint, false, 'Sprint MUST remain false while rising');
  assert.strictEqual(attacks.length, 0, 'Attacks suppressed while rising');

  // Falling apex -> Strike execution
  bot.entity.position.y = 64.30;
  bot.entity.velocity.y = -0.15;
  const tick = critController.update(target, 2.5, true);
  assert.strictEqual(tick.attacked, true, 'Critical strike executed');
  assert.strictEqual(attacks.length, 1);
  assert.strictEqual(attacks[0].sprint, false, 'Hit delivered with 0 sprint (genuine 1.5x crit)');
  assert.strictEqual(attacks[0].onGround, false, 'Hit delivered while airborne');
  assert(attacks[0].vy < -0.04, 'Hit delivered while descending');

  console.log('✅ TEST PASSED: Critical hit controller suppresses sprint during fall; registers legitimate crits.');
});

test('FIX 3: Golden Apple Eating when low health or absorption down', async () => {
  const { bot, slots, isItemActivated } = createMockBot(new Vec3(0, 64, 0));
  const pim = new PotionInventoryManager(bot, { healThresholdHP: 10 });

  // Place golden apple in main inventory (Slot 12)
  slots[12] = {
    slot: 12,
    name: 'golden_apple',
    displayName: 'Golden Apple',
    count: 16
  };

  assert.strictEqual(pim.hasGoldenApples(), true, 'Bot has golden apples');
  const gapple = pim.findGoldenApple();
  assert.strictEqual(gapple.name, 'golden_apple');
  assert.strictEqual(gapple.count, 16);

  // Trigger eatGoldenApple
  const eatPromise = pim.eatGoldenApple();
  assert.strictEqual(pim.isEating, true, 'isEating must be true during consumption');

  await eatPromise;
  assert.strictEqual(pim.isEating, false, 'isEating must be false after consumption');
  assert.strictEqual(bot.heldItem.name, 'diamond_sword', 'Primary weapon restored after eating');
  console.log('✅ TEST PASSED: Golden apple found, consumed, and weapon restored cleanly.');
});

test('FIX 4: Strength & Speed Effect Gating + 2-Second Post-Expiry Delay', async () => {
  const { bot } = createMockBot(new Vec3(0, 64, 0));
  const pim = new PotionInventoryManager(bot, { healThresholdHP: 10 });

  // 1. Initial State: No buffs active -> can throw
  assert.strictEqual(pim.isStrengthActive(), false, 'Strength not active initially');
  assert.strictEqual(pim.isSpeedActive(), false, 'Speed not active initially');
  assert.strictEqual(pim.canThrowStrength(), true, 'Can throw strength initially');
  assert.strictEqual(pim.canThrowSpeed(), true, 'Can throw speed initially');

  // 2. Apply Strength Buff (Minecraft effect ID 5)
  bot.entity.effects[5] = { id: 5, name: 'strength', duration: 300, amplifier: 1 };
  assert.strictEqual(pim.isStrengthActive(), true, 'Strength detected in effect via bot.entity.effects');
  assert.strictEqual(pim.canThrowStrength(), false, 'STRICT RULE: Do NOT throw strength while in effect!');

  // 3. Apply Speed Buff (Minecraft effect ID 1)
  bot.entity.effects[1] = { id: 1, name: 'speed', duration: 400, amplifier: 1 };
  assert.strictEqual(pim.isSpeedActive(), true, 'Speed detected in effect via bot.entity.effects');
  assert.strictEqual(pim.canThrowSpeed(), false, 'STRICT RULE: Do NOT throw speed while in effect!');

  // 4. Strength effect runs off (duration reaches 0 / cleared)
  delete bot.entity.effects[5];
  assert.strictEqual(pim.isStrengthActive(), false, 'Strength has run off');

  // 5. Test 2-second delay rule:
  const now = pim.strengthExpiredAt;
  // Immediately after running off (< 2000ms): MUST NOT THROW!
  assert.strictEqual(pim.canThrowStrength(now + 500), false, 'Must NOT throw after 0.5s of expiry (waiting for 2s delay)');
  assert.strictEqual(pim.canThrowStrength(now + 1500), false, 'Must NOT throw after 1.5s of expiry (waiting for 2s delay)');
  assert.strictEqual(pim.canThrowStrength(now + 1999), false, 'Must NOT throw before full 2000ms delay');

  // Exactly 2 seconds or more (>= 2000ms): SHOULD THROW POTION!
  assert.strictEqual(pim.canThrowStrength(now + 2001), true, 'MUST allow throwing potion after 2 seconds elapsed!');
  assert.strictEqual(pim.canThrowStrength(now + 3000), true, 'MUST allow throwing potion after 3 seconds elapsed!');

  // Same check for Speed:
  delete bot.entity.effects[1];
  assert.strictEqual(pim.isSpeedActive(), false, 'Speed has run off');
  assert.strictEqual(pim.canThrowSpeed(now + 1000), false, 'Speed must wait 2 seconds after running off');
  assert.strictEqual(pim.canThrowSpeed(now + 2050), true, 'Speed can throw after 2 seconds have passed');

  console.log('✅ TEST PASSED: Effect gating and exact 2-second post-expiry delay strictly verified.');
});
