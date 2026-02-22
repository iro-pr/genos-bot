require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    InteractionType,
    ComponentType
} = require('discord.js');

// ==========================================
// CONFIGURATION
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;

// Initialisation du client avec les intents nécessaires
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ==========================================
// STOCKAGE EN MÉMOIRE (State Management)
// ==========================================

// Stockage pour /pr
// Clé : MessageID | Valeur : { present: Set<UserId>, absent: Set<UserId>, late: Map<UserId, TimeString> }
const prSessions = new Map();

// Stockage pour /prp
// Clé : MessageID | Valeur : Map<UserId, Timestamp>
const prpSessions = new Map();

// ==========================================
// ÉVÉNEMENT : READY
// ==========================================
client.once('ready', () => {
    console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
});

// ==========================================
// ÉVÉNEMENT : MESSAGE CREATE (Commandes)
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // --- COMMANDE 1 : /pr ---
    if (message.content === '/pr') {
        const embed = generatePrEmbed([], [], []);
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('pr_present').setLabel('Présent').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId('pr_late').setLabel('En retard').setStyle(ButtonStyle.Secondary).setEmoji('⏰'),
            new ButtonBuilder().setCustomId('pr_absent').setLabel('Absent').setStyle(ButtonStyle.Danger).setEmoji('❌')
        );

        const sentMessage = await message.channel.send({ embeds: [embed], components: [row] });

        // Initialisation des données pour ce message
        prSessions.set(sentMessage.id, {
            present: new Set(),
            absent: new Set(),
            late: new Map() // Map<UserId, "Heure">
        });
    }

    // --- COMMANDE 2 : /prp ---
    if (message.content === '/prp') {
        const embed = generatePrpEmbed(new Map());

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('prp_play').setLabel('Je joue').setStyle(ButtonStyle.Success).setEmoji('🟢'),
            new ButtonBuilder().setCustomId('prp_stop').setLabel('Je ne joue plus').setStyle(ButtonStyle.Danger).setEmoji('🔴')
        );

        const sentMessage = await message.channel.send({ embeds: [embed], components: [row] });

        // Initialisation des données pour ce message
        prpSessions.set(sentMessage.id, new Map());
    }
});

// ==========================================
// ÉVÉNEMENT : INTERACTION CREATE (Boutons)
// ==========================================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const { customId, message, user } = interaction;

    // ------------------------------------------
    // LOGIQUE POUR /pr (Présence Session)
    // ------------------------------------------
    if (customId.startsWith('pr_')) {
        
        // Cas spécial : Sélection de l'heure de retard (Boutons éphémères)
        // Format ID : pr_time_HEURE_MESSAGEID
        if (customId.startsWith('pr_time_')) {
            const parts = customId.split('_');
            const timeLabel = parts[2] === 'plus23h' ? '+23h' : parts[2];
            const originalMessageId = parts[3];

            const session = prSessions.get(originalMessageId);
            if (!session) return interaction.reply({ content: "Session introuvable ou expirée.", ephemeral: true });

            // Mise à jour des listes
            session.present.delete(user.id);
            session.absent.delete(user.id);
            session.late.set(user.id, formatTimeLabel(parts[2])); // Fonction pour rendre joli (ex: 2130 -> 21h30)

            // Récupération du message original pour le mettre à jour
            try {
                const originalMessage = await interaction.channel.messages.fetch(originalMessageId);
                const newEmbed = generatePrEmbed(
                    Array.from(session.present),
                    Array.from(session.absent),
                    Array.from(session.late.entries())
                );
                await originalMessage.edit({ embeds: [newEmbed] });
                await interaction.update({ content: `✅ Noté en retard pour **${formatTimeLabel(parts[2])}**.`, components: [] });
            } catch (e) {
                console.error("Erreur update message original:", e);
                await interaction.reply({ content: "Erreur lors de la mise à jour du message principal.", ephemeral: true });
            }
            return;
        }

        // Récupération de la session liée au message cliqué
        const session = prSessions.get(message.id);
        if (!session) return interaction.reply({ content: "Cette session n'est plus active.", ephemeral: true });

        // Gestion des boutons principaux
        if (customId === 'pr_present') {
            session.present.add(user.id);
            session.absent.delete(user.id);
            session.late.delete(user.id);
            await updatePrMessage(interaction, session);
        } 
        else if (customId === 'pr_absent') {
            session.absent.add(user.id);
            session.present.delete(user.id);
            session.late.delete(user.id);
            await updatePrMessage(interaction, session);
        } 
        else if (customId === 'pr_late') {
            // Envoi du menu éphémère pour choisir l'heure
            // On passe l'ID du message principal dans l'ID du bouton pour garder le contexte
            const mid = message.id;
            const rowTime = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`pr_time_21h30_${mid}`).setLabel('21h30').setStyle(ButtonStyle.Primary).setEmoji('🕤'),
                new ButtonBuilder().setCustomId(`pr_time_22h_${mid}`).setLabel('22h').setStyle(ButtonStyle.Primary).setEmoji('🕙'),
                new ButtonBuilder().setCustomId(`pr_time_22h30_${mid}`).setLabel('22h30').setStyle(ButtonStyle.Primary).setEmoji('🕥'),
                new ButtonBuilder().setCustomId(`pr_time_23h_${mid}`).setLabel('23h').setStyle(ButtonStyle.Primary).setEmoji('🕚'),
                new ButtonBuilder().setCustomId(`pr_time_plus23h_${mid}`).setLabel('+23h').setStyle(ButtonStyle.Primary).setEmoji('🌙')
            );

            await interaction.reply({ 
                content: "⏳ Tu penses être là vers quelle heure ?", 
                components: [rowTime], 
                ephemeral: true 
            });
        }
    }

    // ------------------------------------------
    // LOGIQUE POUR /prp (Présence Permanente)
    // ------------------------------------------
    if (customId.startsWith('prp_')) {
        const sessionMap = prpSessions.get(message.id);
        if (!sessionMap) return interaction.reply({ content: "Session permanente introuvable.", ephemeral: true });

        if (customId === 'prp_play') {
            // Si déjà en jeu, on ne fait rien ou on reset le timer (ici on ignore)
            if (!sessionMap.has(user.id)) {
                sessionMap.set(user.id, Date.now());
            }
        } else if (customId === 'prp_stop') {
            sessionMap.delete(user.id);
        }

        // Mise à jour de l'embed
        const newEmbed = generatePrpEmbed(sessionMap);
        await interaction.update({ embeds: [newEmbed] });
    }
});

