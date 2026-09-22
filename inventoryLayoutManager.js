/**
 * Inventory Layout Manager for Mineflayer PvP Bot.
 * 
 * Manages canonical inventory layout presets:
 * - MACE_ROCKET_LAYOUT
 * - NETHPOT_LAYOUT
 * - CRYSTAL_LAYOUT
 * - MACE_LAYOUT
 * - SPEAR_ELYTRA_LAYOUT
 * - SPEAR_MACE_LAYOUT
 * 
 * Features:
 * 1. Reads actual live inventory rather than assuming hard-coded slot numbers.
 * 2. Determines Mineflayer slot indices dynamically.
 * 3. Verifies actual item IDs, display names, and NBT tags before use.
 * 4. Compares live inventory against the active profile's layout preset.
 * 5. Pre-stages critical items into hotbar slots prior to combat engagement.
 */

class InventoryLayoutManager {
  constructor(bot = null) {
    this.bot = bot;

    // Canonical layout presets defining expected item roles
    this.presets = {
      NETHPOT_LAYOUT: {
        name: 'NETHPOT_LAYOUT',
        profile: 'NETHPOT',
        roles: {
          mainWeapon: ['netherite_sword', 'diamond_sword'],
          healingPotion: ['splash_potion'], // With Healing II
          speedPotion: ['splash_potion', 'potion'], // With Speed II
          strengthPotion: ['splash_potion', 'potion'], // With Strength II
          goldenApples: ['golden_apple', 'enchanted_golden_apple'],
          enderPearls: ['ender_pearl'],
          totem: ['totem_of_undying']
        },
        preferredHotbar: {
          0: 'mainWeapon',
          1: 'healingPotion',
          2: 'speedPotion',
          3: 'strengthPotion',
          4: 'goldenApples',
          8: 'enderPearls'
        },
        requiredRoles: ['mainWeapon']
      },

      SWORD_LAYOUT: {
        name: 'SWORD_LAYOUT',
        profile: 'SWORD',
        roles: {
          mainWeapon: ['diamond_sword', 'netherite_sword', 'iron_sword'],
          secondaryWeapon: ['diamond_axe', 'netherite_axe', 'iron_axe'], // Shield breaker
          goldenApples: ['golden_apple', 'enchanted_golden_apple'],
          healingPotion: ['splash_potion', 'potion'],
          enderPearls: ['ender_pearl'],
          totem: ['totem_of_undying']
        },
        preferredHotbar: {
          0: 'mainWeapon',
          1: 'secondaryWeapon',
          2: 'goldenApples',
          3: 'healingPotion',
          8: 'enderPearls'
        },
        requiredRoles: ['mainWeapon']
      },

      CRYSTAL_LAYOUT: {
        name: 'CRYSTAL_LAYOUT',
        profile: 'CRYSTAL',
        roles: {
          mainWeapon: ['netherite_sword', 'diamond_sword'],
          obsidian: ['obsidian', 'crying_obsidian'],
          endCrystals: ['end_crystal'],
          totem: ['totem_of_undying'],
          respawnAnchor: ['respawn_anchor'],
          glowstone: ['glowstone'],
          enderPearls: ['ender_pearl'],
          goldenApples: ['golden_apple', 'enchanted_golden_apple'],
          pickaxe: ['netherite_pickaxe', 'diamond_pickaxe']
        },
        preferredHotbar: {
          0: 'mainWeapon',
          1: 'obsidian',
          2: 'endCrystals',
          3: 'respawnAnchor',
          4: 'glowstone',
          5: 'totem',
          6: 'goldenApples',
          8: 'enderPearls'
        },
        requiredRoles: ['obsidian', 'endCrystals']
      },

      MACE_LAYOUT: {
        name: 'MACE_LAYOUT',
        profile: 'MACE',
        roles: {
          mace: ['mace'],
          secondaryWeapon: ['netherite_sword', 'diamond_sword'],
          windCharges: ['wind_charge'],
          goldenApples: ['golden_apple', 'enchanted_golden_apple'],
          enderPearls: ['ender_pearl'],
          totem: ['totem_of_undying']
        },
        preferredHotbar: {
          0: 'secondaryWeapon',
          1: 'mace',
          2: 'windCharges',
          3: 'goldenApples',
          8: 'enderPearls'
        },
        requiredRoles: ['mace', 'windCharges']
      },

      MACE_ROCKET_LAYOUT: {
        name: 'MACE_ROCKET_LAYOUT',
        profile: 'ELYTRA_MACE',
        roles: {
          elytra: ['elytra'],
          rockets: ['firework_rocket'],
          mace: ['mace'],
          chestplate: ['netherite_chestplate', 'diamond_chestplate'],
          secondaryWeapon: ['netherite_sword', 'diamond_sword'],
          goldenApples: ['golden_apple', 'enchanted_golden_apple'],
          enderPearls: ['ender_pearl'],
          totem: ['totem_of_undying']
        },
        preferredHotbar: {
          0: 'mace',
          1: 'rockets',
          2: 'chestplate',
          3: 'goldenApples',
          8: 'enderPearls'
        },
        requiredRoles: ['elytra', 'rockets', 'mace']
      },

      SPEAR_ELYTRA_LAYOUT: {
        name: 'SPEAR_ELYTRA_LAYOUT',
        profile: 'SPEAR_ELYTRA',
        roles: {
          spear: ['trident', 'diamond_spear', 'golden_spear', 'iron_spear'],
          elytra: ['elytra'],
          rockets: ['firework_rocket'],
          chestplate: ['netherite_chestplate', 'diamond_chestplate'],
          goldenApples: ['golden_apple', 'enchanted_golden_apple'],
          enderPearls: ['ender_pearl'],
          totem: ['totem_of_undying']
        },
        preferredHotbar: {
          0: 'spear',
          1: 'rockets',
          2: 'chestplate',
          3: 'goldenApples',
          8: 'enderPearls'
        },
        requiredRoles: ['spear', 'elytra', 'rockets']
      },

      SPEAR_MACE_LAYOUT: {
        name: 'SPEAR_MACE_LAYOUT',
        profile: 'SPEAR_MACE',
        roles: {
          spear: ['trident', 'diamond_spear', 'golden_spear', 'iron_spear'],
          mace: ['mace'],
          windCharges: ['wind_charge'],
          goldenApples: ['golden_apple', 'enchanted_golden_apple'],
          enderPearls: ['ender_pearl'],
          totem: ['totem_of_undying']
        },
        preferredHotbar: {
          0: 'spear',
          1: 'mace',
          2: 'windCharges',
          3: 'goldenApples',
          8: 'enderPearls'
        },
        requiredRoles: ['spear', 'mace']
      }
    };
  }

