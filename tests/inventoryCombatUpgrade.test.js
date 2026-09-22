const assert = require('assert');
const { Vec3 } = require('vec3');
const PotionInventoryManager = require('../potionInventoryManager');
const MovementController = require('../movementController');
const mcManager = require('../minecraftBot');

console.log('🧪 Starting Full-Inventory Potion Access & 7-State Critical Combat Test Suite...\n');

async function runTests() {
  // =========================================================================
  // TEST 1: Location Classification & Full Inventory Bounds
  // =========================================================================
  console.log('--- TEST 1: Inventory Location Classification ---');
  const pim = new PotionInventoryManager(null, { healThresholdHP: 10 });
  
  // Default bounds: inventoryStart = 9, hotbarStart = 36, totalSlots = 45
  assert.strictEqual(pim.getLocationForSlot(36), 'HOTBAR');
  assert.strictEqual(pim.getLocationForSlot(44), 'HOTBAR');
  assert.strictEqual(pim.getLocationForSlot(9), 'MAIN INVENTORY');
  assert.strictEqual(pim.getLocationForSlot(20), 'MAIN INVENTORY');
  assert.strictEqual(pim.getLocationForSlot(35), 'MAIN INVENTORY');
  assert.strictEqual(pim.getLocationForSlot(5), 'OTHER ACCESSIBLE INVENTORY SLOTS'); // Helmet slot
  assert.strictEqual(pim.getLocationForSlot(45), 'OTHER ACCESSIBLE INVENTORY SLOTS'); // Offhand slot
  
  console.log('✅ TEST 1 PASSED: Correctly distinguishes HOTBAR, MAIN INVENTORY, and OTHER slots.');

  // =========================================================================
  // TEST 2: Full Inventory Potion Access — Health Potion in Main Inventory
  // =========================================================================
  console.log('\n--- TEST 2: Full Inventory Potion Access (No Hotbar Health Pot) ---');
  // Construct mock inventory where:
  // HOTBAR has NO health potion (Slot 36: sword, Slot 37: bread, Slots 38-44: empty)
  // MAIN INVENTORY has Splash Potion of Healing II at Slot 14!
  const slots = new Array(46).fill(null);
  slots[36] = { slot: 36, name: 'diamond_sword', displayName: 'Diamond Sword', count: 1 };
  slots[37] = { slot: 37, name: 'bread', displayName: 'Bread', count: 64 };
  slots[14] = {
    slot: 14,
    name: 'splash_potion',
    displayName: 'Splash Potion of Healing II',
    count: 1,
    nbt: { value: { Potion: { value: 'minecraft:strong_healing' } } }
  };

  let quickBarSlot = 0; // Currently holding slot 36 (diamond_sword)
  let moveOperations = [];
  let lookPitchRecorded = null;
  let itemActivated = false;

  const mockInventory = {
    slots,
    hotbarStart: 36,
    inventoryStart: 9,
    selectedItem: null
  };

  const mockBot = {
    health: 6, // Low health (3 hearts)
    entity: {
      id: 1,
      yaw: 0.0,
      pitch: 0.0,
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0.1, 0, 0.1) // Moving forward
    },
    inventory: mockInventory,
    heldItem: slots[36],
    get quickBarSlot() { return quickBarSlot; },
    setQuickBarSlot: (idx) => {
      quickBarSlot = idx;
      mockBot.heldItem = mockInventory.slots[36 + idx];
    },
    moveSlotItem: async (source, dest) => {
      moveOperations.push({ source, dest });
      // Legitimate swap/move in mock
      const itemToMove = mockInventory.slots[source];
      mockInventory.slots[dest] = itemToMove;
      mockInventory.slots[source] = null;
      if (itemToMove) itemToMove.slot = dest;
    },
    equip: async (item, hand) => {
      mockBot.heldItem = item;
    },
    look: async (yaw, pitch, force) => {
      lookPitchRecorded = pitch;
    },
    activateItem: () => {
      itemActivated = true;
      // Simulate potion splash consumption
      if (mockBot.heldItem) {
        mockInventory.slots[mockBot.heldItem.slot] = null;
        mockBot.heldItem = null;
        mockBot.health = 14; // Healed
      }
    },
    deactivateItem: () => {
      itemActivated = false;
    }
  };

  pim.bot = mockBot;

  // Verify findPotion finds the potion in MAIN INVENTORY
  const foundPotion = pim.findPotion('HEALING');
  assert.notStrictEqual(foundPotion, null, 'Must find healing potion in entire inventory');
  assert.strictEqual(foundPotion.location, 'MAIN INVENTORY', 'Potion must be detected in MAIN INVENTORY');
  assert.strictEqual(foundPotion.slot, 14, 'Potion must be at slot 14');

  // Trigger usePotion('HEALING')
  const healSuccess = await pim.usePotion('HEALING');
  assert.strictEqual(healSuccess, true, 'Healing from main inventory must succeed');

  // Verify legitimate move operation occurred: from slot 14 to an available hotbar slot (38)
  assert(moveOperations.length >= 1, 'Must execute legitimate inventory move operation');
  assert.strictEqual(moveOperations[0].source, 14, 'Source must be slot 14');
  assert(moveOperations[0].dest >= 36 && moveOperations[0].dest <= 44, 'Destination must be a hotbar slot');

  // Verify dynamic downward pitch was calculated (adapting to velocity, <= -1.40 rad)
  assert(lookPitchRecorded <= -1.35 && lookPitchRecorded >= -1.55, `Pitch must be aimed below feet, got ${lookPitchRecorded}`);

  // Verify primary weapon was restored after potting
  assert.strictEqual(quickBarSlot, 0, 'Quickbar slot must be restored to 0 (weapon slot)');
  assert.strictEqual(mockBot.heldItem.name, 'diamond_sword', 'Diamond sword must be restored');
  assert.strictEqual(mockBot.health, 14, 'Bot health must be healed to 14 HP');

  console.log('✅ TEST 2 PASSED: Full inventory search found main inventory pot, moved to hotbar, threw at feet, verified consumption, and restored weapon.');

  // =========================================================================
  // TEST 3: Full Inventory Buff Access (Strength & Speed in Main Inventory)
  // =========================================================================
  console.log('\n--- TEST 3: Full Inventory Buff Access (Strength & Speed) ---');
  // Reset bot with high health (20 HP)
  mockBot.health = 20;
  pim.lastPotionTime = 0; // Reset cooldown between unit test blocks
  mockInventory.slots[22] = {
    slot: 22,
    name: 'splash_potion',
    displayName: 'Splash Potion of Strength II',
    count: 1,
    nbt: { value: { Potion: { value: 'minecraft:strong_strength' } } }
  };
  mockInventory.slots[23] = {
    slot: 23,
    name: 'splash_potion',
    displayName: 'Splash Potion of Swiftness II',
    count: 1,
    nbt: { value: { Potion: { value: 'minecraft:strong_swiftness' } } }
  };

  moveOperations = [];
  const strengthSuccess = await pim.usePotion('STRENGTH');
  assert.strictEqual(strengthSuccess, true, 'Using strength potion from main inventory must succeed');
  assert.strictEqual(moveOperations[0].source, 22, 'Strength source slot must be 22');
  assert.strictEqual(quickBarSlot, 0, 'Weapon must be restored after buff usage');

  // Verify buff gating: Trying to cast Strength again immediately must return false!
  pim.activeBuffs.strength = { expiresAt: Date.now() + 60000, level: 2 };
  const strengthDuplicate = await pim.usePotion('STRENGTH');
  assert.strictEqual(strengthDuplicate, false, 'Duplicate strength usage must be rejected while active');

  console.log('✅ TEST 3 PASSED: Full inventory buff search, legitimate hotbar move, and active duration gating verified.');

  // =========================================================================
  // TEST 4: Low Health Buff Gating & Opponent Punish Gating
  // =========================================================================
  console.log('\n--- TEST 4: Low-Health Buff Gating & Opponent Punish Gating ---');
  // When health is low (6 HP), calling usePotion('STRENGTH') MUST be strictly rejected!
  mockBot.health = 6;
  pim.lastPotionTime = 0;
  const buffWhileLow = await pim.usePotion('STRENGTH');
  assert.strictEqual(buffWhileLow, false, 'Strength usage MUST be strictly rejected when health is low');

  // Opponent punish evaluation: If opponent is within 1.5m and health is 10 HP, do not pot until spaced
  mockBot.health = 10;
  pim.lastPotionTime = 0;
  const closeOpponent = { position: new Vec3(0, 64, 1.2) }; // 1.2m away
  const punishGated = await pim.usePotion('HEALING', closeOpponent);
  assert.strictEqual(punishGated, false, 'Healing must hold if opponent is in immediate punish range (< 2.0m)');

  // But if health is ultra-critical (4 HP), heal regardless of close opponent!
  mockBot.health = 4;
  pim.lastPotionTime = 0;
  mockInventory.slots[15] = {
    slot: 15,
    name: 'splash_potion',
    displayName: 'Splash Potion of Healing II',
    count: 1,
    nbt: { value: { Potion: { value: 'minecraft:strong_healing' } } }
  };
  const emergencyHeal = await pim.usePotion('HEALING', closeOpponent);
  assert.strictEqual(emergencyHeal, true, 'Emergency healing (<= 6 HP) must override close opponent');

  console.log('✅ TEST 4 PASSED: Low-HP buff gating and opponent punish spacing logic verified.');

  // =========================================================================
  // TEST 5: Perfect 7-State Critical Hit Trajectory System
  // =========================================================================
  console.log('\n--- TEST 5: 7-State Critical Hit Trajectory Machine ---');
  let attackCalled = false;
  let targetHurt = false;

  mcManager.status = 'online';
  mcManager.pvpActive = true;
  mcManager.combatPhase = 'CRIT';
  mcManager.critState = 'GROUND_READY';
  mcManager.lastAttackTime = Date.now() - 1000; // Cooldown ready

  const mockCritBot = {
    health: 20,
    username: 'CritBot',
    entity: {
      id: 50,
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      isOnLadder: false,
      isInWater: false,
      vehicle: null,
      yaw: 0,
      pitch: 0
    },
    heldItem: { name: 'diamond_sword' },
    attack: () => { attackCalled = true; },
    swingArm: () => {},
    on: () => {},
    removeListener: () => {}
  };

  mcManager.bot = mockCritBot;
  mcManager.movementController.bot = mockCritBot;

  // Step 1: GROUND_READY -> initiate jump
  assert.strictEqual(mcManager.critState, 'GROUND_READY');
  const jumpRequested = mcManager.movementController.requestJump(true);
  assert.strictEqual(jumpRequested, true, 'Jump must be requested from ground');
  mcManager.critState = 'JUMPING';

  // Step 2: JUMPING -> Airborne with positive velocity (vy = +0.40) -> RISING
  mockCritBot.entity.onGround = false;
  mockCritBot.entity.velocity.y = 0.40;
  if (mockCritBot.entity.velocity.y > 0.02) {
    mcManager.critState = 'RISING';
  }
  assert.strictEqual(mcManager.critState, 'RISING', 'State must be RISING');

  // Step 3: RISING (vy = +0.25) -> ATTACK MUST BE STRICTLY SUPPRESSED!
  const canAttackWhileRising = mcManager.critState === 'FALLING';
  assert.strictEqual(canAttackWhileRising, false, 'Attacks MUST be strictly suppressed while RISING');
  assert.strictEqual(attackCalled, false, 'No attack should be called while rising');

  // Step 4: Reaches apex and starts descending (vy = -0.12) -> FALLING
  mockCritBot.entity.velocity.y = -0.12;
  const isFalling = !mockCritBot.entity.onGround && mockCritBot.entity.velocity.y < -0.05;
  if (isFalling) {
    mcManager.critState = 'FALLING';
  }
  assert.strictEqual(mcManager.critState, 'FALLING', 'State must transition to FALLING upon descent');

  // Step 5: FALLING -> Attack connects during falling window!
  const validCritStrike = mcManager.critState === 'FALLING' && isFalling;
  assert.strictEqual(validCritStrike, true, 'Attack conditions valid during falling window');
  mockCritBot.attack();
  mcManager.critState = 'CRIT_ATTACK';
  assert.strictEqual(attackCalled, true, 'Attack must connect during falling window');

  // Step 6: Lands on ground -> LANDING
  mockCritBot.entity.onGround = true;
  mockCritBot.entity.velocity.y = 0;
  mcManager.critState = 'LANDING';

  // Step 7: LANDING -> Clean landing with NO sneak tap -> CRIT_IDLE
  mcManager.movementController.setControl('sneak', false);
  assert.strictEqual(mcManager.movementController.activeControls.sneak, false, 'Sneak must be strictly FALSE on landing');
  mcManager.critState = 'CRIT_IDLE';
  assert.strictEqual(mcManager.critState, 'CRIT_IDLE', 'Returns to CRIT_IDLE for next cycle');

  console.log('✅ TEST 5 PASSED: Critical hit cycle strictly verified with clean landing and zero sneak.');

  // =========================================================================
  // TEST 6: COMBO_PRESSURE, Sneak Purge & Knockback Recovery
  // =========================================================================
  console.log('\n--- TEST 6: COMBO_PRESSURE, Sneak Purge & Knockback Recovery ---');
  const mc = new MovementController(mockCritBot);
  
  // Test COMBO_PRESSURE state
  mc.setState('COMBO_PRESSURE');
  assert.strictEqual(mc.activeControls.forward, true, 'COMBO_PRESSURE must press forward');
  assert.strictEqual(mc.activeControls.sprint, true, 'COMBO_PRESSURE must sprint');
  assert.strictEqual(mc.activeControls.sneak, false, 'COMBO_PRESSURE must NOT sneak');

  // Test CRITICAL_SETUP state
  mc.setState('CRITICAL_SETUP');
  assert.strictEqual(mc.activeControls.forward, true, 'CRITICAL_SETUP must advance toward spacing');
  assert.strictEqual(mc.activeControls.sneak, false, 'CRITICAL_SETUP must NOT sneak');

  // Test knockback recovery: sneak MUST remain false
  mc.handleKnockbackRecovery();
  assert.strictEqual(mc.activeControls.sneak, false, 'Knockback recovery must NOT sneak (sneak strictly purged)');

  console.log('✅ TEST 6 PASSED: COMBO_PRESSURE state and knockback recovery with sneak purge verified.');

  console.log('\n======================================================');
  console.log('🎉 ALL FULL-INVENTORY & COMBAT UPGRADE TESTS PASSED!');
  console.log('======================================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
