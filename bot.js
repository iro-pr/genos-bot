require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Partials,
    PermissionsBitField,
    ComponentType
} = require('discord.js');
const Enmap = require('enmap');

// ==========================================
// CONFIGURATION & STATE
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel]
});

// State Management
const presenceDB = new Enmap({
    name: "presenceSessions",
    fetchAll: true,
    autoFetch: true,
    cloneLevel: 'deep',
    dataDir: './data'
});

const onlineSessionsDB = new Enmap({
    name: "onlineSessions",
    fetchAll: true,
    autoFetch: true,
    cloneLevel: 'deep',
    dataDir: './data'
});

const metaDB = new Enmap({
    name: "meta",
    dataDir: './data'
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Formats milliseconds into a readable duration string (e.g., "1h 20min")
 */
function formatDuration(ms) {
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)));

    if (hours > 0) return `${hours}h ${minutes}min`;
    return `${minutes}min`;
}

/**
 * Generates the Embed for a Presence Session
 */
function generatePresenceEmbed(session) {
    const embed = new EmbedBuilder()
        .setTitle(`📢 ${session.title}`)
        .setColor(0x0099FF)
        .setFooter({ text: `Point de présence N°${session.id}` })
        .setTimestamp();

    if (session.tasks && session.tasks.length > 0) {
        embed.setDescription(session.tasks.map(t => `• ${t.trim()}`).join('\n'));
    }

    // Helper to format user lists
    const formatList = (set) => {
        if (set.length === 0) return 'Personne';
        return set.map(id => `<@${id}>`).join('\n');
    };

    // Helper to format late list with time
    const formatLate = (map) => {
        if (Object.keys(map).length === 0) return 'Personne';
        return Object.entries(map).map(([id, time]) => `<@${id}> (${time})`).join('\n');
    };

    embed.addFields(
        { name: `✅ Présent (${session.present.length})`, value: formatList(session.present), inline: true },
        { name: `⏰ Retard (${Object.keys(session.late).length})`, value: formatLate(session.late), inline: true },
        { name: `❌ Absent (${session.absent.length})`, value: formatList(session.absent), inline: true }
    );

    // Only show Uncertain if not empty
    if (session.uncertain.length > 0) {
        embed.addFields({ name: `🔵 Incertain (${session.uncertain.length})`, value: formatList(session.uncertain), inline: true });
    }

    return embed;
}

/**
 * Generates the Embed for the Online Panel
 */
function generateOnlineEmbed() {
    const embed = new EmbedBuilder()
        .setTitle('🟢 Joueurs en ligne')
        .setColor(0x2ECC71)
        .setTimestamp();

    if (onlineSessionsDB.size === 0) {
        embed.setDescription("Aucun joueur en ligne.");
    } else {
        const lines = [];
        const now = Date.now();
        onlineSessionsDB.forEach((time, userId) => {
            lines.push(`<@${userId}> (depuis ${formatDuration(now - time)})`);
        });
        embed.setDescription(lines.join('\n'));
    }
    
    embed.setFooter({ text: "Mise à jour automatique • Auto-kick après 7h" });
    return embed;
}

/**
 * Updates the Discord message for a specific presence session
 */
async function updatePresenceMessage(session) {
    try {
        const channel = await client.channels.fetch(session.channelId);
        if (!channel) return;
        const message = await channel.messages.fetch(session.messageId);
        if (!message) return;

        await message.edit({ embeds: [generatePresenceEmbed(session)] });
    } catch (error) {
        console.error(`Error updating presence message ${session.id}:`, error);
    }
}

/**
 * Updates the Discord message for the Online Panel
 */
async function updateOnlineMessage() {
    const messageId = metaDB.get('onlinePanelMessageId');
    const channelId = metaDB.get('onlinePanelChannelId');
    if (!messageId || !channelId) return;

    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;
        const message = await channel.messages.fetch(messageId);
        if (!message) return;

        await message.edit({ embeds: [generateOnlineEmbed()] });
    } catch (error) {
        // If message is deleted (code 10008), clear state
        if (error.code === 10008) {
            metaDB.set('onlinePanelMessageId', null);
            metaDB.set('onlinePanelChannelId', null);
        }
    }
}

// ==========================================
// COMMAND HANDLERS
// ==========================================

/**
 * !presence Title ; task1 ; task2
 */
