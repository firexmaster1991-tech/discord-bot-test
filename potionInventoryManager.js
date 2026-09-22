const { Vec3 } = require('vec3');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Dedicated Potion Inventory Manager for Mineflayer PvP Bot.
 * 
 * Features:
 * 1. Searches the COMPLETE Minecraft inventory (no hardcoded slot numbers).
 * 2. Distinguishes HOTBAR, MAIN INVENTORY, and OTHER ACCESSIBLE INVENTORY SLOTS.
 * 3. Moves/swaps potions from main inventory into hotbar using legitimate Mineflayer inventory actions.
 * 4. Confirms that the potion is accessible in the hotbar before attempting use.
 * 5. Calculates dynamic downward pitch at ground beneath/near feet factoring in velocity.
 * 6. Throws/uses potion, verifies consumption, and restores previous weapon/hotbar slot.
 * 7. Enforces strict survival priority: at low health, ONLY healing potions are selected and buffs are gated out.
 * 8. Evaluates opponent punish distance before healing.
 * 9. Tracks active buff durations to prevent wasting potions.
 */
class PotionInventoryManager {
  constructor(bot = null, options = {}) {
    this.bot = bot;
    this.healThresholdHP = options.healThresholdHP !== undefined ? options.healThresholdHP : 10; // 10 HP = 5 hearts
    this.punishDistanceThreshold = options.punishDistanceThreshold || 2.0; // Opponent within 2 blocks can punish
    this.isUsingPotion = false;
    this.lastPotionTime = 0;
    this.potionCooldownMs = 600; // Minimum delay between potion usages
    this.previousQuickBarSlot = 0;

    // Configurable reserved hotbar slots for fast zero-delay combat access
    this.reservedSlots = options.reservedSlots || {
      weaponQuickbar: 0,   // Hotbar 0 (Slot 36)
      healingQuickbar: 1,  // Hotbar 1 (Slot 37)
      strengthQuickbar: 2, // Hotbar 2 (Slot 38)
      speedQuickbar: 3     // Hotbar 3 (Slot 39)
    };

    // Potion operation mutex lock preventing concurrent inventory transfer collisions
    this.potionOperationLock = false;

    // Track active buffs locally (expiresAt timestamp and amplifier level)
    this.activeBuffs = {
      strength: { expiresAt: 0, level: 0 },
      speed: { expiresAt: 0, level: 0 }
    };

    // Track exact timestamps when buffs ran off / expired
    this.strengthExpiredAt = 0;
    this.speedExpiredAt = 0;
    this.wasStrengthActive = false;
    this.wasSpeedActive = false;

    // Golden apple eating state
    this.isEating = false;
    this.healingActionLock = false;
    this.lastEatTime = 0;

    if (this.bot) {
      this.attachBotListeners();
    }
  }

  attachBotListeners() {
    if (!this.bot || typeof this.bot.on !== 'function') return;

    this.bot.on('entityEffect', (entity, effect) => {
      if (this.bot && this.bot.entity && entity.id === this.bot.entity.id) {
        this.handleEffectApplied(effect);
      }
    });

    this.bot.on('entityEffectEnd', (entity, effect) => {
      if (this.bot && this.bot.entity && entity.id === this.bot.entity.id) {
        this.handleEffectExpired(effect);
      }
    });
  }

  handleEffectApplied(effect) {
    const now = Date.now();
    const durationMs = (effect.duration || 0) * 50; // duration in ticks -> ms
    const expiresAt = now + durationMs;

    const id = effect.id;
    if (id === 1 || id === 'speed' || id === 'swiftness') {
      this.activeBuffs.speed = { expiresAt, level: (effect.amplifier || 0) + 1 };
      this.wasSpeedActive = true;
      console.log(`⚡ [POTION] Speed buff active until ${new Date(expiresAt).toLocaleTimeString()} (Level ${this.activeBuffs.speed.level})`);
    } else if (id === 5 || id === 'strength') {
      this.activeBuffs.strength = { expiresAt, level: (effect.amplifier || 0) + 1 };
      this.wasStrengthActive = true;
      console.log(`💪 [POTION] Strength buff active until ${new Date(expiresAt).toLocaleTimeString()} (Level ${this.activeBuffs.strength.level})`);
    }
  }

  handleEffectExpired(effect) {
    const now = Date.now();
    const id = effect.id;
    if (id === 1 || id === 'speed' || id === 'swiftness') {
      this.activeBuffs.speed = { expiresAt: 0, level: 0 };
      this.speedExpiredAt = now;
      this.wasSpeedActive = false;
      console.log('⚡ [POTION] Speed buff expired. 2-second post-expiry delay begins before re-potting.');
    } else if (id === 5 || id === 'strength') {
      this.activeBuffs.strength = { expiresAt: 0, level: 0 };
      this.strengthExpiredAt = now;
      this.wasStrengthActive = false;
      console.log('💪 [POTION] Strength buff expired. 2-second post-expiry delay begins before re-potting.');
    }
  }

