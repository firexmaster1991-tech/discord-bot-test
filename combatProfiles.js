/**
 * Gamemode Tactical Combat Profiles for Mineflayer LT2 PvP Bot.
 * Provides specialized behavioral parameters and decision trees per gamemode.
 */

class BaseCombatProfile {
  constructor(name) {
    this.name = name;
    this.idealMinRange = 1.8;
    this.idealMaxRange = 3.0;
    this.chaseDistance = 3.4;
    this.allowJumpCrits = true;
    this.jumpCritOnlyWhileFalling = true;
    this.preventVoidDrops = false;
    this.sprintOnAttack = true;
    this.strafeFrequencyTicks = 10;
    this.preferAxeAgainstShield = true;
    this.healThresholdHP = 10;
    this.targetAimHeight = 1.4;
  }

  /**
   * Evaluates combat state and determines next movement and attack action.
   */
  decideMovementState(dist, health, target, isCollidedHorizontally, options = {}) {
    // Low health: Disengage / Retreat to recover/pot ONLY IF potions/healing are available!
    if (health != null && health <= this.healThresholdHP && options.hasPotionsToHeal !== false && !options.outOfPotions) {
      if (dist < 3.5) return 'RETREAT';
      return 'DISENGAGE';
    }

    // Aggressive advantage: If opponent is retreating or knocked back, chase relentlessly
    if (options.opponentRetreating || (options.opponentLow && dist > this.idealMinRange)) {
      return 'CHASE';
    }

    // Opponent far: Chase
    if (dist > this.chaseDistance) {
      return 'CHASE';
    }

    // In approach zone (3.0 - 3.4m)
    if (dist > this.idealMaxRange) {
      return 'APPROACH';
    }

    // Close strike zone (1.8m - 3.0m)
    if (dist >= this.idealMinRange) {
      if (options.combatPhase === 'CRIT' && this.allowJumpCrits) {
        return 'CRITICAL_SETUP';
      }
      if (options.combatPhase === 'COMBO' || options.aggressive) {
        return 'COMBO_PRESSURE';
      }
      return Math.random() < 0.5 ? 'STRAFE_LEFT' : 'STRAFE_RIGHT';
    }

    // Too close (< idealMinRange): Never walk backwards into walls/corners! Flank around with REPOSITION
    return 'REPOSITION';
  }
}

/**
 * BOXING PROFILE:
 * - Constant spacing (2.0 - 2.8m)
 * - Intense strafe cycling (every 6-8 ticks)
 * - Minimal / no jumping to maintain peak ground acceleration & combo speed
 * - High sprint uptime
 */
class BoxingProfile extends BaseCombatProfile {
  constructor() {
    super('Boxing');
    this.idealMinRange = 2.0;
    this.idealMaxRange = 2.8;
    this.chaseDistance = 3.2;
    this.allowJumpCrits = false; // Jumping slows combo momentum in Boxing
    this.strafeFrequencyTicks = 6;
    this.healThresholdHP = 0; // No healing in boxing
  }

  decideMovementState(dist, health, target, isCollidedHorizontally, options = {}) {
    if (dist > this.chaseDistance) return 'CHASE';
    if (dist > this.idealMaxRange) return 'APPROACH';
    if (dist >= this.idealMinRange) {
      return 'COMBO_PRESSURE';
    }
    return 'REPOSITION';
  }
}

/**
 * NODEBUFF / NETHPOT PROFILE:
 * - High aggression W-tap / D-tap combos
 * - Double-pot threshold at <= 10 HP
 * - Falling-apex crit chaining (vy < -0.04)
 * - Automatic full inventory pot access
 */
class NoDebuffProfile extends BaseCombatProfile {
  constructor() {
    super('NoDebuff');
    this.idealMinRange = 1.7;
    this.idealMaxRange = 3.1;
    this.chaseDistance = 3.5;
    this.allowJumpCrits = true;
    this.jumpCritOnlyWhileFalling = true;
    this.healThresholdHP = 10;
    this.strafeFrequencyTicks = 8;
  }

  decideMovementState(dist, health, target, isCollidedHorizontally, options = {}) {
    // Immediate retreat/disengage if low HP to throw splash potions safely (only if potions available)
    if (health != null && health <= this.healThresholdHP && options.hasPotionsToHeal !== false && !options.outOfPotions) {
      return dist < 3.2 ? 'RETREAT' : 'DISENGAGE';
    }

    if (options.opponentRetreating || (options.opponentLow && dist > this.idealMinRange)) {
      return 'CHASE';
    }

    if (dist > this.chaseDistance) return 'CHASE';
    if (dist > this.idealMaxRange) return 'APPROACH';

    if (dist >= this.idealMinRange) {
      if (options.combatPhase === 'CRIT' && this.allowJumpCrits) {
        return 'CRITICAL_SETUP';
      }
      return 'COMBO_PRESSURE';
    }
    return 'REPOSITION';
  }
}

