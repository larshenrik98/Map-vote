const express = require('express');
const router = express.Router();
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');

let botClient;
let _dbGet, _dbRun;

// Initialize global player cache
global.onlinePlayers = global.onlinePlayers || new Map();

router.post('/event', async (req, res) => {
    try {
        const { secret, type } = req.body;

        if (secret !== process.env.API_SECRET) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!botClient) {
            return res.status(503).json({ error: 'Discord bot not ready' });
        }

        if (type === 'playerlist_sync') {
            const { players } = req.body;
            if (Array.isArray(players)) {
                const currentPlayers = new Map();
                for (const p of players) {
                    currentPlayers.set(p.steamId, {
                        steamId: p.steamId,
                        username: p.username,
                        ping: p.ping,
                        ip: p.ip,
                        lastSeen: Date.now()
                    });
                }
                global.onlinePlayers = currentPlayers;
            }
        }
        else if (type === 'chat') {
            const { steamId, username, titles, message } = req.body;
            if (!username || !message) {
                return res.status(400).json({ error: 'Missing username or message' });
            }

            // Chat Channel ID: 1517442151527485491
            const chatChannel = botClient.channels.cache.get('1517442151527485491')
                || await botClient.channels.fetch('1517442151527485491').catch(() => null);
            if (chatChannel) {
                const unixTimestamp = Math.floor(Date.now() / 1000);
                
                // Format prefixes e.g. [VIP] [ClanTag] and clean up potential double brackets
                const prefixStr = (titles && Array.isArray(titles) && titles.length > 0)
                    ? titles.map(t => {
                        let cleanTitle = t.trim();
                        if (cleanTitle.startsWith('[') && cleanTitle.endsWith(']')) {
                            cleanTitle = cleanTitle.slice(1, -1).trim();
                        }
                        return `[${cleanTitle}]`;
                    }).join(' ') + ' '
                    : '';

                const formatted = `<t:${unixTimestamp}:t> ${prefixStr}**${username}**: ${message}`;
                await chatChannel.send({ content: formatted }).catch(err => {
                    console.error('[GameServer Chat Log] Discord Send Error:', err.message);
                });
            }
        }
        else if (type === 'connect') {
            const { steamId, username } = req.body;
            if (steamId && _dbGet && _dbRun) {
                const staff = await _dbGet('SELECT * FROM staff_members WHERE steam_id = ? AND status = "active"', [steamId]).catch(() => null);
                if (staff) {
                    await _dbRun(
                        'INSERT INTO staff_events (discord_id, event_type, note, source, actor_name) VALUES (?, "login", ?, "game", ?)',
                        [staff.discord_id, `Connected to game server (Username: ${username})`, username]
                    ).catch(err => console.error('[GameServer Connect Log DB Error]:', err.message));
                }
            }
        }
        else if (type === 'disconnect') {
            const { steamId, username, reason } = req.body;
            if (steamId && _dbGet && _dbRun) {
                const staff = await _dbGet('SELECT * FROM staff_members WHERE steam_id = ? AND status = "active"', [steamId]).catch(() => null);
                if (staff) {
                    await _dbRun(
                        'INSERT INTO staff_events (discord_id, event_type, note, source, actor_name) VALUES (?, "logout", ?, "game", ?)',
                        [staff.discord_id, `Disconnected from game server (Reason: ${reason || 'Unknown'})`, username]
                    ).catch(err => console.error('[GameServer Disconnect Log DB Error]:', err.message));
                }
            }
        }
        else if (type === 'kill') {
            const { victimId, victimName, killerId, killerName, weapon } = req.body;
            if (_dbGet && _dbRun) {
                const killerStaff = killerId ? await _dbGet('SELECT * FROM staff_members WHERE steam_id = ? AND status = "active"', [killerId]).catch(() => null) : null;
                const victimStaff = victimId ? await _dbGet('SELECT * FROM staff_members WHERE steam_id = ? AND status = "active"', [victimId]).catch(() => null) : null;

                if (killerStaff) {
                    let noteText = `Killed player: ${victimName} with ${weapon}`;
                    if (victimStaff) noteText += ' [Staff]';
                    await _dbRun(
                        'INSERT INTO staff_events (discord_id, event_type, note, source, actor_name) VALUES (?, "kill", ?, "game", ?)',
                        [killerStaff.discord_id, noteText, killerName]
                    ).catch(err => console.error('[GameServer Kill Log DB Error]:', err.message));
                }
                if (victimStaff) {
                    let noteText = `Killed by player: ${killerName} with ${weapon}`;
                    if (killerStaff) noteText += ' [Staff]';
                    await _dbRun(
                        'INSERT INTO staff_events (discord_id, event_type, note, source, actor_name) VALUES (?, "death", ?, "game", ?)',
                        [victimStaff.discord_id, noteText, victimName]
                    ).catch(err => console.error('[GameServer Death Log DB Error]:', err.message));
                }
            }
        }

        res.json({ success: true });
    } catch (e) {
        console.error('[GameServer Event] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

const FOOTER_ICON = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4f/Icon_no.svg/64px-Icon_no.svg.png';

function buildIpCheckYaml({ net, loc, det }) {
    const riskScore = Number.isFinite(det.risk) ? det.risk : 0;
    const riskEmoji = riskScore >= 67 ? '🔴' : riskScore >= 34 ? '🟡' : '🟢';
    const bool = (val) => (val ? 'true' : 'false');

    return [
        `ASN:      ${net.asn || 'Unknown'}`,
        `Provider: ${net.provider || 'Unknown'}`,
        `Country:  ${loc.country_name || 'Unknown'}`,
        `Type:     ${net.type || 'Unknown'}`,
        `VPN:      ${bool(det.vpn)}`,
        `Proxy:    ${bool(det.proxy)}`,
        `Scraper:  ${bool(det.scraper)}`,
        `Risk:     ${riskEmoji} ${riskScore}/100`,
    ].join('\n');
}

function buildIpCheckEmbed({ steamId, lastSeenUnix, net, loc, det }) {
    return new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle('Recent IP Lookup')
        .setDescription("The following information is regarding the player's latest IP used on the server.")
        .addFields(
            { name: '🎮 Steam64 ID', value: `\`${steamId}\``, inline: true },
            { name: '🕒 IP Last Seen', value: `<t:${lastSeenUnix}:F>\n<t:${lastSeenUnix}:R>`, inline: true },
            {
                name: '📍 High-level IP Information',
                value: `\`\`\`yaml\n${buildIpCheckYaml({ net, loc, det })}\n\`\`\``,
                inline: false,
            }
        )
        .setFooter({ text: 'DO NOT SHARE - POLICIES APPLY', iconURL: FOOTER_ICON });
}

router.get('/ipcheck', (req, res) => {
    const steamId = req.query.steamid;
    if (!steamId) return res.status(400).json({ error: 'Missing steamid' });
    const player = global.onlinePlayers.get(steamId);
    if (!player || !player.ip) return res.status(404).json({ error: 'IP not found' });
    res.json({ ip: player.ip });
});

module.exports = {
    router,
    commands: [
        new SlashCommandBuilder()
            .setName('ipcheck')
            .setDescription('Check IP details for a Steam ID')
            .addStringOption(option => 
                option.setName('steamid')
                    .setDescription('The Steam ID of the player to check')
                    .setRequired(true)
            )
    ],
    async handleInteraction(interaction) {
        if (interaction.isChatInputCommand() && interaction.commandName === 'ipcheck') {
            const steamId = interaction.options.getString('steamid').trim();
            await interaction.deferReply({ ephemeral: false });

            const player = global.onlinePlayers.get(steamId);
            if (!player || !player.ip) {
                return interaction.editReply({ content: `❌ No IP logged for Steam ID **${steamId}** yet. They need to connect to the server while the bot is running.` });
            }

            try {
                const ipResp = await axios.get(`https://proxycheck.io/v3/${player.ip}?key=550z96-76m003-11o74l-ee5424&vpn=1&asn=1`);
                const ipData = ipResp.data;

                if (ipData.status !== 'ok' || !ipData[player.ip]) {
                    return interaction.editReply({ content: `❌ Failed to lookup IP info from proxycheck.io.` });
                }

                const info = ipData[player.ip];
                const net = info.network || {};
                const loc = info.location || {};
                const det = info.detections || {};
                const lastSeenUnix = Math.floor((player.lastSeen || Date.now()) / 1000);

                const embed = buildIpCheckEmbed({
                    steamId,
                    lastSeenUnix,
                    net,
                    loc,
                    det,
                });

                await interaction.editReply({ embeds: [embed] });
            } catch (e) {
                console.error('[MercyBot] /ipcheck error:', e.message);
                
                let errorMsg = 'An error occurred while checking IP details from proxycheck.io.';
                if (e.response && e.response.data && e.response.data.message) {
                    errorMsg = `Proxycheck.io error: ${e.response.data.message}`;
                }

                await interaction.editReply({ content: `❌ ${errorMsg}` });
            }
        }
    },
    async init({ client, dbGet, dbRun }) {
        botClient = client;
        _dbGet = dbGet;
        _dbRun = dbRun;
        console.log('[GameServer] Feature initialized.');
    }
};