  /**
   * Helper to get inventory boundaries dynamically from bot.inventory.
   */
  getInventoryBounds() {
    const inv = this.bot && this.bot.inventory;
    const hotbarStart = inv && inv.hotbarStart !== undefined ? inv.hotbarStart : 36;
    const inventoryStart = inv && inv.inventoryStart !== undefined ? inv.inventoryStart : 9;
    const totalSlots = inv && inv.slots ? inv.slots.length : 45;

    return {
      hotbarStart,
      inventoryStart,
      totalSlots,
      hotbarSlots: Array.from({ length: 9 }, (_, i) => hotbarStart + i),
      mainSlots: Array.from({ length: hotbarStart - inventoryStart }, (_, i) => inventoryStart + i)
    };
  }

  /**
   * Classifies an inventory slot into: 'HOTBAR', 'MAIN INVENTORY', or 'OTHER ACCESSIBLE INVENTORY SLOTS'.
   */
  getLocationForSlot(slotIndex) {
    const { hotbarStart, inventoryStart, totalSlots } = this.getInventoryBounds();
    if (slotIndex >= hotbarStart && slotIndex < hotbarStart + 9) {
      return 'HOTBAR';
    }
    if (slotIndex >= inventoryStart && slotIndex < hotbarStart) {
      return 'MAIN INVENTORY';
    }
    return 'OTHER ACCESSIBLE INVENTORY SLOTS';
  }

  /**
   * Deeply inspects an inventory item using its name, displayName, and NBT tags.
   */
  classifyItem(item, slotIndex = null) {
    if (!item || !item.name) return null;

    const itemName = item.name.toLowerCase();
    const isPotion = itemName.includes('potion') || itemName.includes('bottle');
    if (!isPotion) return null;

    const isSplash = itemName.includes('splash');
    const isLingering = itemName.includes('lingering');
    const isDrinkable = !isSplash && !isLingering && !itemName.includes('glass_bottle');
    const disp = (item.displayName || '').toLowerCase();

    // NBT inspection
    let potionTag = '';
    try {
      if (item.nbt && item.nbt.value) {
        const val = item.nbt.value;
        if (val.Potion && val.Potion.value) {
          potionTag = String(val.Potion.value).toLowerCase();
        } else if (val.potion_contents && val.potion_contents.value) {
          potionTag = JSON.stringify(val.potion_contents.value).toLowerCase();
        } else if (val.custom_potion_effects) {
          potionTag = JSON.stringify(val.custom_potion_effects).toLowerCase();
        }
      }
    } catch {}

    const textToSearch = `${itemName} ${disp} ${potionTag}`;

    let type = 'OTHER';
    let tier = 1;

    if (textToSearch.includes('heal') || textToSearch.includes('instant health') || textToSearch.includes('healing')) {
      type = 'HEALING';
    } else if (textToSearch.includes('strength')) {
      type = 'STRENGTH';
    } else if (textToSearch.includes('speed') || textToSearch.includes('swiftness')) {
      type = 'SPEED';
    }

    if (
      textToSearch.includes('strong_') ||
      textToSearch.includes(' ii') ||
      textToSearch.includes('tier 2') ||
      textToSearch.includes('level 2') ||
      textToSearch.includes('strong_healing') ||
      textToSearch.includes('strong_strength') ||
      textToSearch.includes('strong_swiftness')
    ) {
      tier = 2;
    }

    const slot = slotIndex !== null ? slotIndex : (item.slot !== undefined ? item.slot : -1);

    return {
      slot,
      location: this.getLocationForSlot(slot),
      item,
      name: item.name,
      displayName: item.displayName || item.name,
      isSplash,
      isDrinkable,
      type,
      tier,
      count: item.count || 1
    };
  }

  /**
   * Scans the ENTIRE inventory (hotbar, main inventory, and other accessible slots).
   * Does NOT restrict to hotbar or first 9 slots.
   */
  scanAllPotions() {
    if (!this.bot || !this.bot.inventory) return [];
    const inv = this.bot.inventory;
    const { totalSlots, hotbarStart } = this.getInventoryBounds();
    const potions = [];

    if (inv.slots) {
      // Scan every accessible slot in the window
      for (let s = 0; s < totalSlots; s++) {
        const item = inv.slots[s];
        if (item) {
          const classified = this.classifyItem(item, s);
          if (classified && classified.type !== 'OTHER') {
            potions.push(classified);
          }
        }
      }
    } else if (typeof inv.items === 'function') {
      for (const item of inv.items()) {
        if (item) {
          const slot = item.slot !== undefined ? item.slot : -1;
          const classified = this.classifyItem(item, slot);
          if (classified && classified.type !== 'OTHER') {
            potions.push(classified);
          }
        }
      }
    }

    // Sort order: HOTBAR first (for fastest access), then higher tier, then splash
    return potions.sort((a, b) => {
      // Prioritize hotbar if already there
      const aIsHotbar = a.location === 'HOTBAR' ? 1 : 0;
      const bIsHotbar = b.location === 'HOTBAR' ? 1 : 0;
      if (aIsHotbar !== bIsHotbar) return bIsHotbar - aIsHotbar;

      // Prioritize splash over drinkable for combat
      if (a.isSplash !== b.isSplash) return a.isSplash ? -1 : 1;

      // Prioritize tier 2 over tier 1
      return b.tier - a.tier;
    });
  }

