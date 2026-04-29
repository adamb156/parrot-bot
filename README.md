# Voice Transcriber Bot

Discord bot, który robi transkrypcję wiadomości głosowych (voice messages) wysyłanych na czacie tekstowym.

## Funkcje

- **Tryby pracy** (per serwer):
  - `auto` – transkrypcja od razu po wysłaniu nagrania
  - `manual` – bot dodaje przycisk **📝 Transkrybuj** pod nagraniem
  - `off` – wyłączone
- **Menu kontekstowe**: prawy klik na wiadomości → Aplikacje → **Transkrybuj wiadomość**
- **Limit długości** nagrania (sekundy)
- **Whitelista roli** – kto może klikać przycisk / context menu
- **Język** transkrypcji (auto albo wymuszony, np. `pl`)
- **Odpowiedź prywatna lub publiczna**
- **Podsumowania czatu**:
   - `/short okres:<2h|30m|...>` - podsumowanie najwazniejszych tematow z okresu (max 10h)
   - dostep domyslnie tylko dla moderatora/admina (Manage Messages / Manage Server)
   - cooldown na kanal, aby ograniczyc naduzycia
- **Auto-podsumowania** (domyslnie wylaczone):
   - konfigurowane przez `/config short-auto ...`
   - interwal 1-10h, minimalna liczba wiadomosci i kanal publikacji

## Stack

- Node.js 20+
- discord.js v14
- OpenAI Whisper API (`whisper-1`) – domyślnie. Można przełączyć na **Groq** (Whisper large-v3, hojny darmowy tier) zmieniając `TRANSCRIBE_PROVIDER=groq` w `.env`.
- Plik JSON (`data/settings.json`) do ustawień per serwer — zero natywnych zależności

## Setup

1. **Stwórz aplikację bota**: https://discord.com/developers/applications
   - Bot → Reset Token → wklej do `.env` jako `DISCORD_TOKEN`
   - General Information → Application ID → `DISCORD_CLIENT_ID`
   - **Privileged Gateway Intents** → włącz **Message Content Intent**
2. **Zaproś bota** na serwer (OAuth2 → URL Generator):
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Embed Links`, `Use Application Commands`
3. **Klucz API**:
   - OpenAI: https://platform.openai.com/api-keys → `OPENAI_API_KEY`
   - lub Groq: https://console.groq.com/keys → `GROQ_API_KEY` + `TRANSCRIBE_PROVIDER=groq`
4. Skopiuj `.env.example` → `.env` i uzupełnij.
5. Zainstaluj zależności i zarejestruj komendy:
   ```powershell
   npm install
   # rejestracja na konkretnym serwerze (instant) - polecane do testów:
   node src/registerCommands.js TWOJE_GUILD_ID
   # albo globalnie (propagacja do ~1h):
   npm run register
   npm start
   ```

## Komendy

- `/config show` – pokaż ustawienia
- `/config mode value:<auto|manual|off>`
- `/config max-length seconds:<1-1500>`
- `/config language code:<pl|en|...>` – pomiń argument, by ustawić auto-wykrywanie
- `/config role role:<@rola>` – pomiń, by zezwolić wszystkim
- `/config reply ephemeral:<true|false>`
- `/config short-auto enabled:<true|false> interval-hours:<1-10> min-messages:<10-2000> channel:<#kanal>`
- `/config short-auto-show`
- `/ping`
- `/short okres:<2h|5min|30m>`

Komendy `/config` wymagają uprawnienia **Manage Server**.
Komenda `/short` wymaga uprawnienia **Manage Messages** (lub **Manage Server**).
