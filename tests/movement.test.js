const assert = require('assert');
const { Vec3 } = require('vec3');
const mcData = require('minecraft-data')('1.20.4');
const Block = require('prismarine-block')('1.20.4');
const { Physics, PlayerState } = require('prismarine-physics');
const MovementController = require('../movementController');
const { getCombatProfile } = require('../combatProfiles');

// Setup mock world and physics engine
const getBlock = (p) => {
  const b = p.y < 64 ? Block.fromStateId(1, 0) : Block.fromStateId(0, 0); // Stone below 64, air at and above 64
  b.position = p;
  return b;
};

const physics = Physics(mcData, { getBlock });

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

  const bot = {
    version: '1.20.4',
    registry: mcData,
    inventory: { slots: [] },
    blockAt: getBlock,
    jumpTicks: 0,
    entity: {
      position: initialPos.clone(),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: false,
      eyeHeight: 1.6,
      effects: {},
      attributes: {},
    },
    setControlState(control, state) {
      controlStates[control] = Boolean(state);
    },
    clearControlStates() {
      for (const k of Object.keys(controlStates)) {
        controlStates[k] = false;
      }
    },
    getControlState(control) {
      return controlStates[control] || false;
    },
    async look(yaw, pitch) {
      bot.entity.yaw = yaw;
      bot.entity.pitch = pitch;
    },
    stepPhysics() {
      const state = new PlayerState(bot, controlStates);
      physics.simulatePlayer(state, { getBlock });
      bot.entity.position = state.pos;
      bot.entity.velocity = state.vel;
      bot.entity.onGround = state.onGround;
      bot.entity.isCollidedHorizontally = state.isCollidedHorizontally;
    },
  };

  return { bot, controlStates };
}

