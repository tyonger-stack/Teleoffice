# Příkazová řádka a agenti

Každá instalace obsahuje příkaz `teleoffice`, který používá stejné enginy jako okno — stejné parsery, stejný zapisovač, stejný vykreslovač. Soubor, který aplikace uloží, a soubor, který zapíše příkaz, je stejný soubor, a kontrola, kterou projde panel AI v aplikaci, projde i příkaz.

```sh
teleoffice --help          # every command
teleoffice guide slides    # the op reference, for writing your own
```

To je celá plocha na jedné obrazovce — každý příkaz s řádkem, který říká, co dělá, a pak globální přepínače a návratové kódy:

![Skutečný výstup příkazu teleoffice --help: banner s verzí, každý příkaz s jednořádkovým popisem a globální přepínače s návratovými kódy](img/cli.png)

## Získání příkazu

Systémy macOS a Windows jej dodávají uvnitř balíčku aplikace. Chcete-li jej volat jménem, spusťte jednou `teleoffice install-cli`: vytvoří symbolický odkaz na přiložený spustitelný soubor v `/usr/local/bin`, nebo v uživatelské `PATH` v systému Windows.

## Příkazy, které stojí za to znát

| Příkaz            | Co dělá                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Otevře dokument v aplikaci; aplikaci spustí, pokud neběží.                                                                                                                                                    |
| `selection`       | Co uživatel právě vybral v tomto souboru, zatímco aplikace běží — ukazatel na „tady“ / „tenhle“. Vrací rozsah bloků, rozsah v listu, prvky snímku nebo stránku podle toho, v jakém editoru se soubor nachází. |
| `convert`         | Převádí mezi formáty pomocí vlastních enginů aplikace.                                                                                                                                                        |
| `create`          | Vytvoří dokument ze strukturovaného obsahu.                                                                                                                                                                   |
| `render`          | Jeden PNG na stránku, tak jak jej vykreslí vykreslovač.                                                                                                                                                       |
| `pdf`             | Čte textovou vrstvu PDF stránku po stránce, bez procesu aplikace.                                                                                                                                             |
| `info`            | Metadata a souhrn struktury dokumentu.                                                                                                                                                                        |
| `search`          | Vyhledávání na webu nebo v obrázcích pomocí poskytovatele nastaveného v aplikaci.                                                                                                                             |
| `image` / `media` | Vygeneruje obrázek, nebo popíše soubor obrázku, videa či zvuku a umožní na něj dotazy.                                                                                                                        |
| `merge`           | Vyplní zástupné značky `{{key}}` v šabloně `.docx`, `.pptx` nebo `.xlsx`.                                                                                                                                     |
| `capabilities`    | Označí, které cloudové funkce jsou na tomto počítači nastavené.                                                                                                                                               |
| `guide`           | Referenční příručka op a návrhové průvodce, vygenerované ze stejných definic, proti kterým executor validuje — takže se nemůže rozejít s tím, co přijímá `apply`. `--json` ji vrátí se schématem každé op.    |
| `install-cli`     | Umístí `teleoffice` do `PATH`.                                                                                                                                                                                |
| `skill`           | Vypíše programové agenty nalezené na tomto počítači a nainstaluje do nich nebo v nich aktualizuje dovednost TeleOffice.                                                                                       |
| `mcp`             | Vystaví každý příkaz jako nástroj Model Context Protocol. Viz **Připojení programového agenta**.                                                                                                              |

## Úpravy: Docs, Sheets, Slides

`teleoffice docs`, `teleoffice sheet` a `teleoffice slides` čtou a upravují stejnou cestou zápisu, jakou používá aplikace, a sdílejí jednu slovní zásobu: **op** je jediná úprava a **spec** je seznam op aplikovaných v pořadí.

```sh
teleoffice sheet read report.xlsx
teleoffice slides apply deck.pptx --ops ops.json --dry-run
teleoffice docs apply brief.docx --ops ops.json
```

`--dry-run` hlásí, co by dávka udělala, a nic nezapíše — to je nejlevnější způsob, jak si spec před použitím ověřit. Panel AI v aplikaci běží přesně na těchto op, takže všechno, co mu můžete zadat, můžete i zapsat skriptem.

## Model Context Protocol

`teleoffice mcp` vystaví každý příkaz jako nástroj MCP a `teleoffice mcp install <agent|all>` jej zaregistruje ve vlastní konfiguraci programového agenta. Této části se týká kapitola **Připojení programového agenta**.

## Co příkaz neumí

Čte a zapisuje soubor. Není to aplikace: není tu okno a dialog aktualizace v aplikaci zde neplatí. Všechno, co potřebuje okno — panel AI, kontrolu kvality vykreslené snímku — musí počkat, než soubor otevřete. `teleoffice render` vám dá pixely bez něj a `teleoffice slides` prověří rozvržení prezentace sám.
