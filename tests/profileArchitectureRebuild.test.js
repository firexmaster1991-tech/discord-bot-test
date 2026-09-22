const assert = require('assert');
const { Vec3 } = require('vec3');
const InventoryLayoutManager = require('../inventoryLayoutManager');
const PvPProfileManager = require('../profiles/pvpProfileManager');
const NethPotProfile = require('../profiles/nethPotProfile');
const SwordProfile = require('../profiles/swordProfile');
const CrystalProfile = require('../profiles/crystalProfile');
const MaceProfile = require('../profiles/maceProfile');
const ElytraMaceProfile = require('../profiles/elytraMaceProfile');
const SpearElytraProfile = require('../profiles/spearElytraProfile');
const SpearMaceProfile = require('../profiles/spearMaceProfile');
const CombatMovementController = require('../movementController');
const CombatController = require('../combatController');

function createMockBot(initialPos = new Vec3(0, 64, 0), initialItems = []) {
  const controlStates = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  };

  const blocks = new Map();
  const entities = {};
  const actions = {
    attacks: [],
    swings: [],
    placements: [],
    looks: [],
    clicks: [],
    activates: [],
    deactivates: []
  };

  let itemsList = [...initialItems];

  const bot = {
    entity: {
      id: 100,
      position: initialPos.clone(),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      eyeHeight: 1.62,
      onGround: true,
      isInWater: false,
      isOnLadder: false,
      effects: {}
    },
    heldItem: itemsList[0] || null,
    health: 20,
    controlStates,
    entities,
    inventory: {
      items: () => itemsList,
      slots: new Array(46).fill(null),
      requiresConfirmation: false
    },
    setItems: (newItems) => {
      itemsList = [...newItems];
      for (let i = 0; i < 46; i++) {
        bot.inventory.slots[i] = null;
      }
      for (const it of itemsList) {
        if (it && it.slot != null) {
          bot.inventory.slots[it.slot] = it;
        }
      }
      bot.heldItem = itemsList[0] || null;
    },
    setControlState: (ctrl, state) => {
      controlStates[ctrl] = Boolean(state);
    },
    clearControlStates: () => {
      for (const k of Object.keys(controlStates)) {
        controlStates[k] = false;
      }
    },
    look: async (y, p) => {
      bot.entity.yaw = y;
      bot.entity.pitch = p;
      actions.looks.push({ y, p, time: Date.now() });
    },
    lookAt: async (pos) => {
      actions.looks.push({ pos, time: Date.now() });
    },
    attack: (target) => {
      actions.attacks.push({
        target,
        time: Date.now(),
        vy: bot.entity.velocity.y,
        onGround: bot.entity.onGround,
        held: bot.heldItem ? bot.heldItem.name : null
      });
    },
    swingArm: (hand) => {
      actions.swings.push({ hand, time: Date.now() });
    },
    placeBlock: async (refBlock, faceVec) => {
      actions.placements.push({ refBlock, faceVec, time: Date.now() });
    },
    activateItem: () => {
      actions.activates.push({ time: Date.now(), held: bot.heldItem ? bot.heldItem.name : null });
    },
    deactivateItem: () => {
      actions.deactivates.push({ time: Date.now() });
    },
    clickWindow: async (slot, btn, mode) => {
      actions.clicks.push({ slot, btn, mode, time: Date.now() });
    },
    equip: async (item, dest) => {
      if (typeof item === 'string') {
        const found = itemsList.find(i => i.name.includes(item));
        if (found) bot.heldItem = found;
      } else {
        bot.heldItem = item;
      }
    },
    blockAt: (pos) => {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      if (blocks.has(key)) return blocks.get(key);
      if (pos.y < 64) {
        return { name: 'stone', boundingBox: 'block', position: pos.floored(), shapes: [[[0, 0, 0, 1, 1, 1]]] };
      }
      return { name: 'air', boundingBox: 'empty', position: pos.floored(), shapes: [] };
    },
    setBlock: (pos, name, boundingBox = 'block') => {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      blocks.set(key, {
        name,
        boundingBox,
        position: pos.floored(),
        shapes: boundingBox === 'block' ? [[[0, 0, 0, 1, 1, 1]]] : []
      });
    },
    pathfinder: {
      stop: () => {},
      isMoving: () => false
    },
    on: () => {},
    removeListener: () => {},
    actions
  };

  bot.setItems(initialItems);
  return bot;
}

