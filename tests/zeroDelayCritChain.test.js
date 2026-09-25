const test = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const CombatController = require('../combatController');
const MovementController = require('../movementController');
const CritChainController = require('../critChainController');

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

  const attacks = [];
  const swings = [];
  const jumps = [];

  const bot = {
    version: '1.20.4',
    protocolVersion: 765,
    health: 20,
    quickBarSlot: 0,
    controlStates,
    heldItem: { name: 'netherite_sword' },
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
      slots: new Array(45).fill(null),
      items: () => [{ name: 'netherite_sword', slot: 36 }],
      hotbarStart: 36,
      inventoryStart: 9,
      selectedItem: null
    },
    setControlState: (ctrl, val) => {
      controlStates[ctrl] = Boolean(val);
      if (ctrl === 'jump' && val) {
        jumps.push({ time: Date.now(), pos: bot.entity.position.clone() });
      }
    },
    clearControlStates: () => {
      for (const k of Object.keys(controlStates)) {
        controlStates[k] = false;
      }
    },
    setQuickBarSlot: (s) => {
      bot.quickBarSlot = s;
    },
    attack: (t) => {
      attacks.push({
        target: t,
        time: Date.now(),
        sprint: controlStates.sprint,
        forward: controlStates.forward,
        back: controlStates.back,
        onGround: bot.entity.onGround,
        vy: bot.entity.velocity.y,
        y: bot.entity.position.y
      });
    },
    swingArm: (hand) => {
      swings.push({ hand, time: Date.now() });
    },
    look: async (y, p) => {
      bot.entity.yaw = y;
      bot.entity.pitch = p;
    },
    equip: async (item) => {
      bot.heldItem = item;
    },
    activateItem: () => {},
    deactivateItem: () => {},
    blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
    on: () => {},
    removeListener: () => {}
  };

  return { bot, controlStates, attacks, swings, jumps };
}

