// Filter out node-minecraft-protocol partial packet warnings from spamming stdout/stderr
const filterNoise = (str) => typeof str === 'string' && (str.includes('Chunk size is') || str.includes('partial packet'));
const origStdout = process.stdout.write;
process.stdout.write = function(chunk, ...args) {
  if (filterNoise(chunk ? chunk.toString() : '')) return true;
  return origStdout.apply(process.stdout, [chunk, ...args]);
};
const origStderr = process.stderr.write;
process.stderr.write = function(chunk, ...args) {
  if (filterNoise(chunk ? chunk.toString() : '')) return true;
  return origStderr.apply(process.stderr, [chunk, ...args]);
};

const mineflayer = require('mineflayer');
const { EventEmitter } = require('events');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const MovementController = require('./movementController');
const { getCombatProfile } = require('./combatProfiles');
const serverManager = require('./serverManager');
const PotionManager = require('./potionManager');
const CriticalAttackController = require('./criticalAttackController');
const CombatController = require('./combatController');

/**
 * Recursively parses Minecraft chat components into clean plain text.
 */
function parseMinecraftChat(data) {
  if (data == null) return '';
  if (typeof data === 'string') {
    try {
      if (data.trim().startsWith('{') || data.trim().startsWith('[')) {
        return parseMinecraftChat(JSON.parse(data));
      }
    } catch {
      return data;
    }
    return data;
  }
  if (Array.isArray(data)) {
    return data.map(parseMinecraftChat).join('');
  }
  if (typeof data === 'object') {
    if (data.text != null || Array.isArray(data.extra)) {
      let result = data.text || '';
      if (Array.isArray(data.extra)) {
        result += data.extra.map(parseMinecraftChat).join('');
      }
      return result;
    }
    if (data.translate) {
      return data.translate;
    }
    if (typeof data.toString === 'function' && data.toString() !== '[object Object]') {
      return parseMinecraftChat(data.toString());
    }
    try {
      return JSON.stringify(data);
    } catch {
      return '';
    }
  }
  return String(data);
}

/**
 * Extracts and cleans the title of any Minecraft window safely.
 */