function createMockOpponent(pos = new Vec3(0, 64, 3), id = 200) {
  return {
    id,
    username: 'TargetOpponent',
    name: 'TargetOpponent',
    type: 'player',
    position: pos.clone(),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    health: 20,
    isValid: true,
    heldItem: { name: 'diamond_sword' }
  };
}

async function runTests() {
  console.log('====================================================');
  console.log('🚀 RUNNING PROFILE ARCHITECTURE REBUILD TEST SUITE');
  console.log('====================================================\n');

  // TEST 1: InventoryLayoutManager presets and dynamic slot resolution
  console.log('▶ Test 1: InventoryLayoutManager Canonical Presets & Role Mapping');
  {
    const layoutManager = new InventoryLayoutManager();
    const presets = layoutManager.getAvailableLayouts();
    assert(presets.includes('NETHPOT_LAYOUT'), 'Missing NETHPOT_LAYOUT');
    assert(presets.includes('SWORD_LAYOUT'), 'Missing SWORD_LAYOUT');
    assert(presets.includes('CRYSTAL_LAYOUT'), 'Missing CRYSTAL_LAYOUT');
    assert(presets.includes('MACE_LAYOUT'), 'Missing MACE_LAYOUT');
    assert(presets.includes('MACE_ROCKET_LAYOUT'), 'Missing MACE_ROCKET_LAYOUT');
    assert(presets.includes('SPEAR_ELYTRA_LAYOUT'), 'Missing SPEAR_ELYTRA_LAYOUT');
    assert(presets.includes('SPEAR_MACE_LAYOUT'), 'Missing SPEAR_MACE_LAYOUT');

    // Test dynamic live inventory scanning
    const mockBot = createMockBot(new Vec3(0, 64, 0), [
      { name: 'diamond_sword', slot: 36, count: 1 },
      { name: 'golden_apple', slot: 37, count: 64 },
      { name: 'splash_potion', slot: 38, count: 1, nbt: { value: { Potion: { value: 'minecraft:speed' } } } },
      { name: 'splash_potion', slot: 39, count: 1, nbt: { value: { Potion: { value: 'minecraft:strong_strength' } } } },
      { name: 'splash_potion', slot: 40, count: 1, nbt: { value: { Potion: { value: 'minecraft:strong_healing' } } } },
      { name: 'ender_pearl', slot: 41, count: 16 }
    ]);

    layoutManager.setBot(mockBot);
    const resolved = layoutManager.applyLayout('NETHPOT_LAYOUT');
    assert.strictEqual(resolved.roleToSlot['PRIMARY_WEAPON'], 36, 'Sword should be slot 36');
    assert.strictEqual(resolved.roleToSlot['GAPPLE'], 37, 'Gapple should be slot 37');
    assert.strictEqual(resolved.roleToSlot['SPEED_POTION'], 38, 'Speed pot should be slot 38');
    assert.strictEqual(resolved.roleToSlot['STRENGTH_POTION'], 39, 'Strength pot should be slot 39');
    assert.strictEqual(resolved.roleToSlot['HEAL_POTION_1'], 40, 'Healing pot should be slot 40');
    assert.strictEqual(resolved.roleToSlot['PEARL'], 41, 'Pearl should be slot 41');

    // Validation before item usage
    assert.strictEqual(layoutManager.validateItemInSlot(36, 'diamond_sword'), true);
    assert.strictEqual(layoutManager.validateItemInSlot(36, 'golden_apple'), false);
    assert.strictEqual(layoutManager.validateRoleSlot('PRIMARY_WEAPON'), true);

    console.log('  ✅ Layout presets, role mapping, NBT potion verification, and slot validation passed.\n');
  }

  // TEST 2: All 7 Dedicated Profiles and Verification Banner
  console.log('▶ Test 2: PvPProfileManager 7 Dedicated Profiles & 3-Part Banner');
  {
    const mockBot = createMockBot();
    const movement = new CombatMovementController(mockBot);
    const profileManager = new PvPProfileManager({
      bot: mockBot,
      movementController: movement
    });

    const expectedProfiles = [
      'NETHPOT',
      'SWORD',
      'CRYSTAL',
      'MACE',
      'ELYTRA_MACE',
      'SPEAR_ELYTRA',
      'SPEAR_MACE'
    ];

    for (const name of expectedProfiles) {
      const profile = profileManager.getProfile(name);
      assert(profile, `Profile ${name} must be instantiated in manager`);
      assert(typeof profile.preflight === 'function', `${name} must have preflight()`);
      assert(typeof profile.update === 'function', `${name} must have update()`);
      assert(typeof profile.getDebugStatus === 'function', `${name} must have getDebugStatus()`);
    }

    // Capture console output to verify 3-part banner
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(' '));
      origLog.apply(console, args);
    };

    try {
      profileManager.setActiveProfile('CrystalPVP');
      assert.strictEqual(profileManager.activeProfileName, 'CRYSTAL');

      const allLogs = logs.join('\n');
      const bannerFound = allLogs.includes('PROFILE LOADED:\nCRYSTAL') &&
                          allLogs.includes('LAYOUT LOADED:\nCRYSTAL_LAYOUT') &&
                          allLogs.includes('ACTION SYSTEM:\nREADY');
      assert(bannerFound, '3-part verification banner must be printed on profile load');
    } finally {
      console.log = origLog;
    }

    console.log('  ✅ All 7 profiles instantiated and 3-part verification banner verified.\n');
  }

  // TEST 3: Preflight item check & informative error reporting
  console.log('▶ Test 3: Preflight Item Verification');
  {
    const mockBot = createMockBot(new Vec3(0, 64, 0), [
      { name: 'diamond_sword', slot: 36, count: 1 }
    ]);
    const movement = new CombatMovementController(mockBot);
    const profileManager = new PvPProfileManager({
      bot: mockBot,
      movementController: movement
    });

    // Crystal Profile missing End Crystal & Obsidian
    profileManager.setActiveProfile('CrystalPVP');
    const crystalPreflight = await profileManager.preflight();
    assert.strictEqual(crystalPreflight.success, false, 'Preflight should fail when items are missing');
    assert(crystalPreflight.missing.some(m => m.toLowerCase().includes('crystal')), 'Should report missing end crystal');
    assert(crystalPreflight.missing.some(m => m.toLowerCase().includes('obsidian')), 'Should report missing obsidian');

    // Mace Profile missing Wind Charge
    profileManager.setActiveProfile('MacePVP');
    const macePreflight = await profileManager.preflight();
    assert.strictEqual(macePreflight.success, false, 'Mace preflight should fail without mace & wind charge');
    assert(macePreflight.missing.some(m => m.toLowerCase().includes('mace')), 'Should report missing mace');
    assert(macePreflight.missing.some(m => m.toLowerCase().includes('wind')), 'Should report missing wind charge');

    // Add items and verify success
    mockBot.setItems([
      { name: 'mace', slot: 36, count: 1 },
      { name: 'wind_charge', slot: 37, count: 32 }
    ]);
    profileManager.setContext({ bot: mockBot });
    const macePreflightOk = await profileManager.preflight();
    assert.strictEqual(macePreflightOk.success, true, 'Mace preflight should pass with mace and wind charge');

    console.log('  ✅ Preflight accurately reports missing items and passes when present.\n');
  }

  // TEST 4: CrystalProfile 12 Controller States, LOS Raycasting & Detonation Safety
  console.log('▶ Test 4: CrystalController (12 States, Raycasting & Safety)');
  {
    const mockBot = createMockBot(new Vec3(0, 64, 0), [
      { name: 'netherite_sword', slot: 36, count: 1 },
      { name: 'obsidian', slot: 37, count: 64 },
      { name: 'end_crystal', slot: 38, count: 64 },
      { name: 'totem_of_undying', slot: 39, count: 5 },
      { name: 'respawn_anchor', slot: 40, count: 16 },
      { name: 'glowstone', slot: 41, count: 64 },
      { name: 'ender_pearl', slot: 42, count: 16 }
    ]);
    const movement = new CombatMovementController(mockBot);
    const profile = new CrystalProfile({ bot: mockBot, movementController: movement });
    const opponent = createMockOpponent(new Vec3(2, 64, 0));

    // Verify 12 controller states exist
    const expectedStates = [
      'SEARCH', 'APPROACH', 'POSITION', 'HIT_SELECT', 'OBSIDIAN',
      'CRYSTAL', 'BREAK', 'TOTEM', 'ANCHOR', 'PEARL', 'RECOVER', 'FINISH'
    ];
    for (const st of expectedStates) {
      assert(profile.states.includes(st), `State ${st} must exist in CrystalProfile`);
    }

    // Test Line-Of-Sight Raycasting
    // 1. Clear air -> hasLineOfSight should be true
    assert.strictEqual(profile.hasLineOfSight(new Vec3(2, 64, 0)), true, 'Should have LOS through air');

    // 2. Put solid stone wall in between at (1, 65, 0)
    mockBot.setBlock(new Vec3(1, 65, 0), 'stone', 'block');
    assert.strictEqual(profile.hasLineOfSight(new Vec3(2, 65, 0)), false, 'Should NOT have LOS through stone wall');

    // Test Detonation Safety: bot health critically low (< 10)
    mockBot.health = 6;
    assert.strictEqual(profile.isSafeToDetonateAnchor(new Vec3(1, 64, 0)), false, 'Anchor detonation must be unsafe when health is low');

    // Test Failure Reporting
    profile.reportFailure('OBSIDIAN', 'Block placement blocked by obstruction');
    assert.strictEqual(profile.lastFailureStage, 'OBSIDIAN');
    assert(profile.failureHistory.length > 0);
    assert(profile.failureHistory[0].message.includes('placement blocked'));

    console.log('  ✅ CrystalController 12 states, LOS raycasting, and safety gates verified.\n');
  }

  // TEST 5: MaceController 10 States & MACE_EQUIP_LOCK
  console.log('▶ Test 5: MaceController (10 States, Wind Charge & MACE_EQUIP_LOCK)');
  {
    const mockBot = createMockBot(new Vec3(0, 64, 0), [
      { name: 'mace', slot: 36, count: 1 },
      { name: 'wind_charge', slot: 37, count: 32 }
    ]);
    const movement = new CombatMovementController(mockBot);
    const profile = new MaceProfile({ bot: mockBot, movementController: movement });
    const opponent = createMockOpponent(new Vec3(0, 64, 4));

    const expectedStates = [
      'SEARCH', 'APPROACH', 'SETUP', 'WIND_CHARGE', 'ASCEND',
      'TRACK', 'FALL', 'SMASH', 'LAND', 'REPOSITION'
    ];
    for (const st of expectedStates) {
      assert(profile.states.includes(st), `State ${st} must exist in MaceProfile`);
    }

    // Test MACE_EQUIP_LOCK
    // When rising (vy > 0), bot must hold Wind Charge
    mockBot.entity.velocity.y = 0.5;
    profile.enforceMaceEquipLock('ASCENDING');
    assert.strictEqual(mockBot.heldItem.name, 'wind_charge', 'During ascent, MACE_EQUIP_LOCK must hold wind charge');

    // When falling (vy < 0), bot must hold Mace
    mockBot.entity.velocity.y = -0.4;
    profile.enforceMaceEquipLock('FALLING');
    assert.strictEqual(mockBot.heldItem.name, 'mace', 'During descent, MACE_EQUIP_LOCK must hold mace');

    // Ceiling clearance check
    assert.strictEqual(profile.checkCeilingClearance(4), true, 'Open sky should have ceiling clearance');
    mockBot.setBlock(new Vec3(0, 66, 0), 'stone', 'block');
    assert.strictEqual(profile.checkCeilingClearance(4), false, 'Low stone ceiling should fail clearance check');

    // Failure reporting
    profile.reportFailure('WIND_CHARGE', 'Wind charge launch did not yield height');
    assert.strictEqual(profile.lastFailureStage, 'WIND_CHARGE');

    console.log('  ✅ MaceController 10 states, MACE_EQUIP_LOCK, and clearance checks verified.\n');
  }

  // TEST 6: ElytraMaceController 11 States & Flight Interception
  console.log('▶ Test 6: ElytraMaceController (11 States, Rockets & Armor Swap)');
  {
    const mockBot = createMockBot(new Vec3(0, 64, 0), [
      { name: 'mace', slot: 36, count: 1 },
      { name: 'firework_rocket', slot: 37, count: 64 },
      { name: 'elytra', slot: 38, count: 1 },
      { name: 'netherite_chestplate', slot: 6, count: 1 }
    ]);
    const movement = new CombatMovementController(mockBot);
    const profile = new ElytraMaceProfile({ bot: mockBot, movementController: movement });

    const expectedStates = [
      'PREFLIGHT', 'GROUND', 'TAKEOFF', 'FLIGHT', 'TARGET_LOCK',
      'ROCKET_APPROACH', 'EQUIPMENT_SWAP', 'FALL', 'MACE_ATTACK', 'RECOVER', 'REPEAT'
    ];
    for (const st of expectedStates) {
      assert(profile.states.includes(st), `State ${st} must exist in ElytraMaceProfile`);
    }

    // Predictive flight interception calculation
    const opp = createMockOpponent(new Vec3(10, 64, 10));
    opp.velocity = new Vec3(0.2, 0, 0.1);
    const intercept = profile.predictInterceptionPoint(opp, 1.5);
    assert(intercept.x > 10, 'Predicted intercept point should account for target velocity');

    // Torso armor swap
    await profile.ensureTorsoArmor('elytra');
    assert.strictEqual(profile.equippedTorso, 'elytra');
    await profile.ensureTorsoArmor('chestplate');
    assert.strictEqual(profile.equippedTorso, 'chestplate');

    console.log('  ✅ ElytraMaceController 11 states, interception, and armor swaps verified.\n');
  }

  // TEST 7: Spear Profiles (SpearElytra & SpearMace)
  console.log('▶ Test 7: Dedicated Spear Profiles');
  {
    const mockBot = createMockBot(new Vec3(0, 64, 0), [
      { name: 'trident', slot: 36, count: 1 },
      { name: 'mace', slot: 37, count: 1 },
      { name: 'elytra', slot: 38, count: 1 },
      { name: 'firework_rocket', slot: 39, count: 64 }
    ]);
    const movement = new CombatMovementController(mockBot);
    const profileManager = new PvPProfileManager({
      bot: mockBot,
      movementController: movement
    });

    profileManager.setActiveProfile('SpearElytra');
    assert.strictEqual(profileManager.activeProfileName, 'SPEAR_ELYTRA');
    const spearElytraPreflight = await profileManager.preflight();
    assert.strictEqual(spearElytraPreflight.success, true);

    profileManager.setActiveProfile('SpearMace');
    assert.strictEqual(profileManager.activeProfileName, 'SPEAR_MACE');
    const spearMacePreflight = await profileManager.preflight();
    assert.strictEqual(spearMacePreflight.success, true);

    console.log('  ✅ SpearElytra and SpearMace dedicated profiles operational.\n');
  }

  // TEST 8: NethPot & Sword Profiles (Apex Falling Crits & Buff Awareness)
  console.log('▶ Test 8: NethPot & Sword Profiles Apex Falling Crits');
  {
    const mockBot = createMockBot(new Vec3(0, 64, 0), [
      { name: 'netherite_sword', slot: 36, count: 1 },
      { name: 'golden_apple', slot: 37, count: 64 },
      { name: 'splash_potion', slot: 38, count: 1, nbt: { value: { Potion: { value: 'minecraft:speed' } } } }
    ]);
    const movement = new CombatMovementController(mockBot);
    const profile = new NethPotProfile({ bot: mockBot, movementController: movement });
    const opp = createMockOpponent(new Vec3(0, 64, 2));

    // Start-of-match buff check: bot has speed effect
    mockBot.entity.effects = {
      1: { id: 1, amplifier: 1, duration: 200 } // Speed II active
    };
    assert.strictEqual(profile.hasActiveBuff('SPEED'), true, 'Should detect active Speed effect');
    assert.strictEqual(profile.hasActiveBuff('STRENGTH'), false, 'Should detect missing Strength effect');

    // Apex crit check: vy must be < -0.04 while airborne (!onGround)
    mockBot.entity.onGround = false;
    mockBot.entity.velocity.y = 0.3;
    assert.strictEqual(profile.isAtCritFallingApex(), false, 'Rising (vy > 0) is not crit falling apex');
    mockBot.entity.velocity.y = -0.08;
    assert.strictEqual(profile.isAtCritFallingApex(), true, 'Falling (vy < -0.04) is legitimate crit falling apex');

    console.log('  ✅ NethPot & Sword falling apex crits and start-of-match buff awareness verified.\n');
  }

  // TEST 9: Profile Debug Dashboard & "DO NOTHING" Watchdog
  console.log('▶ Test 9: Profile Debug Dashboard & DO NOTHING Failsafe Watchdog');
  {
    const mockBot = createMockBot();
    const movement = new CombatMovementController(mockBot);
    const profile = new CrystalProfile({ bot: mockBot, movementController: movement });
    const opp = createMockOpponent(new Vec3(0, 64, 3));
    profile.setTarget(opp);

    const status = profile.getDebugStatus();
    assert(status.currentState !== undefined, 'Dashboard must include currentState');
    assert(status.lastAction !== undefined, 'Dashboard must include lastAction');
    assert(status.currentTarget === 'TargetOpponent', 'Dashboard must include currentTarget');
    assert(status.distance !== null, 'Dashboard must include distance');
    assert(status.stuckCount !== undefined, 'Dashboard must include stuckCount');
    assert(status.recentFailuresCount !== undefined, 'Dashboard must include recentFailuresCount');

    // Simulate inactivity to trigger Watchdog
    profile.state = 'OBSIDIAN';
    for (let i = 0; i < 25; i++) {
      profile.checkStuckWatchdog();
    }
    assert(profile.stuckTicks >= 20, 'Watchdog ticks should accumulate before threshold');

    // Run exactly 5 more ticks to reach 30 and trigger recovery
    for (let i = 0; i < 5; i++) {
      profile.checkStuckWatchdog();
    }
    assert.strictEqual(profile.state, 'SEARCH', 'Watchdog must trigger recovery to SEARCH after being stuck');
    assert.strictEqual(profile.stuckTicks, 0, 'Stuck ticks must reset after recovery');

    console.log('  ✅ Profile Debug Dashboard and Watchdog failsafe recovery verified.\n');
  }

  // TEST 10: Central CombatController integration & delegation
  console.log('▶ Test 10: CombatController Profile Delegation & API Integrity');
  {
    const mockBot = createMockBot(new Vec3(0, 64, 0), [
      { name: 'mace', slot: 36, count: 1 },
      { name: 'wind_charge', slot: 37, count: 32 }
    ]);
    const combat = new CombatController(mockBot, { debug: false });
    combat.setGamemode('MacePVP');

    assert.strictEqual(combat.profileManager.activeProfileName, 'MACE');
    const preflightRes = await combat.preflight();
    assert.strictEqual(preflightRes.success, true);

    const debugStatus = combat.getDebugStatus();
    assert.strictEqual(debugStatus.activeProfile, 'MACE');

    const opp = createMockOpponent(new Vec3(0, 64, 2));
    combat.startCombat(opp);
    combat.update(opp);

    assert(combat.profileManager.activeProfile.target !== null, 'Profile should receive target update');
    combat.stopCombat();
    assert.strictEqual(combat.state, 'IDLE');

    console.log('  ✅ Central CombatController directly delegates to active profile without interference.\n');
  }

  console.log('====================================================');
  console.log('🎉 ALL PROFILE ARCHITECTURE REBUILD TESTS PASSED!');
  console.log('====================================================');
}

runTests().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