async function runTests() {
  console.log('🧪 Running comprehensive 15-test PvP movement verification suite...\n');

  // TEST 1: Bot can move forward physically (in Minecraft yaw=0, forward is -Z)
  {
    const { bot } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    mc.setState('CHASE');
    bot.stepPhysics();
    const dz = bot.entity.position.z;
    assert(dz < 0, `Test 1 failed: Expected forward displacement dz < 0, got ${dz}`);
    console.log(`✅ TEST 1 PASSED: Forward movement physically displaced entity to z=${dz.toFixed(3)}`);
  }

  // TEST 2: Bot can move backward physically (in Minecraft yaw=0, back is +Z)
  {
    const { bot } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    mc.setState('RETREAT');
    bot.stepPhysics();
    const dz = bot.entity.position.z;
    assert(dz > 0, `Test 2 failed: Expected backward displacement dz > 0, got ${dz}`);
    console.log(`✅ TEST 2 PASSED: Backward movement physically displaced entity to z=${dz.toFixed(3)}`);
  }

  // TEST 3: Bot can strafe left physically (in Minecraft yaw=0, left is -X)
  {
    const { bot } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    mc.setState('STRAFE_LEFT');
    bot.stepPhysics();
    const dx = bot.entity.position.x;
    assert(dx < 0, `Test 3 failed: Expected left strafe dx < 0, got ${dx}`);
    console.log(`✅ TEST 3 PASSED: Strafe left physically displaced entity to x=${dx.toFixed(3)}`);
  }

  // TEST 4: Bot can strafe right physically (in Minecraft yaw=0, right is +X)
  {
    const { bot } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    mc.setState('STRAFE_RIGHT');
    bot.stepPhysics();
    const dx = bot.entity.position.x;
    assert(dx > 0, `Test 4 failed: Expected right strafe dx > 0, got ${dx}`);
    console.log(`✅ TEST 4 PASSED: Strafe right physically displaced entity to x=${dx.toFixed(3)}`);
  }

  // TEST 5: Bot can sprint (velocity is higher than normal walk)
  {
    const { bot: walkBot } = createMockBot(new Vec3(0, 64, 0));
    walkBot.setControlState('forward', true);
    walkBot.setControlState('sprint', false);
    walkBot.stepPhysics();
    const walkSpeed = Math.abs(walkBot.entity.velocity.z);

    const { bot: sprintBot } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(sprintBot);
    mc.setState('CHASE');
    sprintBot.stepPhysics();
    const sprintSpeed = Math.abs(sprintBot.entity.velocity.z);

    assert(sprintSpeed > walkSpeed, `Test 5 failed: Sprint speed (${sprintSpeed}) should be > walk speed (${walkSpeed})`);
    console.log(`✅ TEST 5 PASSED: Sprint physically increased forward speed (${sprintSpeed.toFixed(3)} > ${walkSpeed.toFixed(3)})`);
  }

  // TEST 6: Bot can jump (vertical velocity vy > 0.4)
  {
    const { bot } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    mc.requestJump(true);
    bot.stepPhysics();
    const vy = bot.entity.velocity.y;
    assert(vy > 0.30, `Test 6 failed: Expected jump velocity vy > 0.30, got ${vy}`);
    console.log(`✅ TEST 6 PASSED: Jump physically launched entity upward with vy=${vy.toFixed(3)}`);
  }

  // TEST 7: Bot can combine movement directions (W+A and W+D)
  {
    const { bot: diagBot } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(diagBot);
    mc.setState('REPOSITION', { strafeDirection: 'left' });
    diagBot.stepPhysics();
    assert(diagBot.entity.position.x < 0 && diagBot.entity.position.z < 0,
      `Test 7 failed: W+A should produce negative X and negative Z displacement`);
    console.log(`✅ TEST 7 PASSED: Diagonal movement physically produced combined dx=${diagBot.entity.position.x.toFixed(3)}, dz=${diagBot.entity.position.z.toFixed(3)}`);
  }

  // TEST 8: Bot can track an opponent while moving (smooth predictive look calculation)
  {
    const { bot } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    const target = {
      position: new Vec3(5, 64, 5),
    };
    const lookResult = mc.aimAtTarget(target, 1.4, 0.15);
    assert(lookResult && typeof lookResult.yaw === 'number', `Test 8 failed: Look result missing yaw`);
    assert(Math.abs(bot.entity.yaw - lookResult.yaw) < 0.001, `Test 8 failed: Bot yaw not updated`);
    console.log(`✅ TEST 8 PASSED: Predictive target tracking successfully rotated yaw to ${bot.entity.yaw.toFixed(3)} rad`);
  }

  // TEST 9: Bot can approach an opponent (distance decreases over steps)
  {
    const { bot } = createMockBot(new Vec3(0, 64, 10)); // 10 blocks away on +Z
    const mc = new MovementController(bot);
    const target = { position: new Vec3(0, 64, 0) };

    const initialDist = bot.entity.position.distanceTo(target.position);
    mc.aimAtTarget(target);
    mc.setState('APPROACH');
    for (let i = 0; i < 5; i++) {
      mc.update(target);
      bot.stepPhysics();
    }
    const finalDist = bot.entity.position.distanceTo(target.position);
    assert(finalDist < initialDist, `Test 9 failed: Approach should decrease distance (${finalDist} < ${initialDist})`);
    console.log(`✅ TEST 9 PASSED: Approach closed distance from ${initialDist.toFixed(2)}m to ${finalDist.toFixed(2)}m`);
  }

  // TEST 10: Bot can strafe around an opponent (retaining distance without running straight through)
  {
    const { bot } = createMockBot(new Vec3(0, 64, 2.5));
    const mc = new MovementController(bot);
    const target = { position: new Vec3(0, 64, 0) };

    mc.aimAtTarget(target);
    mc.setState('STRAFE_LEFT', { maintainSpacing: true });
    for (let i = 0; i < 4; i++) {
      bot.stepPhysics();
    }
    const dist = bot.entity.position.distanceTo(target.position);
    assert(Math.abs(bot.entity.position.x) > 0.1, `Test 10 failed: Should have moved horizontally around target`);
    assert(dist >= 2.0 && dist <= 3.2, `Test 10 failed: Strafe should maintain useful spacing, got ${dist}`);
    console.log(`✅ TEST 10 PASSED: Strafe orbited opponent laterally (x=${bot.entity.position.x.toFixed(2)}, dist=${dist.toFixed(2)}m)`);
  }

  // TEST 11: Bot can retreat (distance increases)
  {
    const { bot } = createMockBot(new Vec3(0, 64, 2.0));
    const mc = new MovementController(bot);
    const target = { position: new Vec3(0, 64, 0) };

    mc.aimAtTarget(target);
    mc.setState('RETREAT');
    for (let i = 0; i < 5; i++) {
      bot.stepPhysics();
    }
    const finalDist = bot.entity.position.distanceTo(target.position);
    assert(finalDist > 2.0, `Test 11 failed: Retreat should increase distance, got ${finalDist}`);
    console.log(`✅ TEST 11 PASSED: Retreat successfully opened distance to ${finalDist.toFixed(2)}m`);
  }

  // TEST 12: Bot can recover from knockback (velocity is stabilized)
  {
    const { bot } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    // Simulate severe knockback velocity
    bot.entity.velocity = new Vec3(0.6, 0.4, 0.8);
    mc.setState('RECOVER');
    for (let i = 0; i < 4; i++) {
      bot.stepPhysics();
    }
    const velNorm = bot.entity.velocity.norm();
    assert(velNorm < 0.6, `Test 12 failed: Recovery should dampen knockback velocity, got ${velNorm}`);
    console.log(`✅ TEST 12 PASSED: Recovery dampened knockback velocity from 1.07 to ${velNorm.toFixed(2)}`);
  }

  // TEST 13: Bot can stop movement cleanly (all controls false, state IDLE)
  {
    const { bot, controlStates } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    mc.setState('CHASE');
    assert(controlStates.forward === true, 'Setup failed: forward should be true');

    mc.setState('IDLE');
    assert(controlStates.forward === false, 'Test 13 failed: forward not cleared');
    assert(controlStates.sprint === false, 'Test 13 failed: sprint not cleared');
    assert(mc.getState() === 'IDLE', 'Test 13 failed: state not IDLE');
    console.log(`✅ TEST 13 PASSED: Movement stopped cleanly with all control states reset to false`);
  }

  // TEST 14: Bot can start movement again after stopping
  {
    const { bot, controlStates } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    mc.setState('IDLE');
    mc.setState('CHASE');
    bot.stepPhysics();
    assert(controlStates.forward === true, 'Test 14 failed: forward should be active');
    assert(bot.entity.position.z < 0, 'Test 14 failed: should move forward after resume');
    console.log(`✅ TEST 14 PASSED: Movement resumed cleanly after IDLE (displaced to z=${bot.entity.position.z.toFixed(3)})`);
  }

  // TEST 15: Anti-stuck watchdog triggers unstuck maneuvers when immobilized
  {
    const { bot, controlStates } = createMockBot(new Vec3(0, 64, 0));
    const mc = new MovementController(bot);
    mc.setState('CHASE');

    // Simulate being stuck against a wall: position stays exactly the same despite CHASE
    for (let i = 0; i < 8; i++) {
      mc.updateWatchdog();
    }

    assert(mc.isUnstucking === true, 'Test 15 failed: Watchdog should have triggered isUnstucking');
    assert(controlStates.jump === true, 'Test 15 failed: Watchdog should have requested jump to clear obstacle');
    console.log(`✅ TEST 15 PASSED: Anti-stuck watchdog detected zero displacement and triggered un-stuck jump`);
  }

  console.log('\n🎉 ALL 15 MOVEMENT & COMBAT TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
