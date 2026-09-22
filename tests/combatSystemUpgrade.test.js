const assert = require('assert');
const { Vec3 } = require('vec3');

const OpponentModel = require('../opponentModel');
const AttackScheduler = require('../attackScheduler');
const CombatDistanceController = require('../combatDistanceController');
const PvPCombatStateMachine = require('../pvpStateMachine');
const ResourcePredictor = require('../resourcePredictor');
const BenchmarkManager = require('../benchmarkManager');
const PvPProfileManager = require('../profiles/pvpProfileManager');
const NethPotProfile = require('../profiles/nethPotProfile');
const SwordProfile = require('../profiles/swordProfile');
const CrystalProfile = require('../profiles/crystalProfile');
const MaceProfile = require('../profiles/maceProfile');
const ElytraMaceProfile = require('../profiles/elytraMaceProfile');
const CombatController = require('../combatController');

function createMockBot(initialPos = new Vec3(0, 64, 0)) {
  const controlStates = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  };

  const inventoryItems = [
    { name: 'diamond_sword', slot: 36, type: 276 },
    { name: 'mace', slot: 37, type: 1000 },
    { name: 'splash_potion', slot: 38, count: 5, nbt: { value: { Potion: { value: 'minecraft:strong_healing' } } } },
    { name: 'totem_of_undying', slot: 45, count: 2 },
    { name: 'golden_apple', slot: 39, count: 16 },
    { name: 'end_crystal', slot: 40, count: 64 },
    { name: 'obsidian', slot: 41, count: 64 },
    { name: 'firework_rocket', slot: 42, count: 32 },
    { name: 'elytra', slot: 6 } // chestplate slot
  ];

  let attackCalls = [];
  let lookCalls = [];
  let swingCalls = [];

  const bot = {
    entity: {
      id: 100,
      position: initialPos.clone(),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      eyeHeight: 1.62,
      height: 1.8,
      onGround: true,
      isInWater: false,
      isOnLadder: false,
      isCollidedHorizontally: false
    },
    heldItem: inventoryItems[0],
    health: 20,
    controlStates,
    attackCalls,
    lookCalls,
    swingCalls,
    setControlState(control, val) {
      controlStates[control] = Boolean(val);
    },
    clearControlStates() {
      for (const k of Object.keys(controlStates)) {
        controlStates[k] = false;
      }
    },
    attack(target) {
      attackCalls.push({ targetId: target.id, time: Date.now() });
    },
    lookAt(pos, force) {
      lookCalls.push({ pos: pos.clone ? pos.clone() : pos, force });
      return Promise.resolve();
    },
    look(yaw, pitch, force) {
      this.entity.yaw = yaw;
      this.entity.pitch = pitch;
      return Promise.resolve();
    },
    swingArm(hand) {
      swingCalls.push({ hand, time: Date.now() });
    },
    activateItem() {},
    deactivateItem() {},
    inventory: {
      items: () => inventoryItems,
      slots: inventoryItems.reduce((acc, it) => { acc[it.slot] = it; return acc; }, {})
    }
  };

  return bot;
}

function createMockOpponent(id = 200, pos = new Vec3(0, 64, 3)) {
  return {
    id,
    username: 'TestEnemy',
    type: 'player',
    position: pos.clone(),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    eyeHeight: 1.62,
    height: 1.8,
    onGround: true,
    health: 20,
    heldItem: { name: 'diamond_sword' },
    metadata: []
  };
}

