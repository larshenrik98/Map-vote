const { Router } = require('express');

let _client, _dbRun, _dbGet, _dbAll;

// ── CONFIG (env-var driven so standalone users can configure) ──
const WIPE_FEED_CHANNEL_ID = process.env.WIPE_FEED_CHANNEL_ID || null;
const SERVER_CONNECT_IP    = process.env.SERVER_CONNECT_IP    || null;

// ── INIT ──
async function init({ client, db, dbRun, dbGet, dbAll }) {
    _client = client;
    _dbRun  = dbRun;
    _dbGet  = dbGet;
    _dbAll  = dbAll;

    // Create/migrate wipe_schedules table
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS wipe_schedules (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id            INTEGER,
            vote_start_time      DATETIME,
            wipe_time            DATETIME,
            status               TEXT,  -- 'pending_vote','active_vote','wiping','completed','failed'
            wipe_map             INTEGER DEFAULT 1,
            wipe_bp              INTEGER DEFAULT 0,
            wipe_deaths          INTEGER DEFAULT 0,
            wipe_announce        INTEGER DEFAULT 1,
            error_message        TEXT,
            vote_id              INTEGER,
            created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
            repeat_interval_days INTEGER DEFAULT 0,
            vote_lead_hours      INTEGER DEFAULT 24,
            last_used_map_url    TEXT,
            next_wipe_time       DATETIME,
            cycle_count          INTEGER DEFAULT 0
        )`);

        // Migrate: add columns if they don't exist yet
        [
            `ALTER TABLE wipe_schedules ADD COLUMN repeat_interval_days INTEGER DEFAULT 0`,
            `ALTER TABLE wipe_schedules ADD COLUMN vote_lead_hours INTEGER DEFAULT 24`,
            `ALTER TABLE wipe_schedules ADD COLUMN last_used_map_url TEXT`,
            `ALTER TABLE wipe_schedules ADD COLUMN next_wipe_time DATETIME`,
            `ALTER TABLE wipe_schedules ADD COLUMN cycle_count INTEGER DEFAULT 0`,
        ].forEach(sql => db.run(sql, () => {})); // silently ignore "column already exists"
    });

    // Background loop — check every 30 seconds
    setInterval(async () => {
        try {
            const now = new Date().toISOString();

            // 1. Start pending votes whose vote_start_time has arrived
            const pendingVotes = await _dbAll(
                'SELECT * FROM wipe_schedules WHERE status = ? AND vote_start_time <= ?',
                ['pending_vote', now]
            ).catch(() => []);
            for (const sched of pendingVotes) {
                await startScheduledVote(sched);
            }

            // 2. Execute wipes whose wipe_time has arrived
            const activeWipes = await _dbAll(
                'SELECT * FROM wipe_schedules WHERE status = ? AND wipe_time <= ?',
                ['active_vote', now]
            ).catch(() => []);
            for (const sched of activeWipes) {
                await executeScheduledWipe(sched);
            }
        } catch (err) {
            console.error('[WipePlanner] Loop error:', err.message);
        }
    }, 30_000);

    console.log('[WipePlanner] Feature initialized.');
}

// ── HELPERS ──

/**
 * Pick up to `count` random maps from the pool, excluding `excludeUrl` (last used map).
 * If the pool is too small to exclude, fall back to the full pool.
 */
async function pickRandomMaps(serverId, count = 3, excludeUrl = null) {
    const pool = await _dbAll('SELECT * FROM map_pool').catch(() => []);
    if (pool.length === 0) return null; // no maps at all

    let eligible = excludeUrl
        ? pool.filter(m => m.rustmaps_url !== excludeUrl)
        : pool;

    // Fallback: if exclusion leaves fewer than 2 maps, use the full pool
    if (eligible.length < 2) eligible = pool;

    const shuffled = eligible.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, Math.min(count, shuffled.length))
        .map(m => ({ url: m.rustmaps_url, dl: m.download_url || null }));
}

// ── ACTIONS ──

async function startScheduledVote(sched) {
    console.log(`[WipePlanner] Starting scheduled map vote for schedule #${sched.id} (Server #${sched.server_id})`);

    try {
        const maps = await pickRandomMaps(sched.server_id, 3, sched.last_used_map_url);
        if (!maps || maps.length < 2) {
            await _dbRun(
                'UPDATE wipe_schedules SET status = ?, error_message = ? WHERE id = ?',
                ['failed', 'Not enough maps in pool (need at least 2).', sched.id]
            );
            return;
        }

        const mapvote = require('./mapvote');
        const result  = await mapvote.createVote(maps, sched.server_id, 'Wipe Planner (Auto)', null);

        if (result.error) {
            await _dbRun(
                'UPDATE wipe_schedules SET status = ?, error_message = ? WHERE id = ?',
                ['failed', `MapVote creation failed: ${result.error}`, sched.id]
            );
        } else {
            const vote = await _dbGet(
                'SELECT id FROM map_votes WHERE server_id = ? AND ended = 0 ORDER BY id DESC LIMIT 1',
                [sched.server_id]
            ).catch(() => null);
            await _dbRun(
                'UPDATE wipe_schedules SET status = ?, vote_id = ? WHERE id = ?',
                ['active_vote', vote?.id || null, sched.id]
            );
            console.log(`[WipePlanner] Map vote started for schedule #${sched.id}`);
        }
    } catch (e) {
        console.error(`[WipePlanner] Failed to start vote for #${sched.id}:`, e.message);
        await _dbRun(
            'UPDATE wipe_schedules SET status = ?, error_message = ? WHERE id = ?',
            ['failed', e.message, sched.id]
        );
    }
}

