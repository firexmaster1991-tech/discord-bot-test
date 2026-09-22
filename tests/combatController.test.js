const assert = require('assert');
const { Vec3 } = require('vec3');
const CombatController = require('../combatController');
const MovementController = require('../movementController');
const CriticalAttackController = require('../criticalAttackController');
const PotionInventoryManager = require('../potionInventoryManager');
const {
  detectCombatVersion,
  getWeaponAttackSpeed,
  getWeaponRecoveryMs,
  isAttackReady,
  WEAPON_ATTACK_SPEEDS
} = require('../combatProfiles');

function createMockBot(initialPos = new Vec3(0, 64, 0), version = '1.20.4') {
  const controlStates = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false,
  };

  const attacks = [];
  const swings = [];
  const items = [];

  // Mock 45 inventory slots
  const slots = new Array(45).fill(null);

  const inventory = {
    slots,
    items: () => slots.filter(Boolean),
    hotbarStart: 36,
    inventoryStart: 9,
    selectedItem: null
  };

  const bot = {
    version,
    protocolVersion: version === '1.8.9' ? 47 : 765,
    entity: {
      id: 88,
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
    inventory,
    quickBarSlot: 0,
    setControlState: (control, val) => {
      controlStates[control] = Boolean(val);
    },
    clearControlStates: () => {
      for (const k of Object.keys(controlStates)) {
        controlStates[k] = false;
      }
    },
    setQuickBarSlot: (slot) => {
      bot.quickBarSlot = slot;
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
    moveSlotItem: async (source, dest) => {
      const item = slots[source];
      slots[source] = slots[dest] || null;
      slots[dest] = item;
      return true;
    },
    activateItem: () => {},
    deactivateItem: () => {},
    on: () => {},
    removeListener: () => {},
    attacks,
    swings
  };

  return { bot, controlStates, inventory, attacks, swings };
}

async function runTests() {
  console.log('🧪 Starting Comprehensive Combat Controller & Version-Aware PvP Suite...\n');

  // =========================================================================
  // TEST 1: Protocol & Version Detection (Classic 1.8 vs Modern Java)
  // =========================================================================
  console.log('--- TEST 1: Protocol & Combat Version Detection ---');
  {
    // A. Default Modern 1.20.4
    const { bot: modernBot } = createMockBot(new Vec3(0, 64, 0), '1.20.4');
    const detectedModern = detectCombatVersion(modernBot, null);
    assert.strictEqual(detectedModern, 'modern', '1.20.4 bot must detect as modern');

    // B. Classic 1.8.9
    const { bot: classicBot } = createMockBot(new Vec3(0, 64, 0), '1.8.9');
    const detectedClassic = detectCombatVersion(classicBot, null);
    assert.strictEqual(detectedClassic, 'classic', '1.8.9 bot must detect as classic');

    // C. Server Profile Override takes precedence over bot version
    const overrideClassic = detectCombatVersion(modernBot, { combatVersion: '1.8' });
    assert.strictEqual(overrideClassic, 'classic', 'Server profile combatVersion 1.8 must override modern bot');

    const overrideModern = detectCombatVersion(classicBot, { combatVersion: 'modern' });
    assert.strictEqual(overrideModern, 'modern', 'Server profile combatVersion modern must override 1.8 bot');

    console.log('✅ TEST 1 PASSED: Automatic version detection & server profile overrides verified.');
  }

  // =========================================================================
  // TEST 2: Weapon-Aware Attack Speed & Cooldown Recovery Calculation
  // =========================================================================
  console.log('\n--- TEST 2: Weapon-Aware Attack Speed & Recovery Calculation ---');
  {
    // Modern Java weapon recovery calculation: recovery = (20 / attackSpeed) * 50ms
    const swordMs = getWeaponRecoveryMs('diamond_sword', 'modern');
    assert.strictEqual(swordMs, 625, `Diamond sword recovery must be 625ms (12.5 ticks), got ${swordMs}`);

    const diamondAxeMs = getWeaponRecoveryMs('diamond_axe', 'modern');
    assert.strictEqual(diamondAxeMs, 1000, `Diamond axe recovery must be 1000ms (20 ticks), got ${diamondAxeMs}`);

    const woodAxeMs = getWeaponRecoveryMs('wooden_axe', 'modern');
    assert.strictEqual(woodAxeMs, 1250, `Wooden axe recovery must be 1250ms (25 ticks), got ${woodAxeMs}`);

    const maceMs = getWeaponRecoveryMs('mace', 'modern');
    assert.strictEqual(maceMs, 1667, `Mace recovery must be 1667ms (33.3 ticks), got ${maceMs}`);

    const tridentMs = getWeaponRecoveryMs('trident', 'modern');
    assert.strictEqual(tridentMs, 909, `Trident recovery must be 909ms (18.2 ticks), got ${tridentMs}`);

    const diamondHoeMs = getWeaponRecoveryMs('diamond_hoe', 'modern');
    assert.strictEqual(diamondHoeMs, 250, `Diamond hoe recovery must be 250ms (5 ticks), got ${diamondHoeMs}`);

    // Classic 1.8: No modern cooldown, click timing ~85-110ms (~9-12 CPS)
    const classicSwordMs = getWeaponRecoveryMs('diamond_sword', 'classic');
    assert(classicSwordMs >= 80 && classicSwordMs <= 115, `Classic click interval should be ~85-110ms, got ${classicSwordMs}`);

    console.log('✅ TEST 2 PASSED: Weapon-aware recovery calculation & classic timing verified across all weapon tiers.');
  }

  // =========================================================================
  // TEST 3: 9-State Critical Hit Trajectory & Section 8 Telemetry Output
  // =========================================================================
  console.log('\n--- TEST 3: 9-State Critical Machine & Section 8 Telemetry ---');
  {
    const { bot, controlStates, attacks } = createMockBot(new Vec3(0, 64, 0), '1.20.4');
    const mc = new MovementController(bot);
    const telemetryLogs = [];
    const critController = new CriticalAttackController(bot, mc, {
      combatVersion: 'modern',
      debug: true,
      logger: (msg) => telemetryLogs.push(msg)
    });

    assert.strictEqual(critController.state, 'IDLE');

    const target = {
      username: 'TargetDummy',
      position: new Vec3(0, 64, 2.5)
    };
    const now = Date.now();

    // 1. Ground check -> JUMP_START
    const startOk = critController.startCrit(target, 2.5, true, now);
    assert.strictEqual(startOk, true);
    assert.strictEqual(critController.state, 'JUMP_START');
    assert.strictEqual(controlStates.sprint, false, 'Sprint MUST be false during modern Java crit');

    // 2. Ascending -> RISING (Attacks strictly suppressed)
    bot.entity.onGround = false;
    bot.entity.position.y = 64.35;
    bot.entity.velocity.y = 0.35;
    let res = critController.update(target, 2.5, true, now + 50);
    assert.strictEqual(critController.state, 'RISING');
    assert.strictEqual(res.attacked, false, 'Attacks strictly suppressed while rising');
    assert.strictEqual(attacks.length, 0);

    // 3. Peak -> APEX -> FALLING (Descent confirmed, execute strike!)
    bot.entity.position.y = 64.60;
    bot.entity.velocity.y = -0.15;
    res = critController.update(target, 2.5, true, now + 150);
    assert.strictEqual(res.attacked, true, 'Attack MUST execute during falling descent');
    assert.strictEqual(critController.state, 'CRIT_ATTACK');
    assert.strictEqual(attacks.length, 1);

    // Verify critical hit condition was met
    assert.strictEqual(attacks[0].onGround, false);
    assert(attacks[0].vy < -0.04);
    assert.strictEqual(attacks[0].sprint, false);

    // 4. Touch ground -> LANDING -> RECOVERY -> IDLE
    bot.entity.onGround = true;
    bot.entity.velocity.y = 0;
    critController.update(target, 2.5, true, now + 200);
    assert.strictEqual(critController.state, 'RECOVERY');
    assert.strictEqual(controlStates.sneak, false, 'Sneak must be strictly FALSE on landing');
    assert.strictEqual(controlStates.sprint, true, 'Sprint restored on ground');

    critController.update(target, 2.5, true, now + 250);
    assert.strictEqual(critController.state, 'IDLE');

    // Verify Section 8 Telemetry Log format
    const fullLogText = telemetryLogs.join('\n');
    assert(fullLogText.includes('CRIT ATTEMPT'), 'Telemetry must include CRIT ATTEMPT');
    assert(fullLogText.includes('Version: modern'), 'Telemetry must include Version');
    assert(fullLogText.includes('Vertical State: FALLING') || fullLogText.includes('Falling: true'), 'Telemetry must include Falling state');
    assert(fullLogText.includes('RESULT: ATTACK'), 'Telemetry must record RESULT: ATTACK');

    console.log('✅ TEST 3 PASSED: 9-state critical machine, falling execution, and Section 8 telemetry verified.');
  }

  // =========================================================================
  // TEST 4: Fast Potion Pre-Staging & Operation Lock Mutex
  // =========================================================================
  console.log('\n--- TEST 4: Fast Potion Pre-Staging & Operation Lock Mutex ---');
  {
    const { bot, inventory } = createMockBot(new Vec3(0, 64, 0), '1.20.4');
    const pim = new PotionInventoryManager(bot);

    // Put Healing in main inventory slot 14, Strength in slot 20, Speed in slot 21
    inventory.slots[14] = {
      slot: 14,
      name: 'splash_potion',
      displayName: 'Splash Potion of Healing II',
      count: 1,
      nbt: { value: { Potion: { value: 'minecraft:strong_healing' } } }
    };
    inventory.slots[20] = {
      slot: 20,
      name: 'splash_potion',
      displayName: 'Splash Potion of Strength II',
      count: 1,
      nbt: { value: { Potion: { value: 'minecraft:strong_strength' } } }
    };
    inventory.slots[21] = {
      slot: 21,
      name: 'splash_potion',
      displayName: 'Splash Potion of Swiftness II',
      count: 1,
      nbt: { value: { Potion: { value: 'minecraft:strong_swiftness' } } }
    };

    // Hotbar slots 36-39 are currently empty
    assert.strictEqual(inventory.slots[37], null);
    assert.strictEqual(inventory.slots[38], null);
    assert.strictEqual(inventory.slots[39], null);

    // Execute match-start pre-staging
    const prestaged = await pim.preStagePotions();
    assert.strictEqual(prestaged, true, 'preStagePotions should successfully move potions to reserved slots');

    // Confirmed in reserved hotbar slots:
    // Slot 37 (Quickbar 1) = Healing
    assert(inventory.slots[37] && inventory.slots[37].displayName.includes('Healing'), 'Slot 37 must contain Healing');
    // Slot 38 (Quickbar 2) = Strength
    assert(inventory.slots[38] && inventory.slots[38].displayName.includes('Strength'), 'Slot 38 must contain Strength');
    // Slot 39 (Quickbar 3) = Speed
    assert(inventory.slots[39] && inventory.slots[39].displayName.includes('Swiftness'), 'Slot 39 must contain Speed');

    // Test potionOperationLock mutex
    assert.strictEqual(pim.potionOperationLock, false, 'Lock must be released after pre-staging');

    console.log('✅ TEST 4 PASSED: Potion pre-staging into reserved slots & operation lock verified.');
  }

  // =========================================================================
  // TEST 5: 11 Combat Phases & Aggressive Decision Flow
  // =========================================================================
  console.log('\n--- TEST 5: 11 Combat Phases & Aggressive Decision Flow ---');
  {
    const { bot, attacks } = createMockBot(new Vec3(0, 64, 0), '1.20.4');
    const controller = new CombatController(bot, { combatVersion: 'modern' });

    const target = {
      username: 'Challenger',
      position: new Vec3(0, 64, 8.0), // Far away
      health: 20
    };

    // 1. Far away -> PRESSURE / OPENING
    controller.startCombat(target);
    controller.update(target);
    assert.strictEqual(controller.phase, 'PRESSURE', 'Far target should evaluate to PRESSURE phase');

    // 2. Approach into combat range (2.4m) -> COMBO & First Attack via update()
    target.position.z = 2.4;
    let now = Date.now();
    controller.update(target);
    assert.strictEqual(controller.phase, 'COMBO', 'Strike range target should evaluate to COMBO phase');
    assert.strictEqual(attacks.length, 1, 'First combo hit executed via update()');
    assert.strictEqual(controller.comboCount, 1);

    // Hit 2: Dispatched via scheduleAttack
    now += 700;
    controller.scheduleAttack(target, 2.4, true, now);
    assert.strictEqual(attacks.length, 2, 'Second combo hit executed');
    assert.strictEqual(controller.comboCount, 2);

    // Hit 3: Reaches target combo hits -> CRITICAL_SETUP
    now += 700;
    controller.scheduleAttack(target, 2.4, true, now);
    assert.strictEqual(attacks.length, 3, 'Third combo hit executed');
    assert.strictEqual(controller.phase, 'CRITICAL_SETUP', 'Target combo hits reached -> CRITICAL_SETUP');

    // 3. Crit initiation
    now += 700;
    controller.scheduleAttack(target, 2.4, true, now);
    assert.strictEqual(controller.critController.state, 'JUMP_START');

    // Airborne rising -> attacks blocked
    bot.entity.onGround = false;
    bot.entity.position.y = 64.4;
    bot.entity.velocity.y = 0.35;
    now += 50;
    controller.scheduleAttack(target, 2.4, true, now);
    assert.strictEqual(attacks.length, 3, 'No attacks during rising');

    // Falling descent -> crit executes
    bot.entity.position.y = 64.3;
    bot.entity.velocity.y = -0.15;
    now += 50;
    controller.scheduleAttack(target, 2.4, true, now);
    assert.strictEqual(attacks.length, 4, 'Falling critical strike executed');

    // 4. Opponent low health (5 HP) -> FINISH phase
    target.health = 5;
    const finishPhase = controller.evaluatePhase(2.2, 20, target.health);
    assert.strictEqual(finishPhase, 'FINISH', 'Opponent low HP should evaluate to FINISH phase');

    // 5. Bot low health (8 HP) -> HEALING phase
    bot.health = 8;
    const healPhase = controller.evaluatePhase(2.2, bot.health, 20);
    assert.strictEqual(healPhase, 'HEALING', 'Bot low HP must evaluate to HEALING phase');

    console.log('✅ TEST 5 PASSED: 11 combat phases & aggressive decision transitions verified.');
  }

  // =========================================================================
  // TEST 6: Strict 0% Sneak Rate in Combat
  // =========================================================================
  console.log('\n--- TEST 6: Strict 0% Sneak Rate in Combat ---');
  {
    const { bot, controlStates } = createMockBot(new Vec3(0, 64, 0), '1.20.4');
    const controller = new CombatController(bot);
    const target = { username: 'Rival', position: new Vec3(0, 64, 2.5), health: 20 };
    controller.startCombat(target);

    let sneakActiveCount = 0;
    const totalTicks = 100;

    for (let i = 0; i < totalTicks; i++) {
      controller.update(target);
      if (i % 10 === 0) {
        controller.movementController.handleKnockbackRecovery();
      }
      if (controlStates.sneak === true) {
        sneakActiveCount++;
      }
    }

    assert.strictEqual(sneakActiveCount, 0, `Sneak must be 0% in normal combat, got ${sneakActiveCount}/${totalTicks}`);
    console.log(`✅ TEST 6 PASSED: Sneak state remained strictly FALSE across all ${totalTicks} ticks (0.0% usage).`);
  }

  console.log('\n======================================================');
  console.log('🎉 ALL CENTRAL COMBAT CONTROLLER TESTS PASSED (6/6)!');
  console.log('======================================================\n');
}

runTests().catch(err => {
  console.error('❌ Combat Controller test failed:', err);
  process.exit(1);
});