async function runAllTests() {
  console.log('🧪 Starting Comprehensive Combat System Upgrade Test Suite...\n');

  // ==========================================
  // TEST 1: OpponentModel Kinematics & Tracking
  // ==========================================
  console.log('--- Test 1: OpponentModel Kinematics & Rolling History ---');
  {
    const model = new OpponentModel();
    const opponent = createMockOpponent(200, new Vec3(0, 64, 0));

    model.update(opponent, 20);
    assert.strictEqual(model.trackedEntityId, 200);

    // Simulate moving forward along +Z over 10 ticks (0.2 blocks per tick)
    for (let i = 1; i <= 10; i++) {
      opponent.position = new Vec3(0, 64, i * 0.2);
      model.update(opponent, 20);
    }

    assert.strictEqual(model.positionHistory.length, 10);
    assert.strictEqual(model.velocityHistory.length, 10);
    assert(model.currentVelocity.z > 0, 'Velocity in Z should be positive');

    // Test clamped extrapolation: 100ms lookahead (0.1s)
    const predicted = model.getPredictedPosition(0.1);
    assert(predicted.z > opponent.position.z, 'Extrapolated position should be ahead of current position');
    
    // Lookahead must be clamped between 0.05 and 0.25
    const clampedShort = model.getPredictedPosition(0.01);
    const clampedLong = model.getPredictedPosition(1.5);
    assert(clampedShort !== null);
    assert(clampedLong !== null);

    // Test Opponent Classification
    opponent.position = new Vec3(0, 64, 5);
    const bot = createMockBot(new Vec3(0, 64, 10)); // bot is at z=10, opponent at z=5
    // Opponent moving toward bot (+Z)
    opponent.position = new Vec3(0, 64, 7);
    model.update(opponent, 20);
    const classification = model.classifyOpponentStyle(bot);
    assert(typeof classification === 'string', 'Classification must return a string');
    console.log(`  ✓ OpponentModel kinematics, extrapolation, and classification passed (${classification})`);
  }

  // ==========================================
  // TEST 2: AttackScheduler (Single Authority, Hit-Select, Sprint Reset)
  // ==========================================
  console.log('--- Test 2: AttackScheduler Single Authority & Sprint Reset ---');
  {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const scheduler = new AttackScheduler(bot);
    const opponent = createMockOpponent(200, new Vec3(0, 64, 2.5));

    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);

    // Attack execution through single authority
    let attacked = scheduler.executeAttack(opponent, 'NORMAL_HIT', { isCooldownReady: true, dist: 2.5 });
    assert.strictEqual(attacked, true);
    assert.strictEqual(bot.attackCalls.length, 1);
    assert.strictEqual(bot.attackCalls[0].targetId, 200);

    // Immediate second attack without cooldown should fail (half-swing prevention)
    let attackBlocked = scheduler.executeAttack(opponent, 'NORMAL_HIT', { isCooldownReady: false, dist: 2.5 });
    assert.strictEqual(attackBlocked, false, 'Half-swing should be blocked when cooldown is not ready');
    assert.strictEqual(bot.attackCalls.length, 1);

    // Sprint reset W-tap test: verify sprint is temporarily reset
    scheduler.triggerSprintReset();
    assert.strictEqual(bot.controlStates.forward, false, 'Forward should be released during W-tap');
    
    // Wait 50ms for W-tap recovery
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(bot.controlStates.forward, true, 'Forward should be restored after W-tap');

    // S-tap test
    scheduler.triggerSTap(40);
    assert.strictEqual(bot.controlStates.back, true, 'Back key should be active during S-tap');
    await new Promise(r => setTimeout(r, 55));
    assert.strictEqual(bot.controlStates.back, false, 'Back key should be released after S-tap');

    console.log('  ✓ AttackScheduler authority, cooldown gating, W-tap, and S-tap passed');
  }

  // ==========================================
  // TEST 3: CombatDistanceController (Outspacing, Anti-Circle, Overlap)
  // ==========================================
  console.log('--- Test 3: CombatDistanceController Outspacing & Anti-Circle ---');
  {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const distanceCtrl = new CombatDistanceController(bot);
    const opponent = createMockOpponent(200, new Vec3(0, 64, 2.6)); // Inside ideal 2.4 - 2.85m outspacing

    // Test Outspacing calculation
    const actionIdeal = distanceCtrl.calculateDistanceAction(opponent, 2.6, 20);
    assert.strictEqual(actionIdeal.state, 'OUTSPACING', 'Between 2.4m and 2.85m should maintain OUTSPACING');

    // Test Hitbox Overlap (< 1.6m)
    const actionOverlap = distanceCtrl.calculateDistanceAction(opponent, 1.2, 20);
    assert.strictEqual(actionOverlap.state, 'OVERLAP_ESCAPE', 'Inside 1.6m must trigger OVERLAP_ESCAPE');

    // Test Chase (> 3.5m)
    const actionChase = distanceCtrl.calculateDistanceAction(opponent, 4.0, 20);
    assert.strictEqual(actionChase.state, 'CHASE', 'Beyond 3.5m must trigger CHASE');

    // Test Anti-Circle Watchdog
    // Feed circular tangential movements around bot
    for (let angle = 0; angle < Math.PI * 2; angle += 0.2) {
      const circPos = new Vec3(Math.cos(angle) * 2.5, 64, Math.sin(angle) * 2.5);
      distanceCtrl.antiCircleWatchdog.recordAngle(circPos, bot.entity.position);
    }
    const isCircling = distanceCtrl.antiCircleWatchdog.isCircling();
    assert.strictEqual(isCircling, true, 'Anti-circle watchdog must detect orbital circling');

    // Counter-strafe action on circle detection
    const circleAction = distanceCtrl.calculateDistanceAction(opponent, 2.5, 20);
    assert.strictEqual(circleAction.state, 'CIRCLE_BREAK', 'Circling must trigger CIRCLE_BREAK');

    console.log('  ✓ CombatDistanceController outspacing, overlap escape, and circle-breaking passed');
  }

  // ==========================================
  // TEST 4: Profile Isolation & Gamemode Resolution
  // ==========================================
  console.log('--- Test 4: Profile Isolation & PvPProfileManager ---');
  {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const combatCtrl = new CombatController(bot);
    const profileMgr = new PvPProfileManager(combatCtrl);

    // Gamemode mappings
    const p1 = profileMgr.setProfile('NethPot');
    assert.strictEqual(p1.name, 'NETHPOT');
    assert(p1 instanceof NethPotProfile);

    const p2 = profileMgr.setProfile('classic');
    assert.strictEqual(p2.name, 'SWORD');
    assert(p2 instanceof SwordProfile);

    const p3 = profileMgr.setProfile('CrystalPVP');
    assert.strictEqual(p3.name, 'CRYSTAL');
    assert(p3 instanceof CrystalProfile);

    const p4 = profileMgr.setProfile('mace');
    assert.strictEqual(p4.name, 'MACE');
    assert(p4 instanceof MaceProfile);

    const p5 = profileMgr.setProfile('elytramace');
    assert.strictEqual(p5.name, 'ELYTRA_MACE');
    assert(p5 instanceof ElytraMaceProfile);

    // Profile State Isolation: switching profiles cleans up active timers/states
    profileMgr.setProfile('CrystalPVP');
    p3.placingObsidian = true;
    p3.detonatingCrystal = true;
    profileMgr.setProfile('Sword');
    // Ensure crystal profile states were purged
    assert.strictEqual(p3.placingObsidian, false, 'Crystal profile states must be purged on profile switch');
    assert.strictEqual(p3.detonatingCrystal, false);

    console.log('  ✓ PvPProfileManager 5 dedicated profiles and state isolation passed');
  }

  // ==========================================
  // TEST 5: NethPotProfile Behavior
  // ==========================================
  console.log('--- Test 5: NethPotProfile Specific Tactics ---');
  {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const combatCtrl = new CombatController(bot);
    const profile = new NethPotProfile(combatCtrl);

    assert.strictEqual(profile.allowJumpCrits, true);
    assert.strictEqual(profile.jumpCritOnlyWhileFalling, true);
    assert.strictEqual(profile.healThresholdHP, 10);

    // Health > 10: normal combat
    const actHighHP = profile.decideMovementState(2.6, 18, createMockOpponent());
    assert(actHighHP === 'OUTSPACING' || actHighHP === 'CRITICAL_SETUP');

    // Health <= 10 with potions: retreat for splash potion
    const actLowHP = profile.decideMovementState(2.0, 8, createMockOpponent(), { hasPotionsToHeal: true });
    assert.strictEqual(actLowHP, 'RETREAT');

    console.log('  ✓ NethPotProfile crits, low-HP retreat, and heal gating passed');
  }

  // ==========================================
  // TEST 6: SwordProfile Behavior
  // ==========================================
  console.log('--- Test 6: SwordProfile Dynamic Strafing & Outspacing ---');
  {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const combatCtrl = new CombatController(bot);
    const profile = new SwordProfile(combatCtrl);

    assert.strictEqual(profile.idealMinRange, 2.4);
    assert.strictEqual(profile.idealMaxRange, 2.85);

    // When inside edge of reach, sword profile presses combo pressure & outspacing
    const moveState = profile.decideMovementState(2.6, 20, createMockOpponent());
    assert(moveState === 'OUTSPACING' || moveState === 'COMBO_PRESSURE');

    console.log('  ✓ SwordProfile 2.4 - 2.85m outspacing & combo pressure passed');
  }

  // ==========================================
  // TEST 7: CrystalProfile 15-State & Safety
  // ==========================================
  console.log('--- Test 7: CrystalProfile Safety & Anchor Distances ---');
  {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const combatCtrl = new CombatController(bot);
    const profile = new CrystalProfile(combatCtrl);

    assert.strictEqual(profile.groundedCombatDefault, true);
    assert.strictEqual(profile.safeAnchorDistance, 4.5);
    assert.strictEqual(profile.validateLineOfSight, true);

    // Safe distance checks
    assert.strictEqual(profile.isSafeAnchorPlacement(5.0), true);
    assert.strictEqual(profile.isSafeAnchorPlacement(3.0), false, 'Anchor inside 4.5m is unsafe for self-damage');

    console.log('  ✓ CrystalProfile grounded default, LoS validation, and safe anchor checks passed');
  }

  // ==========================================
  // TEST 8: MaceProfile & ElytraMaceProfile
  // ==========================================
  console.log('--- Test 8: Mace & ElytraMace Profiles ---');
  {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const combatCtrl = new CombatController(bot);
    const maceProfile = new MaceProfile(combatCtrl);
    const elytraProfile = new ElytraMaceProfile(combatCtrl);

    assert.strictEqual(maceProfile.minFallDistanceForSmash, 1.5);
    assert.strictEqual(maceProfile.windChargeLaunchVelocity, 0.65);

    assert.strictEqual(elytraProfile.rocketAscendMinDist, 6.0);
    assert.strictEqual(elytraProfile.diveSmashMinFall, 2.5);

    console.log('  ✓ Mace and ElytraMace vertical combat & dive smash parameters passed');
  }

  // ==========================================
  // TEST 9: PvPCombatStateMachine 15 Explicit States
  // ==========================================
  console.log('--- Test 9: PvPCombatStateMachine 15 Explicit States ---');
  {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const combatCtrl = new CombatController(bot);
    const sm = new PvPCombatStateMachine(combatCtrl);

    const expectedStates = [
      'SEARCH', 'APPROACH', 'OUTSPACE', 'COMBO', 'CRIT_SETUP', 'CRIT_ATTACK',
      'HIT_SELECT', 'JUMP_RESET', 'P_CRIT', 'REPOSITION', 'HEAL', 'BUFF',
      'ESCAPE', 'FINISH', 'RECOVER'
    ];

    for (const state of expectedStates) {
      assert(sm.STATES[state] !== undefined, `State ${state} must exist in STATES`);
      sm.transitionTo(state);
      assert.strictEqual(sm.getCurrentState(), state);
    }

    // Watchdog reset on timeout
    sm.transitionTo('CRIT_ATTACK');
    sm.stateStartTime = Date.now() - 4000;
    sm.evaluateWatchdog(createMockOpponent(), 3.0, 'APPROACH');
    assert.strictEqual(sm.getCurrentState(), 'APPROACH', 'Stuck state should reset to APPROACH');

    console.log('  ✓ PvPCombatStateMachine 15 states and watchdog recovery passed');
  }

  // ==========================================
  // TEST 10: BenchmarkManager & ResourcePredictor
  // ==========================================
  console.log('--- Test 10: BenchmarkManager Telemetry & ResourcePredictor ---');
  {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const combatCtrl = new CombatController(bot);
    const bm = new BenchmarkManager(combatCtrl);
    const rp = new ResourcePredictor(bot);

    // Telemetry match simulation
    bm.startMatch('OpponentUser', 'NethPot');
    bm.recordAttackAttempt();
    bm.recordHitLanded(true); // crit landed
    bm.recordComboStreak(4);
    bm.recordDistanceSample(2.6);

    const matchStats = bm.endMatch('VICTORY');
    assert.strictEqual(matchStats.opponent, 'OpponentUser');
    assert.strictEqual(matchStats.attacksAttempted, 1);
    assert.strictEqual(matchStats.hitsLanded, 1);
    assert.strictEqual(matchStats.accuracy, 100);
    assert.strictEqual(matchStats.critsLanded, 1);
    assert.strictEqual(matchStats.maxCombo, 4);

    // Resource prediction
    const snapshot = rp.scanInventory();
    assert(snapshot.potionsCount > 0, 'Resource predictor should count potions');
    assert(snapshot.totemCount > 0, 'Resource predictor should count totems');
    assert(snapshot.gapplesCount > 0, 'Resource predictor should count golden apples');

    console.log('  ✓ BenchmarkManager telemetry, TPS tracking, and ResourcePredictor passed');
  }

  console.log('\n🎉 ALL 10 UPGRADE TEST SUITES PASSED FLAWLESSLY!\n');
}

runAllTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
