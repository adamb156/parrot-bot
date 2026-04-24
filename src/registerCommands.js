import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { allCommands } from './commands.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.argv[2]; // opcjonalne: node src/registerCommands.js <GUILD_ID> -> rejestracja na 1 serwerze (instant)

if (!token || !clientId) {
  console.error('Brak DISCORD_TOKEN lub DISCORD_CLIENT_ID w .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

try {
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: allCommands });
    console.log(`Zarejestrowano ${allCommands.length} komend na serwerze ${guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: allCommands });
    console.log(`Zarejestrowano ${allCommands.length} komend globalnie (propagacja do ~1h).`);
  }
} catch (err) {
  console.error('Błąd rejestracji komend:', err);
  process.exit(1);
}
