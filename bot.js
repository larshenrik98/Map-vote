/**
 * Mercy Rust â€” General Bot
 * Modular architecture: add features by creating files in /features/
 */
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, Partials } = require('discord.js');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ DATABASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const db = new sqlite3.Database(path.join(__dirname, 'mercy.db'), err => {
    if (err) console.error('[Mercy] DB Error:', err.message);
    else console.log('[Mercy] Database connected.');
});

// Promisified helpers shared across all features
const dbRun = (q, p = []) => new Promise((res, rej) => db.run(q, p, function(e) { e ? rej(e) : res(this); }));
const dbGet = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => e ? rej(e) : res(r)));
const dbAll = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => e ? rej(e) : res(r)));

// Core tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS bot_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature TEXT DEFAULT 'core',
        type TEXT,
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ CLIENT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel]
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ FEATURE LOADER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const features = new Map(); // featureName -> module
const allCommands = [];

async function loadFeatures() {
    const featuresDir = path.join(__dirname, 'features');
    if (!fs.existsSync(featuresDir)) fs.mkdirSync(featuresDir);

    const files = fs.readdirSync(featuresDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
        try {
            const feature = require(path.join(featuresDir, file));
            const name = file.replace('.js', '');

            if (typeof feature.init === 'function') {
                await feature.init({ client, db, dbRun, dbGet, dbAll });
            }

            if (feature.commands) {
                allCommands.push(...feature.commands);
            }

            // Mount API router right after loading so routes are registered
            if (feature.router) {
                app.use(`/api/${name}`, feature.router);
                console.log(`[Mercy] ðŸŒ Mounted API: /api/${name}`);
            }

            features.set(name, feature);
            console.log(`[Mercy] âœ… Loaded feature: ${name}`);
        } catch (e) {
            console.error(`[Mercy] âŒ Failed to load feature ${file}:`, e.message);
        }
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ READY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
client.once('ready', async () => {
    console.log(`[Mercy] Logged in as ${client.user.tag}`);

    await loadFeatures();

    // Register all slash commands
    if (allCommands.length > 0) {
        const rest = new REST({ version: '10' }).setToken(process.env.MERCY_BOT_TOKEN);
        try {
            await rest.put(
                Routes.applicationGuildCommands(process.env.MERCY_CLIENT_ID, process.env.MERCY_GUILD_ID),
                { body: allCommands.map(c => c.toJSON()) }
            );
            console.log(`[Mercy] Registered ${allCommands.length} slash command(s).`);
        } catch (e) {
            if (e.code === 50001) {
                console.warn('[Mercy] âš ï¸  Bot is not in the guild yet â€” invite it first, then restart.');
                console.warn('[Mercy] Invite: https://discord.com/oauth2/authorize?client_id=' + process.env.MERCY_CLIENT_ID + '&permissions=8&scope=bot%20applications.commands');
            } else {
                console.error('[Mercy] Failed to register commands:', e.message);
            }
        }
    }

    await dbRun('INSERT INTO bot_events (feature, type, message) VALUES (?, ?, ?)',
        ['core', 'start', `Bot started as ${client.user.tag}`]).catch(() => {});

    console.log('[Mercy] Bot is ready!');
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ MEMBER JOIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
client.on('guildMemberAdd', async member => {
    try {
        const roleId = '1514070446700494950'; // Member role
        const role = member.guild.roles.cache.get(roleId);
        if (role) {
            await member.roles.add(role);
            console.log(`[Mercy] Assigned member role to ${member.user.tag}`);
        }
    } catch (err) {
        console.error(`[Mercy] Failed to assign member role:`, err.message);
    }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ INTERACTION ROUTER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
client.on('interactionCreate', async interaction => {
    for (const [name, feature] of features) {
        if (typeof feature.handleInteraction === 'function') {
            try {
                await feature.handleInteraction(interaction, { client, db, dbRun, dbGet, dbAll });
            } catch (e) {
                console.error(`[Mercy] Error in feature ${name}:`, e.message);
            }
        }
    }
});

// Channels ignored for Community Pulse "last activity" (bots, logs, etc.)
const ACTIVITY_EXCLUDED_CHANNELS = new Set([
    '1517039349647151175',
    '1514047799640068118'
]);

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // Track last Discord activity for Community Pulse
    if (!ACTIVITY_EXCLUDED_CHANNELS.has(message.channel?.id)) {
        try {
            const activityPath = path.join(__dirname, 'last_discord_activity.json');
            fs.writeFileSync(activityPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                channelName: message.channel?.name || 'unknown',
                guildId: message.guild?.id || null
            }));
        } catch (_) {}
    }

    for (const [name, feature] of features) {
        if (typeof feature.handleMessage === 'function') {
            try {
                await feature.handleMessage(message, { client, db, dbRun, dbGet, dbAll });
            } catch (e) {
                console.error(`[Mercy] Error in feature ${name}:`, e.message);
            }
        }
    }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ DASHBOARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const axios = require('axios');
const app = express();

if (process.env.TRUST_PROXY !== '0') {
    app.set('trust proxy', 1);
}

app.use(express.json());

const publicUrl = (process.env.MERCY_PUBLIC_URL || 'https://mercypanel.online').replace(/\/$/, '');
const redirectUri = process.env.MERCY_OAUTH_REDIRECT_URI || `${publicUrl}/api/auth/callback`;
const sessionCookieSecure = process.env.SESSION_COOKIE_SECURE === 'true';

// Session setup
app.use(session({
    store: new SQLiteStore({
        db: 'mercy_sessions.db',
        dir: __dirname
    }),
    secret: process.env.MERCY_SESSION_SECRET || process.env.MERCY_CLIENT_SECRET || 'secret123',
    resave: false,
    saveUninitialized: false,
    proxy: sessionCookieSecure,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        secure: sessionCookieSecure,
        sameSite: 'lax',
        httpOnly: true
    }
}));

// OAuth2 Auth Routes

app.get('/api/auth/login', (req, res) => {
    const url = `https://discord.com/api/oauth2/authorize?client_id=${process.env.MERCY_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
    res.redirect(url);
});

app.get('/api/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/?error=NoCode');

    try {
        const tokenParams = new URLSearchParams({
            client_id: process.env.MERCY_CLIENT_ID,
            client_secret: process.env.MERCY_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri
        });

        const tokenRes = await axios.post('https://discord.com/api/oauth2/token', tokenParams, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
        });

        const whitelist = (process.env.MERCY_DASHBOARD_WHITELIST || '').split(',');
        if (!whitelist.includes(userRes.data.id)) {
            return res.status(403).send('Access Denied: You are not whitelisted for the dashboard.');
        }

        req.session.user = {
            id: userRes.data.id,
            username: userRes.data.username,
            avatar: userRes.data.avatar,
            tag: `${userRes.data.username}#${userRes.data.discriminator}`
        };

        res.redirect('/?v=' + Date.now());
    } catch (e) {
        console.error('[Mercy] Auth error:', e.message);
        res.status(500).send('Authentication failed');
    }
});

app.get('/api/auth/me', (req, res) => {
    if (req.session.user) return res.json(req.session.user);
    res.status(401).json({ error: 'Not logged in' });
});

app.get('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) console.error('[Mercy] Logout error:', err.message);
        res.clearCookie('connect.sid', {
            path: '/',
            secure: sessionCookieSecure,
            sameSite: 'lax',
            httpOnly: true
        });
        res.redirect('/?loggedOut=1');
    });
});

