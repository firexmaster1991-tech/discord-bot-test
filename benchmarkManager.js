/**
 * PvP Benchmark & Telemetry Manager for Mineflayer Combat Engine.
 * 
 * Collects per-match performance statistics to measure actual combat effectiveness:
 * - Accuracy, hits landed, critical hit rate, combo lengths
 * - Average engagement spacing, hitbox overlap duration
 * - Anti-stuck and corner event tracking
 * - TPS tracking
 * - PVP_DEBUG structured output
 */
class BenchmarkManager {
  constructor(options = {}) {
    this.debug = process.env.PVP_DEBUG === 'true' || options.debug === true;
    this.reset();

    // TPS monitoring
    this.lastTickTime = Date.now();
    this.tpsSamples = [];
    this.currentTps = 20.0;
  }

  reset() {
    this.matchStartTime = Date.now();
    this.attacksAttempted = 0;
    this.hitsLanded = 0;
    this.criticalAttempts = 0;
    this.criticalSuccesses = 0;

    this.currentCombo = 0;
    this.maxCombo = 0;

    this.distanceSamples = [];
    this.timeInsideMinDistanceMs = 0;
    this.insideMinStart = 0;

    this.timeStationaryMs = 0;
    this.stationaryStart = 0;

    this.cornerEvents = 0;
    this.stuckEvents = 0;
    this.successfulHeals = 0;
    this.failedItemSwitches = 0;

    this.damageDealt = 0;
    this.damageReceived = 0;
    this.currentOpponent = 'Unknown';
    this.currentGamemode = 'Practice';
  }

  startMatch(opponent = 'Unknown', gamemode = 'Practice') {
    this.reset();
    this.currentOpponent = opponent;
    this.currentGamemode = gamemode;
  }

  endMatch(result = 'FINISHED') {
    const summary = this.getSummary();
    return {
      opponent: this.currentOpponent,
      gamemode: this.currentGamemode,
      result,
      attacksAttempted: this.attacksAttempted,
      hitsLanded: this.hitsLanded,
      accuracy: this.attacksAttempted > 0 ? (this.hitsLanded / this.attacksAttempted) * 100 : 0,
      critsLanded: this.criticalSuccesses,
      maxCombo: this.maxCombo,
      summary
    };
  }

  recordAttackAttempt(type = 'NORMAL') {
    this.recordAttack(type);
  }

  recordComboStreak(combo) {
    this.currentCombo = combo;
    if (this.currentCombo > this.maxCombo) {
      this.maxCombo = this.currentCombo;
    }
  }

  recordDistanceSample(dist) {
    this.recordDistance(dist);
  }

  recordAttack(type = 'NORMAL') {
    this.attacksAttempted++;
    if (type.includes('CRIT')) {
      this.criticalAttempts++;
    }
  }

  recordHitLanded(isCrit = false, dmg = 3.5) {
    this.hitsLanded++;
    this.currentCombo++;
    if (this.currentCombo > this.maxCombo) {
      this.maxCombo = this.currentCombo;
    }
    if (isCrit) {
      this.criticalSuccesses++;
    }
    this.damageDealt += dmg;
  }

  recordHitReceived(dmg = 3.0) {
    this.damageReceived += dmg;
    this.currentCombo = 0; // Combo broken by taking hit
  }

  recordDistance(dist) {
    if (dist > 0 && dist < 30) {
      this.distanceSamples.push(dist);
      if (this.distanceSamples.length > 200) {
        this.distanceSamples.shift();
      }
    }

    const now = Date.now();
    if (dist < 1.6) {
      if (!this.insideMinStart) this.insideMinStart = now;
    } else {
      if (this.insideMinStart) {
        this.timeInsideMinDistanceMs += (now - this.insideMinStart);
        this.insideMinStart = 0;
      }
    }
  }

  recordStationary(isStationary) {
    const now = Date.now();
    if (isStationary) {
      if (!this.stationaryStart) this.stationaryStart = now;
    } else {
      if (this.stationaryStart) {
        this.timeStationaryMs += (now - this.stationaryStart);
        this.stationaryStart = 0;
      }
    }
  }

  recordCornerEvent() { this.cornerEvents++; }
  recordStuckEvent() { this.stuckEvents++; }
  recordHeal() { this.successfulHeals++; }
  recordFailedSwitch() { this.failedItemSwitches++; }

  updateTps() {
    const now = Date.now();
    const delta = now - this.lastTickTime;
    this.lastTickTime = now;

    if (delta > 0) {
      const instantTps = Math.min(20, 1000 / delta);
      this.tpsSamples.push(instantTps);
      if (this.tpsSamples.length > 20) this.tpsSamples.shift();
      this.currentTps = this.tpsSamples.reduce((a, b) => a + b, 0) / this.tpsSamples.length;
    }
  }

  getSummary() {
    const avgDist = this.distanceSamples.length > 0
      ? (this.distanceSamples.reduce((a, b) => a + b, 0) / this.distanceSamples.length).toFixed(2)
      : '0.00';
    const accuracy = this.attacksAttempted > 0
      ? ((this.hitsLanded / this.attacksAttempted) * 100).toFixed(1)
      : '0.0';
    const critRate = this.criticalAttempts > 0
      ? ((this.criticalSuccesses / this.criticalAttempts) * 100).toFixed(1)
      : '0.0';

    return {
      attacksAttempted: this.attacksAttempted,
      hitsLanded: this.hitsLanded,
      accuracy: `${accuracy}%`,
      criticalAttempts: this.criticalAttempts,
      criticalSuccesses: this.criticalSuccesses,
      critRate: `${critRate}%`,
      maxCombo: this.maxCombo,
      avgDistance: `${avgDist}m`,
      timeInsideMinDistance: `${(this.timeInsideMinDistanceMs / 1000).toFixed(2)}s`,
      timeStationary: `${(this.timeStationaryMs / 1000).toFixed(2)}s`,
      cornerEvents: this.cornerEvents,
      stuckEvents: this.stuckEvents,
      successfulHeals: this.successfulHeals,
      failedItemSwitches: this.failedItemSwitches,
      damageDealt: this.damageDealt.toFixed(1),
      damageReceived: this.damageReceived.toFixed(1),
      serverTps: this.currentTps.toFixed(1)
    };
  }

  logDebug(state, target, dist, action) {
    if (!this.debug) return;
    console.log(`[PVP_DEBUG] State: ${state} | Target: ${target ? target.username || 'none' : 'none'} | Dist: ${dist.toFixed(2)}m | Action: ${action} | TPS: ${this.currentTps.toFixed(1)}`);
  }
}

module.exports = BenchmarkManager;
