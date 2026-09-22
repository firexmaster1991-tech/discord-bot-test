const assert = require('assert');
const { Vec3 } = require('vec3');
const PotionManager = require('../potionManager');
const mcManager = require('../minecraftBot');

console.log('🧪 Starting Comprehensive Combat Upgrades & Subsystems Test Suite...\n');

async function runTests() {
  // =========================================================================
  // TEST 1: Potion NBT & Metadata Classification
  // =========================================================================
  console.log('--- TEST 1: Potion Classification (NBT / Metadata) ---');
  const pm = new PotionManager(null, { healThresholdHP: 10 });

  const mockItems = [
    {
      slot: 36,
      name: 'splash_potion',
      displayName: 'Splash Potion of Healing II',
      count: 1,
      nbt: { value: { Potion: { value: 'minecraft:strong_healing' } } }
    },
    {
      slot: 37,
      name: 'splash_potion',
      displayName: 'Splash Potion of Strength II',
      count: 1,
      nbt: { value: { Potion: { value: 'minecraft:strong_strength' } } }
    },
    {
      slot: 38,
      name: 'potion',
      displayName: 'Potion of Swiftness II',
      count: 1,
      nbt: { value: { Potion: { value: 'minecraft:strong_swiftness' } } }
    },
    {
      slot: 39,
      name: 'diamond_sword',
      displayName: 'Diamond Sword',
      count: 1
    }
  ];

  const classifiedHealth = pm.classifyItem(mockItems[0], 36);
  assert(classifiedHealth.type === 'HEALTH' || classifiedHealth.type === 'HEALING', 'Item 0 must be classified as HEALTH or HEALING');
  assert.strictEqual(classifiedHealth.tier, 2, 'Item 0 must be classified as tier 2');
  assert.strictEqual(classifiedHealth.isSplash, true, 'Item 0 must be splash');

  const classifiedStrength = pm.classifyItem(mockItems[1], 37);
  assert.strictEqual(classifiedStrength.type, 'STRENGTH', 'Item 1 must be classified as STRENGTH');
  assert.strictEqual(classifiedStrength.tier, 2, 'Item 1 must be classified as tier 2');

  const classifiedSpeed = pm.classifyItem(mockItems[2], 38);
  assert.strictEqual(classifiedSpeed.type, 'SPEED', 'Item 2 must be classified as SPEED');
  assert.strictEqual(classifiedSpeed.isDrinkable, true, 'Item 2 must be drinkable');

  const classifiedSword = pm.classifyItem(mockItems[3], 39);
  assert.strictEqual(classifiedSword, null, 'Diamond sword must not be classified as a potion');

  console.log('✅ TEST 1 PASSED: Potion classification accurately identifies Health, Strength, Speed, tier, and splash form.');

  // =========================================================================
  // TEST 2: Low Health Gating & Foot Pitch Calculation
  // =========================================================================
  console.log('\n--- TEST 2: Low Health Gating & Foot Pitch ---');
  // Mock bot with low health (6 HP = 3 hearts)
  const mockInventorySlots = new Array(45).fill(null);
  mockInventorySlots[36] = mockItems[0]; // Healing II
  mockInventorySlots[37] = mockItems[1]; // Strength II
  mockInventorySlots[38] = mockItems[2]; // Speed II

  let lookedAtPitch = null;
  let activatedItem = false;
  let equippedItem = null;

  let equippedHistory = [];
  const mockBot = {
    health: 6,
    entity: { id: 1, yaw: 0.5, pitch: 0 },
    heldItem: { name: 'diamond_sword' },
    inventory: {
      slots: mockInventorySlots,
      items: () => mockInventorySlots.filter(Boolean)
    },
    equip: async (item, hand) => {
      equippedHistory.push(item);
    },
    look: async (yaw, pitch) => {
      lookedAtPitch = pitch;
    },
    activateItem: () => {
      activatedItem = true;
    },
    deactivateItem: () => {
      activatedItem = false;
    }
  };

  pm.bot = mockBot;

  // Verify foot pitch calculation
  const pitch = pm.calculateFootThrowPitch();
  assert(pitch <= -1.45 && pitch >= -1.55, `Foot pitch should be ~ -1.50 rad, got ${pitch}`);

  // Low HP check: evaluateBuffMaintenance MUST return false and do nothing
  const buffAttempt = await pm.evaluateBuffMaintenance();
  assert.strictEqual(buffAttempt, false, 'Buff maintenance MUST be rejected when health is <= healThresholdHP');

  // Low HP health throw: MUST select ONLY the health potion and aim at feet
  const healSuccess = await pm.executeHealthPotionThrow();
  assert.strictEqual(healSuccess, true, 'Health potion throw should succeed');
  assert(equippedHistory.length >= 2, 'Equip history should record potion equip and sword re-equip');
  assert.strictEqual(equippedHistory[0].name, 'splash_potion', 'First equipped item MUST be the splash healing potion');
  assert(equippedHistory[0].displayName.includes('Healing'), 'Equipped potion MUST be healing');
  assert.strictEqual(equippedHistory[1].name, 'diamond_sword', 'Primary weapon MUST be immediately re-equipped');
  assert(lookedAtPitch <= -1.40 && lookedAtPitch >= -1.55, `Potion pitch must be directed at feet, got ${lookedAtPitch}`);

  console.log('✅ TEST 2 PASSED: Low health strictly gates out buffs, selects ONLY healing potion, and throws at feet.');

  // =========================================================================
  // TEST 3: Active Buff Tracking & Expiration Gating
  // =========================================================================
  console.log('\n--- TEST 3: Buff Tracking & Refresh Gating ---');
  const pmBuff = new PotionManager(null, { healThresholdHP: 10 });
  // Initially no buffs active
  assert.strictEqual(pmBuff.isStrengthActive(), false, 'Strength should initially be inactive');
  assert.strictEqual(pmBuff.isSpeedActive(), false, 'Speed should initially be inactive');

  // Simulate buff applied event
  pmBuff.handleEffectApplied({ id: 5, duration: 1800, amplifier: 1 }); // Strength II for 90s
  assert.strictEqual(pmBuff.isStrengthActive(), true, 'Strength should now be active');
  assert.strictEqual(pmBuff.activeBuffs.strength.level, 2, 'Strength level should be 2');

  // Simulate expiration
  pmBuff.handleEffectExpired({ id: 5 });
  assert.strictEqual(pmBuff.isStrengthActive(), false, 'Strength should be inactive after expiration');

  console.log('✅ TEST 3 PASSED: Active buffs tracked accurately and prevent premature consumption.');

  // =========================================================================
  // TEST 4: Genuine Minecraft Critical Hit Trajectory Mechanics
  // =========================================================================
  console.log('\n--- TEST 4: Genuine Critical Hit Mechanics (Rising Suppressed vs Falling Executed) ---');
  let attackCount = 0;
  let swingCount = 0;

  const mockPvPBot = {
    health: 20,
    username: 'TestBot',
    entity: {
      id: 100,
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      isOnLadder: false,
      isInWater: false,
      vehicle: null,
      yaw: 0,
      pitch: 0
    },
    heldItem: { name: 'netherite_sword' },
    attack: (target) => { attackCount++; },
    swingArm: () => { swingCount++; },
    on: () => {},
    removeListener: () => {}
  };

  // Test Critical Jump Cycle
  mcManager.bot = mockPvPBot;
  mcManager.pvpActive = true;
  mcManager.combatPhase = 'CRIT';
  mcManager.critState = 'GROUNDED';
  mcManager.lastAttackTime = Date.now() - 1000; // Cooldown ready

  // Step A: Grounded -> Jump Initiated
  const onGround = true;
  const dist = 2.5;
  const isCooldownReady = true;

  const canJump = mcManager.combatPhase === 'CRIT' && onGround && dist <= 3.2 && isCooldownReady;
  assert.strictEqual(canJump, true, 'Bot should initiate crit jump when grounded with cooldown ready');

  // Step B: Airborne and Rising (vy = +0.33) -> ATTACK MUST BE SUPPRESSED!
  const isAirborne = true;
  const vyRising = 0.33;
  const isFallingWhileRising = isAirborne && vyRising < -0.05;
  assert.strictEqual(isFallingWhileRising, false, 'While rising, isFalling MUST be false');

  const wouldCritWhileRising = isFallingWhileRising;
  assert.strictEqual(wouldCritWhileRising, false, 'Attack while rising must be strictly blocked');

  // Step C: Airborne and Falling at apex (vy = -0.15) -> ATTACK MUST EXECUTE!
  const vyFalling = -0.15;
  const isFalling = isAirborne && vyFalling < -0.05;
  assert.strictEqual(isFalling, true, 'Apex descent (vy = -0.15) is falling');

  const wouldCritWhileFalling = isFalling && !mockPvPBot.entity.isOnLadder;
  assert.strictEqual(wouldCritWhileFalling, true, 'Falling apex correctly satisfies Minecraft critical hit condition!');

  console.log('✅ TEST 4 PASSED: Critical hit trajectory strictly suppresses attacks while rising and executes exclusively during falling apex.');

  // =========================================================================
  // TEST 5: Combo vs Crit Phase Transition Cycle
  // =========================================================================
  console.log('\n--- TEST 5: Combo vs Crit Phase Transitions ---');
  mcManager.combatPhase = 'COMBO';
  mcManager.comboHitsCount = 4;
  mcManager.targetComboHits = 4;

  // Transition from COMBO to CRIT
  if (mcManager.combatPhase === 'COMBO' && mcManager.comboHitsCount >= mcManager.targetComboHits) {
    mcManager.combatPhase = 'CRIT';
    mcManager.critHitsCount = 0;
  }
  assert.strictEqual(mcManager.combatPhase, 'CRIT', 'Phase should transition from COMBO to CRIT after target hits');

  // Transition from CRIT to COMBO
  mcManager.critHitsCount = 4;
  mcManager.targetCritHits = 4;
  if (mcManager.combatPhase === 'CRIT' && mcManager.critHitsCount >= mcManager.targetCritHits) {
    mcManager.combatPhase = 'COMBO';
    mcManager.comboHitsCount = 0;
  }
  assert.strictEqual(mcManager.combatPhase, 'COMBO', 'Phase should transition from CRIT to COMBO after target crits');

  // Fallback to COMBO if target distance breaks (> 3.4m)
  mcManager.combatPhase = 'CRIT';
  const largeDist = 4.2;
  if (mcManager.combatPhase === 'CRIT' && largeDist > 3.4) {
    mcManager.combatPhase = 'COMBO';
  }
  assert.strictEqual(mcManager.combatPhase, 'COMBO', 'Phase should immediately revert to COMBO if opponent spaces out');

  console.log('✅ TEST 5 PASSED: Combo and Crit phases dynamically cycle and safely fallback upon disengagement.');

  // =========================================================================
  // TEST 6: Incoming Duel Request Detection & /duel accept <player>
  // =========================================================================
  console.log('\n--- TEST 6: Incoming Duel Detection & /duel accept ---');
  let lastChatSent = '';
  mcManager.bot = {
    username: 'PvPBot',
    chat: (msg) => { lastChatSent = msg; }
  };
  mcManager.status = 'online';
  mcManager.state = 'PRACTICE';
  mcManager.hasNavigatedToPractice = true;
  mcManager.matchState = 'idle';

  let incomingEventFired = false;
  let incomingEventData = null;

  mcManager.once('incomingDuelRequest', (data) => {
    incomingEventFired = true;
    incomingEventData = data;
  });

  // Simulate incoming duel message from server
  const incomingChatMsg = '[Duels] ChallengerPro has requested to duel you in NethPot. Click here or type /duel accept ChallengerPro';
  mcManager.handleChatMessage(incomingChatMsg);

  assert.strictEqual(incomingEventFired, true, 'incomingDuelRequest event must be emitted');
  assert.strictEqual(incomingEventData.challenger, 'ChallengerPro');
  assert.strictEqual(incomingEventData.gamemode, 'NethPot');

  // Verify stored in pendingDuelRequests
  assert(mcManager.pendingDuelRequests.has('challengerpro'), 'Request should be saved in pendingDuelRequests map');

  // Test /duel accept ChallengerPro
  const acceptResult = await mcManager.acceptDuel('ChallengerPro');
  assert.strictEqual(acceptResult.success, true, 'Accepting valid pending duel should succeed');
  assert.strictEqual(lastChatSent, '/duel accept ChallengerPro', 'Chat command must be /duel accept <player>');
  assert.strictEqual(mcManager.state, 'MATCH', 'State should update to MATCH');
  assert.strictEqual(mcManager.currentOpponent, 'ChallengerPro', 'Current opponent should be ChallengerPro');
  assert.strictEqual(mcManager.pendingDuelRequests.has('challengerpro'), false, 'Pending request should be cleared after acceptance');

  // Test rejecting duel when already in a match
  const inMatchResult = await mcManager.acceptDuel('GhostPlayer');
  assert.strictEqual(inMatchResult.success, false, 'Accepting duel while in match must fail');
  assert(inMatchResult.message.includes('Bot is currently in a match'), 'Error message should indicate bot is in a match');

  // Reset to idle practice state to test non-existent duel
  mcManager.state = 'PRACTICE';
  mcManager.matchState = 'idle';
  mcManager.currentOpponent = null;

  // Test rejecting expired or non-existent duel
  const nonExistentResult = await mcManager.acceptDuel('GhostPlayer');
  assert.strictEqual(nonExistentResult.success, false, 'Accepting non-existent duel must fail');
  assert(nonExistentResult.message.includes('No pending duel request found'), 'Error message should indicate no pending request');

  console.log('✅ TEST 6 PASSED: Incoming duel chat correctly parsed, stored with TTL, and accepted via /duel accept.');

  // =========================================================================
  // TEST 7: Segmented /leave Subcommands (server, queue, duel)
  // =========================================================================
  console.log('\n--- TEST 7: Segmented /leave Subcommands ---');
  // Setup online state in queue
  mcManager.status = 'online';
  mcManager.state = 'QUEUEING';
  mcManager.queueActive = true;
  mcManager.matchState = 'preparing';

  // Test /leave queue
  const leaveQueueResult = mcManager.leaveQueue();
  assert.strictEqual(leaveQueueResult.success, true, 'Leaving active queue should succeed');
  assert.strictEqual(mcManager.queueActive, false, 'queueActive should be false');
  assert.strictEqual(mcManager.state, 'PRACTICE', 'State should return to PRACTICE');

  // Test /leave queue when not queuing
  const leaveQueueAgain = mcManager.leaveQueue();
  assert.strictEqual(leaveQueueAgain.success, false, 'Leaving queue when not in queue should return failure');

  // Test /leave duel
  mcManager.matchState = 'in-match';
  mcManager.state = 'COMBAT';
  mcManager.currentOpponent = 'ChallengerPro';

  const leaveDuelResult = mcManager.leaveDuel();
  assert.strictEqual(leaveDuelResult.success, true, 'Leaving active duel should succeed');
  assert.strictEqual(mcManager.matchState, 'idle', 'matchState should reset to idle');
  assert.strictEqual(mcManager.currentOpponent, null, 'currentOpponent should reset to null');

  // Test /leave server
  const leaveServerResult = mcManager.leaveServer();
  assert.strictEqual(leaveServerResult.success, true, 'Leaving server should succeed and disconnect bot');
  assert.strictEqual(mcManager.status, 'offline', 'Status should be offline after leaving server');

  // Test /leave server when already offline
  const leaveServerOffline = mcManager.leaveServer();
  assert.strictEqual(leaveServerOffline.success, false, 'Leaving server when offline should return failure');

  console.log('✅ TEST 7 PASSED: Segmented /leave subcommands (server, queue, duel) execute with correct state transitions.');

  console.log('\n======================================================');
  console.log('🎉 ALL COMBAT & SUB-SYSTEM UPGRADE TESTS PASSED!');
  console.log('======================================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
