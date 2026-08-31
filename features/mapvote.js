/**
 * Feature: Map Vote
 * Handles /mapvote and /endvote commands + button interactions
 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { Router } = require('express');
const axios = require('axios');

let _client, _dbRun, _dbGet, _dbAll;

const WIPE_FEED_CONNECT = process.env.SERVER_CONNECT_IP || null;
const WIPE_FEED_CHANNEL_ID = process.env.WIPE_FEED_CHANNEL_ID || null;

// ─────────────────────── HELPERS ───────────────────────
function extractMapId(url) {
    const m = url.match(/rustmaps\.com\/map\/([^/?#\s]+)/i);
    return m ? m[1] : null;
}

async function fetchMapInfo(mapId) {
    try {
        const res = await axios.get(`https://rustmaps.com/api/v2/maps/${mapId}`, {
            headers: { 'X-API-Key': process.env.RUSTMAPS_API_KEY },
            timeout: 15000
        });
        return res.data;
    } catch (e) {
        console.error(`[MapVote] Rustmaps error (${mapId}):`, e.response?.data?.message || e.message);
        return null;
    }
}

async function closeVote(vote, announce = true) {
    if (!_client || !_dbRun || !_dbAll) return;

    const maps = JSON.parse(vote.maps_json);
    const results = await _dbAll(
        'SELECT map_index, COUNT(*) as count FROM map_vote_selections WHERE vote_id = ? GROUP BY map_index',
        [vote.id]
    );

    const counts = {};
    maps.forEach((_, i) => counts[i + 1] = 0);
    results.forEach(r => counts[r.map_index] = r.count);

    const totalVotes = Object.values(counts).reduce((a, b) => a + b, 0);
    let winnerIndex = 1, maxVotes = -1;
    Object.entries(counts).forEach(([idx, c]) => {
        if (c > maxVotes) { maxVotes = c; winnerIndex = parseInt(idx); }
    });

    const winnerMap = maps[winnerIndex - 1];
    const emojis = ['1️⃣', '2️⃣', '3️⃣'];

    const pct = idx => totalVotes > 0 ? Math.round((counts[idx] / totalVotes) * 100) : 0;
    const bar = idx => {
        const p = pct(idx);
        const filled = Math.round(p / 10);
        return '`' + '█'.repeat(filled) + '░'.repeat(10 - filled) + `\` ${p}% (${counts[idx]} votes)`;
    };

    if (announce) {
        try {
            const guild = _client.guilds.cache.get(process.env.MERCY_GUILD_ID);
            const channel = guild?.channels.cache.get(vote.channel_id)
                || await _client.channels.fetch(vote.channel_id).catch(() => null);
            const message = channel ? await channel.messages.fetch(vote.message_id).catch(() => null) : null;

            if (message) {
                // Disable all vote buttons, show final counts
                const disabledRow = new ActionRowBuilder().addComponents(
                    maps.map((_, i) => new ButtonBuilder()
                        .setCustomId(`vote_dead_${i + 1}`)
                        .setLabel(`Map ${i + 1}: ${counts[i + 1]} vote${counts[i + 1] !== 1 ? 's' : ''}`)
                        .setStyle(i + 1 === winnerIndex ? ButtonStyle.Success : ButtonStyle.Secondary)
                        .setDisabled(true)
                    )
                );
                await message.edit({ components: [disabledRow] }).catch(() => {});
            }

            if (channel) {
                const resultEmbed = new EmbedBuilder()
                    .setColor('#00ff88')
                    .setTitle('🏁 Map Vote — Results!')
                    .setDescription(
                        `**${totalVotes}** player${totalVotes !== 1 ? 's' : ''} voted.\n\n` +
                        maps.map((m, i) => {
                            const idx = i + 1;
                            return `${emojis[i]} **Map ${idx}**${idx === winnerIndex ? ' 🏆 **WINNER**' : ''}\n${bar(idx)}\n> Size: ${m.size} | Seed: ${m.seed} | [Rustmaps](${m.url})`;
                        }).join('\n\n')
                    )
                    .setImage(winnerMap.imageUrl || null)
                    .setFooter({ text: 'Mercy Rust Map Vote', iconURL: _client.user.displayAvatarURL() })
                    .setTimestamp();

                await channel.send({ content: '@everyone 🗺️ The map vote has ended!', embeds: [resultEmbed] });
            }
        } catch (e) {
            console.error('[MapVote] Error closing vote:', e.message);
        }
    }

    // Store winner in DB
    await _dbRun(
        'UPDATE map_votes SET ended = 1, winner_seed = ?, winner_size = ?, winner_url = ? WHERE id = ?',
        [winnerMap.seed, winnerMap.size, winnerMap.url, vote.id]
    );

    // Update Pine Hosting Pterodactyl Panel automatically
    await updatePterodactylStartupVariables(winnerMap.seed, winnerMap.size, winnerMap.downloadUrl, vote.server_id);
}

async function updatePterodactylStartupVariables(seed, size, mapUrl, serverId) {
    const pKey = process.env.PTERODACTYL_API_KEY;
    const pUrl = process.env.PTERODACTYL_PANEL_URL;
    
    const serverObj = await _dbGet('SELECT ptero_id FROM rust_servers WHERE id = ?', [serverId]).catch(() => null);
    const pId = serverObj?.ptero_id || process.env.PTERODACTYL_SERVER_ID; // Fallback to env

    if (!pKey || !pId || !pUrl) {
        console.log('[MapVote] Pterodactyl credentials missing, skipping automatic panel update.');
        return;
    }

    try {
        const baseUrl = `${pUrl}/api/client/servers/${pId}/startup/variable`;
        const headers = {
            'Authorization': `Bearer ${pKey}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };

        // Update WORLD_SEED
        await axios.put(baseUrl, { key: 'WORLD_SEED', value: seed.toString() }, { headers });
        // Update WORLD_SIZE
        await axios.put(baseUrl, { key: 'WORLD_SIZE', value: size.toString() }, { headers });
        // Update MAP_URL (Set to the download URL if provided, or clear it for procedural maps)
        await axios.put(baseUrl, { key: 'MAP_URL', value: mapUrl || '' }, { headers });

        console.log(`[MapVote] Successfully updated Pterodactyl variables: Seed=${seed}, Size=${size}`);
    } catch (e) {
        console.error('[MapVote] Failed to update Pterodactyl variables:', e.response?.data || e.message);
    }
}

// ─────────────────────── WIPE ANNOUNCEMENT EMBED BUILDER ───────────────────────

/**
 * Builds a rich Discord embed for wipe announcements.
 * Includes connect IP, winning map link, seed, size, and map image.
 */
