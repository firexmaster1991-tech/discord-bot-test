// Load environment variables from .env file
require('dotenv').config();

// Retrieve token from environment
const token = process.env.DISCORD_TOKEN;

// Guard against missing or placeholder token
if (!token || token.trim() === '' || token === 'your_bot_token_here') {
  console.error('❌ Error: DISCORD_TOKEN is missing or not set in your .env file.');
  console.error('Please open .env and set your DISCORD_TOKEN before starting the bot.');
  process.exit(1);
}

const { Client, GatewayIntentBits, Events, SlashCommandBuilder } = require('discord.js');
const mcManager = require('./minecraftBot');
const serverManager = require('./serverManager');

// Channel reference for sending match updates
let activeDiscordChannel = null;

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with Pong!'),

  new SlashCommandBuilder()
    .setName('server')
    .setDescription('Manage and select Minecraft servers')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Save a new Minecraft server')
        .addStringOption(opt => opt.setName('name').setDescription('Unique server name (e.g. Practice1)').setRequired(true))
        .addStringOption(opt => opt.setName('ip').setDescription('Server IP or hostname').setRequired(true))
        .addIntegerOption(opt => opt.setName('port').setDescription('Server port (default: 25565)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all saved Minecraft servers')
    )
    .addSubcommand(sub =>
      sub.setName('select')
        .setDescription('Select which saved server the Minecraft bot should use')
        .addStringOption(opt => opt.setName('name').setDescription('Saved server name to select').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a saved Minecraft server')
        .addStringOption(opt => opt.setName('name').setDescription('Saved server name to remove').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('current')
        .setDescription('Show the currently selected Minecraft server')
    ),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join a destination on the selected Minecraft server')
    .addStringOption(opt =>
      opt.setName('destination')
        .setDescription('Destination to join (e.g. practise)')
        .setRequired(true)
        .addChoices(
          { name: 'practise', value: 'practise' },
          { name: 'practice', value: 'practice' }
        )
    ),

  new SlashCommandBuilder()
    .setName('duel')
    .setDescription('Challenge a player or accept an incoming duel request')
    .addSubcommand(sub =>
      sub.setName('challenge')
        .setDescription('Challenge a specific player to a duel')
        .addStringOption(opt =>
          opt.setName('player')
            .setDescription('Minecraft username of the player to challenge')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('gamemode')
            .setDescription('Optional gamemode/kit to challenge with (e.g. NethPot, Sword, CrystalPVP, Mace)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('accept')
        .setDescription('Accept an incoming duel request from a player')
        .addStringOption(opt =>
          opt.setName('player')
            .setDescription('Minecraft username of the player to accept')
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Queue for a Minecraft PvP gamemode')
    .addStringOption(opt =>
      opt.setName('gamemode')
        .setDescription('Select or type the PvP gamemode to queue for')
        .setRequired(true)
        .addChoices(
          { name: 'NethPot', value: 'NethPot' },
          { name: 'Sword', value: 'Sword' },
          { name: 'CrystalPVP', value: 'CrystalPVP' },
          { name: 'MacePVP', value: 'MacePVP' },
          { name: 'MaceRocket', value: 'MaceRocket' },
          { name: 'ElytraMace', value: 'ElytraMace' },
          { name: 'Boxing', value: 'Boxing' },
          { name: 'Classic', value: 'Classic' },
          { name: 'SMP Kit', value: 'SMP Kit' },
          { name: 'DiaSMP', value: 'DiaSMP' },
          { name: 'Axe', value: 'Axe' },
          { name: 'SpearElytra', value: 'SpearElytra' },
          { name: 'SpearMace', value: 'SpearMace' },
          { name: 'Sumo', value: 'Sumo' },
          { name: 'Tank', value: 'Tank' },
          { name: 'Beast', value: 'Beast' },
          { name: 'CreeperPvP', value: 'CreeperPvP' },
          { name: 'CartPVP', value: 'CartPVP' },
          { name: 'Bow', value: 'Bow' },
          { name: 'BuildUHC', value: 'BuildUHC' },
          { name: 'Bedwars', value: 'Bedwars' },
          { name: 'Bridge', value: 'Bridge' },
          { name: 'Fireball', value: 'Fireball' },
          { name: 'StickFight', value: 'StickFight' },
          { name: 'Mace', value: 'Mace' }
        )
    ),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave current server, queue, or duel')
    .addSubcommand(sub =>
      sub.setName('server')
        .setDescription('Disconnect the bot from the current Minecraft server')
    )
    .addSubcommand(sub =>
      sub.setName('queue')
        .setDescription('Leave the current PvP matchmaking queue')
    )
    .addSubcommand(sub =>
      sub.setName('duel')
        .setDescription('Forfeit and leave the current match or duel')
    ),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check connection, server, state, and PvP status'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Disconnect the Minecraft bot safely'),

  new SlashCommandBuilder()
    .setName('players')
    .setDescription('List currently online Minecraft players'),

  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a chat message to the Minecraft server')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('The message to send to Minecraft chat')
        .setRequired(true)
        .setMaxLength(256)
    ),
];

// Initialize the Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

// Event listener triggered once when the bot successfully connects
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Discord bot is online! Logged in as ${readyClient.user.tag}`);

  try {
    // 1. Register immediately to every guild the bot is currently in (instant availability)
    const guilds = await readyClient.guilds.fetch();
    for (const [guildId] of guilds) {
      const guild = await readyClient.guilds.fetch(guildId);
      await guild.commands.set(commands);
    }

    // 2. Also register globally
    await readyClient.application.commands.set(commands);

    console.log(`✅ Successfully registered slash commands (${commands.map(c => '/' + c.name).join(', ')}) across ${guilds.size} server(s)!`);
  } catch (error) {
    console.error('❌ Failed to register slash commands:', error.message);
  }
});

// Broadcast match started updates
mcManager.on('matchStarted', ({ opponent, gamemode }) => {
  if (activeDiscordChannel) {
    activeDiscordChannel.send(
      `⚔️ **Match Started!**\n` +
      `• Gamemode: **${gamemode || 'Practice'}**\n` +
      `• Opponent: **${opponent}**\n` +
      `Bot is engaging in combat!`
    ).catch(() => {});
  }
});

// Broadcast match ended updates
mcManager.on('matchEnded', ({ result, opponent, gamemode }) => {
  if (activeDiscordChannel) {
    activeDiscordChannel.send(
      `🏁 **Match Result:**\n` +
      `• ${result}\n` +
      `• Gamemode: **${gamemode || 'Practice'}**` +
      (opponent ? `\n• Opponent: **${opponent}**` : '') +
      `\n💡 *The bot is now idle in the Practice lobby. You can queue with \`/queue <gamemode>\` or challenge a player with \`/duel challenge <player>\`.*`
    ).catch(() => {});
  }
});

