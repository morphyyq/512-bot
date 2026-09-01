const http = require('http');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
const port = Number(process.env.PORT || 10000);

if (!token) {
  throw new Error('DISCORD_TOKEN is not set');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
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

async function registerCommands() {
  if (guildId) {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set(commands);
    console.log(`Slash-команды зарегистрированы на сервере ${guild.name}`);
  } else {
    await client.application.commands.set(commands);
    console.log('Глобальные slash-команды зарегистрированы');
  }
}

function hasManageMessages(permissionLike) {
  return permissionLike && permissionLike.has(PermissionFlagsBits.ManageMessages);
}

async function clearAllMessages(channel) {
  let deletedTotal = 0;
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;

  while (true) {
    const messages = await channel.messages.fetch({ limit: 100 });
    if (messages.size === 0) break;

    const recent = messages.filter(
      (message) => Date.now() - message.createdTimestamp < fourteenDays
    );
    const old = messages.filter(
      (message) => Date.now() - message.createdTimestamp >= fourteenDays
    );

    if (recent.size > 0) {
      const deleted = await channel.bulkDelete(recent, true);
      deletedTotal += deleted.size;
    }

    for (const message of old.values()) {
      try {
        await message.delete();
        deletedTotal += 1;
      } catch (error) {
        console.warn(`Не удалось удалить старое сообщение ${message.id}: ${error.message}`);
      }
    }

    if (messages.size < 100) break;
  }

  return deletedTotal;
}

async function clearAmount(channel, amount) {
  let left = amount;
  let deletedTotal = 0;

  while (left > 0) {
    const batch = Math.min(left, 100);
    const deleted = await channel.bulkDelete(batch, true);
    deletedTotal += deleted.size;
    left -= batch;

    if (deleted.size < batch) break;
  }

  return deletedTotal;
}

client.once('ready', async () => {
  console.log(`Бот вошёл как ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Ошибка регистрации slash-команд:', error);
  }
});

client.on('guildMemberAdd', async (member) => {
  const roleId = '1525615883525951538';

  // Если указан GUILD_ID, работаем только на нужном сервере.
  if (guildId && member.guild.id !== guildId) return;
  // Ботам роль не выдаём.
  if (member.user.bot) return;

  const role = member.guild.roles.cache.get(roleId);
  const botMember = member.guild.members.me;

  if (!role) {
    console.error(`Роль ${roleId} не найдена на сервере ${member.guild.name}`);
    return;
  }

  if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.error('У бота нет права Управлять ролями');
    return;
  }

  if (role.managed || role.position >= botMember.roles.highest.position) {
    console.error('Роль нельзя выдать: роль бота должна находиться выше этой роли');
    return;
  }

  try {
    await member.roles.add(role, 'Автоматическая роль новому участнику');
    console.log(`Роль ${role.name} выдана пользователю ${member.user.tag}`);
  } catch (error) {
    console.error(`Не удалось выдать роль пользователю ${member.user.tag}:`, error);
  }
});

const photoOnlyChannelIds = new Set([
  '1525590497542930542',
  '1525594630257639474',
]);

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!photoOnlyChannelIds.has(message.channel.id)) return;

  const imageExtension = /\.(png|jpe?g|gif|webp|bmp|heic|avif)(?:$|[?#])/i;
  const hasImageAttachment = [...message.attachments.values()].some((attachment) => {
    const contentType = (attachment.contentType || '').toLowerCase();
    const fileName = attachment.name || '';
    const url = attachment.url || '';

    return (
      contentType.startsWith('image/') ||
      (attachment.width > 0 && attachment.height > 0) ||
      imageExtension.test(fileName) ||
      imageExtension.test(url)
    );
  });
  const hasImageEmbed = message.embeds.some(
    (embed) => Boolean(embed.image || embed.thumbnail)
  );
  const hasImage = hasImageAttachment || hasImageEmbed;

  // В этих каналах разрешены только сообщения с изображениями.
  if (hasImage) return;

  try {
    await message.delete();
    console.log(`Удалено текстовое сообщение в фотоканале: ${message.author.tag}`);
  } catch (error) {
    console.error('Не удалось удалить сообщение в фотоканале:', error.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'ping') {
      await interaction.reply({
        content: `Pong! Задержка: ${Math.round(client.ws.ping)} мс.`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName !== 'clear') return;

    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Команду можно использовать только на сервере.',
        ephemeral: true,
      });
      return;
    }

    if (!hasManageMessages(interaction.memberPermissions)) {
      await interaction.reply({
        content: 'Нужны права **Управлять сообщениями**.',
        ephemeral: true,
      });
      return;
    }

    const channel = interaction.channel;
    const botPermissions = channel.permissionsFor(interaction.guild.members.me);
    if (!hasManageMessages(botPermissions)) {
      await interaction.reply({
        content: 'У бота нет права **Управлять сообщениями** в этом канале.',
        ephemeral: true,
      });
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
        if (buttonInteraction.user.id !== interaction.user.id) {
          await buttonInteraction.reply({
            content: 'Эту кнопку может нажать только автор команды.',
            ephemeral: true,
          });
          return;
        }

        if (buttonInteraction.customId.startsWith('clear_cancel_')) {
          await buttonInteraction.update({
            content: 'Очистка отменена.',
            components: [],
          });
          return;
        }

        await buttonInteraction.update({
          content: 'Удаляю сообщения…',
          components: [],
        });

        try {
          const deleted = await clearAllMessages(channel);
          await interaction.editReply({
            content: `Удалено сообщений: **${deleted}**.`,
            components: [],
          });
        } catch (error) {
          console.error('Ошибка полной очистки:', error);
          await interaction.editReply({
            content: 'Не получилось полностью очистить канал. Проверь права бота и лимиты Discord.',
            components: [],
          });
        }
      });

      collector.on('end', async (collected) => {
        if (collected.size === 0) {
          await interaction.editReply({
            content: 'Время подтверждения истекло.',
            components: [],
          }).catch(() => {});
        }
      });
      return;
    }

    if (!/^\d+$/.test(value)) {
      await interaction.reply({
        content: 'Укажи число от 1 до 1000 или `all`.',
        ephemeral: true,
      });
      return;
    }

    const amount = Number(value);
    if (amount < 1 || amount > 1000) {
      await interaction.reply({
        content: 'Количество должно быть от 1 до 1000.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const deleted = await clearAmount(channel, amount);
      await interaction.editReply(`Удалено сообщений: **${deleted}**.`);
    } catch (error) {
      console.error('Ошибка очистки:', error);
      await interaction.editReply('Не получилось удалить сообщения. Проверь права бота.');
    }
  }
});

startHealthServer();
client.login(token);
