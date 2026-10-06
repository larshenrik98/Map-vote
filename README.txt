=========================================================
MERCY BOT — RUST SERVER DISCORD BOT
=========================================================

A self-hosted Discord bot for Rust servers. Handles map
voting, automated biweekly wipes, skin suggestions with
community voting and one-click approval, and full server
management — all controllable from Discord slash commands.
No Oxide plugins or open server ports required.

---------------------------------------------------------
WHAT'S INCLUDED
---------------------------------------------------------
- Map Vote: Players vote on the next map in Discord.
  Integrates with Pterodactyl to apply the winner
  automatically and restart the server.

- Wipe Planner: Schedule automated biweekly (or one-time)
  wipes. Automatically starts a map vote before each wipe,
  cleans files, restarts the server, and posts a Discord
  announcement when the server is back online.

- Wipe Announcement: Rich Discord embeds with map image,
  seed, size, connect IP, and a Rustmaps link — posted
  automatically when the server finishes restarting.

- Skin Request: Players suggest skins via /skinrequest
  (Steam Workshop ID or link). The bot fetches the name
  and preview image from Steam automatically. Community
  members can vote 👍/👎. Staff approve with one click,
  which sends skinbox.addskin / skinbox.addcollection
  directly to the Rust server via Pterodactyl — no plugin
  or open port needed.

- Setup Commands: Configure everything via Discord slash
  commands without needing a web dashboard.

---------------------------------------------------------
REQUIREMENTS
---------------------------------------------------------
- A Linux VPS / Pterodactyl server to host the bot
- Node.js 18+
- PM2 (npm install -g pm2)
- A Pterodactyl panel (Pine Hosting, Vastrust, or self-hosted)
- A Discord Bot (Token, Client ID)
- A Rustmaps API key (from rustmaps.com)
- Your Rust server running SkinBox (Oxide/uMod plugin)

=========================================================
SETUP GUIDE
=========================================================

STEP 1 — COPY FILES TO YOUR VPS
Create a folder on your VPS (e.g., /home/user/mercy_bot)
and upload all the files from this folder using FTP/SFTP.
If hosting via Pterodactyl, upload all files to the root
of the container (/home/container/).

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
Fill in all the required values (tokens, API keys, IDs, etc.).

Required variables:
  MERCY_BOT_TOKEN          - Your Discord bot token
  MERCY_CLIENT_ID          - Your Discord application/client ID
  MERCY_GUILD_ID           - Your Discord server (guild) ID
  PTERODACTYL_PANEL_URL    - Full URL to your Pterodactyl panel
                             (e.g. https://panel.vastrust.com)
  PTERODACTYL_API_KEY      - Your Pterodactyl CLIENT API key
                             (starts with ptlc_, from Account -> API)
  PTERODACTYL_SERVER_ID    - The short server ID shown in the panel URL
  WIPE_FEED_CHANNEL_ID     - Channel ID where wipe announcements are posted
  RUSTMAPS_API_KEY         - Your Rustmaps API key

For Skin Requests (optional but recommended):
  MERCY_SKIN_CHANNEL_ID    - Channel ID for skin suggestions
  MERCY_STAFF_ROLE_ID      - Role ID allowed to approve skins

STEP 4 — INSTALL DEPENDENCIES
Open your VPS terminal, navigate to the bot folder, and run:
  npm install

STEP 5 — START THE BOT
  pm2 start bot.js --name mercy-bot
  pm2 save
  pm2 logs mercy-bot

STEP 6 — REGISTER YOUR RUST SERVER (IN DISCORD)
In your Discord server, type the slash command:
  /server add name:MyServer ptero_id:abc12345 channel:#map-vote api_secret:MySecret123

  ptero_id  = The short server ID from your Pterodactyl panel URL
  channel   = The Discord channel where map votes will be posted

STEP 7 — ADD MAPS TO THE POOL (IN DISCORD)
Add at least 2 maps to the map pool:
  /mappool add rustmaps_url:https://rustmaps.com/map/4000_1234567

STEP 8 — SCHEDULE YOUR FIRST WIPE (IN DISCORD)
Set up the automated wipe schedule (use UTC time):
  /wipeschedule set server:MyServer wipe_date:2026-09-11 wipe_time:18:00 vote_lead_hours:24 biweekly:true

STEP 9 — SET UP SKIN REQUESTS (OPTIONAL)
1. Create a channel for skin suggestions in your Discord server.
2. Set MERCY_SKIN_CHANNEL_ID to that channel's ID in your .env file.
3. Set MERCY_STAFF_ROLE_ID to the role ID that should be able to approve skins.
4. Make sure SkinBox is installed on your Rust server.

That's it! When a player uses /skinrequest, the bot posts
the skin with a community vote. Staff click "Approve" and
the bot runs skinbox.addskin automatically on the server.

NOTE: The MercyMapVote.cs Oxide plugin is NOT required.
The bot communicates directly with your Pterodactyl panel
for all server operations (map changes, restarts, skin commands).
You do not need to open any extra ports on your Rust server.

=========================================================
ALL DISCORD COMMANDS (Admin/Staff Only)
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

SKIN SUGGESTIONS:
  /skinrequest     - Submit a skin from Steam Workshop
                     (Any player can use this in the skin channel)
