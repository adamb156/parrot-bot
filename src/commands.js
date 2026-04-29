import { SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits } from 'discord.js';

export const slashCommands = [
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Konfiguracja transkrypcji i podsumowań')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((sc) =>
      sc
        .setName('mode')
        .setDescription('Tryb transkrypcji')
        .addStringOption((o) =>
          o
            .setName('value')
            .setDescription('auto = od razu, manual = po kliknięciu przycisku, off = wyłączone')
            .setRequired(true)
            .addChoices(
              { name: 'auto', value: 'auto' },
              { name: 'manual', value: 'manual' },
              { name: 'off', value: 'off' },
            ),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('max-length')
        .setDescription('Maksymalna długość nagrania (sekundy)')
        .addIntegerOption((o) =>
          o.setName('seconds').setDescription('Limit w sekundach (1–1500)').setMinValue(1).setMaxValue(1500).setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('language')
        .setDescription('Język transkrypcji (puste = auto-wykrywanie)')
        .addStringOption((o) =>
          o.setName('code').setDescription('Kod ISO np. pl, en, de. Pozostaw puste, aby wyczyścić.').setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('role')
        .setDescription('Rola, której członkowie mogą używać transkrypcji (puste = wszyscy)')
        .addRoleOption((o) => o.setName('role').setDescription('Wymagana rola').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('reply')
        .setDescription('Czy odpowiedź ma być widoczna tylko dla klikającego')
        .addBooleanOption((o) => o.setName('ephemeral').setDescription('true = prywatnie').setRequired(true)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('short-auto')
        .setDescription('Włącz/wyłącz auto-podsumowania i ustaw parametry')
        .addBooleanOption((o) => o.setName('enabled').setDescription('true = włącz').setRequired(true))
        .addIntegerOption((o) =>
          o
            .setName('interval-hours')
            .setDescription('Co ile godzin (1-10)')
            .setMinValue(1)
            .setMaxValue(10)
            .setRequired(false),
        )
        .addIntegerOption((o) =>
          o
            .setName('min-messages')
            .setDescription('Minimalna liczba wiadomości w oknie czasu')
            .setMinValue(10)
            .setMaxValue(2000)
            .setRequired(false),
        )
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Kanał podsumowań (domyślnie bieżący)').setRequired(false),
        ),
    )
    .addSubcommand((sc) => sc.setName('short-auto-show').setDescription('Pokaż ustawienia auto-podsumowań'))
    .addSubcommand((sc) => sc.setName('show').setDescription('Pokaż aktualne ustawienia')),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Sprawdź czy bot żyje'),
  new SlashCommandBuilder()
    .setName('short')
    .setDescription('Streść najważniejsze tematy rozmowy z wybranego okresu (max 10h)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages | PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName('okres')
        .setDescription('Np. 2h, 5min, 30m')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('short-test')
    .setDescription('Wersja testowa podsumowania widoczna tylko dla Ciebie (max 10h)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages | PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName('okres')
        .setDescription('Np. 2h, 5min, 30m')
        .setRequired(true),
    ),
].map((c) => c.toJSON());

export const contextMenuCommands = [
  new ContextMenuCommandBuilder()
    .setName('Transkrybuj wiadomość')
    .setType(ApplicationCommandType.Message)
    .setDMPermission(false)
    .toJSON(),
];

export const allCommands = [...slashCommands, ...contextMenuCommands];