  setBot(bot) {
    this.bot = bot;
  }

  getAvailableLayouts() {
    return Object.keys(this.presets);
  }

  applyLayout(profileKey) {
    const layout = this.getLayout(profileKey);
    const scan = this.scanLiveInventory(profileKey);
    const roleToSlot = {};
    for (const [role, data] of Object.entries(scan.mapped)) {
      roleToSlot[role] = data.slot;
      // Also map standard UPPER_SNAKE_CASE aliases
      if (role === 'mainWeapon') roleToSlot['PRIMARY_WEAPON'] = data.slot;
      if (role === 'secondaryWeapon') roleToSlot['SECONDARY_WEAPON'] = data.slot;
      if (role === 'goldenApples') roleToSlot['GAPPLE'] = data.slot;
      if (role === 'speedPotion') roleToSlot['SPEED_POTION'] = data.slot;
      if (role === 'strengthPotion') roleToSlot['STRENGTH_POTION'] = data.slot;
      if (role === 'healingPotion') roleToSlot['HEAL_POTION_1'] = data.slot;
      if (role === 'enderPearls') roleToSlot['PEARL'] = data.slot;
    }
    return {
      name: layout.name,
      profile: layout.profile,
      roleToSlot,
      scan
    };
  }

  validateItemInSlot(slotIndex, expectedItemName) {
    if (!this.bot || !this.bot.inventory) return false;
    let item = null;
    if (this.bot.inventory.slots) {
      item = this.bot.inventory.slots[slotIndex];
    }
    if (!item && typeof this.bot.inventory.items === 'function') {
      item = this.bot.inventory.items().find(i => i.slot === slotIndex);
    }
    if (!item || !item.name) return false;
    return item.name.toLowerCase().includes(expectedItemName.toLowerCase());
  }

