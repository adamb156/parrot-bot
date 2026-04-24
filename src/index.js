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
} from 'discord.js';
import { getSettings, updateSettings } from './settings.js';
import { transcribeFromUrl } from './transcriber.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // potrzebne, by widzieć załączniki w wiadomościach
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ---------- helpers ----------

const VOICE_FLAG = 1 << 13; // MessageFlags.IsVoiceMessage

function isVoiceMessage(message) {
  if (typeof message.flags?.has === 'function' && MessageFlags?.IsVoiceMessage !== undefined) {
    if (message.flags.has(MessageFlags.IsVoiceMessage)) return true;
  }
  if (typeof message.flags?.bitfield === 'number' && (message.flags.bitfield & VOICE_FLAG) !== 0) {
    return true;
  }
  // fallback: pojedynczy załącznik audio z polem duration
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

// ---------- events ----------

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Zalogowano jako ${c.user.tag}`);
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

    // mode === 'auto'
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
  await interaction.deferReply({ ephemeral });

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

// Wariant dla przycisku: edytuje TĘ SAMĄ wiadomość bota (z przyciskiem),
// dezaktywując przycisk natychmiast — niemożliwe podwójne kliknięcie,
// a wynik pojawia się dokładnie w miejscu przycisku (bez nowych wiadomości).
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

  // Krok 1: natychmiastowa podmiana wiadomości — przycisk się dezaktywuje,
  // więc kolejne kliknięcia są niemożliwe (Discord odrzuci je jako "already acknowledged").
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
}

// ---------- start ----------

if (!process.env.DISCORD_TOKEN) {
  console.error('Brak DISCORD_TOKEN w .env');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
