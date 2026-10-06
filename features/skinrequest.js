/**
 * Feature: Skin Request
 * Lets players suggest skins via /skinrequest (Steam Workshop ID or link).
 * Staff can approve individual skins or entire collections, which sends the
 * skinbox.addskin / skinbox.addcollection command directly to the game server
 * via the Pterodactyl panel API (no extra plugin or open port required).
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const axios = require('axios');

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Sends a console command to the game server via Pterodactyl.
 * Uses the same credentials already stored in .env for MapVote.
 */
async function sendPterodactylCommand(command) {
    const pKey = process.env.PTERODACTYL_API_KEY;
    const pUrl = process.env.PTERODACTYL_PANEL_URL;
    const pId  = process.env.PTERODACTYL_SERVER_ID;

    if (!pKey || !pUrl || !pId) {
        throw new Error('Pterodactyl credentials missing in .env (PTERODACTYL_API_KEY / PTERODACTYL_PANEL_URL / PTERODACTYL_SERVER_ID).');
    }

    await axios.post(
        `${pUrl}/api/client/servers/${pId}/command`,
        { command },
        {
            headers: {
                Authorization: `Bearer ${pKey}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        }
    );
}

/**
 * Fetches details for a Steam Workshop item.
 */
async function fetchSteamItem(skinId) {
    const res = await axios.post(
        'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
        `itemcount=1&publishedfileids[0]=${skinId}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return res.data?.response?.publishedfiledetails?.[0] ?? null;
}

/**
 * Returns true if the Steam Workshop ID belongs to a collection.
 */
async function isCollection(skinId) {
    const res = await axios.post(
        'https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/',
        `collectioncount=1&publishedfileids[0]=${skinId}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return res.data?.response?.collectiondetails?.[0]?.result === 1;
}

// ─── sticky-message state ────────────────────────────────────────────────────
let _client       = null;
let skinStickyId  = null;
let stickyTimeout = null;

async function refreshSticky(channel) {
    const SKIN_CHANNEL_ID = process.env.MERCY_SKIN_CHANNEL_ID;
    if (!SKIN_CHANNEL_ID) return;

    const stickyText =
        '# 💡 How to request a skin:\n' +
        '### 1. Find a skin here: https://steamcommunity.com/app/252490/workshop/\n' +
        '### 2. Type `/skinrequest` and paste the Steam Workshop link or ID to submit it!\n\n' +
        '*Example:* `/skinrequest https://steamcommunity.com/sharedfiles/filedetails/?id=12345678`\n\n' +
        '_This is an automated sticky message._';

    // Delete previous sticky (by stored ID)
    if (skinStickyId) {
        await channel.messages.fetch(skinStickyId).then(m => m.delete()).catch(() => {});
        skinStickyId = null;
    }

    // Also clean up any other lingering stickies from the bot
    try {
        const recent = await channel.messages.fetch({ limit: 15 });
        for (const [, m] of recent) {
            if (m.author.id === _client.user.id && m.content === stickyText) {
                await m.delete().catch(() => {});
            }
        }
    } catch (_) {}

    const newSticky = await channel.send(stickyText);
    skinStickyId = newSticky.id;
}

// ─── module export ───────────────────────────────────────────────────────────

module.exports = {
    commands: [
        new SlashCommandBuilder()
            .setName('skinrequest')
            .setDescription('Suggest a skin from Steam Workshop')
            .addStringOption(opt =>
                opt.setName('skin')
                   .setDescription('Steam Workshop ID or link to the skin / collection')
                   .setRequired(true)
            ),
    ],

    async init({ client }) {
        _client = client;
        console.log('[SkinRequest] Feature loaded.');

        const SKIN_CHANNEL_ID = process.env.MERCY_SKIN_CHANNEL_ID;
        if (!SKIN_CHANNEL_ID) {
            console.warn('[SkinRequest] MERCY_SKIN_CHANNEL_ID not set – sticky and channel-lock disabled.');
            return;
        }

        client.on('messageCreate', async message => {
            if (message.channel.id !== SKIN_CHANNEL_ID) return;

            // Delete regular user messages (they must use the slash command)
            if (!message.author.bot) {
                await message.delete().catch(() => {});
            }

            // Don't react to our own sticky
            if (message.author.id === client.user.id) return;

            // Debounce sticky refresh
            if (stickyTimeout) clearTimeout(stickyTimeout);
            stickyTimeout = setTimeout(() => refreshSticky(message.channel), 1000);
        });
    },

    async handleInteraction(interaction) {
        const SKIN_CHANNEL_ID  = process.env.MERCY_SKIN_CHANNEL_ID;
        const STAFF_ROLE_ID    = process.env.MERCY_STAFF_ROLE_ID;

        // ── /skinrequest ──────────────────────────────────────────────────────
        if (interaction.isChatInputCommand() && interaction.commandName === 'skinrequest') {
            // Enforce skin channel (if configured)
            if (SKIN_CHANNEL_ID && interaction.channelId !== SKIN_CHANNEL_ID) {
                return interaction.reply({
                    content: `❌ This command can only be used in <#${SKIN_CHANNEL_ID}>.`,
                    ephemeral: true,
                });
            }

            let skinInput = interaction.options.getString('skin');
            let skinId    = skinInput;

            // Extract numeric ID from a full Steam URL
            const urlMatch = skinInput.match(/id=(\d+)/);
            if (urlMatch) {
                skinId = urlMatch[1];
            } else if (!/^\d+$/.test(skinId)) {
                return interaction.reply({
                    content: '❌ Please provide a valid Steam Workshop ID or link.',
                    ephemeral: true,
                });
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                const [isCol, item] = await Promise.all([isCollection(skinId), fetchSteamItem(skinId)]);

                if (!item || item.result !== 1) {
                    return interaction.editReply('❌ Could not find this skin/collection on Steam Workshop. Double-check the ID or link.');
                }

                const commandStr = isCol ? `skinbox.addcollection ${skinId}` : `skinbox.addskin ${skinId}`;
                const customId   = isCol ? `approve_collection_${skinId}`    : `approve_skin_${skinId}`;

                const embed = new EmbedBuilder()
                    .setColor('#2b2d31')
                    .setTitle(item.title || 'Unknown Skin')
                    .setURL(`https://steamcommunity.com/sharedfiles/filedetails/?id=${skinId}`)
                    .setAuthor({
                        name: `Requested by ${interaction.user.username}`,
                        iconURL: interaction.user.displayAvatarURL(),
                    })
                    .setDescription(`\`${commandStr}\``)
                    .setFooter({ text: `Workshop ID: ${skinId}` })
                    .setTimestamp();

                if (item.preview_url) embed.setImage(item.preview_url);

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(customId)
                        .setLabel(isCol ? '✅ Approve Collection' : '✅ Approve Skin')
                        .setStyle(ButtonStyle.Success)
                );

                const sentMsg = await interaction.channel.send({ embeds: [embed], components: [row] });

                // Community up/down voting
                await sentMsg.react('👍');
                await sentMsg.react('👎');

                await interaction.editReply('✅ Your skin request has been posted!');
            } catch (e) {
                console.error('[SkinRequest] Error:', e.message);
                await interaction.editReply('❌ An error occurred while contacting Steam.');
            }
        }

        // ── Approve single skin ───────────────────────────────────────────────
        else if (interaction.isButton() && interaction.customId.startsWith('approve_skin_')) {
            const hasRole = STAFF_ROLE_ID
                ? interaction.member.roles.cache.has(STAFF_ROLE_ID)
                : interaction.member.permissions.has('ManageMessages');

            if (!hasRole) {
                return interaction.reply({ content: '❌ Only staff can approve skins.', ephemeral: true });
            }

            const skinId = interaction.customId.replace('approve_skin_', '');
            await interaction.deferUpdate();

            try {
                await sendPterodactylCommand(`skinbox.addskin ${skinId}`);

                const updated = interaction.message.components.map(row =>
                    new ActionRowBuilder().addComponents(
                        row.components.map(btn =>
                            btn.customId === interaction.customId
                                ? ButtonBuilder.from(btn)
                                    .setDisabled(true)
                                    .setStyle(ButtonStyle.Secondary)
                                    .setLabel(`✅ Approved by ${interaction.user.username}`)
                                : ButtonBuilder.from(btn)
                        )
                    )
                );

                await interaction.editReply({ components: updated });
                console.log(`[SkinRequest] Skin ${skinId} approved by ${interaction.user.tag}.`);
            } catch (e) {
                console.error('[SkinRequest] Pterodactyl error:', e.message);
                await interaction.followUp({ content: '❌ Could not send the command to the server.', ephemeral: true });
            }
        }

        // ── Approve collection ────────────────────────────────────────────────
        else if (interaction.isButton() && interaction.customId.startsWith('approve_collection_')) {
            const hasRole = STAFF_ROLE_ID
                ? interaction.member.roles.cache.has(STAFF_ROLE_ID)
                : interaction.member.permissions.has('ManageMessages');

            if (!hasRole) {
                return interaction.reply({ content: '❌ Only staff can approve collections.', ephemeral: true });
            }

            const skinId = interaction.customId.replace('approve_collection_', '');
            await interaction.deferUpdate();

            try {
                await sendPterodactylCommand(`skinbox.addcollection ${skinId}`);

                const updated = interaction.message.components.map(row =>
                    new ActionRowBuilder().addComponents(
                        row.components.map(btn =>
                            btn.customId === interaction.customId
                                ? ButtonBuilder.from(btn)
                                    .setDisabled(true)
                                    .setStyle(ButtonStyle.Secondary)
                                    .setLabel(`✅ Approved by ${interaction.user.username}`)
                                : ButtonBuilder.from(btn)
                        )
                    )
                );

                await interaction.editReply({ components: updated });
                console.log(`[SkinRequest] Collection ${skinId} approved by ${interaction.user.tag}.`);
            } catch (e) {
                console.error('[SkinRequest] Pterodactyl error:', e.message);
                await interaction.followUp({ content: '❌ Could not send the command to the server.', ephemeral: true });
            }
        }
    },
};