  validateRoleSlot(role, profileKey = 'NETHPOT') {
    const roleKey = role === 'PRIMARY_WEAPON' ? 'mainWeapon' :
                    role === 'GAPPLE' ? 'goldenApples' :
                    role === 'SPEED_POTION' ? 'speedPotion' :
                    role === 'STRENGTH_POTION' ? 'strengthPotion' :
                    role === 'HEAL_POTION_1' ? 'healingPotion' :
                    role === 'PEARL' ? 'enderPearls' : role;
    const itemData = this.findItemByRole(roleKey, profileKey);
    return Boolean(itemData && itemData.slot != null);
  }

  /**
   * Resolves canonical layout name based on profile key or gamemode.
   */
  resolveLayoutName(profileKey) {
    const raw = String(profileKey || '').toUpperCase().trim();
    if (raw.includes('NETHPOT') || raw.includes('POT') || raw.includes('NODEBUFF')) return 'NETHPOT_LAYOUT';
    if (raw.includes('SWORD') || raw.includes('CLASSIC') || raw.includes('BOXING') || raw.includes('SMP')) return 'SWORD_LAYOUT';
    if (raw.includes('CRYSTAL') || raw.includes('CPVP')) return 'CRYSTAL_LAYOUT';
    if (raw.includes('ELYTRA_MACE') || raw.includes('MACEROCKET') || raw.includes('MACE_ROCKET')) return 'MACE_ROCKET_LAYOUT';
    if (raw.includes('SPEAR_ELYTRA') || raw.includes('SPEARELYTRA')) return 'SPEAR_ELYTRA_LAYOUT';
    if (raw.includes('SPEAR_MACE') || raw.includes('SPEARMACE')) return 'SPEAR_MACE_LAYOUT';
    if (raw.includes('MACE')) return 'MACE_LAYOUT';
    return 'NETHPOT_LAYOUT';
  }

  /**
   * Retrieves preset layout definition.
   */
  getLayout(profileOrLayoutName) {
    const resolved = this.resolveLayoutName(profileOrLayoutName);
    return this.presets[resolved] || this.presets.NETHPOT_LAYOUT;
  }

  /**
   * Scans live inventory and maps actual items to layout roles.
   */
  scanLiveInventory(profileKey) {
    const layout = this.getLayout(profileKey);
    const mapped = {};
    const missing = [];

    if (!this.bot || !this.bot.inventory) {
      return { ready: false, layout: layout.name, mapped, missing: layout.requiredRoles };
    }

    const items = typeof this.bot.inventory.items === 'function' ? this.bot.inventory.items() : [];

    // Map each role to matching live item
    for (const [role, acceptedNames] of Object.entries(layout.roles)) {
      const matchedItem = items.find(item => {
        if (!item || !item.name) return false;
        const itemName = item.name.toLowerCase();

        // Check name match
        const matchesName = acceptedNames.some(acc => itemName.includes(acc.toLowerCase()));
        if (!matchesName) return false;

        // Specific sub-type validation for potions
        if (role === 'healingPotion') {
          return this.isHealingPotion(item);
        }
        if (role === 'speedPotion') {
          return this.isSpeedPotion(item);
        }
        if (role === 'strengthPotion') {
          return this.isStrengthPotion(item);
        }

        return true;
      });

      if (matchedItem) {
        mapped[role] = {
          slot: matchedItem.slot,
          name: matchedItem.name,
          count: matchedItem.count || 1,
          item: matchedItem
        };
      }
    }

    // Check required items
    for (const req of layout.requiredRoles) {
      if (!mapped[req]) {
        missing.push(req);
      }
    }

    return {
      ready: missing.length === 0,
      layout: layout.name,
      profile: layout.profile,
      mapped,
      missing
    };
  }