async function createPresence(message, argsStr) {
    const parts = argsStr.split(';').map(s => s.trim()).filter(s => s.length > 0);
    if (parts.length === 0) return;

    const title = parts[0];
    const tasks = parts.slice(1);
    const id = metaDB.ensure('nextPresenceId', 1);
    metaDB.inc('nextPresenceId');

    const session = {
        id,
        title,
        tasks,
        channelId: message.channel.id,
        messageId: null,
        present: [],
        absent: [],
        late: {}, // UserId -> TimeString
        uncertain: []
    };

    const embed = generatePresenceEmbed(session);
    
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pres_present_${id}`).setLabel('Présent').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`pres_late_${id}`).setLabel('Retard').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`pres_absent_${id}`).setLabel('Absent').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`pres_uncertain_${id}`).setLabel('Incertain').setStyle(ButtonStyle.Primary)
    );

    const sentMsg = await message.channel.send({ content: '@everyone', embeds: [embed], components: [row] });
    session.messageId = sentMsg.id;
    presenceDB.set(id, session);
}

/**
 * !modif ID Title ; task1
 */
async function modifyPresence(message, argsStr) {
    const firstSpace = argsStr.indexOf(' ');
    if (firstSpace === -1) return;

    const idStr = argsStr.substring(0, firstSpace);
    const contentStr = argsStr.substring(firstSpace + 1);
    const id = parseInt(idStr);

    if (isNaN(id) || !presenceDB.has(id)) {
        const reply = await message.channel.send("❌ ID de présence invalide.");
        setTimeout(() => reply.delete().catch(() => {}), 5000);
        return;
    }

    const session = presenceDB.get(id);
    const parts = contentStr.split(';').map(s => s.trim()).filter(s => s.length > 0);
    
    if (parts.length > 0) {
        session.title = parts[0];
        session.tasks = parts.slice(1);
        presenceDB.set(id, session);
        await updatePresenceMessage(session);
        const reply = await message.channel.send(`✅ Point de présence N°${id} modifié.`);
        setTimeout(() => reply.delete().catch(() => {}), 5000);
    }
}

/**
 * !enligne
 */
async function createOnlinePanel(message) {
    // Delete old panel if it exists
    const oldMsgId = metaDB.get('onlinePanelMessageId');
    const oldChanId = metaDB.get('onlinePanelChannelId');
    if (oldMsgId && oldChanId) {
        try {
            const oldChan = await client.channels.fetch(oldChanId);
            if (oldChan) {
                const oldMsg = await oldChan.messages.fetch(oldMsgId).catch(() => null);
                if (oldMsg) await oldMsg.delete();
            }
        } catch (e) { /* Ignore */ }
    }

    const embed = generateOnlineEmbed();
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('online_join').setLabel('Présent').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('online_leave').setLabel('Absent').setStyle(ButtonStyle.Danger)
    );

    const sentMsg = await message.channel.send({ embeds: [embed], components: [row] });
    metaDB.set('onlinePanelMessageId', sentMsg.id);
    metaDB.set('onlinePanelChannelId', message.channel.id);
}

/**
 * !rappel ID or !rappel category ID
 */
async function handleReminder(message, argsStr) {
    const args = argsStr.split(' ').filter(s => s.length > 0);
    if (args.length === 0) return;

    let id;
    let category = null;

    const categories = ['present', 'absent', 'retard', 'incertain'];
    if (categories.includes(args[0].toLowerCase())) {
        category = args[0].toLowerCase();
        id = parseInt(args[1]);
    } else {
        id = parseInt(args[0]);
    }

    if (isNaN(id) || !presenceDB.has(id)) {
        const reply = await message.channel.send("❌ ID invalide.");
        setTimeout(() => reply.delete().catch(() => {}), 5000);
        return;
    }

    const session = presenceDB.get(id);
    let targets = [];

    if (category) {
        if (category === 'present') targets = session.present;
        else if (category === 'absent') targets = session.absent;
        else if (category === 'retard') targets = Object.keys(session.late);
        else if (category === 'incertain') targets = session.uncertain;
    } else {
        // Target everyone in channel who hasn't reacted
        try {
            const channel = await client.channels.fetch(session.channelId);
            if (channel.isTextBased()) {
                const members = await channel.guild.members.fetch(); 
                const reactedIds = new Set([
                    ...session.present,
                    ...session.absent,
                    ...Object.keys(session.late),
                    ...session.uncertain
                ]);
                
                targets = members.filter(m => !m.user.bot && !reactedIds.has(m.id)).map(m => m.id);
            }
        } catch (e) {
            console.error("Error fetching members for reminder:", e);
            return;
        }
    }

    let count = 0;
    if (targets.length > 0) {
        const mentions = targets.map(id => `<@${id}>`).join(' ');
        await message.channel.send(`🔔 **RAPPEL** : ${session.title} (Point N°${session.id})\nMerci d'indiquer votre présence !\n${mentions}`);
        count = targets.length;
    }

    const reply = await message.channel.send(`✅ Rappel envoyé à ${count} membres.`);
    setTimeout(() => reply.delete().catch(() => {}), 5000);
}

/**
 * !del amount
 */
async function deleteMessages(message, amountStr) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;

    const amount = parseInt(amountStr);
    if (isNaN(amount) || amount < 1 || amount > 100) return;

    try {
        await message.channel.bulkDelete(amount, true);
        const reply = await message.channel.send(`🗑️ ${amount} messages supprimés.`);
        setTimeout(() => reply.delete().catch(() => {}), 3000);
    } catch (e) {
        console.error("Bulk delete error:", e);
    }
}

