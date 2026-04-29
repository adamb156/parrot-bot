import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import { getSettings, updateSettings } from './settings.js';
import { transcribeFromUrl, summarizeChatMessages } from './transcriber.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const VOICE_FLAG = 1 << 13;
const SHORT_MAX_HOURS = 10;
const SHORT_COOLDOWN_SEC = 10 * 60;
const shortCooldownByChannel = new Map();

function isVoiceMessage(message) {
  if (typeof message.flags?.has === 'function' && MessageFlags?.IsVoiceMessage !== undefined) {
    if (message.flags.has(MessageFlags.IsVoiceMessage)) return true;
  }
  if (typeof message.flags?.bitfield === 'number' && (message.flags.bitfield & VOICE_FLAG) !== 0) {
    return true;
  }
  const att = message.attachments?.first?.();
  if (att && typeof att.duration === 'number') return true;
  return false;
}

function getVoiceAttachment(message) {
  return message.attachments?.find?.((a) => typeof a.duration === 'number') ?? message.attachments?.first?.();
}

function userHasAccess(member, settings) {
  if (!settings.allowed_role_id) return true;
  if (!member) return false;
  return member.roles.cache.has(settings.allowed_role_id);
}

function buildTranscribeButton(messageId, { disabled = false, label = 'Transkrybuj' } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`transcribe:${messageId}`)
      .setLabel(label)
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

function buildResultEmbed({ text, language, durationSec, author }) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📝 Transkrypcja wiadomości głosowej')
    .setDescription(text.length > 4000 ? text.slice(0, 3997) + '...' : text || '*(pusta transkrypcja)*');
  const footerParts = [];
  if (author) footerParts.push(`Autor: ${author}`);
  if (language) footerParts.push(`Język: ${language}`);
  if (durationSec) footerParts.push(`Długość: ${Math.round(durationSec)}s`);
  if (footerParts.length) embed.setFooter({ text: footerParts.join(' • ') });
  return embed;
}

async function performTranscription(message, settings) {
  const att = getVoiceAttachment(message);
  if (!att) throw new Error('Wiadomość nie zawiera załącznika audio.');

  const duration = att.duration ?? 0;
  if (duration > settings.max_seconds) {
    throw new Error(`Nagranie (${Math.round(duration)}s) przekracza limit ${settings.max_seconds}s ustawiony na serwerze.`);
  }

  const filename = att.name || 'voice.ogg';
  const result = await transcribeFromUrl(att.url, filename, settings.language);
  return {
    ...result,
    durationSec: result.durationSec ?? duration,
  };
}

function parsePeriodInput(input) {
  const raw = (input || '').trim().toLowerCase().replace(',', '.');
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|godz|godz\.|m|min|mins|minute|minutes)$/i);
  if (!match) {
    throw new Error('Niepoprawny format okresu. Użyj np. 2h, 90m, 15min.');
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Okres musi być większy od zera.');
  }

  const isHour = ['h', 'hr', 'hrs', 'godz', 'godz.'].includes(unit);
  const hours = isHour ? value : value / 60;
  if (hours > SHORT_MAX_HOURS) {
    throw new Error(`Maksymalny zakres to ${SHORT_MAX_HOURS}h.`);
  }

  const ms = Math.round(hours * 60 * 60 * 1000);
  const roundedHours = Number((ms / (60 * 60 * 1000)).toFixed(2));
  return { ms, hours: roundedHours };
}

function normalizeMessageContent(message) {
  const text = (message.content || '').trim();
  if (text) return text;
  if (message.attachments?.size) {
    return message.attachments.map((a) => a.name || 'zalacznik').join(', ');
  }
  return '';
}