  /**
   * Helper: validates if item is specifically a Healing potion.
   */
  isHealingPotion(item) {
    if (!item || !item.name) return false;
    const name = item.name.toLowerCase();
    if (!name.includes('potion')) return false;

    let nbtVal = '';
    try {
      nbtVal = String(item.nbt?.value?.Potion?.value || '').toLowerCase();
    } catch {}

    const disp = (item.displayName || '').toLowerCase();
    const text = `${name} ${disp} ${nbtVal}`;
    return text.includes('heal') || text.includes('health') || (!text.includes('speed') && !text.includes('strength'));
  }

  isSpeedPotion(item) {
    if (!item || !item.name) return false;
    const name = item.name.toLowerCase();
    if (!name.includes('potion')) return false;

    let nbtVal = '';
    try {
      nbtVal = String(item.nbt?.value?.Potion?.value || '').toLowerCase();
    } catch {}

    const disp = (item.displayName || '').toLowerCase();
    const text = `${name} ${disp} ${nbtVal}`;
    return text.includes('speed') || text.includes('swiftness');
  }

  isStrengthPotion(item) {
    if (!item || !item.name) return false;
    const name = item.name.toLowerCase();
    if (!name.includes('potion')) return false;

    let nbtVal = '';
    try {
      nbtVal = String(item.nbt?.value?.Potion?.value || '').toLowerCase();
    } catch {}

    const disp = (item.displayName || '').toLowerCase();
    const text = `${name} ${disp} ${nbtVal}`;
    return text.includes('strength');
  }

  /**
   * Finds the exact live item for a specific role and verifies its identity.
   */
  findItemByRole(role, profileKey) {
    const scan = this.scanLiveInventory(profileKey);
    return scan.mapped[role] || null;
  }

  /**
   * Validates if a specific hotbar slot currently contains an item matching the expected role.
   */
  verifySlotRole(slotIndex, expectedRole, profileKey) {
    if (!this.bot || !this.bot.inventory) return false;
    const item = this.bot.inventory.slots[slotIndex];
    if (!item) return false;

    const layout = this.getLayout(profileKey);
    const acceptedNames = layout.roles[expectedRole] || [];
    const itemName = item.name.toLowerCase();

    return acceptedNames.some(acc => itemName.includes(acc.toLowerCase()));
  }

  /**
   * Pre-stages critical profile items into the hotbar before combat begins.
   */
  async preStageHotbar(profileKey) {
    if (!this.bot || !this.bot.inventory || typeof this.bot.clickWindow !== 'function') return false;

    const layout = this.getLayout(profileKey);
    const scan = this.scanLiveInventory(profileKey);
    if (!scan.ready) return false;

    // Hotbar slots in vanilla 1.14+ are 36 - 44
    for (const [quickbarIndexStr, role] of Object.entries(layout.preferredHotbar)) {
      const qIndex = parseInt(quickbarIndexStr, 10);
      const targetSlot = 36 + qIndex;
      const mappedRole = scan.mapped[role];

      if (mappedRole && mappedRole.slot !== targetSlot && mappedRole.slot < 36) {
        // Move item from main inventory into hotbar slot
        try {
          // Click source slot, click target slot, click source slot (swap)
          await this.bot.clickWindow(mappedRole.slot, 0, 0);
          await this.bot.clickWindow(targetSlot, 0, 0);
          if (this.bot.inventory.selectedItem) {
            await this.bot.clickWindow(mappedRole.slot, 0, 0);
          }
        } catch {}
      }
    }

    return true;
  }
}

module.exports = InventoryLayoutManager;
