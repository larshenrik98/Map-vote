using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Oxide.Core;
using Oxide.Core.Libraries;
using Oxide.Core.Libraries.Covalence;

namespace Oxide.Plugins
{
    [Info("MercyMapVote", "LarsH / Mercy Rust", "1.0.0")]
    [Description("Polls the Mercy bot API and applies the winning map vote result automatically")]
    class MercyMapVote : CovalencePlugin
    {
        // ── Configuration ─────────────────────────────────────────────
        // URL to your Node.js bot API (same VPS, port 3006)
        private const string API_BASE   = "http://54.37.38.122:3006/api/mapvote";

        // How often (seconds) to poll for a winner
        private const float POLL_INTERVAL = 30f;

        // Countdown (seconds) from announcement to actual server restart
        private const int RESTART_DELAY_SECONDS = 60;

        // ── Internal state ─────────────────────────────────────────────
        private Timer _pollTimer;
        private bool  _applying = false;   // guard against double-apply

        private Configuration config;

        private class Configuration
        {
            [JsonProperty("API Secret")]
            public string ApiSecret { get; set; } = "MercyRustMapVote2026!";
        }

        protected override void LoadConfig()
        {
            base.LoadConfig();
            try
            {
                config = Config.ReadObject<Configuration>();
                if (config == null) throw new Exception();
            }
            catch
            {
                LoadDefaultConfig();
            }
            SaveConfig();
        }

        protected override void LoadDefaultConfig()
        {
            config = new Configuration();
        }

        protected override void SaveConfig()
        {
            Config.WriteObject(config);
        }

        // ── Oxide Hooks ───────────────────────────────────────────────
        void OnServerInitialized()
        {
            // The server has finished booting (either a normal restart or after a wipe)
            // We tell the Node.js API so it can post the wipe announcement if this is the first boot after a map vote
            SendBootedEvent();
        }

        void Loaded()
        {
            _applying = false;
            Puts("[MercyMapVote] Plugin loaded — polling for winner every " + POLL_INTERVAL + "s");
            _pollTimer = timer.Every(POLL_INTERVAL, PollForWinner);
            PollForWinner(); // immediate first check
        }

        void Unload()
        {
            _pollTimer?.Destroy();
        }

        // ── Poll the bot API ──────────────────────────────────────────
        void PollForWinner()
        {
            if (_applying) return;

            var headers = new Dictionary<string, string>
            {
                { "x-api-secret", config.ApiSecret },
                { "Accept", "application/json" }
            };

            webrequest.Enqueue(
                API_BASE + "/winner",
                null,
                OnWinnerResponse,
                this,
                RequestMethod.GET,
                headers
            );
        }

        void OnWinnerResponse(int code, string body)
        {
            if (_applying) return;

            if (code != 200)
            {
                if (code != 0)
                    Puts($"[MercyMapVote] Poll returned HTTP {code}");
                return;
            }

            if (string.IsNullOrEmpty(body) || body.Trim() == "null")
                return; // no winner yet

            WinnerPayload winner;
            try { winner = JsonConvert.DeserializeObject<WinnerPayload>(body); }
            catch (Exception e) { Puts("[MercyMapVote] JSON parse error: " + e.Message); return; }

            if (winner == null || winner.seed <= 0 || winner.size <= 0) return;

            _applying = true;
            _pollTimer?.Destroy(); // stop polling while we handle this

            Puts($"[MercyMapVote] Winner received! Seed={winner.seed} Size={winner.size}");
            ApplyWinner(winner);
        }