// ==========================================
// EVENT LISTENERS
// ==========================================

client.once('ready', () => {
    console.log(`✅ Bot connecté: ${client.user.tag}`);

    // Initialize meta database keys if they don't exist
    metaDB.ensure('nextPresenceId', 1);
    metaDB.ensure('onlinePanelMessageId', null);
    metaDB.ensure('onlinePanelChannelId', null);
    
    // Online Panel Update Loop (Every 60s)
    setInterval(() => {
        const now = Date.now();
        let changed = false;
        
        // Auto-kick users > 7h
        for (const [userId, time] of onlineSessionsDB.entries()) {
            if (now - time > 7 * 60 * 60 * 1000) {
                onlineSessionsDB.delete(userId);
                changed = true;
            }
        }

        // Update message to refresh timestamps
        updateOnlineMessage();
    }, 60000);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const restArgs = message.content.slice(1 + command.length).trim();

    try {
        if (command === 'presence') {
            await message.delete().catch(() => {});
            await createPresence(message, restArgs);
        }
        else if (command === 'modif') {
            await message.delete().catch(() => {});
            await modifyPresence(message, restArgs);
        }
        else if (command === 'rappel') {
            await message.delete().catch(() => {});
            await handleReminder(message, restArgs);
        }
        else if (command === 'enligne') {
            await message.delete().catch(() => {});
            await createOnlinePanel(message);
        }
        else if (command === 'del') {
            await message.delete().catch(() => {});
            await deleteMessages(message, args[0]);
        }
    } catch (e) {
        console.error(`Command error (${command}):`, e);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const { customId, user } = interaction;

    // --- ONLINE PANEL LOGIC ---
    if (customId.startsWith('online_')) {
        if (customId === 'online_join') {
            onlineSessionsDB.set(user.id, Date.now());
        } else {
            onlineSessionsDB.delete(user.id);
        }
        await interaction.deferUpdate();
        await updateOnlineMessage();
        return;
    }

    // --- PRESENCE LOGIC ---
    if (customId.startsWith('pres_')) {
        const parts = customId.split('_');
        const action = parts[1];
        const id = parseInt(parts[2]);

        const session = presenceDB.get(id);
        if (!session) {
            return interaction.reply({ content: "❌ Ce point de présence n'existe plus.", ephemeral: true });
        }

        // Remove user from all lists first (toggle logic)
        // If user clicks same button, we remove them (toggle off)
        // If user clicks different button, we remove from old and add to new
        
        let isRemoving = false;

        if (action === 'present' && session.present.includes(user.id)) isRemoving = true;
        if (action === 'absent' && session.absent.includes(user.id)) isRemoving = true;
        if (action === 'uncertain' && session.uncertain.includes(user.id)) isRemoving = true;
        if (action === 'late' && session.late.hasOwnProperty(user.id)) isRemoving = true;

        // Clear all previous states
        presenceDB.remove(id, user.id, 'present');
        presenceDB.remove(id, user.id, 'absent');
        presenceDB.delete(id, `late.${user.id}`);
        presenceDB.remove(id, user.id, 'uncertain');

        if (!isRemoving) {
            if (action === 'present') {
                presenceDB.push(id, user.id, 'present');
                await interaction.deferUpdate();
                await updatePresenceMessage(presenceDB.get(id));
            }
            else if (action === 'absent') {
                presenceDB.push(id, user.id, 'absent');
                await interaction.deferUpdate();
                await updatePresenceMessage(presenceDB.get(id));
            }
            else if (action === 'uncertain') {
                presenceDB.push(id, user.id, 'uncertain');
                await interaction.deferUpdate();
                await updatePresenceMessage(presenceDB.get(id));
            }
            else if (action === 'late') {
                // Ask for time input
                await interaction.reply({ content: "⏳ À quelle heure ? (Écrivez simplement l'heure dans le chat, ex: 21h30)", ephemeral: true });
                
                const filter = m => m.author.id === user.id;
                const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 60000 });

                collector.on('collect', async m => {
                    const timeText = m.content;
                    await m.delete().catch(() => {}); // Delete user input
                    
                    // Re-clean to be safe and set the new state
                    presenceDB.remove(id, user.id, 'present');
                    presenceDB.remove(id, user.id, 'absent');
                    presenceDB.remove(id, user.id, 'uncertain');
                    presenceDB.set(id, timeText, `late.${user.id}`);

                    await updatePresenceMessage(presenceDB.get(id));
                    await interaction.editReply({ content: `✅ Noté : ${timeText}` });
                });
            }
        } else {
            // Just removing
            await interaction.deferUpdate();
            await updatePresenceMessage(presenceDB.get(id));
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