// Broadcast incoming duel requests
mcManager.on('incomingDuelRequest', ({ challenger, gamemode, server, expiresAt }) => {
  if (activeDiscordChannel) {
    const expireSec = Math.max(1, Math.round((expiresAt - Date.now()) / 1000));
    activeDiscordChannel.send(
      `⚔️ **Incoming Duel Request!**\n` +
      `• Challenger: **${challenger}**\n` +
      `• Gamemode: **${gamemode}**\n` +
      `• Server: **${server}**\n` +
      `👉 Run \`/duel accept ${challenger}\` within ${expireSec}s to accept!`
    ).catch(() => {});
  }
});

// Broadcast profile preflight warnings
mcManager.on('profileWarning', ({ profile, missing, message }) => {
  if (activeDiscordChannel) {
    activeDiscordChannel.send(`⚠️ **Combat Profile Warning:** ${message}`).catch(() => {});
  }
});

// Also register slash commands whenever the bot joins a new server
client.on(Events.GuildCreate, async (guild) => {
  try {
    await guild.commands.set(commands);
  } catch (error) {
    console.error(`❌ Failed to register commands for server ${guild.name}:`, error.message);
  }
});

// Handle slash command interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Track channel for match broadcast notifications
  activeDiscordChannel = interaction.channel;

  try {
    switch (interaction.commandName) {
      case 'ping': {
        await interaction.reply('🏓 Pong!');
        break;
      }

      case 'server': {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'add') {
          const name = interaction.options.getString('name');
          const ip = interaction.options.getString('ip');
          const port = interaction.options.getInteger('port') || 25565;
          const result = serverManager.addServer(name, ip, port);
          await interaction.reply(result.message);
        } else if (subcommand === 'list') {
          const servers = serverManager.listServers();
          if (servers.length === 0) {
            await interaction.reply('📋 No saved servers found. Use `/server add <name> <ip> [port]` to add one.');
          } else {
            const listStr = servers.map(s =>
              `• **${s.name}** — \`${s.host}:${s.port}\`${s.isSelected ? ' ⭐ **[SELECTED]**' : ''}`
            ).join('\n');
            await interaction.reply(`📋 **Saved Servers:**\n${listStr}`);
          }
        } else if (subcommand === 'select') {
          const name = interaction.options.getString('name');
          const selectResult = serverManager.selectServer(name);
          if (!selectResult.success) {
            await interaction.reply(selectResult.message);
            break;
          }

          // If the bot is currently connected, switch connection to the newly selected server
          if (mcManager.getStatus() === 'online') {
            await interaction.deferReply();
            console.log(`🔄 Switching Minecraft connection to newly selected server: ${selectResult.server.name}`);
            const switchResult = await mcManager.connectAndWaitForSpawn(selectResult.server);
            if (switchResult.success) {
              await interaction.editReply(`✅ Selected and switched connection to **${selectResult.server.name}** (${selectResult.server.host}:${selectResult.server.port})!`);
            } else {
              await interaction.editReply(`⚠️ Selected **${selectResult.server.name}**, but connection failed: ${switchResult.message}`);
            }
          } else {
            await interaction.reply(selectResult.message);
          }
        } else if (subcommand === 'remove') {
          const name = interaction.options.getString('name');
          const result = serverManager.removeServer(name);
          await interaction.reply(result.message);
        } else if (subcommand === 'current') {
          const current = serverManager.getSelectedServer();
          if (!current) {
            await interaction.reply('⚠️ No server is currently selected. Use `/server add` or `/server select`.');
          } else {
            await interaction.reply(
              `⭐ **Currently Selected Server:**\n` +
              `• Name: **${current.name}**\n` +
              `• Address: \`${current.host}:${current.port}\`\n` +
              `• Practice Navigation: \`${current.practiceMethod}\` (${current.practiceMethod === 'gui' ? `Slot ${current.practiceSlot} -> "${current.practiceItem}"` : current.practiceCommand})\n` +
              `• Duel Method: \`${current.duelMethod}\` (\`${current.duelCommand}\`)\n` +
              `• Queue Method: \`${current.queueMethod}\` (${current.queueMethod === 'gui' ? `Slot ${current.queueSlot}` : current.queueCommand})`
            );
          }
        }
        break;
      }

      case 'join': {
        const destination = interaction.options.getString('destination');
        if (destination.toLowerCase() === 'practise' || destination.toLowerCase() === 'practice') {
          await interaction.deferReply();
          const result = await mcManager.joinPractice();
          await interaction.editReply(result.message);
        } else {
          await interaction.reply(`⚠️ Destination "${destination}" is not supported. Use \`/join practise\`.`);
        }
        break;
      }

      case 'duel': {
        const subcommand = interaction.options.getSubcommand(false);
        const player = interaction.options.getString('player');
        const gamemode = interaction.options.getString('gamemode');

        if (subcommand === 'accept') {
          await interaction.deferReply();
          const result = await mcManager.acceptDuel(player);
          await interaction.editReply(result.message);
        } else {
          // 'challenge' or default
          await interaction.deferReply();
          const result = await mcManager.sendDuel(player, gamemode);
          await interaction.editReply(result.message);
        }
        break;
      }

      case 'queue': {
        const gamemode = interaction.options.getString('gamemode');
        await interaction.deferReply();
        const result = await mcManager.startQueue(gamemode);
        await interaction.editReply(result.message);
        break;
      }

      case 'leave': {
        const subcommand = interaction.options.getSubcommand(false);

        if (subcommand === 'server') {
          const result = mcManager.leaveServer();
          await interaction.reply(result.message);
        } else if (subcommand === 'queue') {
          const result = mcManager.leaveQueue();
          await interaction.reply(result.message);
        } else if (subcommand === 'duel') {
          const result = mcManager.leaveDuel();
          await interaction.reply(result.message);
        } else {
          const result = mcManager.leave();
          await interaction.reply(result.message);
        }
        break;
      }

      case 'status': {
        const info = mcManager.getStatusInfo();
        let statusMsg =
          `📊 **Minecraft Bot Status**\n` +
          `• Minecraft Connection: **${info.connection}**\n` +
          `• Selected Server: **${info.selectedServer}**\n` +
          `• Server: \`${info.server}\`\n` +
          `• Minecraft State: **${info.minecraftState}**\n` +
          `• Gamemode: **${info.gamemode}**\n` +
          `• Opponent: **${info.opponent}**\n` +
          `• Health: **${info.health}**\n` +
          `• Movement: \`${info.movement}\`\n` +
          `• Combat: \`${info.combat}\``;

        if (info.debugDashboard) {
          statusMsg += `\n\n🛠️ **Combat Profile Dashboard**\n` +
            `• Profile: **${info.debugDashboard.activeProfile || 'None'}**\n` +
            `• State: \`${info.debugDashboard.currentState || 'IDLE'}\`\n` +
            `• Last Action: \`${info.debugDashboard.lastAction || 'None'}\`${info.debugDashboard.lastActionAgeMs != null ? ` (${info.debugDashboard.lastActionAgeMs}ms ago)` : ''}\n` +
            `• Target: \`${info.debugDashboard.currentTarget || 'None'}\`${info.debugDashboard.distance != null ? ` (${info.debugDashboard.distance.toFixed(1)}m)` : ''}\n` +
            `• Watchdog Stuck Count: \`${info.debugDashboard.stuckCount || 0}\`\n` +
            `• Failure Events: \`${info.debugDashboard.recentFailuresCount || 0}\``;
        }

        await interaction.reply(statusMsg);
        break;
      }

      case 'stop': {
        const result = mcManager.stop();
        await interaction.reply(result.message);
        break;
      }

      case 'players': {
        const result = mcManager.getPlayers();
        if (!result.success) {
          await interaction.reply(result.message);
          break;
        }

        if (result.count === 0) {
          await interaction.reply('👥 No online players detected.');
          break;
        }

        const displayLimit = 40;
        const playerNames = result.players.slice(0, displayLimit).join(', ');
        const remaining = result.count - displayLimit;
        const suffix = remaining > 0 ? ` ...and ${remaining} more` : '';

        await interaction.reply(`👥 **Online Players (${result.count}):**\n${playerNames}${suffix}`);
        break;
      }

      case 'say': {
        const message = interaction.options.getString('message');
        const result = mcManager.sendChat(message);
        await interaction.reply(result.message);
        break;
      }

      default: {
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
        break;
      }
    }
  } catch (error) {
    console.error(`❌ Error responding to /${interaction.commandName}:`, error.message);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: 'There was an error executing this command!', ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: 'There was an error executing this command!', ephemeral: true }).catch(() => {});
    }
  }
});

// Handle general Discord client errors
client.on(Events.Error, (error) => {
  console.error('❌ Discord client error:', error.message);
});

// Guard against unexpected crashes
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception encountered:', err.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled promise rejection:', reason);
});

// Connect to Discord and handle login errors clearly
client.login(token).catch((error) => {
  console.error('❌ Failed to connect to Discord:', error.message);
  if (error.code === 'TokenInvalid') {
    console.error('Please verify that the DISCORD_TOKEN in your .env file is correct and not expired.');
  }
  process.exit(1);
});