/**
 * SUMO PROFILE:
 * - Extreme edge and void awareness
 * - Never walks off platform
 * - Prioritizes center ring positioning and knockback maximization
 * - High ground friction, strictly avoids jumping near edges
 */
class SumoProfile extends BaseCombatProfile {
  constructor() {
    super('Sumo');
    this.idealMinRange = 1.9;
    this.idealMaxRange = 2.9;
    this.chaseDistance = 3.2;
    this.allowJumpCrits = false; // Jumps make you take massive knockback in Sumo
    this.preventVoidDrops = true; // Crucial for Sumo platform edge
    this.healThresholdHP = 0;
  }

  decideMovementState(dist, health, target, isCollidedHorizontally) {
    if (dist > this.chaseDistance) return 'CHASE';
    if (dist > this.idealMaxRange) return 'APPROACH';
    if (dist >= this.idealMinRange) {
      return Math.random() < 0.5 ? 'STRAFE_LEFT' : 'STRAFE_RIGHT';
    }
    return 'CIRCLE';
  }
}

/**
 * CLASSIC / SMP PROFILE:
 * - Shield disabling with axes
 * - Controlled spacing (2.2 - 3.2m)
 * - True 150% crits on falling apex
 */
class ClassicProfile extends BaseCombatProfile {
  constructor() {
    super('Classic');
    this.idealMinRange = 2.1;
    this.idealMaxRange = 3.2;
    this.chaseDistance = 3.6;
    this.allowJumpCrits = true;
    this.preferAxeAgainstShield = true;
    this.healThresholdHP = 12; // Gapple threshold
  }
}

/**
 * CRYSTAL PVP PROFILE:
 * - Spacing for obsidian & crystal placement
 * - Totem of undying off-hand vigilance
 */
class CrystalProfile extends BaseCombatProfile {
  constructor() {
    super('CrystalPVP');
    this.idealMinRange = 2.4;
    this.idealMaxRange = 4.2;
    this.chaseDistance = 4.5;
    this.allowJumpCrits = false;
    this.healThresholdHP = 14;
  }

  decideMovementState(dist, health, target, isCollidedHorizontally) {
    if (health != null && health <= this.healThresholdHP) return 'RETREAT';
    if (dist > this.chaseDistance) return 'CHASE';
    if (dist < this.idealMinRange) return 'CPVP_POSITION';
    return 'REPOSITION';
  }
}

/**
 * MACE PVP PROFILE:
 * - Mace attack cooldown (1667ms)
 * - Jump smash timing
 */
class MaceProfile extends BaseCombatProfile {
  constructor() {
    super('MacePVP');
    this.idealMinRange = 2.0;
    this.idealMaxRange = 3.2;
    this.chaseDistance = 3.8;
    this.allowJumpCrits = true;
  }
}

/**
 * Profile factory mapping all server gamemodes to their specialized profiles.
 */
function getCombatProfile(gamemode) {
  const mode = String(gamemode || '').toLowerCase().trim();

  if (mode.includes('boxing')) {
    return new BoxingProfile();
  }
  if (mode.includes('nethpot') || mode.includes('pot') || mode.includes('nodebuff')) {
    return new NoDebuffProfile();
  }
  if (mode.includes('sumo')) {
    return new SumoProfile();
  }
  if (mode.includes('crystal')) {
    return new CrystalProfile();
  }
  if (mode.includes('mace')) {
    return new MaceProfile();
  }
  if (mode.includes('classic') || mode.includes('smp') || mode.includes('diasmp') || mode.includes('axe')) {
    return new ClassicProfile();
  }
  if (mode.includes('bridge')) {
    const p = new BaseCombatProfile('Bridge');
    p.preventVoidDrops = true;
    return p;
  }

  return new BaseCombatProfile('Default');
}

/**
 * Detects whether the Minecraft connection is using Classic 1.8 combat or Modern Java cooldown combat.
 * Prioritizes explicit server profile overrides, then inspects Mineflayer bot version/protocol.
 */
function detectCombatVersion(bot = null, serverProfile = null) {
  // 1. Explicit server profile override
  if (serverProfile) {
    if (serverProfile.combatVersion) {
      const cv = String(serverProfile.combatVersion).toLowerCase().trim();
      if (cv.includes('1.8') || cv === 'classic') return 'classic';
      if (cv.includes('1.9') || cv.includes('1.20') || cv === 'modern') return 'modern';
    }
    if (serverProfile.classicPvP === true) {
      return 'classic';
    }
  }

  // 2. Mineflayer bot connection protocol / version
  if (bot) {
    const ver = String(bot.version || '').trim();
    if (ver.startsWith('1.8') || ver.startsWith('1.7')) {
      return 'classic';
    }
    if (bot.protocolVersion && bot.protocolVersion < 107) {
      return 'classic';
    }
  }

  // Default to modern Java 1.9+ (1.20.4 on StaticPvP)
  return 'modern';
}