async function buildWipeEmbed(client, serverObj, dbGet) {
    const { EmbedBuilder } = require('discord.js');

    // Fetch the most recent ended vote for this server that hasn't been announced yet
    const winnerVote = await dbGet(
        'SELECT winner_url, winner_seed, winner_size, maps_json FROM map_votes WHERE server_id = ? AND ended = 1 ORDER BY id DESC LIMIT 1',
        [serverObj.id]
    ).catch(() => null);

    const mapUrl  = winnerVote?.winner_url  || null;
    const mapSeed = winnerVote?.winner_seed || null;
    const mapSize = winnerVote?.winner_size || null;

    // Extract winner map image from the stored maps_json array
    let mapImageUrl = null;
    if (winnerVote?.maps_json && mapUrl) {
        try {
            const maps = JSON.parse(winnerVote.maps_json);
            const winner = maps.find(m => m.url === mapUrl);
            mapImageUrl = winner?.imageUrl || null;
        } catch (_) {}
    }

    const embed = new EmbedBuilder()
        .setColor('#ff6600')
        .setTitle(`🗺️ ${serverObj.name} — JUST WIPED!`)
        .setTimestamp();

    let desc = `The server has wiped and is now live on a **new map**!\n\n`;
    desc += `**Connect**\n\`connect ${WIPE_FEED_CONNECT}\`\n\n`;
    if (mapUrl) {
        desc += `**Winning Map** — [🔗 View on Rustmaps](${mapUrl})`;
        if (mapSeed) desc += `\n> 🌱 Seed: \`${mapSeed}\``;
        if (mapSize) desc += `\n> 📏 Size: \`${mapSize}\``;
    }

    embed.setDescription(desc);
    if (mapImageUrl) embed.setImage(mapImageUrl);
    embed.setFooter({ text: serverObj.name, iconURL: client.user.displayAvatarURL() });

    return embed;
}

