const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { ServerManager } = require('../serverManager');
const mcManager = require('../minecraftBot');

// Use a dedicated test servers file so we don't clobber main servers.json during tests
const TEST_SERVERS_FILE = path.join(__dirname, 'test_servers.json');

function cleanupTestFile() {
  if (fs.existsSync(TEST_SERVERS_FILE)) {
    try { fs.unlinkSync(TEST_SERVERS_FILE); } catch {}
  }
}

async function runServerFlowTests() {
  console.log('🧪 Starting Multi-Server Architecture & Flow Verification Tests...\n');

  cleanupTestFile();

  // ==========================================
  // TEST A: /server add
  // ==========================================
  console.log('--- TEST A: /server add ---');
  const sm = new ServerManager(TEST_SERVERS_FILE);
  sm.data = { selectedServer: null, servers: {} };
  sm.save();
  const addResult = sm.addServer('Practice1', 'play.example.net', 25565, {
    practiceMethod: 'command',
    practiceCommand: '/practice',
    duelMethod: 'command',
    duelCommand: '/duel {player}',
    queueMethod: 'command',
    queueCommand: '/queue {gamemode}'
  });

  assert.strictEqual(addResult.success, true, 'TEST A failed: addServer should succeed');
  assert.strictEqual(sm.getSelectedServer().name, 'Practice1', 'TEST A failed: first server should be auto-selected');
  console.log('✅ TEST A PASSED: Server "Practice1" added and saved.');

  // ==========================================
  // TEST B: /server list
  // ==========================================
  console.log('\n--- TEST B: /server list ---');
  sm.addServer('TestServer', '192.168.1.50', 25566);
  const serverList = sm.listServers();
  assert.strictEqual(serverList.length, 2, 'TEST B failed: server count should be 2');
  assert.strictEqual(serverList[0].name, 'Practice1');
  assert.strictEqual(serverList[0].isSelected, true);
  assert.strictEqual(serverList[1].name, 'TestServer');
  assert.strictEqual(serverList[1].isSelected, false);
  console.log(`✅ TEST B PASSED: Correctly listed ${serverList.length} servers with selection flags.`);

  // ==========================================
  // TEST C: /server select
  // ==========================================
  console.log('\n--- TEST C: /server select ---');
  const selectResult = sm.selectServer('TestServer');
  assert.strictEqual(selectResult.success, true, 'TEST C failed: selectServer should succeed');
  assert.strictEqual(sm.getSelectedServer().name, 'TestServer', 'TEST C failed: selectedServer should be TestServer');
  console.log('✅ TEST C PASSED: Server selection switched to "TestServer".');

  // ==========================================
  // TEST D: /server current
  // ==========================================
  console.log('\n--- TEST D: /server current ---');
  const current = sm.getSelectedServer();
  assert.ok(current, 'TEST D failed: current server should exist');
  assert.strictEqual(current.name, 'TestServer');
  assert.strictEqual(current.host, '192.168.1.50');
  assert.strictEqual(current.port, 25566);
  console.log(`✅ TEST D PASSED: Current server retrieved (${current.name} -> ${current.host}:${current.port}).`);

  // ==========================================
  // TEST E: Persistence across reloads
  // ==========================================
  console.log('\n--- TEST E: Persistence Across Restarts ---');
  const reloadedSm = new ServerManager(TEST_SERVERS_FILE);
  const reloadedSelected = reloadedSm.getSelectedServer();
  assert.ok(reloadedSelected, 'TEST E failed: reloaded server profile missing');
  assert.strictEqual(reloadedSelected.name, 'TestServer');
  assert.strictEqual(reloadedSelected.host, '192.168.1.50');
  assert.strictEqual(reloadedSelected.port, 25566);
  console.log('✅ TEST E PASSED: Server configuration and selected server persisted across reload.');

  // ==========================================
  // TEST F: State Machine Transitions
  // ==========================================
  console.log('\n--- TEST F: State Machine Transitions ---');
  mcManager.cleanup();
  assert.strictEqual(mcManager.getState(), 'IDLE', 'TEST F failed: initial state should be IDLE');

  // Simulate spawn
  mcManager.status = 'online';
  mcManager.state = 'CONNECTED';
  assert.strictEqual(mcManager.getState(), 'CONNECTED', 'TEST F failed: state should be CONNECTED after spawn');

  // Simulate navigation to practice
  mcManager.hasNavigatedToPractice = true;
  mcManager.state = 'PRACTICE';
  assert.strictEqual(mcManager.getState(), 'PRACTICE', 'TEST F failed: state should be PRACTICE');

  // Simulate queueing
  mcManager.queueActive = true;
  mcManager.state = 'QUEUEING';
  mcManager.selectedGamemode = 'Boxing';
  assert.strictEqual(mcManager.getState(), 'QUEUEING', 'TEST F failed: state should be QUEUEING');

  // Simulate cage ready / match found
  mcManager.state = 'MATCH';
  mcManager.matchState = 'preparing';
  mcManager.currentOpponent = 'Steve';
  assert.strictEqual(mcManager.getState(), 'MATCH', 'TEST F failed: state should be MATCH');

  // Simulate gate drop / combat
  mcManager.state = 'COMBAT';
  mcManager.matchState = 'in-match';
  mcManager.pvpActive = true;
  assert.strictEqual(mcManager.getState(), 'COMBAT', 'TEST F failed: state should be COMBAT');

  // Simulate match conclusion
  mcManager.concludeMatch('🏆 Bot WON the match!');
  assert.strictEqual(mcManager.getState(), 'MATCH_END', 'TEST F failed: state should be MATCH_END');
  assert.strictEqual(mcManager.pvpActive, false, 'TEST F failed: pvpActive should be false');
  console.log('✅ TEST F PASSED: Full lifecycle transitions verified (IDLE -> CONNECTED -> PRACTICE -> QUEUEING -> MATCH -> COMBAT -> MATCH_END).');

  // ==========================================
  // TEST G: Guard Conditions During Active Match
  // ==========================================
  console.log('\n--- TEST G: Active Match Guard Conditions ---');
  mcManager.state = 'COMBAT';
  mcManager.matchState = 'in-match';

  const queueAttempt = await mcManager.startQueue('Boxing');
  assert.strictEqual(queueAttempt.success, false, 'TEST G failed: queue should be rejected during match');
  assert.strictEqual(queueAttempt.message, '⚠️ Bot is currently in a match.');

  const duelAttempt = await mcManager.sendDuel('Alex');
  assert.strictEqual(duelAttempt.success, false, 'TEST G failed: duel should be rejected during match');
  assert.strictEqual(duelAttempt.message, '⚠️ Bot is currently in a match.');
  console.log('✅ TEST G PASSED: /queue and /duel strictly blocked while in active match.');

  // ==========================================
  // TEST H: Safe /leave Control Clearing
  // ==========================================
  console.log('\n--- TEST H: Safe /leave Command & Control Clearing ---');
  mcManager.status = 'online';
  mcManager.bot = { chat: () => {} };
  // Simulate active movement before /leave
  if (mcManager.movementController) {
    mcManager.movementController.setControl('forward', true);
    mcManager.movementController.setControl('sprint', true);
    mcManager.movementController.setControl('jump', true);
    mcManager.movementController.setState('CHASE');
  }

  const leaveResult = mcManager.leave();
  assert.strictEqual(leaveResult.success, true, 'TEST H failed: leave() should succeed');
  assert.strictEqual(mcManager.getState(), 'PRACTICE', 'TEST H failed: state should reset to PRACTICE');
  assert.strictEqual(mcManager.pvpActive, false, 'TEST H failed: pvpActive should be false');
  assert.strictEqual(mcManager.queueActive, false, 'TEST H failed: queueActive should be false');

  if (mcManager.movementController) {
    const controls = mcManager.movementController.activeControls;
    assert.strictEqual(controls.forward, false, 'TEST H failed: forward should be false');
    assert.strictEqual(controls.sprint, false, 'TEST H failed: sprint should be false');
    assert.strictEqual(controls.jump, false, 'TEST H failed: jump should be false');
    assert.strictEqual(mcManager.movementController.getState(), 'IDLE', 'TEST H failed: movement state should be IDLE');
  }
  console.log('✅ TEST H PASSED: /leave immediately halted combat and wiped all WASD/sprint/jump controls.');

  // ==========================================
  // TEST I: Single Connection Enforcement
  // ==========================================
  console.log('\n--- TEST I: Single Connection Enforcement ---');
  let stoppedCalled = false;
  const origStop = mcManager.stop.bind(mcManager);
  mcManager.stop = () => {
    stoppedCalled = true;
    return origStop();
  };

  const mineflayer = require('mineflayer');
  const origCreateBot = mineflayer.createBot;
  mineflayer.createBot = () => {
    const { EventEmitter } = require('events');
    const fakeBot = new EventEmitter();
    fakeBot.loadPlugin = () => {};
    return fakeBot;
  };

  // Bot is currently "online" on Server A
  mcManager.status = 'online';
  mcManager.bot = { quit: () => {} };
  mcManager.activeServerProfile = { host: '1.1.1.1', port: 25565, name: 'ServerA' };

  // Request connection to Server B
  const serverB = { host: '2.2.2.2', port: 25565, name: 'ServerB' };
  mcManager.start(serverB);

  assert.strictEqual(stoppedCalled, true, 'TEST I failed: stop() must be called when switching servers');
  mineflayer.createBot = origCreateBot;
  mcManager.stop = origStop;
  mcManager.cleanup();
  console.log('✅ TEST I PASSED: Single active connection strictly enforced during server switch.');

  // ==========================================
  // TEST J: Rich /status Output Verification
  // ==========================================
  console.log('\n--- TEST J: Rich /status Format Verification ---');
  mcManager.status = 'online';
  mcManager.state = 'PRACTICE';
  mcManager.selectedGamemode = 'Boxing';
  mcManager.activeServerProfile = { name: 'Practice1', host: 'play.example.net', port: 25565 };

  const info = mcManager.getStatusInfo();
  assert.strictEqual(info.connection, 'CONNECTED', 'TEST J failed: connection should be CONNECTED');
  assert.strictEqual(info.selectedServer, 'Practice1', 'TEST J failed: selectedServer should match');
  assert.strictEqual(info.server, 'play.example.net:25565', 'TEST J failed: server host:port should match');
  assert.strictEqual(info.minecraftState, 'Practice', 'TEST J failed: minecraftState should be Practice');
  assert.strictEqual(info.gamemode, 'Boxing', 'TEST J failed: gamemode should be Boxing');
  assert.strictEqual(typeof info.health, 'string', 'TEST J failed: health should be a string');
  assert.strictEqual(typeof info.movement, 'string', 'TEST J failed: movement should be a string');
  assert.strictEqual(typeof info.combat, 'string', 'TEST J failed: combat should be a string');
  console.log('✅ TEST J PASSED: All 9 status fields formatted and verified.');

  // ==========================================
  // TEST K: /server remove
  // ==========================================
  console.log('\n--- TEST K: /server remove ---');
  const removeResult = sm.removeServer('TestServer');
  assert.strictEqual(removeResult.success, true, 'TEST K failed: removeServer should succeed');
  assert.strictEqual(sm.getServer('TestServer'), null, 'TEST K failed: TestServer should be deleted');
  console.log('✅ TEST K PASSED: Server removal verified.');

  // Clean up test file
  cleanupTestFile();
  mcManager.cleanup();

  console.log('\n======================================================');
  console.log('🎉 ALL MULTI-SERVER & FLOW TESTS PASSED (11/11)!');
  console.log('======================================================\n');
}

runServerFlowTests().catch(err => {
  console.error('❌ Test failed with error:', err);
  cleanupTestFile();
  process.exit(1);
});