/**
 * Modern Java attack speed values (attacks per second).
 * Based on vanilla Minecraft item attribute definitions.
 */
const WEAPON_ATTACK_SPEEDS = {
  // Swords (1.6 attack speed -> 12.5 ticks = 625ms recovery)
  'wooden_sword': 1.6,
  'stone_sword': 1.6,
  'iron_sword': 1.6,
  'golden_sword': 1.6,
  'diamond_sword': 1.6,
  'netherite_sword': 1.6,

  // Tridents (1.1 attack speed -> 18.2 ticks = 909ms)
  'trident': 1.1,

  // Pickaxes (1.2 attack speed -> 16.7 ticks = 833ms)
  'wooden_pickaxe': 1.2,
  'stone_pickaxe': 1.2,
  'iron_pickaxe': 1.2,
  'golden_pickaxe': 1.2,
  'diamond_pickaxe': 1.2,
  'netherite_pickaxe': 1.2,

  // Shovels (1.0 attack speed -> 20 ticks = 1000ms)
  'wooden_shovel': 1.0,
  'stone_shovel': 1.0,
  'iron_shovel': 1.0,
  'golden_shovel': 1.0,
  'diamond_shovel': 1.0,
  'netherite_shovel': 1.0,

  // Axes (0.8 - 1.0 attack speed)
  'wooden_axe': 0.8,
  'stone_axe': 0.8,
  'copper_axe': 0.8,
  'iron_axe': 0.9,
  'golden_axe': 1.0,
  'diamond_axe': 1.0,
  'netherite_axe': 1.0,

  // Mace (0.6 attack speed -> 33.3 ticks = 1667ms)
  'mace': 0.6,

  // Hoes (1.0 - 4.0 attack speed)
  'wooden_hoe': 1.0,
  'golden_hoe': 1.0,
  'stone_hoe': 2.0,
  'copper_hoe': 2.0,
  'iron_hoe': 3.0,
  'diamond_hoe': 4.0,
  'netherite_hoe': 4.0,

  // Unarmed / Hand / Default
  'hand': 4.0,
  'default': 4.0
};

/**
 * Determines attack speed for a held item, inspecting registry if available.
 */
function getWeaponAttackSpeed(itemName, registry = null) {
  if (!itemName) return 4.0;
  const name = String(itemName).toLowerCase().replace('minecraft:', '').trim();

  // 1. Direct table match
  if (WEAPON_ATTACK_SPEEDS[name] !== undefined) {
    return WEAPON_ATTACK_SPEEDS[name];
  }

  // 2. Pattern matching
  if (name.includes('sword')) return 1.6;
  if (name.includes('mace')) return 0.6;
  if (name.includes('trident')) return 1.1;
  if (name.includes('pickaxe')) return 1.2;
  if (name.includes('shovel')) return 1.0;
  if (name.includes('axe')) {
    if (name.includes('wood') || name.includes('stone') || name.includes('copper')) return 0.8;
    if (name.includes('iron')) return 0.9;
    return 1.0;
  }
  if (name.includes('hoe')) {
    if (name.includes('diamond') || name.includes('netherite')) return 4.0;
    if (name.includes('iron')) return 3.0;
    if (name.includes('stone') || name.includes('copper')) return 2.0;
    return 1.0;
  }

  return 4.0;
}

/**
 * Calculates attack recovery time in milliseconds.
 * In Modern Java: fullRecoveryTicks = 20 / attackSpeed -> ms = (20 / attackSpeed) * 50
 * In Classic 1.8: returns classic click timing (~80-110ms / ~10-12 CPS)
 */
function getWeaponRecoveryMs(itemName, combatVersion = 'modern', registry = null) {
  if (combatVersion === 'classic') {
    // Humanized Classic 1.8 click timing: 85ms - 110ms (~9 - 12 CPS)
    return 85 + Math.floor(Math.random() * 25);
  }

  const attackSpeed = getWeaponAttackSpeed(itemName, registry);
  const recoveryTicks = 20 / attackSpeed;
  return Math.round(recoveryTicks * 50);
}

/**
 * Evaluates whether the weapon attack is fully recovered (100% cooldown ready).
 */
function isAttackReady(lastAttackTime, itemName, combatVersion = 'modern', now = Date.now(), registry = null) {
  const recoveryMs = getWeaponRecoveryMs(itemName, combatVersion, registry);
  return (now - lastAttackTime) >= recoveryMs;
}

module.exports = {
  BaseCombatProfile,
  BoxingProfile,
  NoDebuffProfile,
  SumoProfile,
  ClassicProfile,
  CrystalProfile,
  MaceProfile,
  getCombatProfile,
  detectCombatVersion,
  WEAPON_ATTACK_SPEEDS,
  getWeaponAttackSpeed,
  getWeaponRecoveryMs,
  isAttackReady
};
