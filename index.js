const http = require('http');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ChannelType,
  AuditLogEvent,
} = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
const port = Number(process.env.PORT || 10000);
const LOG_FORUM_ID = '1544418674893394010';
const AUTO_ROLE_ID = '1525615883525951538';

if (!token) {
  throw new Error('DISCORD_TOKEN is not set');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Проверить, работает ли бот'),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Удалить сообщения в текущем канале')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .addStringOption((option) =>
      option
        .setName('amount')
        .setDescription('Количество сообщений от 1 до 1000 или all')
        .setRequired(true)
    ),
].map((command) => command.toJSON());

// -----------------------------------------------------
// Render health check
// -----------------------------------------------------
function startHealthServer() {
  const server = http.createServer((request, response) => {
    if (request.url === '/' || request.url === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Majestic Family Bot is running');
      return;
    }

    response.writeHead(404);
    response.end('Not found');
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Health server is listening on port ${port}`);
  });
}

// -----------------------------------------------------
// Forum audit logs
// -----------------------------------------------------
const LOG_THREAD_DEFS = {
  memberJoinLeave: {
    name: '🚪 Входы и выходы',
    title: 'Вход или выход участника',
    color: 0x2ecc71,
    description: 'Логи входа участников на сервер и выхода с сервера.',
  },
  memberKick: {
    name: '🔨 Кики участников',
    title: 'Участник кикнут',
    color: 0xe74c3c,
    description: 'Логи принудительного исключения участников с сервера.',
  },
  roleUpdate: {
    name: '👥 Изменение ролей',
    title: 'Изменение ролей',
    color: 0x3498db,
    description: 'Логи выдачи и снятия ролей с участников.',
  },
  messageUpdate: {
    name: '📝 Изменение сообщений',
    title: 'Изменение сообщения',
    color: 0x3498db,
    description: 'Логи редактирования сообщений участников.',
  },
  messageDelete: {
    name: '🗑️ Удаление сообщений',
    title: 'Удаление сообщения',
    color: 0xe67e22,
    description: 'Логи удаления сообщений участников.',
  },
  channel: {
    name: '📡 Каналы',
    title: 'Изменение каналов',
    color: 0x3498db,
    description: 'Логи создания, удаления, переименования каналов и изменения прав.',
  },
};

const logThreadCache = new Map();
const logThreadLocks = new Map();

function clipLogText(value, max = 1800) {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function isTargetGuild(guild) {
  return Boolean(guild && (!guildId || guild.id === guildId));
}

function buildLogEmbed(def, lines, extra = {}) {
  return new EmbedBuilder()
    .setColor(extra.color || def.color)
    .setTitle(extra.title || def.title)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Majestic Family Bot logs' })
    .setTimestamp();
}

async function findRecentAuditEntry(guild, type, targetId) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const audit = await guild.fetchAuditLogs({ type, limit: 10 });
    const now = Date.now();
    return audit.entries.find((entry) => {
      const entryTargetId = entry.target?.id || entry.targetId;
      return entryTargetId === targetId && now - entry.createdTimestamp < 15000;
    }) || null;
  } catch (error) {
    console.error('[AUDIT LOOKUP ERROR]', error.message || error);
    return null;
  }
}

function formatAuditExecutor(entry) {
  return entry?.executorId ? `<@${entry.executorId}>` : 'Неизвестно / аудит недоступен';
}

async function ensureLogThread(guild, key) {
  if (!isTargetGuild(guild)) return null;

  const def = LOG_THREAD_DEFS[key];
  if (!def) return null;

  const cacheKey = `${guild.id}:${key}`;
  if (logThreadCache.has(cacheKey)) {
    const cached = await guild.channels.fetch(logThreadCache.get(cacheKey)).catch(() => null);
    if (cached) {
      if (cached.archived) await cached.setArchived(false).catch(() => null);
      return cached;
    }
    logThreadCache.delete(cacheKey);
  }

  if (logThreadLocks.has(cacheKey)) return logThreadLocks.get(cacheKey);

  const promise = (async () => {
    const forum = await guild.channels.fetch(LOG_FORUM_ID).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      console.error(`[LOG FORUM] Канал ${LOG_FORUM_ID} не является форумом или недоступен.`);
      return null;
    }

    let thread = null;
    const active = await forum.threads.fetchActive().catch(() => null);
    thread = active?.threads?.find((item) => item.name === def.name) || null;

    if (!thread) {
      const archived = await forum.threads.fetchArchived({ limit: 100 }).catch(() => null);
      thread = archived?.threads?.find((item) => item.name === def.name) || null;
    }

    if (!thread) {
      thread = await forum.threads.create({
        name: def.name,
        autoArchiveDuration: 10080,
        reason: 'Создание публикации форумных логов',
        message: {
          embeds: [buildLogEmbed(def, [def.description], { title: '📚 Публикация логов создана' })],
          allowedMentions: { parse: [] },
        },
      });
    } else if (thread.archived) {
      await thread.setArchived(false).catch(() => null);
    }

    logThreadCache.set(cacheKey, thread.id);
    return thread;
  })().catch((error) => {
    console.error(`[LOG THREAD ERROR] ${key}`, error);
    return null;
  });

  logThreadLocks.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    logThreadLocks.delete(cacheKey);
  }
}

async function sendForumLog(guild, key, lines, extra = {}) {
  try {
    if (!isTargetGuild(guild)) return;
    const def = LOG_THREAD_DEFS[key];
    const thread = await ensureLogThread(guild, key);
    if (!def || !thread) return;
    if (thread.archived) await thread.setArchived(false).catch(() => null);
    await thread.send({
      embeds: [buildLogEmbed(def, lines, extra)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error(`[FORUM LOG ERROR] ${key}`, error);
  }
}

function channelTypeName(channel) {
  if (channel.type === ChannelType.GuildCategory) return 'Категория';
  if (channel.isThread?.()) return 'Ветка';
  if (channel.isVoiceBased?.()) return 'Голосовой канал';
  if (channel.type === ChannelType.GuildForum) return 'Форум';
  return 'Текстовый канал';
}

function channelLabel(channel, fallbackName = 'без названия') {
  const name = clipLogText(channel?.name || fallbackName, 100);
  return channel?.type === ChannelType.GuildCategory
    ? `**${name}**`
    : `<#${channel.id}> (**${name}**)`;
}

function permissionTargetLabel(guild, overwrite, targetId) {
  if (targetId === guild.id) return '@everyone';
  if (overwrite?.type === 1) return `<@${targetId}>`;
  return `<@&${targetId}>`;
}

function permissionNames(permissionBitField) {
  try {
    const names = permissionBitField?.toArray?.() || [];
    return names.length ? names.join(', ') : 'нет';
  } catch {
    return 'не удалось определить';
  }
}

function getPermissionChanges(oldChannel, newChannel) {
  const oldOverwrites = oldChannel.permissionOverwrites?.cache;
  const newOverwrites = newChannel.permissionOverwrites?.cache;
  if (!oldOverwrites || !newOverwrites) return [];

  const ids = new Set([...oldOverwrites.keys(), ...newOverwrites.keys()]);
  const changes = [];
  for (const id of ids) {
    const before = oldOverwrites.get(id);
    const after = newOverwrites.get(id);
    const beforeAllow = before?.allow?.bitfield?.toString() || '0';
    const afterAllow = after?.allow?.bitfield?.toString() || '0';
    const beforeDeny = before?.deny?.bitfield?.toString() || '0';
    const afterDeny = after?.deny?.bitfield?.toString() || '0';
    if (beforeAllow === afterAllow && beforeDeny === afterDeny) continue;

    const target = after || before;
    changes.push(
      `• ${permissionTargetLabel(newChannel.guild, target, id)} — ` +
      `**разрешено:** ${permissionNames(target?.allow)}; ` +
      `**запрещено:** ${permissionNames(target?.deny)}`
    );
  }
  return changes;
}

// -----------------------------------------------------
// Bot commands
// -----------------------------------------------------
const cleanupJobs = new Map();

async function clearAllMessages(channel, job) {
  let deletedTotal = 0;
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;

  while (!job.cancelled) {
    const messages = await channel.messages.fetch({ limit: 100 });
    if (messages.size === 0) break;

    const recent = messages.filter(
      (message) => Date.now() - message.createdTimestamp < fourteenDays
    );
    const old = messages.filter(
      (message) => Date.now() - message.createdTimestamp >= fourteenDays
    );

    if (!job.cancelled && recent.size > 0) {
      const deleted = await channel.bulkDelete(recent, true);
      deletedTotal += deleted.size;
    }

    for (const message of old.values()) {
      if (job.cancelled) break;
      try {
        await message.delete();
        deletedTotal += 1;
      } catch (error) {
        console.warn(`Не удалось удалить старое сообщение: ${error.message}`);
      }
    }

    if (messages.size < 100) break;
  }

  return { deleted: deletedTotal, stopped: job.cancelled };
}

async function clearAmount(channel, amount, job) {
  let left = amount;
  let deletedTotal = 0;

  while (left > 0 && !job.cancelled) {
    const batch = Math.min(left, 100);
    const deleted = await channel.bulkDelete(batch, true);
    deletedTotal += deleted.size;
    left -= batch;
    if (deleted.size < batch) break;
  }

  return { deleted: deletedTotal, stopped: job.cancelled };
}

function stopButtonRow(interactionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`clear_stop_${interactionId}`)
      .setLabel('Остановить очистку')
      .setStyle(ButtonStyle.Danger)
  );
}

