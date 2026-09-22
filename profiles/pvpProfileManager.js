const NethPotProfile = require('./nethPotProfile');
const SwordProfile = require('./swordProfile');
const CrystalProfile = require('./crystalProfile');
const MaceProfile = require('./maceProfile');
const ElytraMaceProfile = require('./elytraMaceProfile');
const SpearElytraProfile = require('./spearElytraProfile');
const SpearMaceProfile = require('./spearMaceProfile');
const InventoryLayoutManager = require('../inventoryLayoutManager');

/**
 * Authoritative PvP Profile Manager.
 * 
 * Manages all 7 dedicated gamemode profiles:
 * 1. NETHPOT (Critical-heavy, short combos, smart splash potions)
 * 2. SWORD (Combo-heavy, outspacing 2.4m - 2.85m, dynamic strafing, occasional crits)
 * 3. CRYSTAL (CPvP, 12-state CrystalController, line-of-sight validation, anchor, totem, pearl)
 * 4. MACE (10-state MaceController, wind charge launch, MACE_EQUIP_LOCK, falling smash)
 * 5. ELYTRA_MACE (11-state ElytraMaceController, flight, rocket approach, equipment swap, dive smash)
 * 6. SPEAR_ELYTRA (Aerial glide, kinetic spear thrust, rocket control)
 * 7. SPEAR_MACE (Hybrid spear poke, wind charge launch, falling mace finisher)
 * 
 * Ensures STRICT PROFILE ISOLATION:
 * No profile may execute actions or leak state logic into another.
 */
class PvPProfileManager {
  constructor(context = {}) {
    this.context = context;
    this.layoutManager = new InventoryLayoutManager(context.bot);
    this.context.layoutManager = this.layoutManager;

    // Instantiate all 7 isolated profiles
    this.profiles = {
      NETHPOT: new NethPotProfile(this.context),
      SWORD: new SwordProfile(this.context),
      CRYSTAL: new CrystalProfile(this.context),
      MACE: new MaceProfile(this.context),
      ELYTRA_MACE: new ElytraMaceProfile(this.context),
      SPEAR_ELYTRA: new SpearElytraProfile(this.context),
      SPEAR_MACE: new SpearMaceProfile(this.context)
    };

    // Default to NethPot
    this.activeProfileKey = 'NETHPOT';
    this.activeProfile = this.profiles.NETHPOT;
    this.lastPreflightResult = null;
  }

  setContext(context) {
    this.context = context;
    if (context.bot) {
      this.layoutManager.setBot(context.bot);
    }
    this.context.layoutManager = this.layoutManager;

    for (const profile of Object.values(this.profiles)) {
      profile.setContext(context);
    }
  }

  getProfile(name) {
    const key = this.resolveProfileKey(name);
    return this.profiles[key] || this.profiles[name] || null;
  }

  /**
   * Resolves gamemode string or alias to canonical profile key.
   */
  resolveProfileKey(gamemode) {
    const raw = String(gamemode || '').toLowerCase().trim();

    if (raw.includes('nethpot') || raw.includes('pot') || raw.includes('nodebuff')) {
      return 'NETHPOT';
    }
    if (raw.includes('crystal') || raw.includes('cpvp')) {
      return 'CRYSTAL';
    }
    if (raw.includes('spearelytra') || raw.includes('spear_elytra')) {
      return 'SPEAR_ELYTRA';
    }
    if (raw.includes('spearmace') || raw.includes('spear_mace')) {
      return 'SPEAR_MACE';
    }
    if (raw.includes('elytra') || raw.includes('macerocket') || raw.includes('mace_rocket') || raw.includes('elytramace')) {
      return 'ELYTRA_MACE';
    }
    if (raw.includes('mace') || raw.includes('macepvp')) {
      return 'MACE';
    }
    if (raw.includes('sword') || raw.includes('smp') || raw.includes('diasmp') || raw.includes('boxing') || raw.includes('classic') || raw.includes('axe')) {
      return 'SWORD';
    }

    return 'NETHPOT'; // Default
  }

