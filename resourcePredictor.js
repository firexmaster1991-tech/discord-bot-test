/**
 * Resource Predictor & Pre-Combat Inventory Stager.
 * 
 * Responsibilities:
 * 1. Tracks inventory counts of all PvP items:
 *    - weapons (sword, axe, mace)
 *    - potions (healing, strength, speed)
 *    - golden apples
 *    - crystals, obsidian, anchors, glowstone
 *    - totems of undying, ender pearls
 *    - wind charges, fireworks, elytra, chestplate
 * 2. Pre-stages required items into hotbar slots before engagement.
 * 3. Adapts strategy when resources run low.
 */
class ResourcePredictor {
  constructor(bot = null) {
    this.bot = bot;
    this.counts = {
      swords: 0,
      axes: 0,
      maces: 0,
      healingPotions: 0,
      strengthPotions: 0,
      speedPotions: 0,
      goldenApples: 0,
      crystals: 0,
      obsidian: 0,
      anchors: 0,
      glowstone: 0,
      totems: 0,
      pearls: 0,
      windCharges: 0,
      rockets: 0,
      elytra: 0,
      chestplate: 0
    };
  }

  setBot(bot) {
    this.bot = bot;
  }

  /**
   * Scans entire inventory and updates resource counts.
   */
  scanResources() {
    // Reset counts
    for (const key of Object.keys(this.counts)) {
      this.counts[key] = 0;
    }

    if (!this.bot || !this.bot.inventory) return this.counts;
    const items = typeof this.bot.inventory.items === 'function' ? this.bot.inventory.items() : [];

    for (const item of items) {
      if (!item || !item.name) continue;
      const name = item.name.toLowerCase();
      const count = item.count || 1;

      if (name.includes('sword')) this.counts.swords += count;
      else if (name.includes('axe')) this.counts.axes += count;
      else if (name.includes('mace')) this.counts.maces += count;
      else if (name.includes('totem')) this.counts.totems += count;
      else if (name.includes('ender_pearl')) this.counts.pearls += count;
      else if (name.includes('golden_apple')) this.counts.goldenApples += count;
      else if (name.includes('end_crystal')) this.counts.crystals += count;
      else if (name.includes('obsidian')) this.counts.obsidian += count;
      else if (name.includes('respawn_anchor')) this.counts.anchors += count;
      else if (name.includes('glowstone')) this.counts.glowstone += count;
      else if (name.includes('wind_charge')) this.counts.windCharges += count;
      else if (name.includes('firework')) this.counts.rockets += count;
      else if (name.includes('elytra')) this.counts.elytra += count;
      else if (name.includes('chestplate')) this.counts.chestplate += count;
      else if (name.includes('potion') || name.includes('bottle')) {
        const disp = (item.displayName || '').toLowerCase();
        let nbtPotion = '';
        try {
          nbtPotion = String(item.nbt?.value?.Potion?.value || '').toLowerCase();
        } catch {}
        const text = `${name} ${disp} ${nbtPotion}`;
        if (text.includes('heal') || text.includes('health')) this.counts.healingPotions += count;
        else if (text.includes('strength')) this.counts.strengthPotions += count;
        else if (text.includes('speed') || text.includes('swiftness')) this.counts.speedPotions += count;
        else this.counts.healingPotions += count; // Default fallback for untagged combat potions
      }
    }

    return this.counts;
  }

  scanInventory() {
    this.scanResources();
    return {
      ...this.counts,
      potionsCount: this.counts.healingPotions + this.counts.strengthPotions + this.counts.speedPotions,
      totemCount: this.counts.totems,
      gapplesCount: this.counts.goldenApples
    };
  }

  hasLowResources(gamemode = 'NethPot') {
    this.scanResources();
    const mode = String(gamemode).toLowerCase();

    if (mode.includes('nethpot') || mode.includes('pot')) {
      return this.counts.healingPotions <= 2 && this.counts.goldenApples <= 1;
    }
    if (mode.includes('crystal')) {
      return this.counts.crystals <= 4 || this.counts.totems <= 1;
    }
    if (mode.includes('mace')) {
      return this.counts.windCharges <= 1;
    }
    if (mode.includes('elytra')) {
      return this.counts.rockets <= 2;
    }
    return false;
  }
}

module.exports = ResourcePredictor;