  /**
   * Searches the entire inventory for a potion matching `type` ('HEALING', 'STRENGTH', 'SPEED').
   */
  findPotion(type) {
    const normalizedType = String(type).toUpperCase();
    const targetType = normalizedType === 'HEALTH' ? 'HEALING' : normalizedType;

    const allPotions = this.scanAllPotions();
    const matching = allPotions.filter((p) => p.type === targetType);
    return matching.length > 0 ? matching[0] : null;
  }

  /**
   * Retrieves all healing potions from entire inventory (preferring hotbar, splash, tier 2).
   */
  getHealthPotions() {
    return this.scanAllPotions().filter((p) => p.type === 'HEALING');
  }

  /**
   * Retrieves all strength potions from entire inventory.
   */
  getStrengthPotions() {
    return this.scanAllPotions().filter((p) => p.type === 'STRENGTH');
  }

  /**
   * Retrieves all speed potions from entire inventory.
   */
  getSpeedPotions() {
    return this.scanAllPotions().filter((p) => p.type === 'SPEED');
  }

  /**
   * Deeply inspects bot.entity.effects and local buffs to determine if an effect is currently active.
   */
  hasActiveEffect(effectNameOrId) {
    if (!this.bot || !this.bot.entity) {
      if (effectNameOrId === 5 || effectNameOrId === 'strength') {
        return this.activeBuffs.strength.expiresAt > Date.now();
      }
      if (effectNameOrId === 1 || effectNameOrId === 'speed') {
        return this.activeBuffs.speed.expiresAt > Date.now();
      }
      return false;
    }

    const effects = this.bot.entity.effects;
    if (effects) {
      for (const [key, eff] of Object.entries(effects)) {
        if (!eff) continue;
        const keyStr = String(key).toLowerCase();
        const effId = eff.id;
        const effName = String(eff.name || '').toLowerCase();

        const isStrength = (effectNameOrId === 5 || effectNameOrId === 'strength') &&
          (effId === 5 || effId === '5' || keyStr === '5' || effName.includes('strength') || keyStr.includes('strength'));
        const isSpeed = (effectNameOrId === 1 || effectNameOrId === 'speed') &&
          (effId === 1 || effId === '1' || keyStr === '1' || effName.includes('speed') || effName.includes('swiftness') || keyStr.includes('speed'));

        if (isStrength || isSpeed) {
          // If duration is defined and > 0, it is currently in effect!
          if (eff.duration === undefined || eff.duration > 0) {
            return true;
          }
        }
      }
    }

    const now = Date.now();
    if ((effectNameOrId === 5 || effectNameOrId === 'strength') && this.activeBuffs.strength.expiresAt > now) {
      return true;
    }
    if ((effectNameOrId === 1 || effectNameOrId === 'speed') && this.activeBuffs.speed.expiresAt > now) {
      return true;
    }

    return false;
  }

  /**
   * Checks if Strength is currently in effect on the bot.
   */
  isStrengthActive() {
    const active = this.hasActiveEffect(5);
    const now = Date.now();
    if (!active && this.wasStrengthActive) {
      this.strengthExpiredAt = now;
      this.wasStrengthActive = false;
      console.log('💪 [POTION] Strength effect ran off. 2s cooldown active before re-throw.');
    } else if (active) {
      this.wasStrengthActive = true;
    }
    return active;
  }

  /**
   * Checks if Speed is currently in effect on the bot.
   */
  isSpeedActive() {
    const active = this.hasActiveEffect(1);
    const now = Date.now();
    if (!active && this.wasSpeedActive) {
      this.speedExpiredAt = now;
      this.wasSpeedActive = false;
      console.log('⚡ [POTION] Speed effect ran off. 2s cooldown active before re-throw.');
    } else if (active) {
      this.wasSpeedActive = true;
    }
    return active;
  }

  /**
   * Determines if the bot is allowed to throw a Strength potion:
   * 1. Must NOT already be in effect.
   * 2. After the effect runs off, must wait at least 2 seconds (2000ms) before re-throwing.
   */
  canThrowStrength(now = Date.now()) {
    if (this.isStrengthActive()) return false;
    if (this.strengthExpiredAt > 0 && (now - this.strengthExpiredAt < 2000)) {
      return false;
    }
    return true;
  }

