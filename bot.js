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
let nextPresenceId = 1;
const presenceSessions = new Map(); // Key: ID (number) | Value: Session Object
const onlinePanel = {
    messageId: null,
    channelId: null,
    sessions: new Map() // Key: UserId | Value: Timestamp (number)
};

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
        if (set.size === 0) return 'Personne';
        return Array.from(set).map(id => `<@${id}>`).join('\n');
    };

    // Helper to format late list with time
    const formatLate = (map) => {
        if (map.size === 0) return 'Personne';
        return Array.from(map.entries()).map(([id, time]) => `<@${id}> (${time})`).join('\n');
    };

    embed.addFields(
        { name: `✅ Présent (${session.present.size})`, value: formatList(session.present), inline: true },
        { name: `⏰ Retard (${session.late.size})`, value: formatLate(session.late), inline: true },
        { name: `❌ Absent (${session.absent.size})`, value: formatList(session.absent), inline: true }
    );

    // Only show Uncertain if not empty
    if (session.uncertain.size > 0) {
        embed.addFields({ name: `🔵 Incertain (${session.uncertain.size})`, value: formatList(session.uncertain), inline: true });
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

    if (onlinePanel.sessions.size === 0) {
        embed.setDescription("Aucun joueur en ligne.");
    } else {
        const lines = [];
        const now = Date.now();
        onlinePanel.sessions.forEach((time, userId) => {
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
    if (!onlinePanel.messageId || !onlinePanel.channelId) return;

    try {
        const channel = await client.channels.fetch(onlinePanel.channelId);
        if (!channel) return;
        const message = await channel.messages.fetch(onlinePanel.messageId);
        if (!message) return;

        await message.edit({ embeds: [generateOnlineEmbed()] });
    } catch (error) {
        // If message is deleted (code 10008), clear state
        if (error.code === 10008) {
            onlinePanel.messageId = null;
            onlinePanel.channelId = null;
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
    const id = nextPresenceId++;

    const session = {
        id,
        title,
        tasks,
        channelId: message.channel.id,
        messageId: null,
        present: new Set(),
        absent: new Set(),
        late: new Map(), // UserId -> TimeString
        uncertain: new Set()
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
    presenceSessions.set(id, session);
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

    if (isNaN(id) || !presenceSessions.has(id)) {
        const reply = await message.channel.send("❌ ID de présence invalide.");
        setTimeout(() => reply.delete().catch(() => {}), 5000);
        return;
    }

    const session = presenceSessions.get(id);
    const parts = contentStr.split(';').map(s => s.trim()).filter(s => s.length > 0);
    
    if (parts.length > 0) {
        session.title = parts[0];
        session.tasks = parts.slice(1);
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
    if (onlinePanel.messageId && onlinePanel.channelId) {
        try {
            const oldChan = await client.channels.fetch(onlinePanel.channelId);
            if (oldChan) {
                const oldMsg = await oldChan.messages.fetch(onlinePanel.messageId).catch(() => null);
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
    onlinePanel.messageId = sentMsg.id;
    onlinePanel.channelId = message.channel.id;
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

    if (isNaN(id) || !presenceSessions.has(id)) {
        const reply = await message.channel.send("❌ ID invalide.");
        setTimeout(() => reply.delete().catch(() => {}), 5000);
        return;
    }

    const session = presenceSessions.get(id);
    let targets = [];

    if (category) {
        if (category === 'present') targets = Array.from(session.present);
        else if (category === 'absent') targets = Array.from(session.absent);
        else if (category === 'retard') targets = Array.from(session.late.keys());
        else if (category === 'incertain') targets = Array.from(session.uncertain);
    } else {
        // Target everyone in channel who hasn't reacted
        try {
            const channel = await client.channels.fetch(session.channelId);
            if (channel.isTextBased()) {
                const members = await channel.guild.members.fetch(); 
                const reactedIds = new Set([
                    ...session.present,
                    ...session.absent,
                    ...session.late.keys(),
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
    for (const userId of targets) {
        try {
            const user = await client.users.fetch(userId);
            await user.send(`🔔 **RAPPEL** : ${session.title} (Point N°${session.id})\nMerci d'indiquer votre présence !`);
            count++;
        } catch (e) {
            // Cannot DM user
        }
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
    
    // Online Panel Update Loop (Every 60s)
    setInterval(() => {
        const now = Date.now();
        let changed = false;
        
        // Auto-kick users > 7h
        for (const [userId, time] of onlinePanel.sessions.entries()) {
            if (now - time > 7 * 60 * 60 * 1000) {
                onlinePanel.sessions.delete(userId);
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
            onlinePanel.sessions.set(user.id, Date.now());
        } else {
            onlinePanel.sessions.delete(user.id);
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

        const session = presenceSessions.get(id);
        if (!session) {
            return interaction.reply({ content: "❌ Ce point de présence n'existe plus.", ephemeral: true });
        }

        // Remove user from all lists first (toggle logic)
        // If user clicks same button, we remove them (toggle off)
        // If user clicks different button, we remove from old and add to new
        
        let isRemoving = false;

        if (action === 'present' && session.present.has(user.id)) isRemoving = true;
        if (action === 'absent' && session.absent.has(user.id)) isRemoving = true;
        if (action === 'uncertain' && session.uncertain.has(user.id)) isRemoving = true;
        if (action === 'late' && session.late.has(user.id)) isRemoving = true;

        // Clear all previous states
        session.present.delete(user.id);
        session.absent.delete(user.id);
        session.late.delete(user.id);
        session.uncertain.delete(user.id);

        if (!isRemoving) {
            if (action === 'present') {
                session.present.add(user.id);
                await interaction.deferUpdate();
                await updatePresenceMessage(session);
            }
            else if (action === 'absent') {
                session.absent.add(user.id);
                await interaction.deferUpdate();
                await updatePresenceMessage(session);
            }
            else if (action === 'uncertain') {
                session.uncertain.add(user.id);
                await interaction.deferUpdate();
                await updatePresenceMessage(session);
            }
            else if (action === 'late') {
                // Ask for time input
                await interaction.reply({ content: "⏳ À quelle heure ? (Écrivez simplement l'heure dans le chat, ex: 21h30)", ephemeral: true });
                
                const filter = m => m.author.id === user.id;
                const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 60000 });

                collector.on('collect', async m => {
                    const timeText = m.content;
                    await m.delete().catch(() => {}); // Delete user input
                    
                    // Re-clean to be safe
                    session.present.delete(user.id);
                    session.absent.delete(user.id);
                    session.late.set(user.id, timeText);
                    session.uncertain.delete(user.id);

                    await updatePresenceMessage(session);
                    await interaction.editReply({ content: `✅ Noté : ${timeText}` });
                });
            }
        } else {
            // Just removing
            await interaction.deferUpdate();
            await updatePresenceMessage(session);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
