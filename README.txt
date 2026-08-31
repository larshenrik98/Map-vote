=========================================================
MERCY BOT — RUST SERVER DISCORD BOT
=========================================================

A self-hosted Discord bot for Rust servers. Handles map 
voting, automated biweekly wipes, a web dashboard, and 
full server management — all controllable from Discord 
slash commands.

---------------------------------------------------------
WHAT'S INCLUDED
---------------------------------------------------------
- Map Vote: Players vote on the next map in Discord. 
  Integrates with Pterodactyl to apply the winner automatically.
- Wipe Planner: Schedule automated biweekly (or one-time) wipes. 
  Automatically starts a map vote before each wipe, cleans files, 
  restarts the server, and posts a Discord announcement.
- Wipe Announcement: Rich Discord embeds with map image, 
  seed, size, connect IP, and a Rustmaps link.
- Web Dashboard: A browser-based admin panel.
- Setup Commands: Configure everything via Discord slash 
  commands without needing the dashboard.

---------------------------------------------------------
REQUIREMENTS
---------------------------------------------------------
- A Linux VPS or dedicated server
- Node.js 18+
- PM2 (npm install -g pm2)
- A Pterodactyl panel (Pine Hosting or self-hosted)
- A Discord Bot (Token, Client ID, Client Secret)
- A Rustmaps API key (from rustmaps.com)
- Your Rust server running Oxide/uMod

=========================================================
SETUP GUIDE
=========================================================

STEP 1 — COPY FILES TO YOUR VPS
Create a folder on your VPS (e.g., /home/user/mercy_bot)
and upload all the files from this folder using FTP/SFTP.

STEP 2 — CREATE A DISCORD BOT
1. Go to discord.com/developers/applications
2. Create a New Application (e.g., "MyServer Bot")
3. Go to the "Bot" tab -> Reset Token -> Copy the token.
4. Enable "Server Members Intent" and "Message Content Intent".
5. Go to OAuth2 -> URL Generator:
   - Scopes: "bot" + "applications.commands"
   - Bot Permissions: "Administrator"
6. Open the generated URL to invite the bot to your server.
7. Go to General Information and copy your Application ID.

STEP 3 — CONFIGURE THE .ENV FILE
Rename ".env.example" to ".env" and open it in a text editor.
Fill in all the required values (Tokens, API keys, etc.).

STEP 4 — INSTALL DEPENDENCIES
Open your VPS terminal, go to the bot folder, and run:
npm install

STEP 5 — START THE BOT
Run the following commands:
pm2 start bot.js --name mercy-bot
pm2 save
pm2 logs mercy-bot

STEP 6 — REGISTER YOUR RUST SERVER (IN DISCORD)
In your Discord server, type the slash command:
/server add name:MyServer ptero_id:abc12345 channel:#map-vote api_secret:MySecret123

STEP 7 — ADD MAPS TO THE POOL (IN DISCORD)
Add at least 2 maps to the map pool:
/mappool add rustmaps_url:https://rustmaps.com/map/4000_1234567

STEP 8 — SCHEDULE YOUR FIRST WIPE (IN DISCORD)
Set up the automated wipe schedule (use UTC time):
/wipeschedule set server:MyServer wipe_date:2026-09-11 wipe_time:18:00 vote_lead_hours:24 biweekly:true

STEP 9 — INSTALL THE RUST OXIDE PLUGIN
1. Upload "MercyMapVote.cs" to your Rust server's "oxide/plugins" folder.
2. Edit "oxide/config/MercyMapVote.json" on your Rust server:
   "Api Base Url": "http://your-vps-ip:3006/api/mapvote"
   "Api Secret": "MySecret123" (must match Step 6 exactly!)
3. Reload the plugin: oxide.reload MercyMapVote

Everything is now fully automated!

=========================================================
ALL DISCORD COMMANDS (Admin Only)
=========================================================
SERVER MANAGEMENT:
/server add      - Register a Rust server
/server list     - List all registered servers
/server remove   - Remove a server

MAP POOL:
/mappool add     - Add a map to the pool
/mappool list    - List all maps with their IDs
/mappool remove  - Remove a map by ID

MAP VOTE:
/mapvote         - Start a map vote manually
/endvote         - End the active vote and apply winner

WIPE PLANNER:
/wipeschedule set    - Schedule a wipe
/wipeschedule status - Show active/upcoming wipe schedules
/wipeschedule cancel - Cancel a scheduled wipe

ANNOUNCEMENTS:
/wipeannounce    - Manually post a wipe announcement