// Middleware to protect API routes and static files
function requireAuth(req, res, next) {
    if (req.path === '/icon.png') return next(); // Allow icon
    if (req.path.startsWith('/api/mapvote/winner') || req.path.startsWith('/api/mapvote/booted')) return next(); // Allow Rust plugin
    if (req.path === '/api/gameserver/event') return next(); // Allow Rust logger event reporting
    if (req.path === '/api/temprank/sync') return next(); // Allow MercyTempRank plugin sync
    if (req.path === '/api/banapprovals/request-ban') return next(); // Allow Chrome extension (auth via API secret)
    if (req.session.user) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
    
    // If not logged in and requesting HTML, let static serve it so it redirects or shows login
    next(); 
}

app.use(requireAuth);

// Serve dashboard.html dynamically to prevent caching
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.sendFile(path.join(__dirname, '.', 'dashboard.html'));
});

app.use(express.static(path.join(__dirname, '.'), {
    etag: false,
    maxAge: 0,
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
}));

// Core API
app.get('/api/status', async (req, res) => {
    const guild = client.guilds.cache.get(process.env.MERCY_GUILD_ID);
    const events = await dbAll('SELECT * FROM bot_events ORDER BY id DESC LIMIT 10').catch(() => []);
    res.json({
        online: client.isReady(),
        tag: client.user?.tag,
        avatarUrl: client.user?.displayAvatarURL({ size: 128 }),
        guildName: guild?.name,
        memberCount: guild?.memberCount,
        features: [...features.keys()],
        recentEvents: events,
        uptime: process.uptime()
    });
});

app.get('/api/events', async (req, res) => {
    const events = await dbAll('SELECT * FROM bot_events ORDER BY id DESC LIMIT 100').catch(() => []);
    res.json(events);
});

// Feature API routes are mounted inside loadFeatures() after each feature loads.

const PORT = process.env.MERCY_DASHBOARD_PORT || 3006;
const HOST = process.env.MERCY_BIND_HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`[Mercy] Dashboard on ${publicUrl} (bind ${HOST}:${PORT})`));

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ LOGIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
client.login(process.env.MERCY_BOT_TOKEN);