function getCleanTitle(window) {
  if (!window || !window.title) return '';
  return parseMinecraftChat(window.title).trim().toLowerCase();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Configuration for the 19 gamemodes in the "Select Kit : 1v1" GUI.
 * Slots correspond exactly to the 45-slot chest layout on staticpvp.fun.
 */
const KIT_CONFIG = {
  'NethPot': { slot: 9, item: 'netherite_sword', name: 'NethPot' },
  'SMP Kit': { slot: 10, item: 'netherite_chestplate', name: 'SMP Kit' },
  'DiaSMP': { slot: 11, item: 'diamond_chestplate', name: 'DiaSMP' },
  'MacePVP': { slot: 12, item: 'mace', name: 'MacePVP' },
  'MaceRocket': { slot: 13, item: 'mace', name: 'MaceRocket' },
  'SpearElytra': { slot: 14, item: 'diamond_spear', name: 'SpearElytra' },
  'SpearMace': { slot: 15, item: 'golden_spear', name: 'SpearMace' },
  'Tank': { slot: 16, item: 'stone_sword', name: 'Tank' },
  'Beast': { slot: 17, item: 'diamond_sword', name: 'Beast' },
  'CreeperPvP': { slot: 19, item: 'creeper_spawn_egg', name: 'CreeperPvP' },
  'Axe': { slot: 20, item: 'diamond_axe', name: 'Axe' },
  'CrystalPVP': { slot: 21, item: 'end_crystal', name: 'CrystalPVP' },
  'CartPVP': { slot: 22, item: 'tnt_minecart', name: 'CartPVP' },
  'Bow': { slot: 23, item: 'bow', name: 'Bow' },
  'BuildUHC': { slot: 24, item: 'lava_bucket', name: 'BuildUHC' },
  'Bedwars': { slot: 25, item: 'red_wool', name: 'Bedwars' },
  'Bridge': { slot: 30, item: 'terracotta', name: 'Bridge' },
  'Fireball': { slot: 31, item: 'fire_charge', name: 'Fireball' },
  'StickFight': { slot: 32, item: 'stick', name: 'StickFight' }
};

/**
 * Manager class controlling Minecraft bot connection, lobby navigation,
 * autonomous queue/duel detection, and LT2 competitive PvP combat.
 */
class MinecraftBotManager extends EventEmitter {
  constructor() {
    super();
    this.bot = null;
    this.status = 'offline'; // 'offline' | 'connecting' | 'online'
    this.state = 'IDLE'; // 'IDLE' | 'CONNECTED' | 'PRACTICE' | 'QUEUEING' | 'MATCH' | 'COMBAT' | 'MATCH_END' | 'DISCONNECTING'
    this.activeServerProfile = null;
    this.hasNavigatedToPractice = false;
    this.lobbyPosition = null;

    // PvP & Match state
    this.pvpActive = false;
    this.pvpTarget = null;
    this.queueActive = false;
    this.queueConfirmed = false;
    this.queueStartedAt = 0;
    this.selectedGamemode = null;
    this.matchState = 'idle'; // 'idle' | 'preparing' | 'in-match'
    this.currentOpponent = null;
    this.arenaWatcherInterval = null;
    this.gateCountdownTimeout = null;

    // LT2 competitive combat variables
    this.physicsTickHandler = null;
    this.entityHurtHandler = null;
    this.isWtapping = false;
    this.lastAttackTime = 0;
    this.lastHealTime = 0;
    this.lastTotemCheck = 0;
    this.lastCrystalActionTime = 0;
    this.isHealing = false;
    this.prevTargetPos = null;
    this.strafeDirection = 'left';
    this.strafeTicks = 0;
    this.strafeChangeInterval = 8;
    this.isRefillingInventory = false;
    this.lastRefillCheck = 0;

    // Central Authoritative Combat Controller (owns tracking, movement, crits, attack timing, potions)
    this.combatController = new CombatController(null);
    this.movementController = this.combatController.movementController;
    this.potionManager = this.combatController.potionManager;
    this.critController = this.combatController.critController;
    this.combatState = 'IDLE';
    this.currentProfile = this.combatController.currentProfile;

    this._combatPhase = 'COMBO';
    this._comboHitsCount = 0;
    this._critHitsCount = 0;
    this._targetComboHits = 3;
    this._targetCritHits = 2;
    this.jumpStartTime = 0;

    // Incoming Duel Challenge Requests
    this.pendingDuelRequests = new Map(); // playerLower -> { player, gamemode, server, receivedAt, expiresAt }
  }

  get combatPhase() {
    return this.combatController ? this.combatController.phase : (this._combatPhase || 'COMBO');
  }

  set combatPhase(val) {
    this._combatPhase = val;
    if (this.combatController) {
      this.combatController.phase = val;
    }
  }

  get comboHitsCount() {
    return this.combatController ? this.combatController.comboCount : (this._comboHitsCount || 0);
  }

  set comboHitsCount(val) {
    this._comboHitsCount = val;
    if (this.combatController) {
      this.combatController.comboCount = val;
    }
  }

  get critHitsCount() {
    return this.combatController ? this.combatController.critCount : (this._critHitsCount || 0);
  }

  set critHitsCount(val) {
    this._critHitsCount = val;
    if (this.combatController) {
      this.combatController.critCount = val;
    }
  }

  get targetComboHits() {
    return this.combatController ? this.combatController.targetComboHits : (this._targetComboHits || 3);
  }

  set targetComboHits(val) {
    this._targetComboHits = val;
    if (this.combatController) {
      this.combatController.targetComboHits = val;
    }
  }

  get targetCritHits() {
    return this.combatController ? this.combatController.targetCritHits : (this._targetCritHits || 2);
  }

  set targetCritHits(val) {
    this._targetCritHits = val;
    if (this.combatController) {
      this.combatController.targetCritHits = val;
    }
  }

  get critState() {
    return this.critController ? this.critController.state : 'IDLE';
  }

  set critState(val) {
    if (this.critController) {
      this.critController.state = val;
    }
  }

  getStatus() {
    return this.status;
  }

  getState() {
    return this.state;
  }

  /**
   * Returns rich status object formatted for Discord /status command.
   */
  getStatusInfo() {
    const isOnline = this.status === 'online';
    const profile = this.activeServerProfile || serverManager.getSelectedServer();
    const serverName = profile ? profile.name : 'None';
    const serverHostPort = profile ? `${profile.host}:${profile.port}` : 'None';

    // Minecraft State: Lobby / Practice / Queue / Match / Dead / Unknown
    let mcState = 'Unknown';
    if (!isOnline) {
      mcState = this.status === 'connecting' ? 'Connecting' : 'Disconnected';
    } else if (this.bot && this.bot.isDead) {
      mcState = 'Dead';
    } else if (this.state === 'COMBAT' || this.state === 'MATCH' || this.matchState === 'in-match') {
      mcState = 'Match';
    } else if (this.state === 'QUEUEING' || this.queueActive || this.matchState === 'preparing') {
      mcState = 'Queue';
    } else if (this.state === 'PRACTICE' || this.hasNavigatedToPractice) {
      mcState = 'Practice';
    } else if (this.state === 'CONNECTED') {
      mcState = 'Lobby';
    }

    const health = this.bot && this.bot.health != null ? Math.round(this.bot.health) : null;
    const opponent = this.currentOpponent || (this.matchState === 'in-match' ? this.pvpTarget : null);
    const gamemode = this.selectedGamemode || 'None';
    const movement = this.movementController ? this.movementController.getState() : 'IDLE';
    const combat = (this.state === 'COMBAT' || this.pvpActive) ? (this.combatState || 'ENGAGED') : 'IDLE';
    const debugDashboard = this.combatController ? this.combatController.getDebugStatus() : null;

    return {
      connection: isOnline ? 'CONNECTED' : (this.status === 'connecting' ? 'CONNECTING' : 'DISCONNECTED'),
      selectedServer: serverName,
      server: serverHostPort,
      minecraftState: mcState,
      gamemode: gamemode,
      opponent: opponent || 'None',
      health: health !== null ? `${health}/20` : 'Unknown',
      movement: movement,
      combat: combat,
      debugDashboard: debugDashboard
    };
  }

  getPvPStatus() {
    const health = this.bot && this.bot.health != null ? Math.round(this.bot.health) : null;
    const targetName = this.currentOpponent || this.pvpTarget || null;
    let distanceStr = 'N/A';

    if (this.bot && this.bot.entity) {
      const targetEntity = this.findTargetEntity(targetName);
      if (targetEntity && targetEntity.position) {
        distanceStr = `${this.bot.entity.position.distanceTo(targetEntity.position).toFixed(1)} blocks`;
      }
    }

    return {
      active: this.pvpActive,
      target: targetName,
      botOnline: this.status === 'online',
      selectedGamemode: this.selectedGamemode,
      matchState: this.matchState,
      currentOpponent: this.currentOpponent,
      health: health !== null ? `${health}/20 HP` : 'Unknown',
      movementState: this.movementController ? this.movementController.getState() : 'IDLE',
      combatState: this.combatState || 'IDLE',
      distance: distanceStr,
    };
  }

  /**
   * Helper to connect to a server and await successful spawn event.
   */
  connectAndWaitForSpawn(profile, timeoutMs = 15000) {
    return new Promise((resolve) => {
      if (this.status === 'online' && this.bot) {
        return resolve({ success: true, message: 'Already connected.' });
      }

      const startResult = this.start(profile);
      if (!startResult.success) {
        return resolve(startResult);
      }

      let resolved = false;

      const onSpawn = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({ success: true, message: 'Connected and spawned.' });
      };

      const onError = (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({ success: false, message: `Connection error: ${err.message}` });
      };

      const onKicked = (reason) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({ success: false, message: `Disconnected by server: ${reason}` });
      };

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({ success: false, message: 'Connection timed out waiting for spawn.' });
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('spawn', onSpawn);
        this.removeListener('error', onError);
        this.removeListener('kicked', onKicked);
      };

      this.once('spawn', onSpawn);
      this.once('error', onError);
      this.once('kicked', onKicked);
    });
  }

  /**
   * Configurable Practice Navigation:
   * Connects to server if needed, then navigates to the Practice/PvP area using
   * the server profile's configured practiceMethod ('gui', 'command', etc.).
   */
  async joinPractice(force = false) {
    const profile = this.activeServerProfile || serverManager.getSelectedServer();
    if (!profile) {
      return { success: false, message: '❌ No server selected. Use `/server select <name>` or `/server add` first.' };
    }

    // 1. Connect if not connected
    if (this.status !== 'online' || !this.bot) {
      console.log(`🔌 Connecting to selected server ${profile.name} for Practice...`);
      const connResult = await this.connectAndWaitForSpawn(profile);
      if (!connResult.success) {
        return connResult;
      }
      await sleep(1000);
    }

    // 2. Check if already in practice
    if (this.state === 'PRACTICE' && this.hasNavigatedToPractice && !force) {
      return { success: true, message: `✅ Bot is already in the Practice area on **${profile.name}**!` };
    }

    // 3. Navigate using configured method
    const method = (profile.practiceMethod || 'command').toLowerCase();
    console.log(`🧭 Navigating to Practice area using method "${method}" on server ${profile.name}...`);

    try {
      if (method === 'command') {
        const cmd = profile.practiceCommand || '/practice';
        console.log(`💬 Sending practice command: ${cmd}`);
        this.bot.chat(cmd);
        await sleep(1500);
        this.hasNavigatedToPractice = true;
        this.state = 'PRACTICE';
        if (this.bot.entity) this.lobbyPosition = this.bot.entity.position.clone();
        return { success: true, message: `✅ Sent practice command \`${cmd}\`! Bot is in Practice lobby on **${profile.name}**.` };
      }

      if (method === 'gui') {
        const guiResult = await this.navigatePracticeGui(profile);
        if (guiResult.success) {
          this.hasNavigatedToPractice = true;
          this.state = 'PRACTICE';
          if (this.bot.entity) this.lobbyPosition = this.bot.entity.position.clone();
          return { success: true, message: `✅ Successfully navigated GUI to Practice on **${profile.name}**!` };
        } else {
          // Fallback to command if GUI fails
          if (profile.practiceCommand) {
            console.log(`⚠️ GUI navigation failed (${guiResult.message}), falling back to command: ${profile.practiceCommand}`);
            this.bot.chat(profile.practiceCommand);
            await sleep(1500);
            this.hasNavigatedToPractice = true;
            this.state = 'PRACTICE';
            if (this.bot.entity) this.lobbyPosition = this.bot.entity.position.clone();
            return { success: true, message: `⚠️ GUI failed; used fallback command \`${profile.practiceCommand}\`. Bot is in Practice.` };
          }
          return guiResult;
        }
      }

      // Default fallback: send command
      const fallbackCmd = profile.practiceCommand || '/practice';
      this.bot.chat(fallbackCmd);
      await sleep(1200);
      this.hasNavigatedToPractice = true;
      this.state = 'PRACTICE';
      if (this.bot.entity) this.lobbyPosition = this.bot.entity.position.clone();
      return { success: true, message: `✅ Sent command \`${fallbackCmd}\` to enter Practice on **${profile.name}**.` };

    } catch (err) {
      console.error('❌ Error during Practice navigation:', err.message);
      return { success: false, message: `❌ Error navigating to Practice: ${err.message}` };
    }
  }

  /**
   * GUI-based Practice selector menu navigation.
   */
  async navigatePracticeGui(profile) {
    if (!this.bot || !this.bot.inventory) return { success: false, message: 'Bot or inventory not available' };

    await sleep(800);

    // Check if already in Practice lobby (hotbar slot 0 has a sword)
    const slot0 = this.bot.inventory?.slots[36];
    if (slot0 && slot0.name && slot0.name.includes('sword')) {
      console.log('✅ Bot already holding sword in Practice lobby!');
      return { success: true, message: 'Already in Practice' };
    }

    // 1. Select Hotbar Selector Slot
    const slotIndex = profile.practiceSlot !== undefined ? profile.practiceSlot : 4;
    console.log(`🧭 Selecting hotbar selector slot index ${slotIndex}...`);
    this.bot.setQuickBarSlot(slotIndex);
    await sleep(400);

    // 2. Activate selector item
    console.log('🖱️ Activating Server Selector item...');
    this.bot.activateItem();

    // 3. Wait for window open and click Practice item
    return new Promise((resolve) => {
      let resolved = false;

      const onWindowOpen = async (window) => {
        if (resolved) return;
        resolved = true;
        console.log(`📋 Server Selector GUI opened: "${getCleanTitle(window) || 'Menu'}"`);
        await sleep(1000);

        const targetItemQuery = (profile.practiceItem || 'purple_bed').toLowerCase();
        let targetSlot = -1;

        for (let i = 0; i < window.inventoryStart; i++) {
          const item = window.slots[i];
          if (item) {
            const name = item.name.toLowerCase();
            const displayName = (item.displayName || '').toLowerCase();
            if (name.includes(targetItemQuery) || displayName.includes(targetItemQuery) ||
                displayName.includes('practise') || displayName.includes('practice')) {
              targetSlot = i;
              console.log(`🎯 Found Practice item in slot ${i}: ${item.name} ("${item.displayName}")`);
              break;
            }
          }
        }

        if (targetSlot !== -1) {
          console.log(`🖱️ Clicking Practice item in slot ${targetSlot}...`);
          try {
            await this.bot.clickWindow(targetSlot, 0, 0);
            await sleep(1500);
            resolve({ success: true });
          } catch (err) {
            resolve({ success: false, message: `Failed to click window slot ${targetSlot}: ${err.message}` });
          }
        } else {
          resolve({ success: false, message: `Practice item matching "${targetItemQuery}" not found in GUI.` });
        }
      };

      this.bot.once('windowOpen', onWindowOpen);

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (this.bot) this.bot.removeListener('windowOpen', onWindowOpen);
          resolve({ success: false, message: 'Server Selector GUI did not open within timeout.' });
        }
      }, 8000);
    });
  }

  /**
   * Backwards compatibility for lobby navigation.
   */
  async handleLobbyNavigation() {
    return this.joinPractice();
  }

  /**
   * Authentic W-Tap sprint-reset for maximum knockback.
   */
  triggerWTap() {
    if (this.isWtapping) return;
    this.isWtapping = true;
    if (this.movementController) {
      this.movementController.setControl('sprint', false);
    }
    setTimeout(() => {
      this.isWtapping = false;
      if (this.movementController && this.pvpActive) {
        this.movementController.setControl('sprint', true);
      }
    }, 55);
  }

  /**
   * Equips best weapon. If preferAxe is true, prefers axe to disable shields.
   */
  async equipBestWeapon(preferAxe = false) {
    if (!this.bot || !this.bot.inventory || this.isHealing) return;
    const items = this.bot.inventory.items();
    const sword = items.find(i => i.name.includes('sword'));
    const axe = items.find(i => i.name.includes('axe'));
    const mace = items.find(i => i.name.includes('mace'));
    const spear = items.find(i => i.name.includes('spear') || i.name.includes('trident'));

    let weapon;
    if (preferAxe) {
      weapon = axe || sword || mace || spear;
    } else {
      weapon = sword || mace || axe || spear;
    }

    if (weapon && (!this.bot.heldItem || this.bot.heldItem.name !== weapon.name)) {
      try {
        await this.bot.equip(weapon, 'hand');
      } catch {}
    }
  }

  /**
   * Automatically equips a Totem of Undying in the off-hand if empty or lost.
   */
  async ensureTotemInOffHand() {
    if (!this.bot || !this.bot.inventory) return;
    const offHandItem = this.bot.inventory.slots[45];
    if (!offHandItem || !offHandItem.name.includes('totem')) {
      const totem = this.bot.inventory.items().find(i => i.name.includes('totem'));
      if (totem) {
        try {
          await this.bot.equip(totem, 'off-hand');
        } catch {}
      }
    }
  }

  /**
   * Extremely Fast Universal Healing:
   * When bot drops to <= 10 HP (5 hearts), rapidly throws 2 splash potions at feet
   * in ~80ms, restoring +16 HP straight up to 19-20 HP.
   * Maintains sprint momentum without freezing in place.
   */
  async executeUniversalHealing() {
    if (!this.bot || !this.bot.inventory || this.isHealing) return;
    if (this.bot.health == null || this.bot.health > 10) return;

    const now = Date.now();
    if (now - this.lastHealTime < 650) return;

    const items = this.bot.inventory.items();

    // 1. Splash Potions: Rapid double-burst to reach 19-20 HP
    const splashPots = items.filter(i => {
      const name = i.name.toLowerCase();
      const disp = (i.displayName || '').toLowerCase();
      return name.includes('splash') &&
        (name.includes('potion') || disp.includes('heal') || disp.includes('regen') || disp.includes('health'));
    });

    if (splashPots.length > 0) {
      this.isHealing = true;
      this.lastHealTime = now;
      console.log(`🧪 Low HP (${Math.round(this.bot.health)}/20)! Rapid double-potting to 19 HP...`);

      try {
        const originalYaw = this.bot.entity.yaw;
        const potsToThrow = Math.min(2, splashPots.length);

        for (let p = 0; p < potsToThrow; p++) {
          if (!this.bot || !this.pvpActive) break;
          const currentPot = this.bot.inventory.items().find(i =>
            i.name.includes('splash') &&
            (i.name.includes('potion') || (i.displayName || '').toLowerCase().includes('heal') || (i.displayName || '').toLowerCase().includes('health'))
          );
          if (!currentPot) break;

          await this.bot.equip(currentPot, 'hand');
          // Angle pitch down at feet (-1.35 rads preserves forward sprint momentum)
          await this.bot.look(originalYaw, -1.35, true);
          this.bot.activateItem();
          await sleep(30);
          this.bot.deactivateItem();
        }

        // Instantly re-equip primary weapon in < 20ms
        await this.equipBestWeapon();
        // Immediately restock used hotbar potion slots
        this.refillHotbarWithPotions();
      } catch (err) {
        console.error('⚠️ Fast potting error:', err.message);
      } finally {
        this.isHealing = false;
      }
      return;
    }

    // 2. Golden Apples (fallback if out of splash potions)
    const gapple = items.find(i => {
      const name = i.name.toLowerCase();
      return name.includes('golden_apple') || name.includes('enchanted_golden_apple');
    });

    if (gapple) {
      this.isHealing = true;
      this.lastHealTime = now;
      try {
        console.log(`🍎 Low HP (${Math.round(this.bot.health)}/20)! Eating golden apple...`);
        await this.bot.equip(gapple, 'hand');
        this.bot.activateItem();
        const eatStart = Date.now();
        while (Date.now() - eatStart < 1650 && this.bot && this.pvpActive) {
          await sleep(100);
          if (this.bot.health != null && this.bot.health >= 18) break;
        }
        if (this.bot) this.bot.deactivateItem();
        await this.equipBestWeapon();
        this.refillHotbarWithPotions();
      } catch (err) {
        console.error('⚠️ Gapple error:', err.message);
      } finally {
        this.isHealing = false;
      }
      return;
    }

    // 3. Drinkable Potion fallback
    const drinkPot = items.find(i =>
      !i.name.includes('splash') && !i.name.includes('lingering') &&
      i.name.includes('potion') &&
      ((i.displayName || '').toLowerCase().includes('heal') || (i.displayName || '').toLowerCase().includes('regen'))
    );

    if (drinkPot) {
      this.isHealing = true;
      this.lastHealTime = now;
      try {
        await this.bot.equip(drinkPot, 'hand');
        this.bot.activateItem();
        const drinkStart = Date.now();
        while (Date.now() - drinkStart < 1650 && this.bot && this.pvpActive) {
          await sleep(100);
        }
        if (this.bot) this.bot.deactivateItem();
        await this.equipBestWeapon();
        this.refillHotbarWithPotions();
      } catch (err) {
      } finally {
        this.isHealing = false;
      }
    }
  }

  /**
   * Refills Splash Potions of Healing from upper inventory (slots 9-35)
   * into empty or exhausted hotbar slots (slots 37-42).
   * Replicates authentic competitive LT2 inventory management.
   */
  async refillHotbarWithPotions() {
    if (!this.bot || !this.bot.inventory || this.isRefillingInventory) return;
    if (this.isHealing) return;

    const inventory = this.bot.inventory;
    const hotbarSlots = [37, 38, 39, 40, 41, 42]; // Hotbar keys 2 through 7

    const refillNeededSlots = [];
    let currentHotbarPots = 0;

    for (const slotIndex of hotbarSlots) {
      const item = inventory.slots[slotIndex];
      if (!item) {
        refillNeededSlots.push(slotIndex);
      } else {
        const name = item.name.toLowerCase();
        const disp = (item.displayName || '').toLowerCase();
        const isHealPot = name.includes('splash') &&
          (name.includes('potion') || disp.includes('heal') || disp.includes('health') || disp.includes('regen'));
        if (isHealPot) {
          currentHotbarPots++;
        } else if (name.includes('bottle')) {
          refillNeededSlots.push(slotIndex);
        }
      }
    }

    // If hotbar has 4 or more splash potions and no slots need refill, skip
    if (currentHotbarPots >= 4 || refillNeededSlots.length === 0) return;

    // Scan main inventory (slots 9-35) for splash potions
    const availablePots = [];
    for (let s = 9; s <= 35; s++) {
      const item = inventory.slots[s];
      if (item) {
        const name = item.name.toLowerCase();
        const disp = (item.displayName || '').toLowerCase();
        const isHealPot = name.includes('splash') &&
          (name.includes('potion') || disp.includes('heal') || disp.includes('health') || disp.includes('regen'));
        if (isHealPot) {
          availablePots.push(s);
        }
      }
    }

    if (availablePots.length === 0) return;

    this.isRefillingInventory = true;
    console.log(`🎒 [POT REFILL] Opening inventory to refill ${refillNeededSlots.length} hotbar potion slots (${availablePots.length} pots remaining in inventory)...`);

    try {
      const slotsToFill = Math.min(refillNeededSlots.length, availablePots.length);
      for (let i = 0; i < slotsToFill; i++) {
        if (!this.bot || !this.bot.inventory) break;
        const targetSlot = refillNeededSlots[i];
        const sourceSlot = availablePots[i];

        // Toss out empty bottle if present in targetSlot
        if (inventory.slots[targetSlot] && inventory.slots[targetSlot].name.includes('bottle')) {
          await this.bot.clickWindow(targetSlot, 0, 0);
          await this.bot.clickWindow(-999, 0, 0);
          await sleep(40);
        }

        // Shift-click moves item directly into first available empty hotbar slot
        await this.bot.clickWindow(sourceSlot, 0, 1);
        await sleep(50);
      }
      console.log(`✅ [POT REFILL] Hotbar refilled with potions successfully!`);
    } catch (err) {
      console.log('⚠️ [POT REFILL] Refill warning:', err.message);
    } finally {
      this.isRefillingInventory = false;
    }
  }

  /**
   * High-tier Crystal PvP Cycling:
   * Delegates to authoritative CrystalPvPController with strict physical placement validation,
   * line-of-sight raycasting, non-blocking execution, and timeouts.
   */
  async handleCrystalPvP(target, dist) {
    if (!this.combatController || !this.combatController.cpvpController) return;
    const currentHealth = this.bot && this.bot.health != null ? this.bot.health : 20;
    const targetHealth = target && target.health != null ? target.health : null;
    await this.combatController.cpvpController.update(target, dist, currentHealth, targetHealth);
  }

  /**
   * Resilient Opponent Resolution:
   * 1. Exact username match in bot.players & bot.entities
   * 2. Substring / rank prefix-cleaned match
   * 3. Arena Duel Fallback: When in-match or PvP active, locks onto the opponent in the arena
   */
  findTargetEntity(targetUsername = null) {
    if (!this.bot || !this.bot.entities) return null;

    const cleanTarget = String(targetUsername || this.currentOpponent || '').toLowerCase().trim();

    if (cleanTarget) {
      // 1. Check exact username in bot.players
      for (const [name, p] of Object.entries(this.bot.players || {})) {
        if (name.toLowerCase() === cleanTarget && p.entity) {
          return p.entity;
        }
      }

      // 2. Check exact username in bot.entities
      for (const entity of Object.values(this.bot.entities)) {
        if (
          entity &&
          entity.type === 'player' &&
          entity.username &&
          entity.username.toLowerCase() === cleanTarget &&
          entity !== this.bot.entity
        ) {
          return entity;
        }
      }

      // 3. Substring match (handles server prefixes like [MVP+] or _ suffixes)
      for (const entity of Object.values(this.bot.entities)) {
        if (
          entity &&
          entity.type === 'player' &&
          entity.username &&
          entity !== this.bot.entity
        ) {
          const eName = entity.username.toLowerCase();
          if (eName.includes(cleanTarget) || cleanTarget.includes(eName)) {
            return entity;
          }
        }
      }
    }

    // 4. Active Match Arena Fallback:
    // In a 1v1 duel arena, any other player within 64m is the opponent
    if (this.matchState === 'in-match' || this.pvpActive) {
      let nearest = null;
      let minDist = Infinity;
      const botPos = this.bot.entity?.position;
      if (botPos) {
        for (const entity of Object.values(this.bot.entities)) {
          if (
            entity &&
            entity.type === 'player' &&
            entity !== this.bot.entity &&
            entity.position
          ) {
            const d = botPos.distanceTo(entity.position);
            if (d < minDist && d <= 64) {
              minDist = d;
              nearest = entity;
            }
          }
        }
      }
      if (nearest) {
        if (!this.currentOpponent && nearest.username) {
          this.currentOpponent = nearest.username;
        }
        return nearest;
      }
    }

    return null;
  }

  /**
   * Swings arm to ready up at gate without walking into blocks or digging.
   */
  async hitTheGate() {
    if (!this.bot || !this.bot.entity) return;
    console.log('⚡ Readying up: Left-click punching the gate to ready up...');
    try {
      for (let i = 0; i < 3; i++) {
        if (!this.bot) break;
        this.bot.swingArm('right');
        await sleep(150);
      }
    } catch {}
  }

  /**
  /**
   * Centralized Attack Scheduler:
   * Single authority over player attacks during combat.
   * Delegates to CombatController to guarantee mutual exclusion between combo hits and crits.
   */
  scheduleAttack(target, dist, isCooldownReady, now = Date.now()) {
    if (this.combatController) {
      if (!this.combatController.bot) this.combatController.setBot(this.bot, this.activeServerProfile);
      this.combatController.scheduleAttack(target, dist, isCooldownReady, now);
      this.comboHitsCount = this.combatController.comboCount;
      this.critHitsCount = this.combatController.critCount;
      this.lastAttackTime = this.combatController.lastAttackTime;
    }
  }

  /**
   * LT2 Competitive PvP Combat Engine:
   * - Authentic Keyboard WASD Simulation:
   *   * W Key: Forward pursuit
   *   * S Key: Backward spacing when opponent is inside 1.6m
   *   * A & D Keys: Dynamic 45-degree walk-strafing, dodging on hurt
   *   * Space Bar: Sprint-jump bunny hopping (7.1 blocks/s) in chase, and Crit Chaining in combat
   * - True 150% Crit Chaining:
   *   * Attacks STRICTLY when falling downward (vy < -0.04) from Space Bar jump apex
   *   * Crosshair locks onto opponent's head level (y + 1.62)
   *   * On landing, immediately taps Space Bar again to chain consecutive crits
   * - Rapid Double-Pot Healing to 19 HP in ~80ms without stopping movement
   */
  startCombatMovement(targetUsername = null) {
    this.stopCombatMovement();

    // Ensure pathfinder is completely stopped so it does not interfere or zero out velocity
    if (this.bot && this.bot.pathfinder) {
      try {
        this.bot.pathfinder.stop();
      } catch {}
    }

    if (this.movementController) {
      this.movementController.bot = this.bot;
      this.movementController.clearAllControls();
      this.movementController.setState('IDLE');
    }

    if (this.combatController) {
      this.combatController.setBot(this.bot, this.activeServerProfile);
      this.combatController.setGamemode(this.selectedGamemode);
      const target = this.findTargetEntity(targetUsername || this.currentOpponent || this.pvpTarget);
      if (target) {
        this.combatController.startCombat(target);
      }
    }

    this.currentProfile = this.combatController.profileManager
      ? this.combatController.profileManager.getActiveProfile()
      : getCombatProfile(this.selectedGamemode);
    this.combatState = 'APPROACH';
    this.isWtapping = false;
    this.isHealing = false;
    this.lastAttackTime = 0;
    this.lastHealTime = 0;
    this.lastTotemCheck = 0;
    this.lastCrystalActionTime = 0;
    this.prevTargetPos = null;

    // Reset Critical Hit & Combo State
    if (this.critController) {
      this.critController.bot = this.bot;
      this.critController.movementController = this.movementController;
      this.critController.reset();
    }
    this.combatPhase = 'COMBO';
    this.comboHitsCount = 0;
    this.critHitsCount = 0;
    this.targetComboHits = 2 + Math.floor(Math.random() * 2); // 2 to 3 hits
    this.targetCritHits = 1 + Math.floor(Math.random() * 2); // 1 to 2 crits

    // 1. Damage listeners for W-tapping and D-tapping
    this.entityHurtHandler = (entity) => {
      if (!this.pvpActive || !entity) return;
      const target = this.findTargetEntity(targetUsername || this.currentOpponent || this.pvpTarget);

      // Target was hurt by our hit -> W-tap sprint reset
      if (target && entity.id === target.id) {
        this.triggerWTap();
      }

      // Bot was hurt -> knockback recovery & emergency health potion from full inventory
      if (this.bot && this.bot.entity && entity.id === this.bot.entity.id) {
        this.movementController.handleKnockbackRecovery();
        this.ensureTotemInOffHand();
        if (this.bot.health != null && this.bot.health <= (this.potionManager.healThresholdHP || 10)) {
          this.potionManager.usePotion('HEALING', target);
        }
      }
    };
    this.bot.on('entityHurt', this.entityHurtHandler);

    // 2. Physics-tick combat loop (synchronous with 20 tps engine)
    this.physicsTickHandler = () => {
      // 1. DEAD / MATCH ENDED GUARD
      // The combat controller is the authoritative activity flag. Keeping
      // this in sync with pvpActive prevents a profile from being started
      // successfully while the physics loop immediately idles it.
      const combatRunning = Boolean(
        this.pvpActive ||
        (this.combatController && this.combatController.combatActive)
      );
      if (!this.bot || !combatRunning) {
        this.stopCombatMovement();
        return;
      }

      // Potion use blocks attacks inside the combat controller, but it must
      // not stop the physics loop: profiles still need movement/aim/recovery.
      const usingPotion = Boolean(this.potionManager && this.potionManager.isUsingPotion);

      const target = this.findTargetEntity(targetUsername || this.currentOpponent || this.pvpTarget);
      if (!target || !target.position) {
        this.movementController.setState('IDLE');
        this.combatState = 'OBSERVE';
        return;
      }

      const botPos = this.bot.entity.position;
      const targetPos = target.position;
      const dist = botPos.distanceTo(targetPos);
      const now = Date.now();
      const currentHealth = this.bot.health != null ? this.bot.health : 20;

      // 3. Off-hand Totem upkeep
      if (now - this.lastTotemCheck > 250) {
        this.lastTotemCheck = now;
        this.ensureTotemInOffHand();
      }

      // 4. Weapon selection & shield counter (FORBIDDEN during golden apple eating / healingActionLock!)
      const targetHoldingShield = target.heldItem?.name.includes('shield') ||
        (target.metadata && target.metadata[8] === 3);
      const isHealingLocked = Boolean(this.combatController && this.combatController.healingActionLock);
      const isEatingGapple = Boolean(this.potionManager && this.potionManager.isEating);
      if (!this.potionManager.isUsingPotion && !isHealingLocked && !isEatingGapple) {
        this.equipBestWeapon(targetHoldingShield && this.currentProfile.preferAxeAgainstShield);
      }

      // 5. Central Authoritative Combat Engine update (Phases, Attack Scheduling, Crits, Aiming, Movement, CPvP)
      this.combatController.update(target);
      this.combatState = this.combatController.phase;
      this.lastAttackTime = this.combatController.lastAttackTime;
      this.comboHitsCount = this.combatController.comboCount;
      this.critHitsCount = this.combatController.critCount;
    };

    this.bot.on('physicsTick', this.physicsTickHandler);
  }

  stopCombatMovement() {
    if (this.physicsTickHandler && this.bot) {
      this.bot.removeListener('physicsTick', this.physicsTickHandler);
      this.physicsTickHandler = null;
    }
    if (this.entityHurtHandler && this.bot) {
      this.bot.removeListener('entityHurt', this.entityHurtHandler);
      this.entityHurtHandler = null;
    }
    if (this.combatController) {
      this.combatController.stopCombat();
    }
    if (this.critController) {
      this.critController.reset();
    }
    if (this.movementController) {
      this.movementController.setState('IDLE');
      this.movementController.clearAllControls();
    }
    if (this.bot && this.bot.pathfinder) {
      try {
        this.bot.pathfinder.stop();
      } catch {}
    }
    this.combatState = 'IDLE';
  }

  setPvPTarget(username) {
    if (this.status !== 'online' || !this.bot) {
      return { success: false, message: '🔴 Minecraft bot is offline.' };
    }

    const cleanUsername = String(username || '').trim();
    this.pvpTarget = cleanUsername;

    if (this.pvpActive) {
      this.startCombatMovement(cleanUsername);
      return {
        success: true,
        message: `🎯 Target switched to **${cleanUsername}**. Engaging!`,
      };
    }

    return {
      success: true,
      message: `🎯 PvP target set to **${cleanUsername}**. Use \`/pvp start\` to engage!`,
    };
  }

  startPvP(targetUsername = null) {
    if (this.status !== 'online' || !this.bot) {
      return { success: false, message: '🔴 Minecraft bot is offline.' };
    }

    const targetName = targetUsername || this.currentOpponent || this.pvpTarget;
    if (!targetName) {
      return { success: false, message: '⚠️ No opponent designated.' };
    }

    this.pvpActive = true;
    this.currentOpponent = targetName;
    this.equipBestWeapon();
    this.startCombatMovement(this.currentOpponent);

    console.log(`⚔️ PvP started against real opponent: ${this.currentOpponent}`);

    return {
      success: true,
      message: `⚔️ PvP mode engaged! Attacking **${this.currentOpponent}**.`,
    };
  }

  stopPvP() {
    const wasActive = this.pvpActive;
    this.pvpActive = false;
    this.stopCombatMovement();

    if (this.bot && this.bot.pathfinder) {
      try {
        this.bot.pathfinder.stop();
      } catch {}
    }

    if (!wasActive) {
      return { success: false, message: '⚠️ PvP mode is not currently active.' };
    }

    return { success: true, message: '🛑 PvP training mode stopped.' };
  }

  /**
   * Challenges a specific player to a duel using server-configured mechanism.
   */
  async sendDuel(player, gamemode = null) {
    if (!player || typeof player !== 'string' || player.trim() === '') {
      return { success: false, message: '⚠️ Please specify a player username to duel.' };
    }
    const cleanPlayer = player.trim();

    // Guard: cannot duel while in match or combat
    if (this.state === 'MATCH' || this.state === 'COMBAT' || this.matchState === 'in-match') {
      return { success: false, message: '⚠️ Bot is currently in a match.' };
    }

    const profile = this.activeServerProfile || serverManager.getSelectedServer();
    if (!profile) {
      return { success: false, message: '❌ No server selected. Use `/server select <name>` or `/server add` first.' };
    }

    // Auto-connect if offline
    if (this.status !== 'online' || !this.bot) {
      console.log(`🔌 Connecting to selected server ${profile.name} before sending duel...`);
      const connResult = await this.connectAndWaitForSpawn(profile);
      if (!connResult.success) return connResult;
      await sleep(1000);
    }

    // Auto-navigate to practice if not in practice
    if (this.state !== 'PRACTICE' && !this.hasNavigatedToPractice) {
      console.log('🧭 Auto-navigating to Practice before sending duel...');
      await this.joinPractice();
      await sleep(1000);
    }

    if (gamemode) {
      this.selectedGamemode = gamemode;
      this.currentProfile = getCombatProfile(gamemode);
      if (this.combatController) {
        this.combatController.setProfile(gamemode);
      }
    }

    const cmdTemplate = profile.duelCommand || '/duel {player}';
    let duelCmd = cmdTemplate.replace('{player}', cleanPlayer);
    if (gamemode && !duelCmd.includes(gamemode.toLowerCase())) {
      duelCmd += ` ${gamemode.toLowerCase()}`;
    }

    console.log(`⚔️ Sending duel request to ${cleanPlayer}: "${duelCmd}"`);
    this.bot.chat(duelCmd);

    this.state = 'QUEUEING';
    this.matchState = 'preparing';
    this.currentOpponent = cleanPlayer;
    this.pvpTarget = cleanPlayer;
    this.queueActive = true;

    return {
      success: true,
      message: `⚔️ Sent duel request to **${cleanPlayer}**${gamemode ? ` (${gamemode})` : ''} via \`${duelCmd}\`! Waiting for match start...`
    };
  }

  /**
   * Accepts an incoming duel challenge from another player via Discord /duel accept <player>.
   */
  async acceptDuel(player) {
    if (!player || typeof player !== 'string' || player.trim() === '') {
      return { success: false, message: '⚠️ Please specify the player username whose duel request you want to accept.' };
    }
    const cleanPlayer = player.trim();
    const playerKey = cleanPlayer.toLowerCase();

    if (this.status !== 'online' || !this.bot) {
      return { success: false, message: '⚠️ Bot is not connected to any server.' };
    }

    if (this.state === 'MATCH' || this.state === 'COMBAT' || this.matchState === 'in-match') {
      return { success: false, message: '⚠️ Bot is currently in a match.' };
    }

    const pending = this.pendingDuelRequests.get(playerKey);
    if (!pending) {
      return { success: false, message: `⚠️ No pending duel request found from **${cleanPlayer}** (or it may have expired).` };
    }

    if (Date.now() > pending.expiresAt) {
      this.pendingDuelRequests.delete(playerKey);
      return { success: false, message: `⚠️ The duel request from **${cleanPlayer}** has expired.` };
    }

    // Auto-navigate to practice if not in practice
    if (this.state !== 'PRACTICE' && !this.hasNavigatedToPractice) {
      console.log('🧭 Auto-navigating to Practice before accepting duel...');
      await this.joinPractice();
      await sleep(1000);
    }

    // Remove from pending
    this.pendingDuelRequests.delete(playerKey);

    const acceptCmd = `/duel accept ${cleanPlayer}`;
    console.log(`⚔️ Accepting duel request from ${cleanPlayer}: "${acceptCmd}"`);
    this.bot.chat(acceptCmd);

    this.state = 'MATCH';
    this.matchState = 'preparing';
    this.currentOpponent = cleanPlayer;
    this.pvpTarget = cleanPlayer;
    if (pending.gamemode && pending.gamemode !== 'Unknown') {
      this.selectedGamemode = pending.gamemode;
      this.currentProfile = getCombatProfile(pending.gamemode);
      if (this.combatController) {
        this.combatController.setProfile(pending.gamemode);
      }
    }

    return {
      success: true,
      message: `⚔️ Accepted duel request from **${cleanPlayer}** (${pending.gamemode || 'Practice'})! Preparing for match...`
    };
  }

  /**
   * Starts queue process for a specific gamemode from Discord.
   */
  async startQueue(gamemode) {
    if (!gamemode || typeof gamemode !== 'string') {
      return { success: false, message: '⚠️ Please specify a gamemode to queue.' };
    }

    // Guard: cannot queue while in match or combat
    if (this.state === 'MATCH' || this.state === 'COMBAT' || this.matchState === 'in-match') {
      return { success: false, message: '⚠️ Bot is currently in a match.' };
    }

    const profile = this.activeServerProfile || serverManager.getSelectedServer();
    if (!profile) {
      return { success: false, message: '❌ No server selected. Use `/server select <name>` or `/server add` first.' };
    }

    // Auto-connect if offline
    if (this.status !== 'online' || !this.bot) {
      console.log(`🔌 Connecting to selected server ${profile.name} before queueing...`);
      const connResult = await this.connectAndWaitForSpawn(profile);
      if (!connResult.success) return connResult;
      await sleep(1000);
    }

    // Auto-navigate to practice if not in practice
    if (this.state !== 'PRACTICE' && !this.hasNavigatedToPractice) {
      console.log('🧭 Auto-navigating to Practice before queueing...');
      await this.joinPractice();
      await sleep(1000);
    }

    // Match kit from KIT_CONFIG or aliases
    let resolvedGamemode = gamemode.trim();
    if (profile.gamemodeAliases && profile.gamemodeAliases[resolvedGamemode]) {
      resolvedGamemode = profile.gamemodeAliases[resolvedGamemode];
    } else {
      // Case-insensitive match against KIT_CONFIG keys
      const matchedKey = Object.keys(KIT_CONFIG).find(
        k => k.toLowerCase() === resolvedGamemode.toLowerCase()
      );
      if (matchedKey) resolvedGamemode = matchedKey;
    }

    this.queueActive = true;
    this.queueConfirmed = false;
    this.queueStartedAt = Date.now();
    this.selectedGamemode = resolvedGamemode;
    this.currentProfile = getCombatProfile(resolvedGamemode);
    if (this.combatController) {
      this.combatController.setProfile(resolvedGamemode);
    }
    this.state = 'QUEUEING';
    this.matchState = 'preparing';
    this.currentOpponent = null;

    console.log(`🎮 Queueing for ${resolvedGamemode} on ${profile.name} (queueMethod: ${profile.queueMethod || 'gui'})...`);

    if (profile.queueMethod === 'command') {
      const cmdTemplate = profile.queueCommand || '/queue {gamemode}';
      const queueCmd = cmdTemplate.replace('{gamemode}', resolvedGamemode.toLowerCase());
      console.log(`💬 Sending queue command: ${queueCmd}`);
      this.bot.chat(queueCmd);
    } else {
      await this.executeQueueAction(resolvedGamemode);
    }

    // Do not claim the server accepted the queue unless the server actually
    // confirms it through chat/match state. The command/UI action can be sent
    // successfully while the server rejects it or the GUI click misses.
    if (this.queueConfirmed || this.matchState === 'in-match' || this.currentOpponent) {
      return {
        success: true,
        message: `📥 Queue confirmed for **${resolvedGamemode}** on **${profile.name}**. Waiting for a match...`,
      };
    }

    return {
      success: true,
      message: `📤 Queue request sent for **${resolvedGamemode}** on **${profile.name}**. Server confirmation is still pending — check \`/status\` or Minecraft chat.`,
    };
  }

  /**
   * Opens the "Select Kit : 1v1" GUI and clicks the chosen kit slot.
   */
  async executeQueueAction(gamemode) {
    if (!this.bot) return;

    const profile = this.activeServerProfile || serverManager.getSelectedServer();
    const kitData = KIT_CONFIG[gamemode];
    const targetSlot = kitData ? kitData.slot : (profile.queueSlot !== undefined ? profile.queueSlot : 0);

    console.log(`🎮 Executing GUI queue for ${gamemode} (slot: ${targetSlot})...`);

    const clickKitSlot = async (window) => {
      console.log(`📋 Kit Selection GUI active: "${getCleanTitle(window) || 'Select Kit'}"`);
      await sleep(500);

      console.log(`🖱️ Clicking kit "${gamemode}" in slot ${targetSlot}...`);
      try {
        await this.bot.clickWindow(targetSlot, 0, 0);
        console.log(`✅ Clicked kit "${gamemode}"! Waiting for real opponent...`);
      } catch (err) {
        console.error(`❌ Failed to click kit slot ${targetSlot}:`, err.message);
      }
    };

    const currentTitle = getCleanTitle(this.bot.currentWindow);
    if (this.bot.currentWindow && currentTitle && (currentTitle.includes('kit') || currentTitle.includes('1v1') || currentTitle.includes('select'))) {
      await clickKitSlot(this.bot.currentWindow);
      return;
    }

    const onWindowOpen = async (window) => {
      await clickKitSlot(window);
    };

    this.bot.once('windowOpen', onWindowOpen);
    setTimeout(() => {
      if (this.bot) this.bot.removeListener('windowOpen', onWindowOpen);
    }, 12000);

    // Hotbar queue item (slot index from profile, default 0 for diamond sword)
    const queueSlotIdx = (profile && profile.queueSlot !== undefined) ? profile.queueSlot : 0;
    console.log(`🗡️ Activating Hotbar Queue slot index ${queueSlotIdx}...`);
    this.bot.setQuickBarSlot(queueSlotIdx);
    await sleep(350);
    this.bot.activateItem();

    // Chat fallback after 3.5s if window does not open
    setTimeout(() => {
      const openTitle = getCleanTitle(this.bot.currentWindow);
      if (this.queueActive && (!openTitle || !openTitle.includes('kit'))) {
        console.log(`💬 Trying chat command fallback: /queue ${gamemode.toLowerCase()}...`);
        this.bot.chat(`/queue ${gamemode.toLowerCase()}`);
      }
    }, 3500);
  }

  /**
   * Safely cancels queue, duel request, active combat, and Practice navigation.
   * Clears all movement controls (WASD, sprint, jump).
   */
  leave() {
    if (this.status !== 'online' || !this.bot) {
      this.state = 'IDLE';
      return { success: true, message: '🛑 Bot is offline. All actions cleared.' };
    }

    console.log('🛑 [LEAVE] Cancelling queue, duel, combat, and clearing all movement controls...');

    // 1. Cancel active match / queue state
    this.queueActive = false;
    this.queueConfirmed = false;
    this.queueStartedAt = 0;
    this.pvpActive = false;
    this.matchState = 'idle';
    this.currentOpponent = null;
    this.selectedGamemode = null;

    if (this.gateCountdownTimeout) {
      clearTimeout(this.gateCountdownTimeout);
      this.gateCountdownTimeout = null;
    }

    // 2. Stop combat loops and listeners
    this.stopCombatMovement();
    if (this.bot.pathfinder) {
      try {
        this.bot.pathfinder.stop();
      } catch {}
    }

    // 3. Clear ALL movement control states on MovementController
    if (this.movementController) {
      this.movementController.clearAllControls();
      this.movementController.setState('IDLE');
    }

    // 4. Send /leave command to server
    try {
      this.bot.chat('/leave');
    } catch {}

    // 5. Reset state to PRACTICE
    this.state = 'PRACTICE';

    return {
      success: true,
      message: '🛑 Safely left queue/match. Movement halted, controls cleared, returned to Practice state.'
    };
  }

  stopQueue() {
    return this.leave();
  }

  leaveServer() {
    if (this.status === 'offline' && !this.bot) {
      return { success: false, message: '⚠️ Bot is not connected to any server.' };
    }
    this.stop();
    return { success: true, message: '🔌 Disconnected from Minecraft server.' };
  }

  leaveQueue() {
    if (this.status !== 'online' || !this.bot) {
      return { success: false, message: '⚠️ Bot is not connected to any server.' };
    }
    if (!this.queueActive && this.state !== 'QUEUEING') {
      return { success: false, message: '⚠️ Bot is not currently in a queue.' };
    }
    this.queueActive = false;
    if (this.state === 'QUEUEING') {
      this.state = 'PRACTICE';
    }
    try {
      this.bot.chat('/leave');
    } catch {}
    return { success: true, message: '🚪 Left queue successfully.' };
  }

  leaveDuel() {
    if (this.status !== 'online' || !this.bot) {
      return { success: false, message: '⚠️ Bot is not connected to any server.' };
    }
    if (this.matchState !== 'in-match' && this.matchState !== 'preparing' && this.state !== 'MATCH' && this.state !== 'COMBAT') {
      return { success: false, message: '⚠️ Bot is not currently in a match or duel.' };
    }
    this.leave();
    return { success: true, message: '🛑 Forfeited and left active duel.' };
  }

  /**
   * Begins match against confirmed real opponent.
   */
  beginMatch(opponentName) {
    if (!opponentName || this.matchState === 'in-match') return;

    this.matchState = 'in-match';
    this.state = 'COMBAT';
    this.currentOpponent = opponentName;
    this.queueActive = false;

    if (this.gateCountdownTimeout) {
      clearTimeout(this.gateCountdownTimeout);
      this.gateCountdownTimeout = null;
    }

    // Detect gamemode from held items / inventory if not yet set
    if (!this.selectedGamemode && this.bot && this.bot.inventory) {
      const items = this.bot.inventory.items().map(i => i.name);
      if (items.some(n => n.includes('crystal'))) this.selectedGamemode = 'CrystalPVP';
      else if (items.some(n => n.includes('firework_rocket') || (n.includes('elytra') && n.includes('mace')))) this.selectedGamemode = 'MaceRocket';
      else if (items.some(n => n.includes('spear') && n.includes('elytra'))) this.selectedGamemode = 'SpearElytra';
      else if (items.some(n => n.includes('spear') && n.includes('mace'))) this.selectedGamemode = 'SpearMace';
      else if (items.some(n => n.includes('mace'))) this.selectedGamemode = 'MacePVP';
      else if (items.some(n => n.includes('axe'))) this.selectedGamemode = 'Axe';
      else if (items.some(n => n.includes('bow'))) this.selectedGamemode = 'Bow';
      else if (items.some(n => n.includes('netherite'))) this.selectedGamemode = 'NethPot';
    }

    this.currentProfile = getCombatProfile(this.selectedGamemode);
    if (this.combatController) {
      this.combatController.setProfile(this.selectedGamemode);
      this.combatController.preflight().then(check => {
        if (!check.success) {
          const warningMsg = `⚠️ ${check.profile || this.selectedGamemode} profile requirements not fully detected: ${check.missing.join(', ')}. Combat will still start; missing items may disable only the affected tactic.`;
          console.warn(`[PREFLIGHT] ${warningMsg}`);
          this.emit('profileWarning', {
            profile: check.profile || this.selectedGamemode,
            missing: check.missing,
            message: warningMsg
          });
        }
      }).catch(err => {
        console.error('[PREFLIGHT] Check error:', err.message);
      });
    }

    console.log(`⚔️ Match STARTED against REAL opponent: ${opponentName} [Kit: ${this.selectedGamemode || 'Practice'}, Profile: ${this.currentProfile.name}]!`);
    this.emit('matchStarted', {
      opponent: opponentName,
      gamemode: this.selectedGamemode,
    });

    // Ensure hotbar is fully stocked with potions before engagement
    this.refillHotbarWithPotions();

    // Start grounded. Jump behavior is owned by the active PvP profile.
    // Sword specifically uses jump-reset only after incoming damage.
    if (this.movementController) {
      this.movementController.setState('CHASE');
    }

    this.startPvP(opponentName);
  }

  /**
   * Concludes the current match cleanly and resets state to Practice/idle.
   */
  concludeMatch(resultMsg) {
    if (this.matchState === 'idle' && !this.pvpActive && this.state !== 'COMBAT' && this.state !== 'MATCH') return;

    const endedOpponent = this.currentOpponent;
    const endedGamemode = this.selectedGamemode;

    if (this.gateCountdownTimeout) {
      clearTimeout(this.gateCountdownTimeout);
      this.gateCountdownTimeout = null;
    }

    this.stopPvP();
    this.queueActive = false;
    this.queueConfirmed = false;
    this.queueStartedAt = 0;
    this.matchState = 'idle';
    this.state = 'MATCH_END';
    this.currentOpponent = null;
    this.selectedGamemode = null;

    if (this.movementController) {
      this.movementController.clearAllControls();
      this.movementController.setState('IDLE');
    }

    console.log(`🏁 Match ended: ${resultMsg} (Opponent: ${endedOpponent || 'Unknown'})`);

    this.emit('matchEnded', {
      result: resultMsg,
      opponent: endedOpponent,
      gamemode: endedGamemode,
    });

    // Automatically transition back to PRACTICE state
    setTimeout(() => {
      if (this.status === 'online' && this.state === 'MATCH_END') {
        this.state = 'PRACTICE';
      }
    }, 1500);
  }

  /**
   * Safe Arena Watcher:
   * ONLY checks if the bot returned to the lobby while in-match to cleanly conclude the match.
   * NEVER starts matches on its own!
   */
  startArenaWatcher() {
    this.stopArenaWatcher();

    this.arenaWatcherInterval = setInterval(() => {
      if (!this.bot || this.status !== 'online') {
        this.stopArenaWatcher();
        return;
      }

      // Only monitor active matches
      if ((this.matchState === 'in-match' || this.state === 'COMBAT') && this.currentOpponent) {
        if (!this.pvpActive) {
          const target = this.findTargetEntity(this.currentOpponent);
          if (target) {
            this.startPvP(this.currentOpponent);
          }
        }

        // Check if returned to lobby spawn
        if (this.lobbyPosition && this.bot.entity && this.bot.entity.position) {
          const distToLobby = this.bot.entity.position.distanceTo(this.lobbyPosition);
          if (distToLobby < 15) {
            console.log('📍 Bot returned to practice lobby. Concluding match.');
            this.concludeMatch('Match ended (returned to lobby)');
          }
        }
      }
    }, 1000);
  }

  stopArenaWatcher() {
    if (this.arenaWatcherInterval) {
      clearInterval(this.arenaWatcherInterval);
      this.arenaWatcherInterval = null;
    }
  }

  /**
   * Evaluates server chat messages to detect REAL matches, kits, opponents, wins, and losses.
   */
  handleChatMessage(text) {
    const lower = text.toLowerCase();

    // 0. Auto-Register & Auto-Login Trigger for cracked/auth servers
    const password = process.env.MC_PASSWORD || 'hackerrr';
    if (lower.includes('not registered') || lower.includes('/register') || lower.includes('please register') || lower.includes('use /register')) {
      if (this.bot && this.status === 'online') {
        console.log('📝 Server requested registration. Registering with /register...');
        this.bot.chat(`/register ${password} ${password}`);
        setTimeout(() => {
          if (this.bot && this.status === 'online' && !this.hasNavigatedToPractice) {
            this.joinPractice();
          }
        }, 2000);
      }
    } else if (lower.includes('please login') || lower.includes('use /login') || lower.includes('/login <password>')) {
      if (this.bot && this.status === 'online') {
        console.log('🔑 Server requested login. Logging in with /login...');
        this.bot.chat(`/login ${password}`);
      }
    }

    // 1. Ready-up gate trigger
    if (lower.includes('hit the gate') || lower.includes('ready up') || lower.includes('to ready')) {
      this.state = 'MATCH';
      this.hitTheGate();

      // If real opponent is confirmed, start duel when cage drops (~3.5s)
      if (this.currentOpponent && this.matchState === 'preparing') {
        if (this.gateCountdownTimeout) clearTimeout(this.gateCountdownTimeout);
        this.gateCountdownTimeout = setTimeout(() => {
          if (this.matchState === 'preparing' && this.currentOpponent) {
            console.log('⏱️ Gate drop countdown finished! Starting combat against', this.currentOpponent);
            this.beginMatch(this.currentOpponent);
          }
        }, 3500);
      }
    }

    // 2. Extract kit if mentioned in queue or duel start
    const kitMatch = text.match(/(?:kit|joined queue for)\s*[:]?\s*([a-zA-Z0-9_ ]+)/i);
    if (kitMatch && kitMatch[1]) {
      const matchedKit = kitMatch[1].trim();
      for (const kitName of Object.keys(KIT_CONFIG)) {
        if (matchedKit.toLowerCase().includes(kitName.toLowerCase())) {
          this.selectedGamemode = kitName;
          console.log(`🎮 Gamemode identified: ${kitName}`);
          break;
        }
      }
    }

    // 2b. Queue confirmation: only mark the queue as real when the server
    // explicitly indicates that the bot joined/entered/is searching.
    const queueConfirmationPatterns = [
      'joined queue',
      'entered queue',
      'queue joined',
      'now in queue',
      'in the queue',
      'searching for a match',
      'searching for opponent',
      'waiting for opponent',
      'queued for',
      'queueing for',
      'matchmaking'
    ];
    if (this.queueActive && queueConfirmationPatterns.some(p => lower.includes(p))) {
      this.queueConfirmed = true;
      this.state = 'QUEUEING';
      this.matchState = 'preparing';
      console.log(`✅ Queue confirmed by server: ${text}`);
    }

    // 3. Extract REAL opponent: ONLY from server Duels messages
    if (
      lower.includes('opponent:') ||
      (lower.includes('duels') && (lower.includes('opponent') || lower.includes('match found')))
    ) {
      const oppMatch = text.match(/(?:opponent|dueling|against)\s*[:]?\s*([a-zA-Z0-9_]+)/i);
      if (oppMatch && oppMatch[1]) {
        const detected = oppMatch[1].trim();
        const botName = this.bot ? this.bot.username.toLowerCase() : '';
        if (detected.toLowerCase() !== botName) {
          this.currentOpponent = detected;
          this.matchState = 'preparing';
          this.state = 'MATCH';
          console.log(`🎯 Real opponent identified from server: ${this.currentOpponent}`);
        }
      }
    }

    // 4. Match start triggers
    if (
      lower.includes('the match has started') ||
      lower.includes('the duel has begun') ||
      lower.includes('match started') ||
      lower.includes('starting duel') ||
      (lower.includes('fight!') && (this.matchState === 'preparing' || this.currentOpponent))
    ) {
      if (this.currentOpponent && this.matchState !== 'in-match') {
        this.beginMatch(this.currentOpponent);
      }
    }

    // 5. Match end triggers
    if (
      lower.includes('winner:') ||
      lower.includes('winners:') ||
      lower.includes('won the match') ||
      lower.includes('won the duel') ||
      lower.includes('lost the duel') ||
      lower.includes('match finished') ||
      lower.includes('has won against') ||
      lower.includes('has won the duel') ||
      lower.includes('won against') ||
      lower.includes('has defeated') ||
      lower.includes('victory!') ||
      lower.includes('defeat!') ||
      lower.includes('match ended') ||
      lower.includes('match summary')
    ) {
      const botName = this.bot ? this.bot.username.toLowerCase() : '';
      const isRelevant = (this.matchState === 'in-match' || this.matchState === 'preparing' || this.state === 'COMBAT') && (
        lower.includes('you lost') ||
        lower.includes('you won') ||
        (botName && lower.includes(botName)) ||
        (this.currentOpponent && lower.includes(this.currentOpponent.toLowerCase())) ||
        lower.includes('match summary') ||
        lower.includes('match ended')
      );

      if (isRelevant) {
        console.log('🏆 Match concluded from chat:', text);
        const isWinner = lower.includes('winners: ' + botName) ||
                         lower.includes('you won the duel') ||
                         (botName && lower.includes(botName) && lower.includes('won'));
        const resultMsg = isWinner ? '🏆 Bot WON the match!' : '💀 Bot LOST the match.';
        this.concludeMatch(resultMsg);
      }
    }

    // 6. Practice lobby confirmation
    if (lower.includes('you are already connected to this server') ||
        lower.includes('connected to practice') ||
        lower.includes('joined practice') ||
        lower.includes('practice lobby')) {
      this.hasNavigatedToPractice = true;
      this.state = 'PRACTICE';
      if (this.bot && this.bot.entity) {
        this.lobbyPosition = this.bot.entity.position.clone();
      }
    }

    // 7. Incoming duel request detection
    if (!lower.includes('you have sent') && !lower.includes('duel request sent') && !lower.includes('you sent a duel')) {
      const duelPatterns = [
        // Pattern A: Player name before invitation verb phrase
        /([a-zA-Z0-9_]{3,16})\s*(?:has sent you a duel request|has requested to duel you|has challenged you to a duel|sent you a duel request|invited you to a duel|wants to duel you)(?:\s*(?:in|for|with kit|\()([a-zA-Z0-9_ ]+))?/i,
        // Pattern B: Player name after invitation phrase
        /(?:duel request from|invited you to a duel from|invitation from)\s*[:]?\s*([a-zA-Z0-9_]{3,16})(?:\s*(?:in|for|with kit|\()([a-zA-Z0-9_ ]+))?/i,
        // Pattern C: /duel accept <player> prompt
        /(?:type|click)\s*[:]?\s*\/duel accept\s+([a-zA-Z0-9_]{3,16})/i
      ];

      const invalidNames = ['in', 'for', 'with', 'kit', 'click', 'here', 'type', 'to', 'accept', 'the'];

      for (const pattern of duelPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          const challenger = match[1].trim();
          const botName = this.bot ? this.bot.username.toLowerCase() : '';
          if (
            challenger.toLowerCase() !== botName &&
            !invalidNames.includes(challenger.toLowerCase())
          ) {
            let kit = match[2] ? match[2].replace(/[\)\.\!]/g, '').trim() : 'Unknown';
            for (const kitName of Object.keys(KIT_CONFIG)) {
              if (lower.includes(kitName.toLowerCase())) {
                kit = kitName;
                break;
              }
            }
            const serverName = this.activeServerProfile ? this.activeServerProfile.name : 'Current Server';
            const expiresAt = Date.now() + 60000;
            this.pendingDuelRequests.set(challenger.toLowerCase(), {
              player: challenger,
              gamemode: kit,
              server: serverName,
              receivedAt: Date.now(),
              expiresAt
            });
            console.log(`📩 Incoming duel request from ${challenger} for ${kit} on ${serverName}!`);
            this.emit('incomingDuelRequest', {
              challenger,
              gamemode: kit,
              server: serverName,
              expiresAt
            });
            break;
          }
        }
      }
    }
  }

  /**
   * Connects bot to selected server profile.
   * Enforces single active connection: gracefully shuts down any existing connection.
   */
  start(serverProfile = null) {
    if (this.status === 'connecting') {
      return { success: false, message: '⚠️ Minecraft bot is currently attempting to connect.' };
    }

    const profile = serverProfile || serverManager.getSelectedServer();
    if (!profile) {
      return { success: false, message: '❌ No Minecraft server selected. Use `/server select <name>` or `/server add`.' };
    }

    // Check single-instance: if already online
    if (this.status === 'online' && this.bot) {
      // If connected to the EXACT same server, don't duplicate
      if (this.activeServerProfile &&
          this.activeServerProfile.host === profile.host &&
          this.activeServerProfile.port === profile.port) {
        return { success: false, message: `⚠️ Minecraft bot is already connected to **${profile.name}** (${profile.host}:${profile.port}).` };
      }
      // Otherwise, safely disconnect old server first!
      console.log(`🔄 Switching server from ${this.activeServerProfile ? this.activeServerProfile.name : 'previous'} to ${profile.name}. Disconnecting old session...`);
      this.stop();
    }

    const host = profile.host;
    const port = profile.port || 25565;
    const username = process.env.MC_USERNAME;
    const auth = process.env.MC_AUTH || 'offline';

    if (!host || !username) {
      return {
        success: false,
        message: '❌ Minecraft configuration is incomplete. MC_USERNAME must be set in .env.',
      };
    }

    this.status = 'connecting';
    this.state = 'IDLE';
    this.activeServerProfile = profile;
    this.hasNavigatedToPractice = false;

    try {
      this.bot = mineflayer.createBot({
        host,
        port,
        username,
        auth,
        ...(profile.version ? { version: profile.version } : (process.env.MC_VERSION ? { version: process.env.MC_VERSION } : {})),
      });

      this.bot.loadPlugin(pathfinder);

      this.bot.once('spawn', () => {
        this.status = 'online';
        this.state = 'CONNECTED';
        console.log(`✅ Minecraft bot spawned in server "${profile.name}" (${host}:${port}) successfully.`);
        this.emit('spawn');

        // Auto-login / Auto-register with password
        const password = process.env.MC_PASSWORD || 'hackerrr';
        setTimeout(() => {
          if (this.bot && this.status === 'online') {
            console.log('🔑 Auto-authenticating with /login & /register...');
            this.bot.chat(`/login ${password}`);
            setTimeout(() => {
              if (this.bot && this.status === 'online') {
                this.bot.chat(`/register ${password} ${password}`);
              }
            }, 800);
          }
        }, 1500);

        // Start safe arena watcher
        this.startArenaWatcher();
      });

      this.bot.on('message', (msg) => {
        const text = msg.toString().trim();
        if (text) {
          console.log(`[CHAT]: ${text}`);
          this.handleChatMessage(text);
        }
      });

      this.bot.on('stoppedAttacking', () => {
        if (this.pvpActive) {
          console.log('⚔️ Stopped attacking.');
          this.pvpActive = false;
          if (this.state === 'COMBAT') {
            this.state = 'MATCH';
          }
        }
      });

      this.bot.on('playerLeft', (player) => {
        if (this.currentOpponent && player.username.toLowerCase() === this.currentOpponent.toLowerCase()) {
          console.log(`⚠️ Opponent ${player.username} left the match.`);
          this.concludeMatch(`⚠️ Opponent ${player.username} disconnected.`);
        }
      });

      this.bot.on('death', () => {
        console.log('💀 Bot died.');
        if (this.state === 'COMBAT' || this.matchState === 'in-match') {
          this.concludeMatch('💀 Bot died in match.');
        } else {
          this.stopPvP();
        }
      });

      this.bot.on('kicked', (reason) => {
        const reasonText = parseMinecraftChat(reason) || 'Disconnected by server';
        console.log('⚠️ Minecraft bot was kicked:', reasonText);
        this.emit('kicked', reasonText);
        this.cleanup();
      });

      this.bot.on('end', (reason) => {
        console.log('🔴 Minecraft bot disconnected.');
        this.emit('end', reason);
        this.cleanup();
      });

      this.bot.on('error', (err) => {
        console.error('❌ Minecraft bot connection error:', err.message);
        this.emit('error', err);
        this.cleanup();
      });

      return { success: true, message: `⏳ Connecting to **${profile.name}** (${host}:${port})...` };
    } catch (error) {
      this.cleanup();
      return {
        success: false,
        message: `❌ Failed to initialize Minecraft bot: ${error.message}`,
      };
    }
  }

  /**
   * Safely disconnects bot.
   */
  stop() {
    if (this.status === 'offline' && !this.bot) {
      this.state = 'IDLE';
      return { success: false, message: '⚠️ Minecraft bot is already offline.' };
    }

    this.state = 'DISCONNECTING';
    this.leave();

    if (this.bot) {
      try {
        this.bot.quit();
      } catch {}
    }
    this.cleanup();
    return { success: true, message: '🔴 Minecraft bot disconnected safely.' };
  }

  getPlayers() {
    if (this.status !== 'online' || !this.bot) {
      return { success: false, message: '🔴 Minecraft bot is offline.' };
    }

    const playerList = Object.keys(this.bot.players || {});
    return {
      success: true,
      count: playerList.length,
      players: playerList,
    };
  }

  sendChat(message) {
    if (this.status !== 'online' || !this.bot) {
      return { success: false, message: '🔴 Minecraft bot is offline.' };
    }

    const cleanMessage = String(message || '').replace(/[\r\n]+/g, ' ').trim();
    if (!cleanMessage) {
      return { success: false, message: '⚠️ Cannot send an empty chat message.' };
    }

    if (process.env.DISCORD_TOKEN && cleanMessage.includes(process.env.DISCORD_TOKEN)) {
      return { success: false, message: '❌ Message rejected: contains sensitive token.' };
    }

    try {
      this.bot.chat(cleanMessage);
      return { success: true, message: `💬 Sent to Minecraft: "${cleanMessage}"` };
    } catch (error) {
      return { success: false, message: `❌ Failed to send message: ${error.message}` };
    }
  }

  cleanup() {
    this.status = 'offline';
    this.state = 'IDLE';
    this.pvpActive = false;
    this.queueActive = false;
    this.matchState = 'idle';
    this.currentOpponent = null;
    this.hasNavigatedToPractice = false;
    this.lobbyPosition = null;
    if (this.gateCountdownTimeout) {
      clearTimeout(this.gateCountdownTimeout);
      this.gateCountdownTimeout = null;
    }
    this.stopCombatMovement();
    this.stopArenaWatcher();
    if (this.movementController) {
      this.movementController.clearAllControls();
      this.movementController.setState('IDLE');
    }
    if (this.potionManager) {
      this.potionManager.bot = null;
      this.potionManager.isUsingPotion = false;
    }
    this.bot = null;
  }
}

const mcManager = new MinecraftBotManager();
mcManager.MinecraftBotManager = MinecraftBotManager;

module.exports = mcManager;
