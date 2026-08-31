const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const router = express.Router();
let _dbGet, _dbAll;

const VALID_SIGNALS = ['start', 'stop', 'restart', 'kill'];

const avatarCache = new Map(); // steamId -> avatarUrl

async function getSteamAvatar(steamId) {
    if (avatarCache.has(steamId)) return avatarCache.get(steamId);
    try {
        const res = await axios.get(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, { timeout: 3000 });
        const avatarMatch = res.data.match(/<avatarIcon><!\[CDATA\[(.*?)\]\]><\/avatarIcon>/)
            || res.data.match(/<avatarMedium><!\[CDATA\[(.*?)\]\]><\/avatarMedium>/)
            || res.data.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/);
        if (avatarMatch && avatarMatch[1]) {
            avatarCache.set(steamId, avatarMatch[1]);
            return avatarMatch[1];
        }
    } catch (e) {
        // ignore
    }
    const fallback = 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/512px-Steam_icon_logo.svg.png';
    return fallback;
}

function pineConfig() {
    const apiKey = process.env.PTERODACTYL_API_KEY;
    const panelUrl = (process.env.PTERODACTYL_PANEL_URL || 'https://panel.pinehosting.com').replace(/\/$/, '');
    const defaultId = process.env.PTERODACTYL_SERVER_ID;
    if (!apiKey) throw new Error('PTERODACTYL_API_KEY is not configured on MercyBot.');
    if (!defaultId) throw new Error('PTERODACTYL_SERVER_ID is not configured on MercyBot.');
    return { apiKey, panelUrl, defaultId };
}

function pineHeaders(apiKey) {
    return {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
    };
}

async function resolvePteroId(serverId) {
    const { defaultId } = pineConfig();
    if (serverId && _dbGet) {
        const row = await _dbGet('SELECT ptero_id, name FROM rust_servers WHERE id = ?', [serverId]).catch(() => null);
        if (row?.ptero_id) return { pteroId: row.ptero_id, name: row.name };
    }
    return { pteroId: defaultId, name: 'Default server' };
}

async function pineRequest(method, path, data) {
    const { apiKey, panelUrl } = pineConfig();
    try {
        const res = await axios({
            method,
            url: `${panelUrl}${path}`,
            data,
            headers: pineHeaders(apiKey),
            timeout: 20000,
            validateStatus: () => true
        });
        if (res.status >= 400) {
            const msg = res.data?.errors?.[0]?.detail
                || res.data?.error
                || res.data?.message
                || `Pine API error (${res.status})`;
            throw new Error(msg);
        }
        return res.data;
    } catch (e) {
        if (e.response?.data) {
            const msg = e.response.data?.errors?.[0]?.detail || e.message;
            throw new Error(msg);
        }
        throw e;
    }
}

// ── ENDPOINTS ──