        // ── Apply the winning map ─────────────────────────────────────
        void ApplyWinner(WinnerPayload winner)
        {
            // Set seed and worldsize via server console
            server.Command("server.seed", winner.seed.ToString());
            server.Command("server.worldsize", winner.size.ToString());

            Puts($"[MercyMapVote] Set server.seed={winner.seed} server.worldsize={winner.size}");

            // Broadcast to all connected players
            string line1 = "<color=#ff6600>Map Vote Result!</color>";
            string line2 = "<color=#ffffff>Next wipe map has been chosen!</color>";
            string line3 = $"<color=#ffaa00>Seed: {winner.seed}  |  Size: {winner.size}</color>";
            string line4 = $"<color=#aaaaaa>Server restarts in <color=#ff4455>{RESTART_DELAY_SECONDS} seconds</color>.</color>";

            ulong ChatIcon = 76561199852442684UL;

            foreach (var covalencePlayer in players.Connected)
            {
                var bp = covalencePlayer.Object as BasePlayer;
                if (bp != null)
                {
                    bp.SendConsoleCommand("chat.add", 2, ChatIcon, line1);
                    bp.SendConsoleCommand("chat.add", 2, ChatIcon, line2);
                    bp.SendConsoleCommand("chat.add", 2, ChatIcon, line3);
                    bp.SendConsoleCommand("chat.add", 2, ChatIcon, line4);
                }
                else
                {
                    covalencePlayer.Message(line1);
                    covalencePlayer.Message(line2);
                    covalencePlayer.Message(line3);
                    covalencePlayer.Message(line4);
                }
            }

            Puts($"[MercyMapVote] Announced winner to all players. Sending ACK...");

            // ACK the bot API so it marks winner_applied = 1
            SendAck(winner.voteId);

            // Schedule restart
            ScheduleRestart();
        }

        // ── Send ACK ─────────────────────────────────────────────────
        void SendAck(int voteId)
        {
            var headers = new Dictionary<string, string>
            {
                { "x-api-secret", config.ApiSecret },
                { "Content-Type", "application/json" }
            };

            string body = JsonConvert.SerializeObject(new { voteId });

            webrequest.Enqueue(
                API_BASE + "/winner/ack",
                body,
                (code, resp) =>
                {
                    if (code == 200)
                        Puts("[MercyMapVote] ACK sent — winner_applied marked.");
                    else
                        Puts($"[MercyMapVote] ACK failed (HTTP {code}): {resp}");
                },
                this,
                RequestMethod.POST,
                headers
            );
        }

        // ── Countdown + restart ───────────────────────────────────────
        void ScheduleRestart()
        {
            // Announce at these remaining-second marks
            int[] announceAt = { 30, 10, 5, 4, 3, 2, 1 };

            foreach (int at in announceAt)
            {
                if (at >= RESTART_DELAY_SECONDS) continue;
                int delayFor = RESTART_DELAY_SECONDS - at;
                int count    = at;

                timer.Once(delayFor, () =>
                {
                    string msg = count == 1
                        ? "<color=#ff4455>Server restarting in 1 second!</color>"
                        : $"<color=#ff9900>Server restart in <color=#ff4455>{count} seconds</color>.</color>";
                    ulong ChatIcon = 76561199852442684UL;
                    foreach (var covalencePlayer in players.Connected)
                    {
                        var bp = covalencePlayer.Object as BasePlayer;
                        if (bp != null)
                            bp.SendConsoleCommand("chat.add", 2, ChatIcon, msg);
                        else
                            covalencePlayer.Message(msg);
                    }
                    Puts($"[MercyMapVote] Restart in {count}s...");
                });
            }

            // Actual restart after full delay
            timer.Once(RESTART_DELAY_SECONDS, () =>
            {
                Puts("[MercyMapVote] Restarting server now to apply new map!");
                server.Command("quit");
            });
        }

        // ── Send Booted Event ─────────────────────────────────────────
        void SendBootedEvent()
        {
            var headers = new Dictionary<string, string>
            {
                { "x-api-secret", config.ApiSecret },
                { "Content-Type", "application/json" }
            };

            string body = JsonConvert.SerializeObject(new { 
                port = server.Port
            });

            webrequest.Enqueue(
                API_BASE + "/booted",
                body,
                (code, resp) =>
                {
                    if (code == 200)
                        Puts("[MercyMapVote] Boot event sent to API.");
                },
                this,
                RequestMethod.POST,
                headers
            );
        }

        // ── Data model ───────────────────────────────────────────────
        class WinnerPayload
        {
            public int    voteId { get; set; }
            public int    seed   { get; set; }
            public int    size   { get; set; }
            public string url    { get; set; }
        }
    }
}