async function runClearWithStop(interaction, channel, target) {
  const job = { cancelled: false };
  cleanupJobs.set(interaction.id, job);

  try {
    const reply = await interaction.editReply({
      content: target === 'all'
        ? 'Очищаю канал. Можно остановить процесс кнопкой ниже.'
        : `Удаляю до **${target}** сообщений.`,
      components: [stopButtonRow(interaction.id)],
    });

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 15 * 60 * 1000,
      max: 1,
      filter: (buttonInteraction) => buttonInteraction.user.id === interaction.user.id,
    });

    collector.on('collect', async (buttonInteraction) => {
      job.cancelled = true;
      await buttonInteraction.update({
        content: 'Останавливаю очистку…',
        components: [],
      });
    });

    const result = target === 'all'
      ? await clearAllMessages(channel, job)
      : await clearAmount(channel, target, job);

    collector.stop('finished');
    await interaction.editReply({
      content: result.stopped
        ? `Очистка остановлена. Удалено сообщений: **${result.deleted}**.`
        : `Очистка завершена. Удалено сообщений: **${result.deleted}**.`,
      components: [],
    });
  } finally {
    cleanupJobs.delete(interaction.id);
  }
}

// -----------------------------------------------------
// Events: startup and automatic role
// -----------------------------------------------------
client.once(Events.ClientReady, async () => {
  console.log(`Бот вошёл как ${client.user.tag}`);
  try {
    if (guildId) {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(commands);
      console.log(`Slash-команды зарегистрированы на сервере ${guild.name}`);
    } else {
      await client.application.commands.set(commands);
      console.log('Глобальные slash-команды зарегистрированы');
    }
  } catch (error) {
    console.error('Ошибка регистрации slash-команд:', error);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (!isTargetGuild(member.guild)) return;

  try {
    await sendForumLog(member.guild, 'memberJoinLeave', [
      `**Пользователь:** <@${member.id}> (${clipLogText(member.user.tag)})`,
      `**ID:** \`${member.id}\``,
      `**Аккаунт создан:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`,
    ], { title: '📥 Пользователь зашёл', color: 0x2ecc71 });

    if (member.user.bot) return;

    const role = await member.guild.roles.fetch(AUTO_ROLE_ID).catch(() => null);
    const botMember = member.guild.members.me;
    if (!role || !botMember) {
      console.error(`Роль ${AUTO_ROLE_ID} или участник бота не найдены.`);
      return;
    }
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      console.error('У бота нет права Управлять ролями.');
      return;
    }
    if (role.managed || role.position >= botMember.roles.highest.position) {
      console.error('Роль для автодобавления должна быть ниже роли бота.');
      return;
    }

    await member.roles.add(role, 'Автоматическая роль новому участнику');
    console.log(`Роль ${role.name} выдана пользователю ${member.user.tag}`);
  } catch (error) {
    console.error('[MEMBER ADD ERROR]', error);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  if (!isTargetGuild(member.guild)) return;

  try {
    const kickEntry = await findRecentAuditEntry(
      member.guild,
      AuditLogEvent.MemberKick,
      member.id
    );
    const lines = [
      `**Участник:** <@${member.id}> (${clipLogText(member.user?.tag || member.displayName)})`,
      `**ID:** \`${member.id}\``,
      `**Роли до выхода:** ${member.roles?.cache?.filter((role) => role.id !== member.guild.id).map((role) => `<@&${role.id}>`).join(', ') || 'нет ролей'}`,
    ];

    if (kickEntry) {
      await sendForumLog(member.guild, 'memberKick', [
        ...lines,
        `**Кто кикнул:** ${formatAuditExecutor(kickEntry)}`,
        `**Причина:** ${clipLogText(kickEntry.reason || 'Причина не указана')}`,
      ]);
    } else {
      await sendForumLog(member.guild, 'memberJoinLeave', lines, {
        title: '📤 Участник покинул сервер',
        color: 0xe74c3c,
      });
    }
  } catch (error) {
    console.error('[MEMBER REMOVE LOG ERROR]', error);
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (!isTargetGuild(newMember.guild)) return;

  try {
    const oldRoles = oldMember.roles.cache.filter((role) => role.id !== newMember.guild.id);
    const newRoles = newMember.roles.cache.filter((role) => role.id !== newMember.guild.id);
    const addedRoles = newRoles.filter((role) => !oldRoles.has(role.id));
    const removedRoles = oldRoles.filter((role) => !newRoles.has(role.id));
    if (!addedRoles.size && !removedRoles.size) return;

    const roleAudit = await findRecentAuditEntry(
      newMember.guild,
      AuditLogEvent.MemberRoleUpdate,
      newMember.id
    );
    await sendForumLog(newMember.guild, 'roleUpdate', [
      `**Кто изменил:** ${formatAuditExecutor(roleAudit)}`,
      `**Кому изменили:** <@${newMember.id}> (${clipLogText(newMember.user.tag)})`,
      `**Выданы роли:** ${addedRoles.map((role) => `<@&${role.id}>`).join(', ') || 'нет'}`,
      `**Сняты роли:** ${removedRoles.map((role) => `<@&${role.id}>`).join(', ') || 'нет'}`,
    ]);
  } catch (error) {
    console.error('[ROLE UPDATE LOG ERROR]', error);
  }
});

// -----------------------------------------------------
// Events: message logs
// -----------------------------------------------------
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    if (!newMessage.guild || !isTargetGuild(newMessage.guild) || newMessage.author?.bot) return;
    if (oldMessage.partial) await oldMessage.fetch().catch(() => null);

    const before = oldMessage.content || '[Текст неизвестен]';
    const after = newMessage.content || '[сообщение без текста]';
    if (before === after) return;

    await sendForumLog(newMessage.guild, 'messageUpdate', [
      `**Автор:** <@${newMessage.author.id}> (${clipLogText(newMessage.author.tag)})`,
      `**Канал:** <#${newMessage.channelId}>`,
      `**Сообщение:** [перейти](https://discord.com/channels/${newMessage.guild.id}/${newMessage.channelId}/${newMessage.id})`,
      '',
      `**До:**\n${clipLogText(before)}`,
      '',
      `**После:**\n${clipLogText(after)}`,
    ]);
  } catch (error) {
    console.error('[MESSAGE UPDATE LOG ERROR]', error);
  }
});