async function executeScheduledWipe(sched) {
    console.log(`[WipePlanner] Executing wipe for schedule #${sched.id} (Server #${sched.server_id})`);
    await _dbRun('UPDATE wipe_schedules SET status = ? WHERE id = ?', ['wiping', sched.id]);

    let winnerUrl = null;

    try {
        const { resolvePteroId, pineRequest } = require('./servercontrol');
        const { pteroId, name: serverName } = await resolvePteroId(sched.server_id);

        // 1. Stop server
        console.log(`[WipePlanner] Stopping ${serverName}...`);
        await pineRequest('post', `/api/client/servers/${pteroId}/power`, { signal: 'stop' });

        // 2. Wait for offline (max 60 s)
        let isStopped = false;
        for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const statusData = await pineRequest('get', `/api/client/servers/${pteroId}/resources`).catch(() => null);
            const state = statusData?.attributes?.current_state;
            if (state === 'offline' || state === 'stopped') { isStopped = true; break; }
        }
        if (!isStopped) console.warn(`[WipePlanner] ${serverName} did not stop in 60 s, proceeding anyway.`);

        // 3. Close map vote and apply winner
        const mapvote = require('./mapvote');
        const vote = await _dbGet(
            'SELECT * FROM map_votes WHERE server_id = ? AND ended = 0 ORDER BY id DESC LIMIT 1',
            [sched.server_id]
        ).catch(() => null);

        if (vote) {
            console.log(`[WipePlanner] Closing map vote #${vote.id}...`);
            await mapvote.closeVote(vote);

            // Fetch winner URL from the now-ended vote
            const endedVote = await _dbGet(
                'SELECT winner_url FROM map_votes WHERE id = ?', [vote.id]
            ).catch(() => null);
            winnerUrl = endedVote?.winner_url || null;
        } else {
            console.log(`[WipePlanner] No active vote found for server #${sched.server_id}, skipping.`);
        }

        // 4. Delete wipe files
        console.log(`[WipePlanner] Scanning server files...`);
        let dir   = 'server/rust';
        let files = (await pineRequest('get', `/api/client/servers/${pteroId}/files/list?directory=server/rust`).catch(() => null))?.data;
        if (!files) {
            dir   = '';
            files = (await pineRequest('get', `/api/client/servers/${pteroId}/files/list?directory=`).catch(() => null))?.data;
        }

        if (Array.isArray(files)) {
            const toDelete = [];
            files.forEach(f => {
                const name = f.attributes.name;
                if (sched.wipe_map    && (name.endsWith('.map') || name.endsWith('.sav')))              toDelete.push(name);
                if (sched.wipe_bp     && name.includes('player.blueprints'))                             toDelete.push(name);
                if (sched.wipe_deaths && (name.includes('player.deaths') || name.includes('player.states'))) toDelete.push(name);
            });
            if (toDelete.length > 0) {
                console.log(`[WipePlanner] Deleting: ${toDelete.join(', ')}`);
                await pineRequest('post', `/api/client/servers/${pteroId}/files/delete`, { root: dir, files: toDelete });
            }
        }

        // 5. Start server
        console.log(`[WipePlanner] Starting ${serverName}...`);
        await pineRequest('post', `/api/client/servers/${pteroId}/power`, { signal: 'start' });

        // 6. Discord wipe announcement
        if (sched.wipe_announce) {
            const serverObj = await _dbGet('SELECT * FROM rust_servers WHERE id = ?', [sched.server_id]).catch(() => null);
            if (serverObj) {
                const channel = await _client.channels.fetch(WIPE_FEED_CHANNEL_ID).catch(() => null);
                if (channel) {
                    const { EmbedBuilder } = require('discord.js');

                    // Fetch full winner info from the ended vote
                    const winnerVote = await _dbGet(
                        'SELECT winner_url, winner_seed, winner_size, maps_json FROM map_votes WHERE server_id = ? AND ended = 1 ORDER BY id DESC LIMIT 1',
                        [sched.server_id]
                    ).catch(() => null);

                    const mapUrl  = winnerVote?.winner_url  || null;
                    const mapSeed = winnerVote?.winner_seed || null;
                    const mapSize = winnerVote?.winner_size || null;

                    // Pull the winning map image URL from maps_json
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
                    desc += `**Connect**\n\`connect ${SERVER_CONNECT_IP}\`\n\n`;
                    if (mapUrl) {
                        desc += `**Winning Map** — [🔗 View on Rustmaps](${mapUrl})`;
                        if (mapSeed) desc += `\n> 🌱 Seed: \`${mapSeed}\``;
                        if (mapSize) desc += `\n> 📏 Size: \`${mapSize}\``;
                    }

                    embed.setDescription(desc);
                    if (mapImageUrl) embed.setImage(mapImageUrl);
                    embed.setFooter({ text: serverObj.name, iconURL: _client.user.displayAvatarURL() });

                    await channel.send({ content: '@everyone', embeds: [embed] });

                    // Mark wipe_announced on the vote
                    const voteObj = await _dbGet(
                        'SELECT id FROM map_votes WHERE server_id = ? AND ended = 1 AND (wipe_announced = 0 OR wipe_announced IS NULL) ORDER BY id DESC LIMIT 1',
                        [sched.server_id]
                    ).catch(() => null);
                    if (voteObj) {
                        await _dbRun('UPDATE map_votes SET wipe_announced = 1 WHERE id = ?', [voteObj.id]).catch(() => {});
                    }
                }
            }
        }


        // 7. Mark current cycle completed
        await _dbRun('UPDATE wipe_schedules SET status = ?, last_used_map_url = ? WHERE id = ?',
            ['completed', winnerUrl, sched.id]);
        console.log(`[WipePlanner] Schedule #${sched.id} completed.`);

        // 8. Auto-queue next cycle if this is a recurring schedule
        if (sched.repeat_interval_days > 0) {
            const intervalMs    = sched.repeat_interval_days * 24 * 60 * 60 * 1000;
            const leadMs        = (sched.vote_lead_hours || 24) * 60 * 60 * 1000;
            const nextWipeTime  = new Date(new Date(sched.wipe_time).getTime() + intervalMs);
            const nextVoteStart = new Date(nextWipeTime.getTime() - leadMs);

            await _dbRun(
                `INSERT INTO wipe_schedules
                    (server_id, vote_start_time, wipe_time, status,
                     wipe_map, wipe_bp, wipe_deaths, wipe_announce,
                     repeat_interval_days, vote_lead_hours,
                     last_used_map_url, next_wipe_time, cycle_count)
                 VALUES (?, ?, ?, 'pending_vote', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    sched.server_id,
                    nextVoteStart.toISOString(),
                    nextWipeTime.toISOString(),
                    sched.wipe_map    ? 1 : 0,
                    sched.wipe_bp     ? 1 : 0,
                    sched.wipe_deaths ? 1 : 0,
                    sched.wipe_announce ? 1 : 0,
                    sched.repeat_interval_days,
                    sched.vote_lead_hours || 24,
                    winnerUrl,                      // exclude this map next cycle
                    nextWipeTime.toISOString(),     // pre-calc for UI
                    (sched.cycle_count || 0) + 1,
                ]
            );
            console.log(`[WipePlanner] Next ${sched.repeat_interval_days}-day cycle queued for ${nextWipeTime.toISOString()}`);
        }

    } catch (err) {
        console.error(`[WipePlanner] Wipe execution failed for #${sched.id}:`, err.message);
        await _dbRun(
            'UPDATE wipe_schedules SET status = ?, error_message = ? WHERE id = ?',
            ['failed', err.message, sched.id]
        );
    }
}

// ── API ROUTER ──
const router = Router();

router.get('/list', async (req, res) => {
    try {
        const rows = await _dbAll(
            `SELECT w.*, s.name as server_name
             FROM wipe_schedules w
             LEFT JOIN rust_servers s ON w.server_id = s.id
             ORDER BY w.id DESC`
        ).catch(() => []);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/schedule', async (req, res) => {
    const {
        serverId,
        wipeTime,
        voteLeadHours   = 24,
        repeatIntervalDays = 0,
        wipeMap   = true,
        wipeBp    = false,
        wipeDeaths = false,
        wipeAnnounce = true
    } = req.body || {};

    if (!serverId || !wipeTime) {
        return res.status(400).json({ error: 'serverId and wipeTime are required' });
    }

    const lead     = parseInt(voteLeadHours, 10)  || 24;
    const interval = parseInt(repeatIntervalDays, 10) || 0;

    // Derive vote start time automatically
    const wipeDt   = new Date(wipeTime);
    const voteDt   = new Date(wipeDt.getTime() - lead * 60 * 60 * 1000);

    try {
        await _dbRun(
            `INSERT INTO wipe_schedules
                (server_id, vote_start_time, wipe_time, status,
                 wipe_map, wipe_bp, wipe_deaths, wipe_announce,
                 repeat_interval_days, vote_lead_hours,
                 next_wipe_time, cycle_count)
             VALUES (?, ?, ?, 'pending_vote', ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
                serverId,
                voteDt.toISOString(),
                wipeDt.toISOString(),
                wipeMap    ? 1 : 0,
                wipeBp     ? 1 : 0,
                wipeDeaths ? 1 : 0,
                wipeAnnounce ? 1 : 0,
                interval,
                lead,
                wipeDt.toISOString(),   // next_wipe_time = first wipe for display
            ]
        );
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await _dbRun('DELETE FROM wipe_schedules WHERE id = ?', [req.params.id]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = { init, router };