router.get('/servers', async (req, res) => {
    try {
        const rows = _dbAll
            ? await _dbAll('SELECT id, name, ptero_id FROM rust_servers ORDER BY id ASC').catch(() => [])
            : [];
        const { defaultId } = pineConfig();
        const list = rows.length ? rows : [{ id: 0, name: 'Mercy Rust', ptero_id: defaultId }];
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/status', async (req, res) => {
    try {
        const { pteroId, name } = await resolvePteroId(req.query.serverId);
        const [details, resources] = await Promise.all([
            pineRequest('get', `/api/client/servers/${pteroId}`),
            pineRequest('get', `/api/client/servers/${pteroId}/resources`)
        ]);

        const attrs = details?.attributes || {};
        const stats = resources?.attributes || {};

        res.json({
            serverId: req.query.serverId || null,
            pteroId,
            name: attrs.name || name,
            state: stats.current_state || attrs.current_state || 'unknown',
            suspended: stats.is_suspended || false,
            resources: stats.resources || null
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/power', async (req, res) => {
    try {
        const signal = String(req.body?.signal || '').toLowerCase();
        if (!VALID_SIGNALS.includes(signal)) {
            return res.status(400).json({ error: `Invalid signal. Use: ${VALID_SIGNALS.join(', ')}` });
        }

        const { pteroId, name } = await resolvePteroId(req.body?.serverId);
        await pineRequest('post', `/api/client/servers/${pteroId}/power`, { signal });

        res.json({ success: true, signal, server: name, pteroId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/command', async (req, res) => {
    try {
        const command = String(req.body?.command || '').trim();
        if (!command) return res.status(400).json({ error: 'Command is required.' });
        if (command.length > 500) return res.status(400).json({ error: 'Command too long (max 500 chars).' });

        const { pteroId, name } = await resolvePteroId(req.body?.serverId);
        await pineRequest('post', `/api/client/servers/${pteroId}/command`, { command });

        res.json({ success: true, command, server: name, pteroId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Feature 1: Live Console WebSocket details
router.get('/websocket', async (req, res) => {
    try {
        const { pteroId } = await resolvePteroId(req.query.serverId);
        const data = await pineRequest('get', `/api/client/servers/${pteroId}/websocket`);
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Feature 1: Backups Management
router.get('/backups', async (req, res) => {
    try {
        const { pteroId } = await resolvePteroId(req.query.serverId);
        const data = await pineRequest('get', `/api/client/servers/${pteroId}/backups`);
        res.json(data?.data || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/backups', async (req, res) => {
    try {
        const { pteroId } = await resolvePteroId(req.body?.serverId);
        const name = req.body?.name || `Backup-${Date.now()}`;
        const data = await pineRequest('post', `/api/client/servers/${pteroId}/backups`, { name });
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/backups/:backupId', async (req, res) => {
    try {
        const { pteroId } = await resolvePteroId(req.query.serverId);
        await pineRequest('delete', `/api/client/servers/${pteroId}/backups/${req.params.backupId}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/backups/:backupId/download', async (req, res) => {
    try {
        const { pteroId } = await resolvePteroId(req.query.serverId);
        const data = await pineRequest('get', `/api/client/servers/${pteroId}/backups/${req.params.backupId}/download`);
        res.json(data?.attributes || {});
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Feature 1: Wipe Assistant File Operations
router.get('/files/list', async (req, res) => {
    try {
        const { pteroId } = await resolvePteroId(req.query.serverId);
        const directory = req.query.directory || '/';
        const data = await pineRequest('get', `/api/client/servers/${pteroId}/files/list?directory=${encodeURIComponent(directory)}`);
        res.json(data?.data || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/files/delete', async (req, res) => {
    try {
        const { pteroId } = await resolvePteroId(req.body?.serverId);
        const root = req.body.root || '/';
        const files = req.body.files;
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: 'files array is required' });
        }
        await pineRequest('post', `/api/client/servers/${pteroId}/files/delete`, { root, files });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Feature 3: Oxide Plugin Manager
router.get('/plugins', async (req, res) => {
    try {
        const { pteroId } = await resolvePteroId(req.query.serverId);
        let filesData;
        try {
            filesData = await pineRequest('get', `/api/client/servers/${pteroId}/files/list?directory=oxide/plugins`);
        } catch (e) {
            filesData = await pineRequest('get', `/api/client/servers/${pteroId}/files/list?directory=plugins`).catch(() => null);
        }
        
        if (!filesData || !filesData.data) {
            return res.json([]);
        }

        const plugins = filesData.data
            .filter(f => f.attributes.name.endsWith('.cs'))
            .map(f => {
                const name = f.attributes.name.slice(0, -3);
                return {
                    name,
                    fileName: f.attributes.name,
                    size: f.attributes.size,
                    createdAt: f.attributes.created_at,
                    updatedAt: f.attributes.modified_at
                };
            });

        res.json(plugins);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/plugins/action', async (req, res) => {
    try {
        const { action, pluginName, serverId } = req.body;
        if (!['load', 'unload', 'reload'].includes(action)) {
            return res.status(400).json({ error: 'action must be load, unload, or reload' });
        }
        if (!pluginName) return res.status(400).json({ error: 'pluginName is required' });

        const command = `oxide.${action} ${pluginName}`;
        const { pteroId, name } = await resolvePteroId(serverId);
        await pineRequest('post', `/api/client/servers/${pteroId}/command`, { command });

        res.json({ success: true, command, server: name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Feature 4: Online Players List & Actions
router.get('/players', async (req, res) => {
    try {
        const playersList = [];
        const online = global.onlinePlayers || new Map();
        
        for (const [steamId, p] of online) {
            const avatar = await getSteamAvatar(steamId);
            playersList.push({
                steamId,
                username: p.username,
                ping: p.ping,
                avatar
            });
        }
        res.json(playersList);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/players/kick', async (req, res) => {
    try {
        const { steamId, reason, serverId } = req.body;
        if (!steamId) return res.status(400).json({ error: 'steamId is required' });
        
        const cleanReason = String(reason || 'Kicked by administrator').replace(/"/g, "'");
        const command = `kick ${steamId} "${cleanReason}"`;
        
        const { pteroId, name } = await resolvePteroId(serverId);
        await pineRequest('post', `/api/client/servers/${pteroId}/command`, { command });
        
        res.json({ success: true, command, server: name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/players/ban', async (req, res) => {
    try {
        const { steamId, username, reason, duration, serverId } = req.body;
        if (!steamId) return res.status(400).json({ error: 'steamId is required' });
        
        const cleanReason = String(reason || 'Banned by administrator').replace(/"/g, "'");
        const cleanUsername = String(username || 'Player').replace(/"/g, "'");
        const durationSec = parseInt(duration) || 0;
        
        let command = `banid ${steamId} "${cleanUsername}" "${cleanReason}"`;
        if (durationSec > 0) {
            command += ` ${durationSec}`;
        }
        
        const { pteroId, name } = await resolvePteroId(serverId);
        await pineRequest('post', `/api/client/servers/${pteroId}/command`, { command });
        
        // write to RCON ban config immediately to ensure persistence
        await pineRequest('post', `/api/client/servers/${pteroId}/command`, { command: 'server.writecfg' }).catch(() => {});
        
        res.json({ success: true, command, server: name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── LOCAL BACKUPS (VPS Hosting) ──

const LOCAL_BACKUPS_DIR = './local_backups';
if (!fs.existsSync(LOCAL_BACKUPS_DIR)) {
    fs.mkdirSync(LOCAL_BACKUPS_DIR, { recursive: true });
}

const activeDownloads = new Map(); // backupId -> { progress, total, status, name, filename }

router.get('/backups/local', async (req, res) => {
    try {
        if (!fs.existsSync(LOCAL_BACKUPS_DIR)) {
            return res.json([]);
        }
        const files = fs.readdirSync(LOCAL_BACKUPS_DIR);
        const list = [];

        for (const file of files) {
            const filePath = path.join(LOCAL_BACKUPS_DIR, file);
            const stats = fs.statSync(filePath);
            if (!stats.isFile()) continue;

            // Parse filename: <uuid>_<timestamp>_<name>.<ext>
            const parts = file.split('_');
            if (parts.length >= 3) {
                const uuid = parts[0];
                const timestamp = parseInt(parts[1], 10);
                const remaining = parts.slice(2).join('_');
                const lastDot = remaining.lastIndexOf('.');
                const name = lastDot !== -1 ? remaining.substring(0, lastDot).replace(/-/g, ' ') : remaining.replace(/-/g, ' ');
                
                list.push({
                    uuid,
                    name,
                    size: stats.size,
                    createdAt: new Date(timestamp * 1000).toISOString(),
                    filename: file
                });
            } else {
                list.push({
                    uuid: 'custom',
                    name: file,
                    size: stats.size,
                    createdAt: stats.birthtime.toISOString(),
                    filename: file
                });
            }
        }
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/backups/local/progress', (req, res) => {
    res.json(Array.from(activeDownloads.entries()).map(([backupId, data]) => ({
        backupId,
        ...data
    })));
});

router.post('/backups/local/archive', async (req, res) => {
    const { serverId, backupId, backupName } = req.body || {};
    if (!backupId || !backupName) {
        return res.status(400).json({ error: 'Missing backupId or backupName' });
    }

    if (activeDownloads.has(backupId)) {
        return res.status(400).json({ error: 'Backup is already archiving' });
    }

    try {
        const { pteroId } = await resolvePteroId(serverId);
        
        // 1. Get download URL from Pterodactyl
        const dlData = await pineRequest('get', `/api/client/servers/${pteroId}/backups/${backupId}/download`);
        const downloadUrl = dlData?.attributes?.url;
        if (!downloadUrl) {
            throw new Error('Failed to get download URL from Pine Hosting');
        }

        // 2. Determine file extension
        let ext = '.tar.gz';
        if (downloadUrl.includes('.zip')) ext = '.zip';
        
        const timestamp = Math.floor(Date.now() / 1000);
        const safeName = backupName.replace(/[^a-zA-Z0-9_-]/g, '-');
        const filename = `${backupId}_${timestamp}_${safeName}${ext}`;
        const targetPath = path.join(LOCAL_BACKUPS_DIR, filename);

        // 3. Initialize progress tracker
        activeDownloads.set(backupId, {
            progress: 0,
            total: 0,
            status: 'downloading',
            name: backupName,
            filename
        });

        // 4. Start background download
        res.json({ ok: true, message: 'Archive started in background.' });

        // Run download stream in background
        (async () => {
            try {
                const response = await axios({
                    method: 'GET',
                    url: downloadUrl,
                    responseType: 'stream'
                });

                const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
                let downloadedBytes = 0;

                const tracker = activeDownloads.get(backupId);
                if (tracker) {
                    tracker.total = totalBytes;
                }

                const writer = fs.createWriteStream(targetPath);
                response.data.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    const t = activeDownloads.get(backupId);
                    if (t) {
                        t.progress = downloadedBytes;
                    }
                });

                response.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                // Completed - clear after 1 minute
                const finalTracker = activeDownloads.get(backupId);
                if (finalTracker) {
                    finalTracker.status = 'completed';
                }
                setTimeout(() => activeDownloads.delete(backupId), 60000);
            } catch (err) {
                console.error(`[LocalBackup] Archive error for ${backupId}:`, err.message);
                const finalTracker = activeDownloads.get(backupId);
                if (finalTracker) {
                    finalTracker.status = 'failed';
                    finalTracker.error = err.message;
                }
                setTimeout(() => activeDownloads.delete(backupId), 60000);
                if (fs.existsSync(targetPath)) {
                    try { fs.unlinkSync(targetPath); } catch (e) {}
                }
            }
        })();

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/backups/local/:filename', (req, res) => {
    const filename = req.params.filename;
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(LOCAL_BACKUPS_DIR, filename);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/backups/local/download/:filename', (req, res) => {
    const filename = req.params.filename;
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(LOCAL_BACKUPS_DIR, filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath, filename);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

router.post('/settings/apply', async (req, res) => {
    const { serverId, hostname, description, url, headerimage, maxplayers, customCommand } = req.body || {};
    if (!serverId) return res.status(400).json({ error: 'Missing serverId' });

    try {
        const { pteroId } = await resolvePteroId(serverId);
        const commandsToSend = [];

        if (hostname) commandsToSend.push(`server.hostname "${hostname.replace(/"/g, '\\"')}"`);
        if (description) commandsToSend.push(`server.description "${description.replace(/"/g, '\\"')}"`);
        if (url) commandsToSend.push(`server.url "${url.replace(/"/g, '\\"')}"`);
        if (headerimage) commandsToSend.push(`server.headerimage "${headerimage.replace(/"/g, '\\"')}"`);
        if (maxplayers) {
            const maxVal = parseInt(maxplayers, 10);
            if (!isNaN(maxVal)) {
                commandsToSend.push(`server.maxplayers ${maxVal}`);
            }
        }
        if (customCommand && customCommand.trim()) {
            commandsToSend.push(customCommand.trim());
        }

        if (commandsToSend.length === 0) {
            return res.json({ success: true, message: 'No settings to apply.' });
        }

        // Always save config at the end
        commandsToSend.push('server.writecfg');

        // Send commands one by one
        for (const cmd of commandsToSend) {
            await pineRequest('post', `/api/client/servers/${pteroId}/command`, { command: cmd });
        }

        res.json({ success: true, commands: commandsToSend });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = {
    router,
    resolvePteroId,
    pineRequest,
    async init({ dbGet, dbAll }) {
        _dbGet = dbGet;
        _dbAll = dbAll;
        try {
            pineConfig();
            console.log('[ServerControl] Pine Hosting API ready.');
        } catch (e) {
            console.warn('[ServerControl]', e.message);
        }
    }
};