  /**
   * Determines if the bot is allowed to throw a Speed potion:
   * 1. Must NOT already be in effect.
   * 2. After the effect runs off, must wait at least 2 seconds (2000ms) before re-throwing.
   */
  canThrowSpeed(now = Date.now()) {
    if (this.isSpeedActive()) return false;
    if (this.speedExpiredAt > 0 && (now - this.speedExpiredAt < 2000)) {
      return false;
    }
    return true;
  }

  /**
   * Evaluates if Strength or Speed buffs should be refreshed during a safe micro-window.
   */
  async evaluateBuffMaintenance(target = null) {
    if (this.isUsingPotion || this.isEating || this.healingActionLock || this.potionOperationLock) return false;

    // Strength priority
    if (this.canThrowStrength()) {
      const pot = this.findPotion('STRENGTH');
      if (pot) {
        return await this.usePotion('STRENGTH', target);
      }
    }

    // Speed priority
    if (this.canThrowSpeed()) {
      const pot = this.findPotion('SPEED');
      if (pot) {
        return await this.usePotion('SPEED', target);
      }
    }

    return false;
  }

  /**
   * Inspects active buffs at the start of a match so the bot enters fights already aware.
   */
  checkStartOfMatchBuffs() {
    this.isStrengthActive();
    this.isSpeedActive();
    console.log(`🛡️ [POTION] Match start buff check: Strength active=${this.hasActiveEffect('strength')}, Speed active=${this.hasActiveEffect('speed')}`);
  }

  /**
   * Checks if current spacing and health allow a safe buff splash window.
   */
  isSafeBuffWindow(target, dist, currentHealth) {
    if (!target) return true;
    if (dist < this.punishDistanceThreshold) return false;
    if (currentHealth !== undefined && currentHealth <= this.healThresholdHP) return false;
    return true;
  }

  /**
   * Checks synchronously if a potion of the given type exists in inventory.
   */
  hasPotion(type) {
    return Boolean(this.findPotion(type));
  }

  /**
   * Searches the entire inventory (hotbar and main inventory) for golden apples.
   */
  findGoldenApple() {
    if (!this.bot || !this.bot.inventory) return null;
    const inv = this.bot.inventory;
    const { totalSlots } = this.getInventoryBounds();
    const gapples = [];

    if (inv.slots) {
      for (let s = 0; s < totalSlots; s++) {
        const item = inv.slots[s];
        if (item && item.name) {
          const name = item.name.toLowerCase();
          if (name === 'golden_apple' || name === 'enchanted_golden_apple' || name.includes('golden_apple')) {
            gapples.push({
              slot: s,
              location: this.getLocationForSlot(s),
              item,
              name: item.name,
              isEnchanted: name.includes('enchanted'),
              count: item.count || 1
            });
          }
        }
      }
    } else if (typeof inv.items === 'function') {
      for (const item of inv.items()) {
        if (item && item.name) {
          const name = item.name.toLowerCase();
          if (name === 'golden_apple' || name === 'enchanted_golden_apple' || name.includes('golden_apple')) {
            const slot = item.slot !== undefined ? item.slot : -1;
            gapples.push({
              slot,
              location: this.getLocationForSlot(slot),
              item,
              name: item.name,
              isEnchanted: name.includes('enchanted'),
              count: item.count || 1
            });
          }
        }
      }
    }

    if (gapples.length === 0) return null;

    // Prioritize enchanted golden apple, then hotbar location, then stack count
    return gapples.sort((a, b) => {
      if (a.isEnchanted !== b.isEnchanted) return b.isEnchanted ? 1 : -1;
      const aHotbar = a.location === 'HOTBAR' ? 1 : 0;
      const bHotbar = b.location === 'HOTBAR' ? 1 : 0;
      if (aHotbar !== bHotbar) return bHotbar - aHotbar;
      return b.count - a.count;
    })[0];
  }

  /**
   * Returns true if any golden apples are available in inventory.
   */
  hasGoldenApples() {
    return Boolean(this.findGoldenApple());
  }

  /**
   * Checks current effects at match start.
   * If Strength or Speed is already in effect from the server/kit, strictly prevents throwing!
   */
  checkStartOfMatchBuffs() {
    const hasStrength = this.hasActiveEffect(5);
    const hasSpeed = this.hasActiveEffect(1);

    if (hasStrength) {
      console.log('💪 [START_BUFF] Strength is ALREADY in effect from kit/server. Throwing suppressed.');
    }
    if (hasSpeed) {
      console.log('⚡ [START_BUFF] Speed is ALREADY in effect from kit/server. Throwing suppressed.');
    }

    return { hasStrength, hasSpeed };
  }

  /**
   * Evaluates if the current combat moment is a safe micro-window for buff refresh.
   */
  isSafeBuffWindow(target, dist, currentHealth) {
    if (this.healingActionLock || this.isEating || this.isUsingPotion) return false;
    if (currentHealth <= this.healThresholdHP) return false;
    if (!target || !target.position) return true;

    // Safe window: Target is knocked back (> 3.3m) or spaced safely
    return dist > 3.2;
  }