client.on(Events.MessageDelete, async (message) => {
  try {
    if (!message.guild || !isTargetGuild(message.guild) || message.author?.bot) return;
    if (message.partial) await message.fetch().catch(() => null);

    const attachments = message.attachments?.size
      ? `**Вложения:** ${[...message.attachments.values()].map((attachment) => attachment.url).join('\n')}`
      : '';
    await sendForumLog(message.guild, 'messageDelete', [
      `**Автор:** <@${message.author?.id || '0'}> (${clipLogText(message.author?.tag || 'неизвестно')})`,
      `**Канал:** <#${message.channelId}>`,
      `**Сообщение ID:** \`${message.id}\``,
      `**Текст:**\n${clipLogText(message.content || '[сообщение без текста]')}`,
      attachments,
    ].filter(Boolean));
  } catch (error) {
    console.error('[MESSAGE DELETE LOG ERROR]', error);
  }
});

// -----------------------------------------------------
// Events: channel logs
// -----------------------------------------------------
client.on(Events.ChannelCreate, async (channel) => {
  try {
    if (!channel.guild || !isTargetGuild(channel.guild)) return;
    const entry = await findRecentAuditEntry(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    await sendForumLog(channel.guild, 'channel', [
      `**Канал:** ${channelLabel(channel)}`,
      `**ID:** \`${channel.id}\``,
      `**Тип:** \`${channelTypeName(channel)}\``,
      `**Кто создал:** ${formatAuditExecutor(entry)}`,
      `**Категория:** ${channel.parentId ? `<#${channel.parentId}>` : 'нет'}`,
    ], { title: '📥 Канал создан', color: 0x2ecc71 });
  } catch (error) {
    console.error('[CHANNEL CREATE LOG ERROR]', error);
  }
});

client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
  try {
    if (!newChannel.guild || !isTargetGuild(newChannel.guild)) return;
    const nameChanged = oldChannel.name !== newChannel.name;
    const permissionChanges = getPermissionChanges(oldChannel, newChannel);
    if (!nameChanged && !permissionChanges.length) return;

    const entry = await findRecentAuditEntry(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
    const lines = [
      `**Канал:** ${channelLabel(newChannel)}`,
      `**ID:** \`${newChannel.id}\``,
      `**Кто изменил:** ${formatAuditExecutor(entry)}`,
    ];
    if (nameChanged) {
      lines.push(`**Название до:** ${clipLogText(oldChannel.name || 'без названия')}`);
      lines.push(`**Название после:** ${clipLogText(newChannel.name || 'без названия')}`);
    }
    if (permissionChanges.length) {
      lines.push('**Изменение прав:**', ...permissionChanges);
    }

    await sendForumLog(newChannel.guild, 'channel', lines, {
      title: nameChanged && permissionChanges.length
        ? '✏️ Изменение канала и прав'
        : nameChanged
          ? '✏️ Изменение названия канала'
          : '🔐 Изменение прав канала',
      color: 0xf1c40f,
    });
  } catch (error) {
    console.error('[CHANNEL UPDATE LOG ERROR]', error);
  }
});