  setProfile(gamemode) {
    return this.setActiveProfile(gamemode);
  }

  /**
   * Activates a specific combat profile based on gamemode.
   * Completely purges previous profile state before initializing new profile.
   */
  setActiveProfile(gamemode) {
    const key = this.resolveProfileKey(gamemode);
    if (this.activeProfileKey === key && this.activeProfile) {
      return this.activeProfile;
    }

    // 1. Cleanly stop old profile
    if (this.activeProfile && typeof this.activeProfile.stopCombat === 'function') {
      this.activeProfile.stopCombat();
    }

    // 2. Clear movement and action locks
    if (this.context.movementController) {
      this.context.movementController.clearAllControls();
      this.context.movementController.setState('IDLE');
    }

    // 3. Switch to new profile
    this.activeProfileKey = key;
    this.activeProfile = this.profiles[key];

    // 4. Print mandatory Section 5 Profile Verification lines
    const layout = this.layoutManager.resolveLayoutName(key);
    console.log(`\nPROFILE LOADED:\n${this.activeProfile.name}`);
    console.log(`LAYOUT LOADED:\n${layout}`);
    console.log(`ACTION SYSTEM:\nREADY\n`);

    return this.activeProfile;
  }

  getActiveProfile() {
    return this.activeProfile;
  }

  getActiveProfileKey() {
    return this.activeProfileKey;
  }

  get activeProfileName() {
    return this.activeProfile ? this.activeProfile.name : this.activeProfileKey;
  }

  /**
   * Performs Section 6 preflight check on active profile before combat begins.
   */
  async preflight() {
    if (!this.activeProfile) {
      return { success: false, missing: ['No active profile selected'], reason: 'No profile loaded' };
    }

    this.lastPreflightResult = await this.activeProfile.preflight();
    const layout = this.layoutManager.resolveLayoutName(this.activeProfileKey);

    console.log(`\nPROFILE LOADED:\n${this.activeProfile.name}`);
    console.log(`LAYOUT LOADED:\n${layout}`);
    console.log(`ACTION SYSTEM:\n${this.lastPreflightResult.success ? 'READY' : 'FAILED'}\n`);

    if (!this.lastPreflightResult.success) {
      console.warn(`⚠️ [PREFLIGHT_FAILED] ${this.lastPreflightResult.reason}`);
      if (this.context.onPreflightFailure) {
        this.context.onPreflightFailure(this.lastPreflightResult);
      }
    }

    return this.lastPreflightResult;
  }

  startCombat(target) {
    if (this.activeProfile && typeof this.activeProfile.startCombat === 'function') {
      this.activeProfile.startCombat(target);
    }
  }

  update(target, dist, currentHealth, targetHealth, isCooldownReady, now = Date.now()) {
    if (this.activeProfile && typeof this.activeProfile.update === 'function') {
      this.activeProfile.update(target, dist, currentHealth, targetHealth, isCooldownReady, now);
    }
  }

  stopCombat() {
    if (this.activeProfile && typeof this.activeProfile.stopCombat === 'function') {
      this.activeProfile.stopCombat();
    }
  }

  /**
   * Section 35: Profile Debug Dashboard.
   */
  getDebugStatus(target = null) {
    if (this.activeProfile && typeof this.activeProfile.getDebugStatus === 'function') {
      const status = this.activeProfile.getDebugStatus(target);
      return {
        ...status,
        activeProfile: this.activeProfileName,
        profile: this.activeProfileName
      };
    }
    return {
      activeProfile: this.activeProfileKey,
      profile: this.activeProfileKey,
      state: 'IDLE',
      target: target ? target.username || 'target' : 'none',
      action: 'NONE',
      attackReady: false
    };
  }
}

module.exports = PvPProfileManager;
