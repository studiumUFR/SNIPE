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

// Stockage des sessions snipe en mémoire
const snipeSessions = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// ── Ready ─────────────────────────────────────────────────────────────────────
client.on('ready', () => {
  console.log(`✅ Connecté : ${client.user.tag}`);
  console.log(`   Admins   : ${ADMIN_IDS.join(', ') || '⚠️ aucun configuré'}`);
});

// ── Messages ──────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild)     return;

  const content = message.content.trim();

  if (!content.toLowerCase().startsWith('!snipe')) return;

  // Vérification admin
  if (!isAdmin(message.author.id)) {
    return message.reply('❌ Tu n\'as pas la permission d\'utiliser cette commande.');
  }

  // Récupérer la cible (mention ou ID brut)
  const args     = content.split(/\s+/);
  const targetId = message.mentions.users.first()?.id || args[1]?.replace(/\D/g, '');

  if (!targetId) {
    return message.reply('**Usage :** `!snipe @user` ou `!snipe <userID>`');
  }

  const targetUser = await client.users.fetch(targetId).catch(() => null);
  if (!targetUser) {
    return message.reply(`❌ Utilisateur introuvable pour l'ID \`${targetId}\`.`);
  }

  const statusMsg = await message.reply(`🔍 Scan en cours des messages de **${targetUser.tag}**...`);

  // Récupérer tous les salons texte accessibles par le bot
  const textChannels = message.guild.channels.cache.filter(ch =>
    ch.isTextBased() &&
    !ch.isVoiceBased() &&
    ch.permissionsFor(message.guild.members.me)?.has(PermissionsBitField.Flags.ViewChannel) &&
    ch.permissionsFor(message.guild.members.me)?.has(PermissionsBitField.Flags.ReadMessageHistory)
  );

  // Fetch les 100 derniers messages de chaque salon pour remplir le cache
  for (const [, ch] of textChannels) {
    try { await ch.messages.fetch({ limit: 100 }); } catch { /* salon inaccessible */ }
  }

  // Collecter les messages de la cible depuis le cache
  const collected = [];
  for (const [, ch] of textChannels) {
    for (const [, m] of ch.messages.cache.filter(m => m.author.id === targetId)) {
      collected.push({
        id:          m.id,
        channelId:   ch.id,
        content:     m.content || '*[Pas de texte]*',
        createdAt:   m.createdTimestamp,
        url:         m.url,
        attachments: m.attachments.size,
      });
    }
  }

  // Trier du plus récent au plus ancien
  collected.sort((a, b) => b.createdAt - a.createdAt);

  if (collected.length === 0) {
    return statusMsg.edit({
      content: null,
      embeds: [new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('🔍 Aucun message trouvé')
        .setDescription(
          `Aucun message de <@${targetId}> n'est présent dans le cache.\n` +
          `> *Seuls les **100 derniers messages** par salon sont visibles.*`
        )
        .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
        .setTimestamp()],
    });
  }

  // ── Pagination ───────────────────────────────────────────────────────────
  const PAGE_SIZE  = 10;
  const totalPages = Math.ceil(collected.length / PAGE_SIZE);
  const sessionId  = `snipe_${message.id}`;

  snipeSessions.set(sessionId, {
    messages:   collected,
    page:       0,
    totalPages,
    targetId,
    targetTag:  targetUser.tag,
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
      .setFooter({ text: `ID : ${targetId} · Boutons actifs 10 min` })
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

  // ── Collector boutons ────────────────────────────────────────────────────
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

      let deleted = 0;
      let failed  = 0;

      for (const msgData of session.messages) {
        try {
          const ch = await client.channels.fetch(msgData.channelId).catch(() => null);
          const m  = ch ? await ch.messages.fetch(msgData.id).catch(() => null) : null;
          if (m) { await m.delete(); deleted++; }
          else failed++;
          await new Promise(r => setTimeout(r, 300)); // anti rate-limit
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

// ── Backup / Clone de serveur ────────────────────────────────────────────────
// Usage : !backupserver <sourceServerId> <targetServerId> <adminRoleId>
// Copie les rôles (ordre, perms, couleur) et les salons (catégories, ordre,
// permissions par rôle) du serveur source vers le serveur cible.
//
// Prérequis :
//  - Le bot doit être membre des DEUX serveurs.
//  - Sur le serveur CIBLE, le rôle du bot doit avoir "Administrator" (ou au
//    minimum Manage Roles + Manage Channels) ET être placé au-dessus de tous
//    les rôles qu'il doit créer.
//  - adminRoleId = l'ID du rôle "admin" sur le serveur SOURCE. Il sert de
//    repère pour s'assurer que ce rôle est bien recréé et positionné juste
//    en dessous du rôle du bot sur le serveur cible.
//
// Limites connues :
//  - Les overwrites de permissions ciblant des MEMBRES précis ne sont pas
//    copiés (les membres diffèrent d'un serveur à l'autre) : seuls les
//    overwrites liés à des RÔLES sont reproduits.
//  - @everyone n'est pas recréé : ses permissions sont appliquées au
//    @everyone existant du serveur cible.
//  - Aucune suppression sur le serveur cible : la copie s'ajoute par-dessus
//    l'existant (pas de purge automatique).

const backupSessions = new Map(); // pour éviter les lancements multiples en parallèle

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  if (!content.toLowerCase().startsWith('!backupserver')) return;

  if (!isAdmin(message.author.id)) {
    return message.reply('❌ Tu n\'as pas la permission d\'utiliser cette commande.');
  }

  const args = content.split(/\s+/).slice(1);
  const [sourceId, targetId, adminRoleId] = args;

  if (!sourceId || !targetId || !adminRoleId) {
    return message.reply(
      '**Usage :** `!backupserver <sourceServerId> <targetServerId> <adminRoleId>`\n' +
      '`adminRoleId` = ID du rôle admin sur le serveur **source**.'
    );
  }

  if (backupSessions.has(targetId)) {
    return message.reply('⏳ Un backup est déjà en cours vers ce serveur cible.');
  }

  const sourceGuild = await client.guilds.fetch(sourceId).catch(() => null);
  const targetGuild = await client.guilds.fetch(targetId).catch(() => null);

  if (!sourceGuild) return message.reply(`❌ Le bot n'est pas présent (ou ID invalide) sur le serveur source \`${sourceId}\`.`);
  if (!targetGuild) return message.reply(`❌ Le bot n'est pas présent (ou ID invalide) sur le serveur cible \`${targetId}\`.`);

  const fullSource = await sourceGuild.fetch();
  const fullTarget = await targetGuild.fetch();

  const botMemberTarget = await fullTarget.members.fetchMe();
  if (!botMemberTarget.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply('❌ Le bot doit avoir la permission **Administrator** sur le serveur cible pour faire le backup.');
  }

  const statusMsg = await message.reply(
    `🔄 Backup en cours : **${fullSource.name}** → **${fullTarget.name}**...\nÉtape 1/2 : rôles...`
  );

  backupSessions.set(targetId, true);

  try {
    // ── 1. Rôles ──────────────────────────────────────────────────────────
    await fullSource.roles.fetch();
    await fullTarget.roles.fetch();

    const sourceRoles = [...fullSource.roles.cache.values()]
      .filter(r => r.id !== fullSource.id && !r.managed)
      .sort((a, b) => a.position - b.position);

    const botTopPosition = botMemberTarget.roles.highest.position;

    const roleIdMap = new Map(); // sourceRoleId -> nouveau rôle créé sur target

    for (const role of sourceRoles) {
      const created = await fullTarget.roles.create({
        name:        role.name,
        color:       role.color,
        hoist:       role.hoist,
        permissions: role.permissions,
        mentionable: role.mentionable,
        reason:      `Backup serveur ${fullSource.name} (${fullSource.id})`,
      }).catch(() => null);

      if (created) roleIdMap.set(role.id, created);
      await new Promise(r => setTimeout(r, 400)); // anti rate-limit
    }

    const orderedNew = sourceRoles
      .map(r => roleIdMap.get(r.id))
      .filter(Boolean);

    if (orderedNew.length > 0) {
      const positions = orderedNew.map((r, i) => ({
        role:     r.id,
        position: Math.max(1, botTopPosition - orderedNew.length + i),
      }));
      await fullTarget.roles.setPositions(positions).catch(() => {});
    }

    const sourceEveryone = fullSource.roles.everyone;
    await fullTarget.roles.everyone.setPermissions(sourceEveryone.permissions).catch(() => {});

    const adminRoleCopied = roleIdMap.get(adminRoleId);
    if (!adminRoleCopied) {
      await statusMsg.edit(
        `⚠️ Attention : le rôle admin \`${adminRoleId}\` n'a pas été retrouvé/copié (ID invalide ou rôle managé). ` +
        `Le backup continue quand même.`
      );
    }

    await statusMsg.edit(`🔄 Backup en cours : **${fullSource.name}** → **${fullTarget.name}**...\n✅ Rôles copiés (${roleIdMap.size}).\nÉtape 2/2 : salons...`);

    // ── 2. Salons (catégories d'abord, puis le reste) ───────────────────────
    await fullSource.channels.fetch();

    function buildOverwrites(channel) {
      const overwrites = [];
      for (const [, ow] of channel.permissionOverwrites.cache) {
        if (ow.type === 0) {
          const newRoleId = ow.id === fullSource.id ? fullTarget.id : roleIdMap.get(ow.id)?.id;
          if (newRoleId) {
            overwrites.push({ id: newRoleId, allow: ow.allow, deny: ow.deny, type: 0 });
          }
        }
        // type 1 = membre → ignoré volontairement (cf. limites en commentaire)
      }
      return overwrites;
    }

    const sourceChannels = [...fullSource.channels.cache.values()];
    const categories = sourceChannels
      .filter(c => c.type === 4) // GuildCategory
      .sort((a, b) => a.position - b.position);
    const others = sourceChannels
      .filter(c => c.type !== 4)
      .sort((a, b) => a.position - b.position);

    const channelIdMap = new Map();

    for (const cat of categories) {
      const created = await fullTarget.channels.create({
        name: cat.name,
        type: 4,
        permissionOverwrites: buildOverwrites(cat),
        reason: `Backup serveur ${fullSource.name}`,
      }).catch(() => null);
      if (created) channelIdMap.set(cat.id, created);
      await new Promise(r => setTimeout(r, 400));
    }

    for (const ch of others) {
      const opts = {
        name: ch.name,
        type: ch.type,
        permissionOverwrites: buildOverwrites(ch),
        reason: `Backup serveur ${fullSource.name}`,
      };
      if (ch.parentId && channelIdMap.has(ch.parentId)) {
        opts.parent = channelIdMap.get(ch.parentId).id;
      }
      if (typeof ch.topic === 'string') opts.topic = ch.topic;
      if (typeof ch.nsfw === 'boolean') opts.nsfw = ch.nsfw;
      if (typeof ch.bitrate === 'number') opts.bitrate = ch.bitrate;
      if (typeof ch.userLimit === 'number') opts.userLimit = ch.userLimit;
      if (typeof ch.rateLimitPerUser === 'number') opts.rateLimitPerUser = ch.rateLimitPerUser;

      const created = await fullTarget.channels.create(opts).catch(() => null);
      if (created) channelIdMap.set(ch.id, created);
      await new Promise(r => setTimeout(r, 400));
    }

    await statusMsg.edit({
      content: null,
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Backup terminé')
        .setDescription(`**${fullSource.name}** → **${fullTarget.name}**`)
        .addFields(
          { name: 'Rôles copiés',  value: `${roleIdMap.size}`,    inline: true },
          { name: 'Salons copiés', value: `${channelIdMap.size}`, inline: true },
        )
        .setFooter({ text: 'Les overwrites par membre (pas par rôle) n\'ont pas été copiés.' })
        .setTimestamp()],
    });
  } catch (err) {
    console.error(err);
    await statusMsg.edit(`❌ Erreur pendant le backup : ${err.message || err}`).catch(() => {});
  } finally {
    backupSessions.delete(targetId);
  }
});

client.login(TOKEN);