client.on(Events.ChannelDelete, async (channel) => {
  try {
    if (!channel.guild || !isTargetGuild(channel.guild)) return;
    const entry = await findRecentAuditEntry(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    await sendForumLog(channel.guild, 'channel', [
      `**Канал:** ${channelLabel(channel)}`,
      `**ID:** \`${channel.id}\``,
      `**Тип:** \`${channelTypeName(channel)}\``,
      `**Кто удалил:** ${formatAuditExecutor(entry)}`,
      `**Причина:** ${clipLogText(entry?.reason || 'Причина не указана')}`,
    ], { title: '📤 Канал удалён', color: 0xe74c3c });
  } catch (error) {
    console.error('[CHANNEL DELETE LOG ERROR]', error);
  }
});

// -----------------------------------------------------
// Slash command interactions
// -----------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
      await interaction.reply({
        content: `Pong! Задержка: ${Math.round(client.ws.ping)} мс.`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName !== 'clear') return;
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Команду можно использовать только на сервере.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({ content: 'Нужны права **Управлять сообщениями**.', ephemeral: true });
      return;
    }

    const channel = interaction.channel;
    const botPermissions = channel?.permissionsFor(interaction.guild.members.me);
    if (!channel || !botPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({ content: 'У бота нет права **Управлять сообщениями** в этом канале.', ephemeral: true });
      return;
    }

    const value = interaction.options.getString('amount').trim().toLowerCase();
    if (value === 'all') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`clear_confirm_${interaction.id}`)
          .setLabel('Удалить всё')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`clear_cancel_${interaction.id}`)
          .setLabel('Отмена')
          .setStyle(ButtonStyle.Secondary)
      );

      const reply = await interaction.reply({
        content: 'Точно удалить все доступные сообщения в этом канале?',
        components: [row],
        ephemeral: true,
        fetchReply: true,
      });

      const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 30000,
        max: 1,
      });

      collector.on('collect', async (buttonInteraction) => {
        if (buttonInteraction.user.id !== interaction.user.id) return;
        if (buttonInteraction.customId.startsWith('clear_cancel_')) {
          await buttonInteraction.update({ content: 'Очистка отменена.', components: [] });
          return;
        }

        await buttonInteraction.update({ content: 'Подготавливаю очистку…', components: [] });
        try {
          await runClearWithStop(interaction, channel, 'all');
        } catch (error) {
          console.error('[CLEAR ALL ERROR]', error);
          await interaction.editReply({ content: 'Не получилось полностью очистить канал.', components: [] }).catch(() => {});
        }
      });

      collector.on('end', async (collected) => {
        if (collected.size === 0) {
          await interaction.editReply({ content: 'Время подтверждения истекло.', components: [] }).catch(() => {});
        }
      });
      return;
    }

    if (!/^\d+$/.test(value)) {
      await interaction.reply({ content: 'Укажи число от 1 до 1000 или `all`.', ephemeral: true });
      return;
    }

    const amount = Number(value);
    if (amount < 1 || amount > 1000) {
      await interaction.reply({ content: 'Количество должно быть от 1 до 1000.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    await runClearWithStop(interaction, channel, amount);
  } catch (error) {
    console.error('[INTERACTION ERROR]', error);
    if (interaction.isRepliable()) {
      const content = 'Произошла ошибка при выполнении команды.';
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(content).catch(() => {});
      } else {
        await interaction.reply({ content, ephemeral: true }).catch(() => {});
      }
    }
  }
});

client.on(Events.Error, (error) => {
  console.error('[DISCORD ERROR]', error);
});

startHealthServer();
client.login(token).catch((error) => {
  console.error('[LOGIN ERROR]', error);
  process.exit(1);
});