test('ZERO-DELAY CRIT CHAIN: Continuous 4-Crit chain executes without ground stalling or abort resets', () => {
  const { bot, controlStates, attacks, jumps } = createMockBot(new Vec3(0, 64, 0));
  const mc = new MovementController(bot);
  const chain = new CritChainController(bot, mc, { combatVersion: 'modern', maxChainHits: 4 });
  const target = { id: 101, username: 'Opponent', position: new Vec3(0, 64, 2.2), health: 20 };

  const startTime = 10000;

  // 1. Initial jump: Strike #1
  const started = chain.startChain(target, 2.2, true, startTime);
  assert.strictEqual(started, true);
  assert.strictEqual(chain.chainCount, 1);
  assert.strictEqual(chain.state, 'JUMP_START');
  assert.strictEqual(controlStates.forward, true, 'Must maintain forward momentum during crit jump');
  assert.strictEqual(controlStates.back, false, 'Must NEVER press back during crit jump');

  // Ascend
  bot.entity.onGround = false;
  bot.entity.position.y = 64.35;
  bot.entity.velocity.y = 0.35;
  chain.update(target, 2.2, false, startTime + 100);
  assert.strictEqual(chain.state, 'RISING');
  assert.strictEqual(attacks.length, 0, 'No attacks during ascent');

  // Apex -> Falling into Strike #1
  bot.entity.position.y = 64.25;
  bot.entity.velocity.y = -0.15;
  const res1 = chain.update(target, 2.2, true, startTime + 400);
  assert.strictEqual(res1.attacked, true, 'Strike #1 executed');
  assert.strictEqual(attacks.length, 1);
  assert.strictEqual(chain.state, 'CRIT_ATTACK');

  // Land: Must IMMEDIATELY chain into Strike #2 with ZERO ground reposition stall!
  bot.entity.onGround = true;
  bot.entity.position.y = 64.0;
  bot.entity.velocity.y = 0;
  const landRes1 = chain.update(target, 2.2, false, startTime + 550);

  // KEY CHECK: Must NOT have reset to IDLE! Must be in JUMP_START for strike #2!
  assert.strictEqual(chain.mode, 'CRIT_CHAIN', 'Mode must remain CRIT_CHAIN');
  assert.strictEqual(chain.state, 'JUMP_START', 'Must immediately spring into JUMP_START for next strike');
  assert.strictEqual(chain.chainCount, 2, 'Chain count must advance to 2');
  assert.strictEqual(controlStates.forward, true, 'Forward momentum must remain active on chain jump 2');
  assert.strictEqual(controlStates.back, false, 'Back must remain false on chain jump 2');

  // Ascend jump 2
  bot.entity.onGround = false;
  bot.entity.position.y = 64.35;
  bot.entity.velocity.y = 0.35;
  chain.update(target, 2.2, false, startTime + 650);
  assert.strictEqual(chain.state, 'RISING');

  // Falling apex jump 2 -> Strike #2
  bot.entity.position.y = 64.25;
  bot.entity.velocity.y = -0.15;
  const res2 = chain.update(target, 2.2, true, startTime + 950);
  assert.strictEqual(res2.attacked, true, 'Strike #2 executed');
  assert.strictEqual(attacks.length, 2);

  // Land jump 2 -> Immediately chain jump 3
  bot.entity.onGround = true;
  bot.entity.position.y = 64.0;
  chain.update(target, 2.2, false, startTime + 1100);
  assert.strictEqual(chain.chainCount, 3);
  assert.strictEqual(chain.state, 'JUMP_START');

  // Ascend jump 3
  bot.entity.onGround = false;
  bot.entity.position.y = 64.35;
  bot.entity.velocity.y = 0.35;
  chain.update(target, 2.2, false, startTime + 1200);
  assert.strictEqual(chain.state, 'RISING');

  // Falling apex jump 3 -> Strike #3
  bot.entity.position.y = 64.25;
  bot.entity.velocity.y = -0.15;
  const res3 = chain.update(target, 2.2, true, startTime + 1500);
  assert.strictEqual(res3.attacked, true, 'Strike #3 executed');
  assert.strictEqual(attacks.length, 3);

  // Land jump 3 -> Immediately chain jump 4
  bot.entity.onGround = true;
  bot.entity.position.y = 64.0;
  chain.update(target, 2.2, false, startTime + 1650);
  assert.strictEqual(chain.chainCount, 4);
  assert.strictEqual(chain.state, 'JUMP_START');

  // Ascend jump 4
  bot.entity.onGround = false;
  bot.entity.position.y = 64.35;
  bot.entity.velocity.y = 0.35;
  chain.update(target, 2.2, false, startTime + 1750);
  assert.strictEqual(chain.state, 'RISING');

  // Falling apex jump 4 -> Strike #4
  bot.entity.position.y = 64.25;
  bot.entity.velocity.y = -0.15;
  const res4 = chain.update(target, 2.2, true, startTime + 2050);
  assert.strictEqual(res4.attacked, true, 'Strike #4 executed');
  assert.strictEqual(attacks.length, 4, 'All 4 critical strikes executed in continuous chain');

  // Land jump 4 -> Chain complete! Clean return to IDLE
  bot.entity.onGround = true;
  bot.entity.position.y = 64.0;
  chain.update(target, 2.2, true, startTime + 2200);
  assert.strictEqual(chain.mode, 'IDLE');
  assert.strictEqual(controlStates.sprint, true, 'Sprint restored after chain completion');

  console.log('✅ PASS: Continuous 4-Crit chain executed with zero ground delay and zero abort resets.');
});

test('COMBAT STABILITY: NethPot does not fluctuate between COMBO and CRIT_CHAIN during fight', () => {
  const { bot, controlStates } = createMockBot(new Vec3(0, 64, 0));
  const combat = new CombatController(bot, { gamemode: 'nethpot' });
  combat.gamemode = 'nethpot';

  const target = { id: 102, username: 'NethPotOpponent', position: new Vec3(0, 64, 2.4), health: 20 };

  combat.startCombat(target);

  // Initial tick: starts CRIT_CHAIN immediately without requiring 3 combo hits first
  combat.update(target);
  assert.strictEqual(combat.state, 'CRIT_CHAIN', 'NethPot must immediately initiate CRIT_CHAIN');
  assert.strictEqual(combat.phase, 'CRITICAL_ATTACK', 'Phase must be locked to CRITICAL_ATTACK');

  // Verify controls do not stutter/oscillate
  assert.strictEqual(controlStates.forward, true, 'Must press forward towards target');
  assert.strictEqual(controlStates.back, false, 'Must not press back towards target');

  // Mid-air ascent check: state must stay locked in CRIT_CHAIN
  bot.entity.onGround = false;
  bot.entity.position.y = 64.35;
  bot.entity.velocity.y = 0.30;
  combat.update(target);
  assert.strictEqual(combat.state, 'CRIT_CHAIN', 'State must not fluctuate to COMBO or REPOSITION while airborne');
  assert.strictEqual(combat.phase, 'CRITICAL_ATTACK');
  assert.strictEqual(controlStates.forward, true, 'Must maintain forward glide');
  assert.strictEqual(controlStates.back, false, 'Must not backpedal in mid-air');

  console.log('✅ PASS: NethPot maintains rock-solid CRIT_CHAIN state without fluctuation.');
});
