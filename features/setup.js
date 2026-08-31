/**
 * Feature: Setup & Management Commands
 * All admin slash commands to configure the bot without needing the web panel.
 * Admin-only (requires Administrator permission).
 *
 * Commands:
 *  /server add <name> <ptero_id> <channel> <api_secret>
 *  /server list
 *  /server remove <name>
 *
 *  /mappool add <rustmaps_url> [download_url]
 *  /mappool list
 *  /mappool remove <url_or_id>
 *
 *  /wipeschedule set <server> <wipe_date> <wipe_time> <vote_lead_hours> [biweekly] [wipe_bp] [wipe_deaths] [announce]
 *  /wipeschedule status
 *  /wipeschedule cancel
 *
 *  /wipeannounce <server>   — manually post wipe announcement with map link
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

let _client, _dbRun, _dbGet, _dbAll;

// ─────────────────────── INIT ───────────────────────
async function init({ client, db, dbRun, dbGet, dbAll }) {
    _client = client;
    _dbRun  = dbRun;
    _dbGet  = dbGet;
    _dbAll  = dbAll;
    console.log('[Setup] Feature initialized.');
}

// ─────────────────────── COMMANDS ───────────────────────
const commands = [

    // ── /server ──────────────────────────────────────────────────────────────
    new SlashCommandBuilder()
        .setName('server')
        .setDescription('Manage registered Rust servers')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Register a new Rust server')
            .addStringOption(o => o.setName('name').setDescription('Display name, e.g. "Mercy 5x"').setRequired(true))
            .addStringOption(o => o.setName('ptero_id').setDescription('Pterodactyl server ID, e.g. "421b9b62"').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('Discord channel for map vote messages').setRequired(true))
            .addStringOption(o => o.setName('api_secret').setDescription('Shared secret for MercyMapVote.cs plugin (make it unique!)').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('List all registered servers')
        )
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove a registered server')
            .addStringOption(o => o.setName('name').setDescription('Server name to remove').setRequired(true))
        ),

    // ── /mappool ─────────────────────────────────────────────────────────────
    new SlashCommandBuilder()
        .setName('mappool')
        .setDescription('Manage the map pool used for auto map votes')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Add a map to the pool')
            .addStringOption(o => o.setName('rustmaps_url').setDescription('Rustmaps.com map URL').setRequired(true))
            .addStringOption(o => o.setName('download_url').setDescription('Direct .map file download URL (optional, for custom maps)').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('List all maps in the pool')
        )
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove a map from the pool by its number (use /mappool list to find it)')
            .addIntegerOption(o => o.setName('id').setDescription('Pool entry ID (from /mappool list)').setRequired(true))
        ),

    // ── /wipeschedule ─────────────────────────────────────────────────────────
    new SlashCommandBuilder()
        .setName('wipeschedule')
        .setDescription('Manage automatic wipe schedules')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub => sub
            .setName('set')
            .setDescription('Schedule a wipe (biweekly or one-time)')
            .addStringOption(o => o.setName('server').setDescription('Server name (from /server list)').setRequired(true))
            .addStringOption(o => o.setName('wipe_date').setDescription('Wipe date — YYYY-MM-DD, e.g. 2026-09-11').setRequired(true))
            .addStringOption(o => o.setName('wipe_time').setDescription('Wipe time (24h UTC), e.g. 18:00').setRequired(true))
            .addIntegerOption(o => o.setName('vote_lead_hours').setDescription('Start map vote X hours before wipe (default: 24)').setRequired(false).setMinValue(1).setMaxValue(168))
            .addBooleanOption(o => o.setName('biweekly').setDescription('Auto-repeat every 14 days? (default: true)').setRequired(false))
            .addBooleanOption(o => o.setName('wipe_bp').setDescription('Also wipe Blueprints? (default: false)').setRequired(false))
            .addBooleanOption(o => o.setName('wipe_deaths').setDescription('Also wipe Player Deaths/States? (default: false)').setRequired(false))
            .addBooleanOption(o => o.setName('announce').setDescription('Post Discord wipe announcement? (default: true)').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('status')
            .setDescription('Show all active and upcoming wipe schedules')
        )
        .addSubcommand(sub => sub
            .setName('cancel')
            .setDescription('Cancel an active wipe schedule')
            .addStringOption(o => o.setName('server').setDescription('Server name (leave empty to list all)').setRequired(false))
        ),

    // ── /wipeannounce ─────────────────────────────────────────────────────────
    new SlashCommandBuilder()
        .setName('wipeannounce')
        .setDescription('Manually post a wipe announcement with the last winning map info')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(o => o.setName('server').setDescription('Server name (from /server list)').setRequired(true)),
];

// ─────────────────────── INTERACTION HANDLER ───────────────────────
async function handleInteraction(interaction, { dbRun, dbGet, dbAll }) {
    if (!interaction.isChatInputCommand()) return;

    const cmd = interaction.commandName;
    const sub = interaction.options.getSubcommand(false);

    // ── /server ──────────────────────────────────────────────────────────────
    if (cmd === 'server') {
        if (sub === 'add') {
            await interaction.deferReply({ flags: 64 });
            const name      = interaction.options.getString('name');
            const pteroId   = interaction.options.getString('ptero_id');
            const channel   = interaction.options.getChannel('channel');
            const apiSecret = interaction.options.getString('api_secret');

            const existing = await dbGet('SELECT id FROM rust_servers WHERE name = ?', [name]).catch(() => null);
            if (existing) {
                return interaction.editReply(`❌ A server named **${name}** already exists. Remove it first with \`/server remove\`.`);
            }

            await dbRun(
                'INSERT INTO rust_servers (name, ptero_id, channel_id, api_secret) VALUES (?, ?, ?, ?)',
                [name, pteroId, channel.id, apiSecret]
            );

            const embed = new EmbedBuilder()
                .setColor('#00e87a')
                .setTitle('✅ Server Registered')
                .addFields(
                    { name: 'Name',           value: name,          inline: true },
                    { name: 'Pterodactyl ID', value: `\`${pteroId}\``, inline: true },
                    { name: 'Vote Channel',   value: `<#${channel.id}>`, inline: true },
                    { name: 'API Secret',     value: `\`${apiSecret}\``, inline: false }
                )
                .setDescription(`Server registered! Next steps:\n1. Add maps to the pool with \`/mappool add\`\n2. Schedule a wipe with \`/wipeschedule set\`\n3. Upload \`MercyMapVote.cs\` to your Rust server's \`oxide/plugins/\` folder and set the API Secret in its config to \`${apiSecret}\``)
                .setFooter({ text: 'MercyBot Setup' });

            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'list') {
            await interaction.deferReply({ flags: 64 });
            const servers = await dbAll('SELECT * FROM rust_servers ORDER BY id ASC').catch(() => []);

            if (!servers.length) {
                return interaction.editReply('No servers registered yet. Use `/server add` to register one.');
            }

            const embed = new EmbedBuilder()
                .setColor('#5b8cff')
                .setTitle('🖥️ Registered Servers')
                .setDescription(servers.map((s, i) =>
                    `**${i + 1}. ${s.name}**\nPtero ID: \`${s.ptero_id}\` | Channel: <#${s.channel_id}>\nAPI Secret: \`${s.api_secret}\``
                ).join('\n\n'));

            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'remove') {
            await interaction.deferReply({ flags: 64 });
            const name = interaction.options.getString('name');
            const server = await dbGet('SELECT id FROM rust_servers WHERE name LIKE ? COLLATE NOCASE', [name]).catch(() => null);
            if (!server) return interaction.editReply(`❌ No server found named **${name}**.`);

            await dbRun('DELETE FROM rust_servers WHERE id = ?', [server.id]);
            return interaction.editReply(`✅ Server **${name}** removed.`);
        }
    }

    // ── /mappool ─────────────────────────────────────────────────────────────
    if (cmd === 'mappool') {
        if (sub === 'add') {
            await interaction.deferReply({ flags: 64 });
            const url = interaction.options.getString('rustmaps_url').trim();
            const dl  = interaction.options.getString('download_url')?.trim() || null;

            if (!url.includes('rustmaps.com/map/')) {
                return interaction.editReply('❌ Invalid URL. Must be a `rustmaps.com/map/...` link.');
            }

            const existing = await dbGet('SELECT id FROM map_pool WHERE rustmaps_url = ?', [url]).catch(() => null);
            if (existing) return interaction.editReply('⚠️ That map is already in the pool.');

            await dbRun('INSERT INTO map_pool (rustmaps_url, download_url) VALUES (?, ?)', [url, dl]);

            const embed = new EmbedBuilder()
                .setColor('#00e87a')
                .setTitle('✅ Map Added to Pool')
                .addFields(
                    { name: 'Rustmaps URL',  value: url, inline: false },
                    { name: 'Download URL',  value: dl || '*(procedural map, no file needed)*', inline: false }
                );
            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'list') {
            await interaction.deferReply({ flags: 64 });
            const maps = await dbAll('SELECT * FROM map_pool ORDER BY id ASC').catch(() => []);

            if (!maps.length) {
                return interaction.editReply('The map pool is empty. Add maps with `/mappool add <rustmaps_url>`.');
            }

            const embed = new EmbedBuilder()
                .setColor('#5b8cff')
                .setTitle(`🗺️ Map Pool (${maps.length} maps)`)
                .setDescription(maps.map((m, i) =>
                    `**#${m.id}** — [Rustmaps](${m.rustmaps_url})${m.download_url ? ` | [Download](${m.download_url})` : ''}`
                ).join('\n'));

            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'remove') {
            await interaction.deferReply({ flags: 64 });
            const id = interaction.options.getInteger('id');
            const map = await dbGet('SELECT id, rustmaps_url FROM map_pool WHERE id = ?', [id]).catch(() => null);
            if (!map) return interaction.editReply(`❌ No map found with ID **${id}**. Use \`/mappool list\` to see IDs.`);

            await dbRun('DELETE FROM map_pool WHERE id = ?', [id]);
            return interaction.editReply(`✅ Removed map #${id} from the pool.\n${map.rustmaps_url}`);
        }
    }

    // ── /wipeschedule ─────────────────────────────────────────────────────────
    if (cmd === 'wipeschedule') {
        if (sub === 'set') {
            await interaction.deferReply({ flags: 64 });

            const serverName  = interaction.options.getString('server');
            const wipeDateStr = interaction.options.getString('wipe_date');   // YYYY-MM-DD
            const wipeTimeStr = interaction.options.getString('wipe_time');   // HH:MM
            const leadHours   = interaction.options.getInteger('vote_lead_hours') ?? 24;
            const biweekly    = interaction.options.getBoolean('biweekly') ?? true;
            const wipeBp      = interaction.options.getBoolean('wipe_bp')     ?? false;
            const wipeDeaths  = interaction.options.getBoolean('wipe_deaths') ?? false;
            const announce    = interaction.options.getBoolean('announce')    ?? true;

            const serverObj = await dbGet('SELECT * FROM rust_servers WHERE name LIKE ? COLLATE NOCASE', [serverName]).catch(() => null);
            if (!serverObj) {
                return interaction.editReply(`❌ No server found named **${serverName}**. Use \`/server list\` to see options.`);
            }

            // Parse wipe datetime (treated as UTC)
            const wipeDt = new Date(`${wipeDateStr}T${wipeTimeStr}:00Z`);
            if (isNaN(wipeDt.getTime())) {
                return interaction.editReply('❌ Invalid date or time. Use format: date=`2026-09-11`, time=`18:00`');
            }
            if (wipeDt <= new Date()) {
                return interaction.editReply('❌ Wipe time must be in the future.');
            }

            const voteDt = new Date(wipeDt.getTime() - leadHours * 60 * 60 * 1000);
            const intervalDays = biweekly ? 14 : 0;

            await dbRun(
                `INSERT INTO wipe_schedules
                    (server_id, vote_start_time, wipe_time, status,
                     wipe_map, wipe_bp, wipe_deaths, wipe_announce,
                     repeat_interval_days, vote_lead_hours,
                     next_wipe_time, cycle_count)
                 VALUES (?, ?, ?, 'pending_vote', 1, ?, ?, ?, ?, ?, ?, 1)`,
                [
                    serverObj.id,
                    voteDt.toISOString(),
                    wipeDt.toISOString(),
                    wipeBp    ? 1 : 0,
                    wipeDeaths ? 1 : 0,
                    announce  ? 1 : 0,
                    intervalDays,
                    leadHours,
                    wipeDt.toISOString(),
                ]
            );

            const ts = Math.floor(wipeDt.getTime() / 1000);
            const tsVote = Math.floor(voteDt.getTime() / 1000);

            const embed = new EmbedBuilder()
                .setColor('#ff9900')
                .setTitle(`📅 Wipe Scheduled — ${serverObj.name}`)
                .addFields(
                    { name: '🗳️ Map Vote Starts', value: `<t:${tsVote}:F> (<t:${tsVote}:R>)`, inline: false },
                    { name: '💥 Wipe Time',       value: `<t:${ts}:F> (<t:${ts}:R>)`,         inline: false },
                    { name: '🔄 Repeat',           value: biweekly ? 'Biweekly (every 14 days)' : 'One-time', inline: true },
                    { name: '📋 Wipe Options',    value: [
                        '✅ Map files (.map, .sav)',
                        wipeBp     ? '✅ Blueprints' : '❌ Blueprints',
                        wipeDeaths ? '✅ Deaths/States' : '❌ Deaths/States',
                        announce   ? '✅ Discord announcement' : '❌ Discord announcement',
                    ].join('\n'), inline: true }
                )
                .setDescription(`Map vote will pick **3 random maps** from your pool automatically, ${leadHours}h before the wipe.`)
                .setFooter({ text: `Make sure the map pool has at least 2 maps! Use /mappool add` });

            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'status') {
            await interaction.deferReply({ flags: 64 });
            const schedules = await dbAll(
                `SELECT w.*, s.name as server_name FROM wipe_schedules w
                 LEFT JOIN rust_servers s ON w.server_id = s.id
                 WHERE w.status IN ('pending_vote','active_vote','wiping')
                 ORDER BY w.wipe_time ASC`
            ).catch(() => []);

            if (!schedules.length) {
                return interaction.editReply('📭 No active wipe schedules. Use `/wipeschedule set` to create one.');
            }

            const statusEmoji = { pending_vote: '⏳', active_vote: '🗳️', wiping: '💥' };
            const embed = new EmbedBuilder()
                .setColor('#5b8cff')
                .setTitle('📋 Active Wipe Schedules')
                .setDescription(schedules.map(s => {
                    const ts = Math.floor(new Date(s.wipe_time).getTime() / 1000);
                    const tsVote = Math.floor(new Date(s.vote_start_time).getTime() / 1000);
                    const repeat = s.repeat_interval_days > 0 ? `🔄 Biweekly (cycle #${s.cycle_count || 1})` : 'One-time';
                    return `**${statusEmoji[s.status] || '•'} ${s.server_name}** — ID: \`${s.id}\`\n` +
                           `Vote: <t:${tsVote}:R> | Wipe: <t:${ts}:F>\n${repeat}`;
                }).join('\n\n'));

            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'cancel') {
            await interaction.deferReply({ flags: 64 });
            const serverName = interaction.options.getString('server');

            let query = `SELECT w.id, s.name as server_name, w.wipe_time, w.status FROM wipe_schedules w
                         LEFT JOIN rust_servers s ON w.server_id = s.id
                         WHERE w.status IN ('pending_vote','active_vote','wiping')`;
            const params = [];

            if (serverName) {
                query += ' AND s.name LIKE ? COLLATE NOCASE';
                params.push(serverName);
            }
            query += ' ORDER BY w.wipe_time ASC';

            const schedules = await dbAll(query, params).catch(() => []);

            if (!schedules.length) {
                return interaction.editReply(serverName
                    ? `❌ No active schedule found for **${serverName}**.`
                    : '📭 No active wipe schedules to cancel.');
            }

            if (schedules.length === 1) {
                await dbRun('DELETE FROM wipe_schedules WHERE id = ?', [schedules[0].id]);
                const ts = Math.floor(new Date(schedules[0].wipe_time).getTime() / 1000);
                return interaction.editReply(`✅ Cancelled wipe schedule for **${schedules[0].server_name}** (<t:${ts}:F>).`);
            }

            // Multiple — list them with cancel buttons
            const embed = new EmbedBuilder()
                .setColor('#ff4455')
                .setTitle('Which schedule do you want to cancel?')
                .setDescription(schedules.map((s, i) => {
                    const ts = Math.floor(new Date(s.wipe_time).getTime() / 1000);
                    return `**${i + 1}.** ${s.server_name} — <t:${ts}:F> (ID: ${s.id})`;
                }).join('\n'));

            const row = new ActionRowBuilder().addComponents(
                schedules.slice(0, 5).map(s =>
                    new ButtonBuilder()
                        .setCustomId(`cancel_wipe_${s.id}`)
                        .setLabel(`Cancel #${s.id} (${s.server_name})`)
                        .setStyle(ButtonStyle.Danger)
                )
            );

            return interaction.editReply({ embeds: [embed], components: [row] });
        }
    }

    // ── /wipeannounce ─────────────────────────────────────────────────────────
    if (cmd === 'wipeannounce') {
        await interaction.deferReply({ flags: 64 });
        const serverName = interaction.options.getString('server');
        const serverObj  = await dbGet('SELECT * FROM rust_servers WHERE name LIKE ? COLLATE NOCASE', [serverName]).catch(() => null);
        if (!serverObj) {
            return interaction.editReply(`❌ No server found named **${serverName}**. Use \`/server list\` to see options.`);
        }

        // Fetch last ended vote
        const vote = await dbGet(
            'SELECT winner_url, winner_seed, winner_size, maps_json FROM map_votes WHERE server_id = ? AND ended = 1 ORDER BY id DESC LIMIT 1',
            [serverObj.id]
        ).catch(() => null);

        const WIPE_FEED_CHANNEL_ID = process.env.WIPE_FEED_CHANNEL_ID || null;
        const SERVER_CONNECT_IP    = process.env.SERVER_CONNECT_IP    || null;

        if (!WIPE_FEED_CHANNEL_ID) {
            return interaction.editReply('❌ `WIPE_FEED_CHANNEL_ID` is not set in your `.env` file.');
        }

        const channel = await _client.channels.fetch(WIPE_FEED_CHANNEL_ID).catch(() => null);
        if (!channel) {
            return interaction.editReply(`❌ Could not find channel <#${WIPE_FEED_CHANNEL_ID}>. Check \`WIPE_FEED_CHANNEL_ID\` in your .env.`);
        }

        const mapUrl  = vote?.winner_url  || null;
        const mapSeed = vote?.winner_seed || null;
        const mapSize = vote?.winner_size || null;

        let mapImageUrl = null;
        if (vote?.maps_json && mapUrl) {
            try {
                const maps = JSON.parse(vote.maps_json);
                const winner = maps.find(m => m.url === mapUrl);
                mapImageUrl = winner?.imageUrl || null;
            } catch (_) {}
        }

        const embed = new EmbedBuilder()
            .setColor('#ff6600')
            .setTitle(`🗺️ ${serverObj.name} — JUST WIPED!`)
            .setTimestamp();

        let desc = `The server has wiped and is now live on a **new map**!\n\n`;
        if (SERVER_CONNECT_IP) desc += `**Connect**\n\`connect ${SERVER_CONNECT_IP}\`\n\n`;
        if (mapUrl) {
            desc += `**Winning Map** — [🔗 View on Rustmaps](${mapUrl})`;
            if (mapSeed) desc += `\n> 🌱 Seed: \`${mapSeed}\``;
            if (mapSize) desc += `\n> 📏 Size: \`${mapSize}\``;
        }

        embed.setDescription(desc);
        if (mapImageUrl) embed.setImage(mapImageUrl);
        embed.setFooter({ text: serverObj.name, iconURL: _client.user.displayAvatarURL() });

        await channel.send({ content: '@everyone', embeds: [embed] });

        // Mark vote as announced
        if (vote) {
            await dbRun(
                'UPDATE map_votes SET wipe_announced = 1 WHERE server_id = ? AND ended = 1 AND (wipe_announced = 0 OR wipe_announced IS NULL) ORDER BY id DESC LIMIT 1',
                [serverObj.id]
            ).catch(() => {});
        }

        return interaction.editReply(`✅ Wipe announcement posted in <#${WIPE_FEED_CHANNEL_ID}>!`);
    }
}

// ─────────────────────── BUTTON HANDLER ───────────────────────
// Handles the cancel_wipe_ buttons from /wipeschedule cancel
async function handleInteractionButton(interaction, { dbRun, dbGet }) {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('cancel_wipe_')) return;

    const id = parseInt(interaction.customId.replace('cancel_wipe_', ''), 10);
    const sched = await dbGet('SELECT id, server_id FROM wipe_schedules WHERE id = ?', [id]).catch(() => null);
    if (!sched) {
        return interaction.update({ content: '❌ Schedule not found.', embeds: [], components: [] });
    }

    await dbRun('DELETE FROM wipe_schedules WHERE id = ?', [id]);
    return interaction.update({ content: `✅ Wipe schedule #${id} cancelled.`, embeds: [], components: [] });
}

// Wrap both into a single handleInteraction export
async function handleInteractionAll(interaction, helpers) {
    await handleInteraction(interaction, helpers);
    await handleInteractionButton(interaction, helpers);
}

module.exports = { init, commands, handleInteraction: handleInteractionAll };