// ─────────────────────── INIT ───────────────────────

async function init({ client, db, dbRun, dbGet, dbAll }) {
    _client = client;
    _dbRun = dbRun;
    _dbGet = dbGet;
    _dbAll = dbAll;

    // Create tables
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS rust_servers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            ptero_id TEXT,
            channel_id TEXT,
            api_secret TEXT
        )`);
        _dbRun(`ALTER TABLE map_votes ADD COLUMN server_id INTEGER`).catch(() => {});
        db.run(`CREATE TABLE IF NOT EXISTS map_votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT,
            message_id TEXT,
            started_by TEXT,
            ends_at DATETIME,
            ended INTEGER DEFAULT 0,
            maps_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            winner_seed INTEGER,
            winner_size INTEGER,
            winner_url TEXT,
            winner_applied INTEGER DEFAULT 0,
            server_id INTEGER,
            wipe_announced INTEGER DEFAULT 0
        )`);
        // Migrate existing tables that may lack winner columns
        _dbRun(`ALTER TABLE map_votes ADD COLUMN winner_seed INTEGER`).catch(() => {});
        _dbRun(`ALTER TABLE map_votes ADD COLUMN winner_size INTEGER`).catch(() => {});
        _dbRun(`ALTER TABLE map_votes ADD COLUMN winner_url TEXT`).catch(() => {});
        _dbRun(`ALTER TABLE map_votes ADD COLUMN winner_applied INTEGER DEFAULT 0`).catch(() => {});
        _dbRun(`ALTER TABLE map_votes ADD COLUMN wipe_announced INTEGER DEFAULT 0`).catch(() => {});
        db.run(`CREATE TABLE IF NOT EXISTS map_vote_selections (
            vote_id INTEGER,
            discord_id TEXT,
            discord_tag TEXT,
            map_index INTEGER,
            voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (vote_id, discord_id)
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS map_pool (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rustmaps_url TEXT,
            download_url TEXT,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    });

    // Expire check every 60s
    setInterval(async () => {
        const now = new Date().toISOString();
        const expired = await dbAll('SELECT * FROM map_votes WHERE ended = 0 AND ends_at <= ?', [now]).catch(() => []);
        for (const v of expired) await closeVote(v);
    }, 60_000);

    console.log('[MapVote] Feature initialized.');
}

