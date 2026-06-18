const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Partials,
} = require('discord.js');

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN        = process.env.DISCORD_TOKEN;
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// Nombre max de messages à remonter par salon (évite les timeouts sur gros serveurs)
const MAX_PER_CHANNEL = parseInt(process.env.MAX_PER_CHANNEL || '500');

if (!TOKEN) { console.error('❌ DISCORD_TOKEN manquant !'); process.exit(1); }

// ── Client ────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const snipeSessions = new Map();

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// Fetch TOUS les messages d'un salon jusqu'à MAX_PER_CHANNEL, en paginant
async function fetchAllMessages(channel, targetId, maxMessages) {
  const results = [];
  let lastId    = null;
  let total     = 0;

  while (total < maxMessages) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    let batch;
    try {
      batch = await channel.messages.fetch(options);
    } catch {
      break;
    }

    if (batch.size === 0) break;

    for (const [, m] of batch) {
      if (m.author.id === targetId) {
        results.push({
          id:          m.id,
          channelId:   channel.id,
          content:     m.content || '*[Pas de texte]*',
          createdAt:   m.createdTimestamp,
          url:         m.url,
          attachments: m.attachments.size,
        });
      }
    }

    // Dernier message du batch = le plus ancien → on continue à partir de là
    lastId  = batch.last().id;
    total  += batch.size;

    if (batch.size < 100) break; // Plus de messages dans ce salon
  }

  return results;
}