async function collectMessagesFromPeriod(channel, periodMs) {
  const fromTs = Date.now() - periodMs;
  const collected = [];
  let beforeId;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(beforeId ? { before: beforeId } : {}) });
    if (!batch.size) break;

    const sorted = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    let reachedOld = false;

    for (const msg of sorted) {
      if (msg.createdTimestamp < fromTs) {
        reachedOld = true;
        continue;
      }
      if (msg.author?.bot) continue;
      const content = normalizeMessageContent(msg);
      if (!content) continue;
      collected.push({
        author: msg.member?.displayName || msg.author.username,
        content,
        createdTimestamp: msg.createdTimestamp,
      });
    }

    beforeId = sorted[sorted.length - 1]?.id;
    if (reachedOld || !beforeId) break;
    if (collected.length >= 1200) break;
  }

  return collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function canUseShort(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Zalogowano jako ${c.user.tag}`);
  startAutoSummaryScheduler(c);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guildId) return;
    if (!isVoiceMessage(message)) return;

    const settings = getSettings(message.guildId);
    if (settings.mode === 'off') return;

    if (settings.mode === 'manual') {
      await message.reply({
        components: [buildTranscribeButton(message.id)],
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    const att = getVoiceAttachment(message);
    if (att && att.duration && att.duration > settings.max_seconds) {
      await message.reply({
        content: `⚠️ Nagranie (${Math.round(att.duration)}s) przekracza limit ${settings.max_seconds}s — pomijam.`,
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    const placeholder = await message.reply({
      content: '⏳ Transkrybuję...',
      allowedMentions: { repliedUser: false },
    });
    try {
      const result = await performTranscription(message, settings);
      await placeholder.edit({
        content: '',
        embeds: [buildResultEmbed({ ...result, author: message.author.username })],
      });
    } catch (err) {
      console.error('Auto-transcribe error:', err);
      await placeholder.edit({ content: `❌ Błąd transkrypcji: ${err.message}` });
    }
  } catch (err) {
    console.error('MessageCreate handler error:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'config') {
      return await handleConfig(interaction);
    }
    if (interaction.isChatInputCommand() && interaction.commandName === 'short') {
      return await handleShort(interaction, false);
    }
    if (interaction.isChatInputCommand() && interaction.commandName === 'short-test') {
      return await handleShort(interaction, true);
    }
    if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
      return await interaction.reply({ content: '🏓 Pong!', ephemeral: true });
    }
    if (interaction.isMessageContextMenuCommand() && interaction.commandName === 'Transkrybuj wiadomość') {
      return await handleTranscribeInteraction(interaction, interaction.targetMessage);
    }
    if (interaction.isButton() && interaction.customId.startsWith('transcribe:')) {
      const messageId = interaction.customId.split(':')[1];
      const target = await interaction.channel.messages.fetch(messageId).catch(() => null);
      if (!target) {
        return await interaction.reply({ content: '❌ Nie znaleziono wiadomości.', ephemeral: true });
      }
      return await handleTranscribeButton(interaction, target, messageId);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Błąd: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  }
});

async function handleTranscribeInteraction(interaction, message) {
  const settings = getSettings(interaction.guildId);

  if (settings.mode === 'off') {
    return await interaction.reply({ content: '⛔ Transkrypcja jest wyłączona na tym serwerze.', ephemeral: true });
  }
  if (!userHasAccess(interaction.member, settings)) {
    return await interaction.reply({ content: '⛔ Nie masz uprawnień do używania transkrypcji.', ephemeral: true });
  }
  if (!isVoiceMessage(message)) {
    return await interaction.reply({ content: '❌ Ta wiadomość nie jest nagraniem głosowym.', ephemeral: true });
  }

  const ephemeral = settings.reply_ephemeral === 1;
  await interaction.deferReply({ ephemeral: ephemeral ? true : undefined });

  try {
    const result = await performTranscription(message, settings);
    await interaction.editReply({
      embeds: [buildResultEmbed({ ...result, author: message.author.username })],
    });
  } catch (err) {
    console.error('Manual transcribe error:', err);
    await interaction.editReply({ content: `❌ Błąd transkrypcji: ${err.message}` });
  }
}

async function handleTranscribeButton(interaction, message, originalMessageId) {
  const settings = getSettings(interaction.guildId);

  if (settings.mode === 'off') {
    return await interaction.reply({ content: '⛔ Transkrypcja jest wyłączona na tym serwerze.', ephemeral: true });
  }
  if (!userHasAccess(interaction.member, settings)) {
    return await interaction.reply({ content: '⛔ Nie masz uprawnień do używania transkrypcji.', ephemeral: true });
  }
  if (!isVoiceMessage(message)) {
    return await interaction.reply({ content: '❌ Ta wiadomość nie jest nagraniem głosowym.', ephemeral: true });
  }

  await interaction.update({
    content: '⏳ Transkrybuję...',
    components: [buildTranscribeButton(originalMessageId, { disabled: true, label: 'Transkrybuję...' })],
  });

  try {
    const result = await performTranscription(message, settings);
    await interaction.editReply({
      content: '',
      embeds: [buildResultEmbed({ ...result, author: message.author.username })],
      components: [],
    });
  } catch (err) {
    console.error('Button transcribe error:', err);
    await interaction.editReply({
      content: `❌ Błąd transkrypcji: ${err.message}`,
      embeds: [],
      components: [],
    });
  }
}

async function handleShort(interaction, testOnly) {
  if (!canUseShort(interaction)) {
    return await interaction.reply({
      content: '⛔ Ta komenda jest dostępna tylko dla moderatora/admina.',
      ephemeral: true,
    });
  }

  const channel = interaction.channel;
  if (!channel?.isTextBased() || channel.type === ChannelType.DM) {
    return await interaction.reply({ content: '❌ Ta komenda działa tylko na kanałach tekstowych serwera.', ephemeral: true });
  }

  const cooldownUntil = shortCooldownByChannel.get(channel.id) || 0;
  const now = Date.now();
  if (cooldownUntil > now) {
    const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
    return await interaction.reply({
      content: `⏳ Poczekaj jeszcze ${remainingSec}s przed kolejnym podsumowaniem tego kanału.`,
      ephemeral: true,
    });
  }

  const periodInput = interaction.options.getString('okres', true);
  let parsed;
  try {
    parsed = parsePeriodInput(periodInput);
  } catch (err) {
    return await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: testOnly ? true : undefined });

  try {
    const items = await collectMessagesFromPeriod(channel, parsed.ms);
    if (items.length < 8) {
      return await interaction.editReply('ℹ️ Za mało wiadomości w tym okresie, żeby zrobić sensowne podsumowanie.');
    }

    const summary = await summarizeChatMessages(items, parsed.hours);
    shortCooldownByChannel.set(channel.id, Date.now() + SHORT_COOLDOWN_SEC * 1000);

    const titlePrefix = testOnly ? '🧪 Podsumowanie testowe' : '🧠 Podsumowanie kanału';
    const embed = new EmbedBuilder()
      .setColor(testOnly ? 0xf1c40f : 0x1f8b4c)
      .setTitle(`${titlePrefix} (${parsed.hours}h)`)
      .setDescription(summary.length > 4000 ? summary.slice(0, 3997) + '...' : summary)
      .setFooter({ text: `Wiadomości: ${items.length}` });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('Short summary error:', err);
    await interaction.editReply(`❌ Błąd podsumowania: ${err.message}`);
  }
}

function startAutoSummaryScheduler(discordClient) {
  setInterval(async () => {
    for (const guild of discordClient.guilds.cache.values()) {
      try {
        const settings = getSettings(guild.id);
        if (!settings.short_auto_enabled) continue;

        const intervalMs = settings.short_auto_interval_hours * 60 * 60 * 1000;
        const now = Date.now();
        const last = settings.short_auto_last_run_at || 0;
        if (now - last < intervalMs) continue;

        const channelId = settings.short_auto_channel_id;
        if (!channelId) {
          updateSettings(guild.id, { short_auto_last_run_at: now });
          continue;
        }

        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased() || channel.type === ChannelType.DM) {
          updateSettings(guild.id, { short_auto_last_run_at: now });
          continue;
        }

        const periodMs = settings.short_auto_interval_hours * 60 * 60 * 1000;
        const items = await collectMessagesFromPeriod(channel, periodMs);
        if (items.length < settings.short_auto_min_messages) {
          updateSettings(guild.id, { short_auto_last_run_at: now });
          continue;
        }

        const summary = await summarizeChatMessages(items, settings.short_auto_interval_hours);
        const embed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle(`🧠 Auto-podsumowanie (${settings.short_auto_interval_hours}h)`)
          .setDescription(summary.length > 4000 ? summary.slice(0, 3997) + '...' : summary)
          .setFooter({ text: `Wiadomości: ${items.length}` })
          .setTimestamp(new Date());

        await channel.send({ embeds: [embed] });
        updateSettings(guild.id, { short_auto_last_run_at: now });
      } catch (err) {
        console.error(`Auto-summary error [${guild.id}]:`, err);
        updateSettings(guild.id, { short_auto_last_run_at: Date.now() });
      }
    }
  }, 60 * 1000);
}

async function handleConfig(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (sub === 'show') {
    const s = getSettings(guildId);
    const embed = new EmbedBuilder()
      .setTitle('⚙️ Ustawienia transkrypcji')
      .setColor(0x5865f2)
      .addFields(
        { name: 'Tryb', value: `\`${s.mode}\``, inline: true },
        { name: 'Max długość', value: `${s.max_seconds}s`, inline: true },
        { name: 'Język', value: s.language ? `\`${s.language}\`` : 'auto', inline: true },
        { name: 'Wymagana rola', value: s.allowed_role_id ? `<@&${s.allowed_role_id}>` : 'wszyscy', inline: true },
        { name: 'Odpowiedź prywatna', value: s.reply_ephemeral ? 'tak' : 'nie', inline: true },
        { name: 'Auto-podsumowania', value: s.short_auto_enabled ? 'włączone' : 'wyłączone', inline: true },
      );
    return await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'short-auto-show') {
    const s = getSettings(guildId);
    const channelText = s.short_auto_channel_id ? `<#${s.short_auto_channel_id}>` : 'nie ustawiono';
    const embed = new EmbedBuilder()
      .setTitle('🧠 Ustawienia auto-podsumowań')
      .setColor(0x3498db)
      .addFields(
        { name: 'Status', value: s.short_auto_enabled ? 'włączone' : 'wyłączone', inline: true },
        { name: 'Interwał', value: `${s.short_auto_interval_hours}h`, inline: true },
        { name: 'Min wiadomości', value: `${s.short_auto_min_messages}`, inline: true },
        { name: 'Kanał', value: channelText, inline: true },
      );
    return await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'mode') {
    const value = interaction.options.getString('value', true);
    updateSettings(guildId, { mode: value });
    return await interaction.reply({ content: `✅ Tryb ustawiony na \`${value}\`.`, ephemeral: true });
  }

  if (sub === 'max-length') {
    const seconds = interaction.options.getInteger('seconds', true);
    updateSettings(guildId, { max_seconds: seconds });
    return await interaction.reply({ content: `✅ Maksymalna długość nagrania: ${seconds}s.`, ephemeral: true });
  }

  if (sub === 'language') {
    const code = interaction.options.getString('code');
    updateSettings(guildId, { language: code && code.trim() ? code.trim().toLowerCase() : null });
    return await interaction.reply({
      content: code ? `✅ Język ustawiony na \`${code}\`.` : '✅ Język: auto-wykrywanie.',
      ephemeral: true,
    });
  }

  if (sub === 'role') {
    const role = interaction.options.getRole('role');
    updateSettings(guildId, { allowed_role_id: role ? role.id : null });
    return await interaction.reply({
      content: role ? `✅ Wymagana rola: ${role}.` : '✅ Transkrypcja dostępna dla wszystkich.',
      ephemeral: true,
    });
  }

  if (sub === 'reply') {
    const ephemeral = interaction.options.getBoolean('ephemeral', true);
    updateSettings(guildId, { reply_ephemeral: ephemeral ? 1 : 0 });
    return await interaction.reply({
      content: `✅ Odpowiedź będzie ${ephemeral ? 'prywatna' : 'publiczna'}.`,
      ephemeral: true,
    });
  }

  if (sub === 'short-auto') {
    const enabled = interaction.options.getBoolean('enabled', true);
    const intervalHours = interaction.options.getInteger('interval-hours');
    const minMessages = interaction.options.getInteger('min-messages');
    const channel = interaction.options.getChannel('channel');

    if (channel && !channel.isTextBased()) {
      return await interaction.reply({
        content: '❌ Kanał auto-podsumowań musi być kanałem tekstowym.',
        ephemeral: true,
      });
    }

    const existing = getSettings(guildId);
    const next = {
      short_auto_enabled: enabled ? 1 : 0,
      short_auto_interval_hours: intervalHours ?? existing.short_auto_interval_hours,
      short_auto_min_messages: minMessages ?? existing.short_auto_min_messages,
      short_auto_channel_id: channel?.id ?? existing.short_auto_channel_id ?? interaction.channelId,
    };

    updateSettings(guildId, next);
    return await interaction.reply({
      content:
        `✅ Auto-podsumowania: ${enabled ? 'włączone' : 'wyłączone'}\n`
        + `Kanał: <#${next.short_auto_channel_id}>\n`
        + `Interwał: ${next.short_auto_interval_hours}h\n`
        + `Min wiadomości: ${next.short_auto_min_messages}`,
      ephemeral: true,
    });
  }
}

if (!process.env.DISCORD_TOKEN) {
  console.error('Brak DISCORD_TOKEN w .env');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