// ─────────────────────── REUSABLE VOTE CREATOR ───────────────────────
async function createVote(urls, serverId, startedByTag, logFn) {
    const emojis = ['1️⃣', '2️⃣', '3️⃣'];
    const server = await _dbGet('SELECT * FROM rust_servers WHERE id = ?', [serverId]).catch(() => null);
    if (!server) return { error: `Invalid server selected.` };
    const channelId = server.channel_id;
    
    const existing = await _dbGet('SELECT id FROM map_votes WHERE ended = 0 AND server_id = ?', [server.id]).catch(() => null);
    if (existing) {
        return { error: 'There is already an active map vote! End it first.' };
    }

    const channel = _client.channels.cache.get(channelId) || await _client.channels.fetch(channelId).catch(() => null);
    if (!channel) return { error: `Could not find channel with ID: ${channelId}` };

    const mapsData = [];
    for (let i = 0; i < urls.length; i++) {
        const input = urls[i];
        const mapId = extractMapId(input.url);
        if (!mapId) return { error: `Invalid Rustmaps URL for Map ${i + 1}:\n${input.url}` };

        if (logFn) await logFn(`Fetching Map ${i + 1}/${urls.length} from Rustmaps...`);
        const data = await fetchMapInfo(mapId);
        if (!data) return { error: `Could not fetch info for Map ${i + 1}. Check the URL and try again.\n\`${input.url}\`` };

        // Auto-add to pool
        const inPool = await _dbGet('SELECT id FROM map_pool WHERE rustmaps_url = ?', [input.url]).catch(()=>null);
        if (!inPool) {
            await _dbRun('INSERT INTO map_pool (rustmaps_url, download_url) VALUES (?, ?)', [input.url, input.dl || null]);
        }
        
        mapsData.push({
            index: i + 1,
            id: mapId,
            size: data.size ?? 'Unknown',
            seed: data.seed ?? 'Unknown',
            monuments: Array.isArray(data.monuments) ? data.monuments.length
                : (data.monuments ? Object.keys(data.monuments).length : '?'),
            url: input.url,
            imageUrl: data.imageIconUrl || data.imageUrl || null,
            downloadUrl: input.dl || null
        });
    }

    const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const endsTs = Math.floor(endsAt.getTime() / 1000);

    const mainEmbed = new EmbedBuilder()
        .setColor('#ff6600')
        .setTitle(`🗺️  Vote for the Next Wipe Map — ${server.name}!`)
        .setDescription(
            `A new wipe is approaching for **${server.name}**! Vote for your favourite map below.\n` +
            `⏰ **Closes:** <t:${endsTs}:R>  (<t:${endsTs}:f>)`
        )
        .setFooter({ text: 'Mercy Rust • One vote per player — you can change your vote any time', iconURL: _client.user.displayAvatarURL() })
        .setTimestamp();

    const mapEmbeds = mapsData.map(m => new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle(`${emojis[m.index - 1]} Map ${m.index}`)
        .setDescription(`> 📏 Size: \`${m.size}\`  🌱 Seed: \`${m.seed}\`  🏛️ Monuments: ${m.monuments}\n> [View on Rustmaps](${m.url})`)
        .setImage(m.imageUrl || null)
    );

    const allEmbeds = [mainEmbed, ...mapEmbeds];

    const row = new ActionRowBuilder().addComponents(
        mapsData.map(m => new ButtonBuilder()
            .setCustomId(`vote_map_${m.index}`)
            .setLabel(`Vote Map ${m.index}`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji(emojis[m.index - 1])
        )
    );

    const msg = await channel.send({ content: '@everyone', embeds: allEmbeds, components: [row] });

    await _dbRun(
        'INSERT INTO map_votes (channel_id, message_id, started_by, ends_at, maps_json, server_id) VALUES (?, ?, ?, ?, ?, ?)',
        [channel.id, msg.id, startedByTag, endsAt.toISOString(), JSON.stringify(mapsData), server.id]
    );
    console.log(`[MapVote] Vote started by ${startedByTag}`);
    return { success: true };
}

// ─────────────────────── SLASH COMMANDS ───────────────────────
const commands = [
    new SlashCommandBuilder()
        .setName('mapvote')
        .setDescription('Start a map vote — just paste Rustmaps links')
        .addStringOption(o => o.setName('map1').setDescription('Rustmaps URL for Map 1').setRequired(true))
        .addStringOption(o => o.setName('map2').setDescription('Rustmaps URL for Map 2').setRequired(true))
        .addStringOption(o => o.setName('map3').setDescription('Rustmaps URL for Map 3 (optional)').setRequired(false))
        .addStringOption(o => o.setName('map1_download').setDescription('Direct .map file URL for Map 1 (Optional Custom Map)').setRequired(false))
        .addStringOption(o => o.setName('map2_download').setDescription('Direct .map file URL for Map 2 (Optional Custom Map)').setRequired(false))
        .addStringOption(o => o.setName('map3_download').setDescription('Direct .map file URL for Map 3 (Optional Custom Map)').setRequired(false))
        .addStringOption(o => o.setName('server_name').setDescription('Required if multiple servers share the same channel').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('endvote')
        .setDescription('Manually end the active map vote and announce the winner')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// ─────────────────────── INTERACTION HANDLER ───────────────────────
async function handleInteraction(interaction, { dbRun, dbGet, dbAll }) {
    const emojis = ['1️⃣', '2️⃣', '3️⃣'];

    // /mapvote
    if (interaction.isChatInputCommand() && interaction.commandName === 'mapvote') {
        await interaction.deferReply();
        const urls = [
            { url: interaction.options.getString('map1'), dl: interaction.options.getString('map1_download') },
            { url: interaction.options.getString('map2'), dl: interaction.options.getString('map2_download') },
            { url: interaction.options.getString('map3'), dl: interaction.options.getString('map3_download') },
        ].filter(m => m.url);

        const serverInput = interaction.options.getString('server_name');
        let serverObj = null;
        if (serverInput) {
            serverObj = await _dbGet('SELECT * FROM rust_servers WHERE name LIKE ? COLLATE NOCASE', [serverInput]).catch(() => null);
        } else {
            const serversInChannel = await _dbAll('SELECT * FROM rust_servers WHERE channel_id = ?', [interaction.channel.id]).catch(() => []);
            if (serversInChannel.length === 1) {
                serverObj = serversInChannel[0];
            } else if (serversInChannel.length > 1) {
                return interaction.editReply({ content: '❌ Multiple servers use this channel. Use the `server_name` parameter or start the vote from the Dashboard.' });
            }
        }

        if (!serverObj) return interaction.editReply({ content: '❌ Found no server configured for this (or wrong name).' });

        const res = await createVote(urls, serverObj.id, interaction.user.tag, async (msg) => {
            await interaction.editReply({ content: `⏳ ${msg}` });
        });

        if (res.error) {
            await interaction.editReply({ content: `❌ ${res.error}` });
        } else {
            await interaction.deleteReply(); // createVote sent the message, so we delete the deferred reply
        }
    }

    // /endvote
    if (interaction.isChatInputCommand() && interaction.commandName === 'endvote') {
        // For /endvote, if multiple servers use same channel, just find the active vote in this channel
        const vote = await dbGet('SELECT * FROM map_votes WHERE ended = 0 AND channel_id = ? ORDER BY id DESC LIMIT 1', [interaction.channel.id]).catch(() => null);
        if (!vote) return interaction.reply({ content: '❌ No active map vote found.', ephemeral: true });
        await interaction.reply({ content: '🔒 Ending map vote and counting results...', ephemeral: true });
        await closeVote(vote);
    }

    // Vote buttons
    if (interaction.isButton() && interaction.customId.startsWith('vote_map_')) {
        const mapIndex = parseInt(interaction.customId.split('_')[2]);
        const vote = await dbGet('SELECT * FROM map_votes WHERE message_id = ? AND ended = 0', [interaction.message.id]).catch(() => null);
        if (!vote) return interaction.reply({ content: '❌ This vote has ended.', ephemeral: true });

        const maps = JSON.parse(vote.maps_json);
        if (mapIndex > maps.length) return interaction.reply({ content: '❌ Invalid choice.', ephemeral: true });

        const existing = await dbGet('SELECT * FROM map_vote_selections WHERE vote_id = ? AND discord_id = ?', [vote.id, interaction.user.id]).catch(() => null);

        if (existing) {
            if (existing.map_index === mapIndex) {
                return interaction.reply({ content: `You have already voted for **Map ${mapIndex}**! ✅`, ephemeral: true });
            }
            await dbRun('UPDATE map_vote_selections SET map_index = ?, voted_at = CURRENT_TIMESTAMP WHERE vote_id = ? AND discord_id = ?',
                [mapIndex, vote.id, interaction.user.id]);
            await updateLiveMessage(vote.id, interaction.message, dbAll);
            return interaction.reply({ content: `✅ You changed your vote to **Map ${mapIndex}** ${emojis[mapIndex - 1]}`, ephemeral: true });
        } else {
            await dbRun('INSERT INTO map_vote_selections (vote_id, discord_id, discord_tag, map_index) VALUES (?, ?, ?, ?)',
                [vote.id, interaction.user.id, interaction.user.tag, mapIndex]);
            await updateLiveMessage(vote.id, interaction.message, dbAll);
            return interaction.reply({ content: `✅ Your vote for **Map ${mapIndex}** ${emojis[mapIndex - 1]} has been registered!`, ephemeral: true });
        }
    }
}

async function updateLiveMessage(voteId, message, dbAll) {
    try {
        const results = await dbAll('SELECT map_index, COUNT(*) as count FROM map_vote_selections WHERE vote_id = ? GROUP BY map_index', [voteId]).catch(() => []);
        const counts = {};
        results.forEach(r => counts[r.map_index] = r.count);

        const oldComponents = message.components;
        if (!oldComponents || !oldComponents.length) return;

        const newRow = new ActionRowBuilder();
        const emojis = ['1️⃣', '2️⃣', '3️⃣'];
        
        oldComponents[0].components.forEach((btn, i) => {
            const idx = i + 1;
            const c = counts[idx] || 0;
            const newBtn = new ButtonBuilder()
                .setCustomId(btn.customId)
                .setLabel(`Vote Map ${idx} (${c} vote${c !== 1 ? 's' : ''})`)
                .setStyle(ButtonStyle.Primary)
                .setEmoji(emojis[i]);
            newRow.addComponents(newBtn);
        });

        await message.edit({ components: [newRow] }).catch(() => {});
    } catch (e) {
        console.error('[MapVote] Error updating live message:', e.message);
    }
}

// ─────────────────────── API ROUTER (Dashboard) ───────────────────────
const router = Router();

router.get('/active', async (req, res) => {
    const activeVotes = await _dbAll('SELECT v.*, s.name as server_name FROM map_votes v LEFT JOIN rust_servers s ON v.server_id = s.id WHERE v.ended = 0 ORDER BY v.id DESC').catch(() => []);
    
    const enriched = await Promise.all(activeVotes.map(async vote => {
        const results = await _dbAll('SELECT map_index, COUNT(*) as count FROM map_vote_selections WHERE vote_id = ? GROUP BY map_index', [vote.id]).catch(() => []);
        const totalVoters = await _dbGet('SELECT COUNT(DISTINCT discord_id) as c FROM map_vote_selections WHERE vote_id = ?', [vote.id]).catch(() => ({ c: 0 }));
        return {
            ...vote,
            maps: JSON.parse(vote.maps_json),
            results: results.reduce((a, r) => { a[r.map_index] = r.count; return a; }, {}),
            totalVoters: totalVoters?.c || 0
        };
    }));
    res.json(enriched);
});

router.get('/history', async (req, res) => {
    const votes = await _dbAll('SELECT v.*, s.name as server_name FROM map_votes v LEFT JOIN rust_servers s ON v.server_id = s.id ORDER BY v.id DESC LIMIT 30').catch(() => []);
    const enriched = await Promise.all(votes.map(async v => {
        const total = await _dbGet('SELECT COUNT(DISTINCT discord_id) as c FROM map_vote_selections WHERE vote_id = ?', [v.id]).catch(() => ({ c: 0 }));
        return { ...v, maps: JSON.parse(v.maps_json), totalVoters: total?.c || 0 };
    }));
    res.json(enriched);
});

router.post('/end', async (req, res) => {
    const { voteId } = req.body || {};
    if (!voteId) return res.status(400).json({ error: 'Missing voteId' });
    const vote = await _dbGet('SELECT * FROM map_votes WHERE id = ? AND ended = 0', [voteId]).catch(() => null);
    if (!vote) return res.status(404).json({ error: 'Active vote not found' });
    await closeVote(vote);
    res.json({ ok: true });
});

router.post('/create', async (req, res) => {
    const { serverId, maps } = req.body;
    if (!serverId || !maps || maps.length < 2) {
        return res.status(400).json({ error: 'Must select a server and at least 2 maps.' });
    }
    const mappedUrls = maps.map(m => typeof m === 'string' ? { url: m, dl: null } : m).filter(m => m.url);
    const startedBy = req.session?.user?.tag || 'Dashboard';
    const result = await createVote(mappedUrls, serverId, startedBy, null);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
});



// ── Servers endpoints ──
router.get('/servers', async (req, res) => {
    const servers = await _dbAll('SELECT * FROM rust_servers ORDER BY id ASC').catch(() => []);
    res.json(servers);
});

router.post('/servers', async (req, res) => {
    const { name, ptero_id, channel_id, api_secret } = req.body;
    if (!name || !ptero_id || !channel_id || !api_secret) return res.status(400).json({ error: 'All fields must be filled out' });
    await _dbRun('INSERT INTO rust_servers (name, ptero_id, channel_id, api_secret) VALUES (?, ?, ?, ?)', [name, ptero_id, channel_id, api_secret]);
    res.json({ ok: true });
});

router.delete('/servers/:id', async (req, res) => {
    await _dbRun('DELETE FROM rust_servers WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
});

router.get('/pool', async (req, res) => {
    const maps = await _dbAll('SELECT * FROM map_pool ORDER BY id DESC').catch(() => []);
    res.json(maps);
});

router.post('/pool/add', async (req, res) => {
    const { url, dl } = req.body;
    if (!url) return res.status(400).json({ error: 'Rustmaps URL is required' });
    await _dbRun('INSERT INTO map_pool (rustmaps_url, download_url) VALUES (?, ?)', [url, dl || null]);
    res.json({ ok: true });
});

router.delete('/pool/:id', async (req, res) => {
    await _dbRun('DELETE FROM map_pool WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
});

// ── Winner endpoint (polled by Rust plugin) ──
// Returns the most recent ended vote's winner map, only if not yet acknowledged
router.get('/winner', async (req, res) => {
    const secret = req.headers['x-api-secret'] || req.query.secret;
    
    // Find server by secret
    const serverObj = await _dbGet('SELECT id FROM rust_servers WHERE api_secret = ?', [secret]).catch(() => null);
    let targetServerId = serverObj?.id;
    
    // Fallback if they use the .env secret for the "main" server
    if (!targetServerId && secret !== process.env.MAPVOTE_API_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    let query = 'SELECT * FROM map_votes WHERE ended = 1 AND winner_applied = 0 AND winner_seed IS NOT NULL ';
    let params = [];
    if (targetServerId) {
        query += 'AND server_id = ? ';
        params.push(targetServerId);
    }
    query += 'ORDER BY id DESC LIMIT 1';

    const vote = await _dbGet(query, params).catch(() => null);

    if (!vote) return res.json(null);

    res.json({
        voteId: vote.id,
        seed: vote.winner_seed,
        size: vote.winner_size,
        url: vote.winner_url
    });
});

// ── ACK: Rust plugin confirms it has applied the winner ──
router.post('/winner/ack', async (req, res) => {
    const secret = req.headers['x-api-secret'] || req.body?.secret;
    const serverObj = await _dbGet('SELECT id FROM rust_servers WHERE api_secret = ?', [secret]).catch(() => null);
    
    if (!serverObj && secret !== process.env.MAPVOTE_API_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { voteId } = req.body || {};
    if (!voteId) return res.status(400).json({ error: 'Missing voteId' });

    await _dbRun('UPDATE map_votes SET winner_applied = 1 WHERE id = ?', [voteId]).catch(() => {});
    console.log(`[MapVote] ✅ Winner ACK received for vote #${voteId}`);
    res.json({ ok: true });
});
// ── Booted: Rust plugin confirms it has booted ──
router.post('/booted', async (req, res) => {
    const secret = req.headers['x-api-secret'];
    const serverObj = await _dbGet('SELECT * FROM rust_servers WHERE api_secret = ?', [secret]).catch(() => null);
    
    if (!serverObj) {
        console.log('[MapVote] /booted rejected: Unauthorized');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log(`[MapVote] /booted received from server: ${serverObj.name}`);

    const vote = await _dbGet('SELECT * FROM map_votes WHERE server_id = ? AND ended = 1 AND (wipe_announced = 0 OR wipe_announced IS NULL) ORDER BY id DESC LIMIT 1', [serverObj.id]).catch(() => null);
    
    if (!vote) {
        console.log(`[MapVote] No pending wipe announcements for ${serverObj.name}`);
        return res.json({ ok: false, msg: 'No pending wipe announcements' });
    }

    await _dbRun('UPDATE map_votes SET wipe_announced = 1 WHERE id = ?', [vote.id]).catch(() => {});

    try {
        const channel = await _client.channels.fetch(WIPE_FEED_CHANNEL_ID);
        if (channel) {
            const embed = await buildWipeEmbed(_client, serverObj, _dbGet);

            await channel.send({ content: '@everyone', embeds: [embed] });
            console.log(`[MapVote] Wipe announced for ${serverObj.name} on Discord.`);
        } else {
            console.log('[MapVote] Wipe feed channel not found!');
        }
    } catch(e) {
        console.error('[MapVote] Failed to send wipe announcement:', e.message);
    }

    res.json({ ok: true });
});

router.post('/end-active', async (req, res) => {
    const { serverId } = req.body || {};
    if (!serverId) return res.status(400).json({ error: 'Missing serverId' });

    const vote = await _dbGet('SELECT * FROM map_votes WHERE server_id = ? AND ended = 0 ORDER BY id DESC LIMIT 1', [serverId]).catch(() => null);
    if (!vote) {
        return res.json({ ok: true, msg: 'No active map vote found for this server.' });
    }
    await closeVote(vote);
    res.json({ ok: true });
});

router.post('/announce-wipe', async (req, res) => {
    const { serverId } = req.body || {};
    if (!serverId) return res.status(400).json({ error: 'Missing serverId' });

    const serverObj = await _dbGet('SELECT * FROM rust_servers WHERE id = ?', [serverId]).catch(() => null);
    if (!serverObj) return res.status(404).json({ error: 'Server not found' });

    try {
        const channel = await _client.channels.fetch(WIPE_FEED_CHANNEL_ID);
        if (channel) {
            const embed = new EmbedBuilder()
                .setColor('#2b2d31')
                .setTitle(`[US] Mercy Rust - 5x 8man | JUST WIPED`)
                .setDescription(`The server has wiped!\n\n**Server IP**\nconnect ${WIPE_FEED_CONNECT}`)
                .setFooter({ text: 'Mercy Rust', iconURL: _client.user.displayAvatarURL() });

            await channel.send({ content: '@everyone', embeds: [embed] });
            console.log(`[MapVote] Wipe announced for ${serverObj.name} on Discord.`);

            // If there's an ended vote that was not yet announced, mark it announced so the server boot won't double-announce it
            const vote = await _dbGet('SELECT * FROM map_votes WHERE server_id = ? AND ended = 1 AND (wipe_announced = 0 OR wipe_announced IS NULL) ORDER BY id DESC LIMIT 1', [serverObj.id]).catch(() => null);
            if (vote) {
                await _dbRun('UPDATE map_votes SET wipe_announced = 1 WHERE id = ?', [vote.id]).catch(() => {});
            }

            res.json({ ok: true });
        } else {
            res.status(500).json({ error: 'Wipe feed channel not found!' });
        }
    } catch (e) {
        console.error('[MapVote] Failed to send wipe announcement:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = { init, commands, handleInteraction, router, createVote, closeVote };