client.on('ready', () => {
  console.log(`✅ Connecté : ${client.user.tag}`);
  console.log(`   Admins   : ${ADMIN_IDS.join(', ') || '⚠️ aucun configuré'}`);
  console.log(`   Max msgs  : ${MAX_PER_CHANNEL} par salon`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild)     return;

  const content = message.content.trim();
  if (!content.toLowerCase().startsWith('!snipe')) return;

  if (!isAdmin(message.author.id)) {
    return message.reply('❌ Tu n\'as pas la permission d\'utiliser cette commande.');
  }

  const args     = content.split(/\s+/);
  const targetId = message.mentions.users.first()?.id || args[1]?.replace(/\D/g, '');

  if (!targetId) {
    return message.reply('**Usage :** `!snipe @user` ou `!snipe <userID>`');
  }

  const targetUser = await client.users.fetch(targetId).catch(() => null);
  if (!targetUser) {
    return message.reply(`❌ Utilisateur introuvable pour l'ID \`${targetId}\`.`);
  }

  const statusMsg = await message.reply(
    `🔍 Scan profond en cours pour **${targetUser.tag}**...\n` +
    `*(jusqu'à ${MAX_PER_CHANNEL} messages par salon — peut prendre quelques secondes)*`
  );

  // Salons texte accessibles
  const channels = message.guild.channels.cache
    .filter(ch =>
      ch.isTextBased() &&
      !ch.isVoiceBased() &&
      ch.permissionsFor(message.guild.members.me)?.has(PermissionsBitField.Flags.ViewChannel) &&
      ch.permissionsFor(message.guild.members.me)?.has(PermissionsBitField.Flags.ReadMessageHistory)
    )
    .map(ch => ch);

  // Scan chaque salon séquentiellement (pagination complète)
  const collected = [];
  let scanned = 0;

  for (const ch of channels) {
    scanned++;
    // Mise à jour du statut toutes les 5 salons
    if (scanned % 5 === 0) {
      await statusMsg.edit(
        `🔍 Scan en cours... **${scanned}/${channels.length}** salons · **${collected.length}** messages trouvés`
      ).catch(() => {});
    }

    const msgs = await fetchAllMessages(ch, targetId, MAX_PER_CHANNEL);
    collected.push(...msgs);
  }

  collected.sort((a, b) => b.createdAt - a.createdAt);

  if (collected.length === 0) {
    return statusMsg.edit({
      content: null,
      embeds: [new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('🔍 Aucun message trouvé')
        .setDescription(
          `Aucun message de <@${targetId}> trouvé.\n` +
          `> *${channels.length} salons scannés · ${MAX_PER_CHANNEL} msgs max par salon*`
        )
        .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
        .setTimestamp()],
    });
  }

  // ── Pagination ──────────────────────────────────────────────────────────
  const PAGE_SIZE  = 10;
  const totalPages = Math.ceil(collected.length / PAGE_SIZE);
  const sessionId  = `snipe_${message.id}`;

  snipeSessions.set(sessionId, {
    messages:    collected,
    page:        0,
    totalPages,
    targetId,
    targetTag:   targetUser.tag,
    requesterId: message.author.id,
  });

  function buildPage(page) {
    const slice  = collected.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    const fields = slice.map((m, i) => {
      const ts      = `<t:${Math.floor(m.createdAt / 1000)}:R>`;
      const preview = m.content.length > 120 ? m.content.slice(0, 117) + '...' : m.content;
      const attach  = m.attachments > 0 ? ` 📎×${m.attachments}` : '';
      return {
        name:   `#${page * PAGE_SIZE + i + 1} · <#${m.channelId}> · ${ts}`,
        value:  `${preview}${attach}\n[Voir le message](${m.url})`,
        inline: false,
      };
    });
    return new EmbedBuilder()
      .setColor(0xFF4444)
      .setTitle(`🎯 Snipe — ${targetUser.tag}`)
      .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
      .setDescription(`**${collected.length} message(s) trouvé(s)** · Page ${page + 1}/${totalPages}`)
      .addFields(fields)
      .setFooter({ text: `ID : ${targetId} · ${channels.length} salons scannés · Boutons actifs 10 min` })
      .setTimestamp();
  }

  function buildButtons(page) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${sessionId}_prev`)
        .setLabel('◀ Précédent')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`${sessionId}_next`)
        .setLabel('Suivant ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId(`${sessionId}_delete`)
        .setLabel(`🗑️ Tout supprimer (${collected.length})`)
        .setStyle(ButtonStyle.Danger),
    );
  }

  await statusMsg.edit({
    content:    null,
    embeds:     [buildPage(0)],
    components: [buildButtons(0)],
  });

  // ── Collector boutons ──────────────────────────────────────────────────
  const collector = statusMsg.createMessageComponentCollector({ time: 10 * 60 * 1000 });

  collector.on('collect', async (interaction) => {
    if (!isAdmin(interaction.user.id)) {
      return interaction.reply({ content: '❌ Seul un admin peut utiliser ces boutons.', ephemeral: true });
    }

    const session = snipeSessions.get(sessionId);
    if (!session) {
      return interaction.reply({ content: '❌ Session expirée.', ephemeral: true });
    }

    const action = interaction.customId.split('_').pop();

    if (action === 'prev') {
      session.page = Math.max(0, session.page - 1);
      return interaction.update({ embeds: [buildPage(session.page)], components: [buildButtons(session.page)] });
    }

    if (action === 'next') {
      session.page = Math.min(totalPages - 1, session.page + 1);
      return interaction.update({ embeds: [buildPage(session.page)], components: [buildButtons(session.page)] });
    }

    if (action === 'delete') {
      await interaction.deferUpdate();
      await statusMsg.edit({
        embeds: [new EmbedBuilder()
          .setColor(0xFFA500)
          .setTitle('⏳ Suppression en cours...')
          .setDescription(`Suppression de **${session.messages.length}** messages de **${session.targetTag}**...`)
          .setTimestamp()],
        components: [],
      });

      let deleted = 0, failed = 0;

      for (const msgData of session.messages) {
        try {
          const ch = await client.channels.fetch(msgData.channelId).catch(() => null);
          const m  = ch ? await ch.messages.fetch(msgData.id).catch(() => null) : null;
          if (m) { await m.delete(); deleted++; }
          else failed++;
          // Mise à jour du compteur toutes les 20 suppressions
          if ((deleted + failed) % 20 === 0) {
            await statusMsg.edit({
              embeds: [new EmbedBuilder()
                .setColor(0xFFA500)
                .setTitle('⏳ Suppression en cours...')
                .setDescription(`**${deleted + failed}/${session.messages.length}** traités · ✅ ${deleted} supprimés · ❌ ${failed} échecs`)
                .setTimestamp()],
              components: [],
            }).catch(() => {});
          }
          await new Promise(r => setTimeout(r, 300));
        } catch { failed++; }
      }

      snipeSessions.delete(sessionId);
      collector.stop('deleted');

      await statusMsg.edit({
        embeds: [new EmbedBuilder()
          .setColor(failed > 0 ? 0xFFA500 : 0x57F287)
          .setTitle('✅ Suppression terminée')
          .setDescription(`Messages de **${session.targetTag}** traités.`)
          .addFields(
            { name: '✅ Supprimés', value: `${deleted}`, inline: true },
            { name: '❌ Échecs',    value: `${failed}`,  inline: true },
          )
          .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
          .setFooter({ text: `ID cible : ${session.targetId}` })
          .setTimestamp()],
        components: [],
      });
    }
  });

  collector.on('end', (_, reason) => {
    if (reason !== 'deleted') {
      snipeSessions.delete(sessionId);
      statusMsg.edit({ components: [] }).catch(() => {});
    }
  });
});

client.login(TOKEN);