  /**
   * Consumes a golden apple under healingActionLock.
   * Forbids sword switches, attack calls, and combo interrupts until consumption completes.
   */
  async eatGoldenApple() {
    if (!this.bot || !this.bot.inventory || this.isEating || this.isUsingPotion || this.healingActionLock) return false;
    const now = Date.now();
    if (now - this.lastEatTime < 600) return false;

    const gapple = this.findGoldenApple();
    if (!gapple) return false;

    // ENFORCE HEALING ACTION LOCK: Forbids weapon swaps, attacks, combos, and crits
    this.isEating = true;
    this.healingActionLock = true;
    this.lastEatTime = now;
    const originalHeldItem = this.bot.heldItem;

    try {
      console.log(`🍏 [GAPPLE] Entering HEAL_GAPPLE. Equipping ${gapple.name} under healingActionLock...`);
      if (typeof this.bot.equip === 'function') {
        await this.bot.equip(gapple.item, 'hand');
      } else if (this.bot.quickBarSlot !== undefined && gapple.location === 'HOTBAR') {
        const { hotbarStart } = this.getInventoryBounds();
        this.bot.setQuickBarSlot(gapple.slot - hotbarStart);
      }
      await sleep(30);

      console.log(`🍏 [GAPPLE] Consuming ${gapple.name}...`);
      const initialCount = gapple.item.count || 1;

      // Use official Mineflayer consume() API if available
      let consumedViaApi = false;
      if (typeof this.bot.consume === 'function') {
        try {
          const consumePromise = this.bot.consume();
          if (consumePromise && typeof consumePromise.then === 'function') {
            await Promise.race([consumePromise, sleep(1650)]);
            consumedViaApi = true;
          }
        } catch {
          consumedViaApi = false;
        }
      }

      if (!consumedViaApi) {
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem();
        }

        const eatStart = Date.now();
        // Vanilla eating takes 32 ticks (~1600ms)
        while (Date.now() - eatStart < 1650 && this.bot) {
          await sleep(60);
          const held = this.bot.heldItem;
          if (!held || held.count < initialCount) break;
        }

        if (this.bot && typeof this.bot.deactivateItem === 'function') {
          this.bot.deactivateItem();
        }
      }

      await sleep(30);
      console.log(`✅ [GAPPLE] Finished eating ${gapple.name}! Releasing healingActionLock and restoring weapon.`);
      return true;
    } catch (err) {
      console.error(`⚠️ [GAPPLE] Error eating golden apple:`, err.message);
      return false;
    } finally {
      await this.restorePreviousItem(originalHeldItem);
      this.isEating = false;
      this.healingActionLock = false;
    }
  }

  /**
   * Finds the best hotbar slot to move an item into.
   * Priority:
   * 1. Empty hotbar slot
   * 2. Hotbar slot with an empty glass bottle
   * 3. Non-weapon hotbar slot (avoid swapping active sword/axe or totem)
   */
  findBestHotbarSlot() {
    const { hotbarSlots, hotbarStart } = this.getInventoryBounds();
    const inv = this.bot.inventory;

    // 1. Look for completely empty hotbar slots
    for (const s of hotbarSlots) {
      if (!inv.slots[s]) return s;
    }

    // 2. Look for empty glass bottles in hotbar
    for (const s of hotbarSlots) {
      const item = inv.slots[s];
      if (item && item.name.includes('bottle') && !item.name.includes('potion') && !item.name.includes('experience')) {
        return s;
      }
    }

    // 3. Look for non-essential items (not swords, axes, maces, bows, or crystals)
    const currentQuickBarSlot = this.bot.quickBarSlot !== undefined ? this.bot.quickBarSlot : 0;
    const activeSlot = hotbarStart + currentQuickBarSlot;

    for (const s of hotbarSlots) {
      if (s === activeSlot) continue; // Protect currently held item
      const item = inv.slots[s];
      if (item) {
        const name = item.name.toLowerCase();
        const isWeaponOrTool =
          name.includes('sword') ||
          name.includes('axe') ||
          name.includes('mace') ||
          name.includes('bow') ||
          name.includes('totem') ||
          name.includes('shield') ||
          name.includes('crystal');
        if (!isWeaponOrTool) return s;
      }
    }

    // Fallback: Pick hotbar slot 37-44 (key 2-9) that is not the active slot
    for (const s of hotbarSlots) {
      if (s !== activeSlot) return s;
    }

    return hotbarSlots[0];
  }

  /**
   * Safely moves an item between slots with potionOperationLock mutex protection and post-transfer verification.
   */
  async safeMoveItem(sourceSlot, targetSlot, expectedType = null, retryCount = 1) {
    if (!this.bot || !this.bot.inventory) return false;
    if (this.potionOperationLock) {
      let waitMs = 0;
      while (this.potionOperationLock && waitMs < 300) {
        await sleep(25);
        waitMs += 25;
      }
      if (this.potionOperationLock) return false;
    }

    this.potionOperationLock = true;
    try {
      if (typeof this.bot.moveSlotItem === 'function') {
        await this.bot.moveSlotItem(sourceSlot, targetSlot);
      } else if (typeof this.bot.clickWindow === 'function') {
        await this.bot.clickWindow(sourceSlot, 0, 0);
        await sleep(20);
        await this.bot.clickWindow(targetSlot, 0, 0);
        await sleep(20);
        if (this.bot.inventory.selectedItem) {
          await this.bot.clickWindow(sourceSlot, 0, 0);
          await sleep(20);
        }
      }
      await sleep(30);

      // Post-transfer verification
      if (expectedType) {
        const targetItem = this.bot.inventory.slots[targetSlot];
        const normalized = expectedType.toUpperCase() === 'HEALTH' ? 'HEALING' : expectedType.toUpperCase();
        const classified = targetItem ? this.classifyItem(targetItem, targetSlot) : null;
        if (!classified || classified.type !== normalized) {
          if (retryCount > 0) {
            console.log(`⚠️ [POTION_INV] Move verification failed for ${expectedType}, retrying safely once...`);
            this.potionOperationLock = false;
            const refreshedPot = this.findPotion(expectedType);
            if (refreshedPot && refreshedPot.slot !== targetSlot) {
              return await this.safeMoveItem(refreshedPot.slot, targetSlot, expectedType, retryCount - 1);
            }
            return false;
          }
          return false;
        }
      }
      return true;
    } catch (err) {
      console.error(`❌ [POTION_INV] Error in safeMoveItem: ${err.message}`);
      return false;
    } finally {
      this.potionOperationLock = false;
    }
  }

  /**
   * Pre-stages important potions (Healing, Strength, Speed) into reserved hotbar slots.
   * Called at match start / safe combat windows to eliminate mid-fight inventory delays.
   */
  async preStagePotions() {
    if (!this.bot || !this.bot.inventory || this.potionOperationLock) return false;
    const { hotbarStart } = this.getInventoryBounds();

    const targets = [
      { type: 'HEALING', targetSlot: hotbarStart + this.reservedSlots.healingQuickbar },
      { type: 'STRENGTH', targetSlot: hotbarStart + this.reservedSlots.strengthQuickbar },
      { type: 'SPEED', targetSlot: hotbarStart + this.reservedSlots.speedQuickbar }
    ];

    let prestagedAny = false;
    for (const target of targets) {
      // Check if slot already has the right potion
      const existingItem = this.bot.inventory.slots[target.targetSlot];
      if (existingItem) {
        const classified = this.classifyItem(existingItem, target.targetSlot);
        if (classified && classified.type === target.type) {
          continue; // Already pre-staged!
        }
      }

      // Find in main inventory
      const potion = this.findPotion(target.type);
      if (potion && potion.slot !== target.targetSlot) {
        const moved = await this.safeMoveItem(potion.slot, target.targetSlot, target.type);
        if (moved) prestagedAny = true;
      }
    }
    return prestagedAny;
  }

  /**
   * Safe micro-window replenishment:
   * Checks whether any reserved hotbar slot is missing its potion and replenishes from main inventory.
   * Only called when spacing is safe or opponent is knocked back.
   */
  async replenishHotbarPotions(combatSpacingSafe = true) {
    if (!combatSpacingSafe || this.isUsingPotion || this.potionOperationLock) return false;
    return await this.preStagePotions();
  }

  /**
   * Ensures the requested potion is in the hotbar.
   * If in main inventory or other slots, moves it to hotbar using legitimate Mineflayer inventory actions.
   */
  async ensurePotionInHotbar(type) {
    if (!this.bot || !this.bot.inventory) {
      return { success: false, message: 'Bot inventory unavailable' };
    }

    const potion = this.findPotion(type);
    if (!potion) {
      return { success: false, message: `No ${type} potion found anywhere in inventory` };
    }

    const { hotbarStart } = this.getInventoryBounds();

    // Already in hotbar!
    if (potion.location === 'HOTBAR') {
      const hotbarIndex = potion.slot - hotbarStart;
      return {
        success: true,
        slot: potion.slot,
        hotbarIndex,
        item: potion.item,
        alreadyInHotbar: true
      };
    }

    // In MAIN INVENTORY or OTHER -> Move into preferred reserved hotbar slot!
    let preferredHotbarSlot = null;
    const normalizedType = String(type).toUpperCase() === 'HEALTH' ? 'HEALING' : String(type).toUpperCase();
    if (normalizedType === 'HEALING' && this.reservedSlots.healingQuickbar !== undefined) {
      preferredHotbarSlot = hotbarStart + this.reservedSlots.healingQuickbar;
    } else if (normalizedType === 'STRENGTH' && this.reservedSlots.strengthQuickbar !== undefined) {
      preferredHotbarSlot = hotbarStart + this.reservedSlots.strengthQuickbar;
    } else if (normalizedType === 'SPEED' && this.reservedSlots.speedQuickbar !== undefined) {
      preferredHotbarSlot = hotbarStart + this.reservedSlots.speedQuickbar;
    }

    const targetHotbarSlot = preferredHotbarSlot || this.findBestHotbarSlot();
    const sourceSlot = potion.slot;

    console.log(`🎒 [POTION_INV] Moving ${type} potion "${potion.displayName}" from ${potion.location} (Slot ${sourceSlot}) into Hotbar (Slot ${targetHotbarSlot})...`);

    const moveOk = await this.safeMoveItem(sourceSlot, targetHotbarSlot, type);
    if (!moveOk) {
      return { success: false, message: `Failed to move ${type} into hotbar slot ${targetHotbarSlot}` };
    }

    const targetItem = this.bot.inventory.slots[targetHotbarSlot];
    const hotbarIndex = targetHotbarSlot - hotbarStart;
    console.log(`✅ [POTION_INV] Confirmed ${type} potion is now in Hotbar slot ${targetHotbarSlot} (Quickbar ${hotbarIndex})!`);

    return {
      success: true,
      slot: targetHotbarSlot,
      hotbarIndex,
      item: targetItem,
      alreadyInHotbar: false
    };
  }

  /**
   * Selects the potion in the hotbar so it is currently held in hand.
   */
  async selectPotion(type) {
    const hotbarResult = await this.ensurePotionInHotbar(type);
    if (!hotbarResult.success) return hotbarResult;

    // Save previous quickbar slot to restore later
    if (this.bot.quickBarSlot !== undefined) {
      this.previousQuickBarSlot = this.bot.quickBarSlot;
    }

    // Select hotbar slot
    if (typeof this.bot.setQuickBarSlot === 'function') {
      this.bot.setQuickBarSlot(hotbarResult.hotbarIndex);
    } else if (typeof this.bot.equip === 'function') {
      await this.bot.equip(hotbarResult.item, 'hand');
    }
    await sleep(20);

    return {
      success: true,
      hotbarIndex: hotbarResult.hotbarIndex,
      slot: hotbarResult.slot,
      item: hotbarResult.item
    };
  }

  /**
   * Calculates the optimal downward throw pitch aimed directly at the ground beneath/near feet.
   * Adapts dynamically to current horizontal velocity so running into a splash potion hits the player directly.
   */
  calculateDynamicFootPitch() {
    if (!this.bot || !this.bot.entity) return -1.50;

    const vel = this.bot.entity.velocity || new Vec3(0, 0, 0);
    const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);

    // If standing still or moving very slowly: aim straight down (-1.52 rad ~ -87 deg)
    if (speed < 0.05) {
      return -1.52;
    }

    // When sprinting forward: lead the splash slightly in front of feet (-1.40 to -1.45 rad)
    // so the bot runs directly through the potion cloud
    const leadFactor = Math.min(0.12, speed * 0.4);
    const pitch = -1.52 + leadFactor;
    return Math.max(-1.55, Math.min(-1.35, pitch));
  }

  /**
   * Backward compatibility helper
   */
  calculateFootThrowPitch() {
    return this.calculateDynamicFootPitch();
  }

  /**
   * Evaluates if opponent is close enough to punish the bot while potting.
   */
  isOpponentInPunishRange(opponentEntity) {
    if (!opponentEntity || !opponentEntity.position || !this.bot || !this.bot.entity) return false;
    const dist = this.bot.entity.position.distanceTo(opponentEntity.position);
    return dist < this.punishDistanceThreshold;
  }

  /**
   * Restores previous held item/slot after using a potion.
   */
  async restorePreviousItem(primaryWeapon = null) {
    try {
      if (typeof this.bot.setQuickBarSlot === 'function' && this.previousQuickBarSlot !== undefined) {
        this.bot.setQuickBarSlot(this.previousQuickBarSlot);
      }
      if (primaryWeapon && typeof this.bot.equip === 'function') {
        await this.bot.equip(primaryWeapon, 'hand');
      }
    } catch {}
  }

  /**
   * High-level entry: Uses a potion of the specified type ('HEALING', 'STRENGTH', 'SPEED').
   */
  async usePotion(type, opponentEntity = null) {
    if (!this.bot || !this.bot.inventory || this.isUsingPotion) return false;
    const now = Date.now();
    if (now - this.lastPotionTime < this.potionCooldownMs) return false;

    const currentHealth = this.bot.health != null ? this.bot.health : 20;
    const normalizedType = String(type).toUpperCase() === 'HEALTH' ? 'HEALING' : String(type).toUpperCase();

    // 1. SURVIVAL & HEALTH GATING:
    // If health is low, NEVER throw Strength or Speed!
    if (currentHealth <= this.healThresholdHP && normalizedType !== 'HEALING') {
      return false;
    }

    // 2. PUNISH EVALUATION FOR HEALING:
    // If opponent is right in the bot's face (< 2.0m) and health is not ultra-critical (> 6 HP),
    // disengage spacing first before locking into a pot throw
    if (normalizedType === 'HEALING' && currentHealth > 6 && this.isOpponentInPunishRange(opponentEntity)) {
      console.log('⚠️ [POTION] Opponent is in punish range (< 2.0m). Creating spacing before potting...');
      return false;
    }

    // 3. BUFF GATING FOR STRENGTH & SPEED:
    // Do NOT throw if already in effect! And after the effect runs off, wait 2 seconds before throwing!
    if (normalizedType === 'STRENGTH' && !this.canThrowStrength(now)) return false;
    if (normalizedType === 'SPEED' && !this.canThrowSpeed(now)) return false;

    // 4. FIND & ENSURE IN HOTBAR FROM ENTIRE INVENTORY:
    this.isUsingPotion = true;
    this.lastPotionTime = now;

    const originalHeldItem = this.bot.heldItem;
    const originalYaw = this.bot.entity.yaw;

    try {
      const selectResult = await this.selectPotion(normalizedType);
      if (!selectResult.success) {
        console.log(`⚠️ [POTION] Cannot use ${normalizedType}: ${selectResult.message}`);
        return false;
      }

      const potItem = selectResult.item;
      const classified = this.classifyItem(potItem, selectResult.slot);
      const preCount = potItem.count || 1;
      const initialHealth = this.bot.health != null ? this.bot.health : 20;

      if (classified && classified.isSplash) {
        // Splash potion: Aim downward at feet with dynamic pitch
        const dynamicPitch = this.calculateDynamicFootPitch();
        await this.bot.look(originalYaw, dynamicPitch, true);
        await sleep(25);

        this.bot.activateItem();
        await sleep(40);
        this.bot.deactivateItem();
        await sleep(40);

        // Verify consumption
        const postSlotItem = this.bot.inventory.slots[selectResult.slot];
        const countDecreased = !postSlotItem || (postSlotItem.count || 0) < preCount;
        const postHealth = this.bot.health != null ? this.bot.health : initialHealth;
        const healthHealed = postHealth > initialHealth;

        console.log(`🧪 [POTION] Threw ${normalizedType} splash at feet (pitch: ${dynamicPitch.toFixed(2)} rad). Consumed verified: ${countDecreased || healthHealed}`);
      } else {
        // Drinkable potion: activate and hold until consumed
        console.log(`🧪 [POTION] Drinking ${normalizedType} potion...`);
        this.bot.activateItem();
        const drinkStart = Date.now();
        while (Date.now() - drinkStart < 1650 && this.bot) {
          await sleep(80);
          const currentHeld = this.bot.heldItem;
          if (!currentHeld || currentHeld.name.includes('glass_bottle')) break;
        }
        if (this.bot) this.bot.deactivateItem();
        await sleep(30);

        // Record active buff locally
        const durationSeconds = classified && classified.tier === 2 ? 90 : 180;
        if (normalizedType === 'STRENGTH') {
          this.activeBuffs.strength = {
            expiresAt: Date.now() + durationSeconds * 1000,
            level: classified ? classified.tier : 1
          };
        } else if (normalizedType === 'SPEED') {
          this.activeBuffs.speed = {
            expiresAt: Date.now() + durationSeconds * 1000,
            level: classified ? classified.tier : 1
          };
        }
      }

      return true;
    } catch (err) {
      console.error(`⚠️ [POTION] Error during usePotion(${normalizedType}):`, err.message);
      return false;
    } finally {
      // Restore primary weapon in < 20ms
      await this.restorePreviousItem(originalHeldItem);
      this.isUsingPotion = false;
    }
  }

  /**
   * Compatibility wrapper for existing emergency health throw.
   */
  async executeHealthPotionThrow(opponentEntity = null) {
    return this.usePotion('HEALING', opponentEntity);
  }

  /**
   * Compatibility wrapper for buff maintenance.
   */
  async evaluateBuffMaintenance() {
    if (!this.bot || !this.bot.inventory || this.isUsingPotion) return false;
    const currentHealth = this.bot.health != null ? this.bot.health : 20;
    if (currentHealth <= this.healThresholdHP) return false;

    const now = Date.now();
    // Check Strength: strictly check that it is NOT in effect, AND that >= 2s elapsed since running off
    if (this.canThrowStrength(now)) {
      const hasStrength = this.findPotion('STRENGTH');
      if (hasStrength) return this.usePotion('STRENGTH');
    }

    // Check Speed: strictly check that it is NOT in effect, AND that >= 2s elapsed since running off
    if (this.canThrowSpeed(now)) {
      const hasSpeed = this.findPotion('SPEED');
      if (hasSpeed) return this.usePotion('SPEED');
    }

    return false;
  }
}

module.exports = PotionInventoryManager;
