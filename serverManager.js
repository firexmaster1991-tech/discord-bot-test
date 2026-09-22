const fs = require('fs');
const path = require('path');

const SERVERS_FILE = path.join(__dirname, 'servers.json');

// Default starter profile for StaticPvP
const DEFAULT_CONFIG = {
  selectedServer: 'StaticPvP',
  servers: {
    'StaticPvP': {
      name: 'StaticPvP',
      host: 'staticpvp.fun',
      port: 25565,
      version: '1.20.4',
      practiceMethod: 'gui',
      practiceSlot: 4,
      practiceItem: 'purple_bed',
      practiceCommand: '/practice',
      duelMethod: 'command',
      duelCommand: '/duel {player}',
      queueMethod: 'gui',
      queueSlot: 0,
      gamemodeAliases: {}
    }
  }
};

class ServerManager {
  constructor(filePath = SERVERS_FILE) {
    this.filePath = filePath;
    this.data = { selectedServer: null, servers: {} };
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.data = JSON.parse(raw);
        if (!this.data.servers) this.data.servers = {};
      } else {
        // Create initial file with starter server
        this.data = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        this.save();
      }
    } catch (err) {
      console.error('⚠️ Warning: Failed to parse servers.json, falling back to default:', err.message);
      this.data = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      this.save();
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempPath, this.filePath);
      return true;
    } catch (err) {
      console.error('❌ Failed to save servers.json:', err.message);
      return false;
    }
  }

  addServer(name, host, port = 25565, customOptions = {}) {
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return { success: false, message: '❌ Invalid server name.' };
    }
    if (!host || typeof host !== 'string' || host.trim() === '') {
      return { success: false, message: '❌ Invalid server host/IP.' };
    }

    const cleanName = name.trim();
    const cleanHost = host.trim();
    const cleanPort = parseInt(port, 10) || 25565;

    // Security check: NEVER store passwords, secrets, or tokens in servers.json
    const safeOptions = { ...customOptions };
    delete safeOptions.password;
    delete safeOptions.token;
    delete safeOptions.secret;
    delete safeOptions.auth;

    const existing = this.data.servers[cleanName];

    const serverProfile = {
      name: cleanName,
      host: cleanHost,
      port: cleanPort,
      version: safeOptions.version || (existing ? existing.version : null),
      practiceMethod: safeOptions.practiceMethod || (existing ? existing.practiceMethod : 'command'),
      practiceSlot: safeOptions.practiceSlot !== undefined ? safeOptions.practiceSlot : (existing ? existing.practiceSlot : 4),
      practiceItem: safeOptions.practiceItem || (existing ? existing.practiceItem : 'purple_bed'),
      practiceCommand: safeOptions.practiceCommand || (existing ? existing.practiceCommand : '/practice'),
      duelMethod: safeOptions.duelMethod || (existing ? existing.duelMethod : 'command'),
      duelCommand: safeOptions.duelCommand || (existing ? existing.duelCommand : '/duel {player}'),
      queueMethod: safeOptions.queueMethod || (existing ? existing.queueMethod : 'command'),
      queueSlot: safeOptions.queueSlot !== undefined ? safeOptions.queueSlot : (existing ? existing.queueSlot : 0),
      queueCommand: safeOptions.queueCommand || (existing ? existing.queueCommand : '/queue {gamemode}'),
      gamemodeAliases: safeOptions.gamemodeAliases || (existing ? existing.gamemodeAliases : {})
    };

    this.data.servers[cleanName] = serverProfile;

    // Auto-select if first server or if no server currently selected
    if (!this.data.selectedServer || !this.data.servers[this.data.selectedServer]) {
      this.data.selectedServer = cleanName;
    }

    this.save();
    return {
      success: true,
      server: serverProfile,
      message: `✅ Saved server **${cleanName}** (${cleanHost}:${cleanPort}).`
    };
  }

  removeServer(name) {
    if (!name || !this.data.servers[name]) {
      return { success: false, message: `⚠️ Server **${name}** not found in saved servers.` };
    }

    delete this.data.servers[name];

    if (this.data.selectedServer === name) {
      const keys = Object.keys(this.data.servers);
      this.data.selectedServer = keys.length > 0 ? keys[0] : null;
    }

    this.save();
    return {
      success: true,
      message: `🗑️ Removed server **${name}**.${this.data.selectedServer ? ` Active server is now **${this.data.selectedServer}**.` : ' No server currently selected.'}`
    };
  }

  selectServer(name) {
    if (!name) {
      return { success: false, message: '⚠️ Please specify a server name.' };
    }

    // Case-insensitive lookup
    const targetKey = Object.keys(this.data.servers).find(
      k => k.toLowerCase() === name.trim().toLowerCase()
    );

    if (!targetKey) {
      const available = Object.keys(this.data.servers).join(', ') || 'None';
      return {
        success: false,
        message: `⚠️ Server **${name}** not found. Available servers: ${available}`
      };
    }

    this.data.selectedServer = targetKey;
    this.save();

    const profile = this.data.servers[targetKey];
    return {
      success: true,
      server: profile,
      message: `✅ Selected server **${targetKey}** (${profile.host}:${profile.port}).`
    };
  }

  getSelectedServer() {
    if (!this.data.selectedServer) {
      const keys = Object.keys(this.data.servers);
      if (keys.length > 0) {
        this.data.selectedServer = keys[0];
        this.save();
      } else {
        return null;
      }
    }
    return this.data.servers[this.data.selectedServer] || null;
  }

  getServer(name) {
    if (!name) return null;
    const targetKey = Object.keys(this.data.servers).find(
      k => k.toLowerCase() === name.trim().toLowerCase()
    );
    return targetKey ? this.data.servers[targetKey] : null;
  }

  listServers() {
    const list = [];
    for (const [name, s] of Object.entries(this.data.servers)) {
      list.push({
        name,
        host: s.host,
        port: s.port,
        isSelected: name === this.data.selectedServer,
        practiceMethod: s.practiceMethod,
        duelMethod: s.duelMethod,
        queueMethod: s.queueMethod
      });
    }
    return list;
  }
}

const serverManager = new ServerManager();

module.exports = serverManager;
module.exports.ServerManager = ServerManager;