// ==========================================
// FONCTIONS UTILITAIRES
// ==========================================

/**
 * Génère l'Embed pour la commande /pr
 */
function generatePrEmbed(presentList, absentList, lateListEntries) {
    // lateListEntries est un tableau [userId, heure]
    
    const formatList = (ids) => ids.length > 0 ? ids.map(id => `- <@${id}>`).join('\n') : '- Aucun';
    const formatLateList = (entries) => entries.length > 0 ? entries.map(([id, time]) => `- <@${id}> (${time})`).join('\n') : '- Aucun';

    return new EmbedBuilder()
        .setTitle('📋 Point de présence')
        .setColor(0x0099FF)
        .addFields(
            { name: `Joueurs présents : ${presentList.length}`, value: formatList(presentList), inline: false },
            { name: `Joueurs en retard : ${lateListEntries.length}`, value: formatLateList(lateListEntries), inline: false },
            { name: `Joueurs absents : ${absentList.length}`, value: formatList(absentList), inline: false }
        )
        .setTimestamp();
}

/**
 * Met à jour le message /pr (sauf pour le cas "En retard" qui est géré séparément)
 */
async function updatePrMessage(interaction, session) {
    const newEmbed = generatePrEmbed(
        Array.from(session.present),
        Array.from(session.absent),
        Array.from(session.late.entries())
    );
    await interaction.update({ embeds: [newEmbed] });
}

/**
 * Formate l'ID du bouton temps en texte lisible
 */
function formatTimeLabel(rawTime) {
    if (rawTime === 'plus23h') return '+23h';
    // ex: 21h30 reste 21h30
    return rawTime; 
}

/**
 * Génère l'Embed pour la commande /prp
 */
function generatePrpEmbed(sessionMap) {
    const now = Date.now();
    let description = "";

    if (sessionMap.size === 0) {
        description = "- Aucun joueur";
    } else {
        const lines = [];
        sessionMap.forEach((startTime, userId) => {
            const durationMs = now - startTime;
            const durationStr = formatDuration(durationMs);
            lines.push(`- <@${userId}> (${durationStr})`);
        });
        description = lines.join('\n');
    }

    return new EmbedBuilder()
        .setTitle('🎮 Statut de jeu')
        .setColor(0x2ECC71)
        .setDescription(`**Joueurs en ligne : ${sessionMap.size}**\n\n${description}`)
        .setFooter({ text: "Mise à jour à chaque interaction" })
        .setTimestamp();
}

/**
 * Convertit des millisecondes en format lisible (ex: 1h18 ou 14 min)
 */
function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    if (hours > 0) {
        return `${hours}h${remainingMinutes.toString().padStart(2, '0')}`;
    } else {
        return `${minutes} min`;
    }
}

// Connexion du bot
client.login(TOKEN);
