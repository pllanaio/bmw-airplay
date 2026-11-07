# MGU-Store-Anbindung

## Ab 0.4.0: Empfänger „pllana-airplay-receiver“

Die Laufzeit heißt jetzt `pllana-airplay-receiver` (Dienst
`pllana-airplay-receiver.service`). Die eigene Tool-ID vermeidet den Konflikt
mit einer früher privat installierten `mgu-airplay`, die der Store weder
ersetzen noch entfernen kann. Beim Installieren stoppt und deaktiviert ein
Hook den alten Dienst `mgu-airplay.service`; beim Entfernen wird er wieder
aktiviert. Kein SSH-Befehl ist nötig.

Der Dienst schreibt seinen Zustand nach `/run/pllana-airplay/status.json`
(`waiting_for_app`, `starting`, `running`, `backend_exited` mit Code, …).
Ist der Empfangsdienst nicht erreichbar, zeigt die App den Grund an statt
„Empfangsdienst startet noch“.

Im Store für `pllanaio/bmw-airplay` den Kanal **Releases** verwenden.

## Installation und Updates über „Releases“ (ab 0.3.0, empfohlen)

Ab 0.3.0 veröffentlicht dieses Repository vollständige Store-Pakete:

| Komponente | Art | Inhalt |
| --- | --- | --- |
| `pllana_airplay` | App | iDrive-Oberfläche, SDK-frei; der Store erzeugt das oap-sdk aus einer BMW-Spender-App |
| `mgu-airplay` | Tool | UxPlay-Empfänger mit privater GStreamer-Laufzeit, Firewall- und DNS-Einrichtung |

Im MGU Store die Quelle `pllanaio/bmw-airplay` mit dem Kanal **Releases**
verwenden (eine bestehende `branch:main`-Quelle auf Releases umstellen).
Der Store installiert dann zuerst die Laufzeit und danach die App.

Die Laufzeit ist nicht mehr an eine beim Bau feste App-UID gebunden: Ihr
Dienst liest beim Start die UID, die der App-Manager `pllana_airplay`
zugewiesen hat (`uids.txt`), und richtet Firewall-Regeln und Resolver genau
dafür ein. Ressourcen: keine CPU-Quote, CPUShares 1024, Nice −5, 1 GiB
Speicher, automatischer Neustart.

Gebaut, getestet und veröffentlicht wird in GitHub Actions
(`.github/workflows/store-release.yml`, Debian 12). Ein Push auf `main` mit
einer neuen Version in `app.json`/`package.json` veröffentlicht `v<Version>`
und schaltet danach den `catalog`-Release um. Bereits veröffentlichte
Versionen werden nie überschrieben.

**Früher privat installierte Laufzeit:** Wurde `mgu-airplay` vorher mit
`deploy_runtime.py` installiert, gehört sie keiner Store-Quelle; der Store
installiert nicht darüber („mgu-airplay is already installed“). Einmalig
auf der Headunit entfernen und dann im Store installieren:

~~~sh
sh /var/opt/mgu-deploy/mgu-deploy.sh uninstall mgu-airplay --yes
~~~

## Fehlerbehebung: Update über den Store schlug fehl (behoben in 0.3.0)

Der Store baut das Frontend auf der Headunit mit `tools/build_store.py`.
Der Build verglich die Prüfsumme des mitgelieferten Schriftatlas
(`assets/fonts/airplay.json`) mit `atlas-manifest.json`. Beide passten nicht
zusammen, daher brach jeder Store-Build mit „Prebaked font atlas checksum
differs“ ab. Das Manifest ist korrigiert; der vollständige Store-Build wurde
lokal als unprivilegierter Benutzer mit dem festgelegten Kit-Stand geprüft.

Weiterhin gilt: Das Frontend setzt die separat installierte Laufzeit
`mgu-airplay` (mindestens 0.2.4) voraus. Der Store erkennt sie an
`/var/opt/mgu-airplay/current/component.json`. Die App 0.3.0 läuft mit
Laufzeit 0.2.4; die nativen Verbesserungen kommen mit Laufzeit 0.3.0.

## Was jetzt vorhanden ist

Die Datei mgu-repo.json im Repository-Stamm folgt dem Repo-Tree-/apps-
Muster des mgu-browser-Projekts:

- Schema 1;
- Apps unter apps/*;
- Metadaten aus app.json;
- Kompatibilität ID7;
- ein unprivilegierter Python-Build;
- ein vom Store bereitgestelltes oap-sdk;
- explizit freigegebener Netzwerkzugang für den öffentlichen Kit-Download.

Der Build-Einstiegspunkt ist tools/build_store.py. Die Platzhalter
{id}, {version} und {dir} werden vom Store in die tatsächliche App-
Identität, Version und das Quellverzeichnis umgesetzt.

## Quelle und Kanal

Im Store die GitHub-Quelle pllanaio/bmw-airplay verwenden und für diesen
Entwicklungsstand den Kanal **branch:main** auswählen.

Die Store-Datei wurde nach dem ursprünglichen Tag v0.2.6 ergänzt.
Der historische Tag bleibt unverändert. Wer genau diesen alten Tag statt
main liest, sieht dort die nachträglich ergänzte mgu-repo.json nicht.

Neue Dokumentations-/Build-Commits ändern nicht automatisch die App-
Versionsnummer. Im Branch-Kanal kann der Store zusätzlich die Commit-
Revision berücksichtigen. Die App bleibt derzeit 0.2.6.

## Deklarierte Voraussetzungen

| Komponente | Manifestwert | Zweck |
| --- | --- | --- |
| mgu-airplay | 0.2.4 | Separater nativer Empfänger und Backend-Startpfad |
| mgu-uplink | 0.7.3 | Internetzugang/DNS-Lease für die App-UID |
| mgu-render | 0.6.11 | Native Videoausgabe und passende Renderer-Funktionen |
| mgu-deploy | 0.7.17 | Build-/SDK- und Installationsinfrastruktur |
| mgu-python | vom Store automatisch ergänzt, mindestens 1.0.2 | Python-Build auf der Headunit |

Die Infrastrukturwerte orientieren sich am vorhandenen Browser-/Store-
Aufbau; sie sind keine neue allgemeine Firmware-Qualifikation. Entscheidend
sind zusätzlich die tatsächlich vorhandenen Fähigkeiten und das zur
jeweiligen Headunit passende OEM-SmartX/ALSA.

Es wird **keine Abhängigkeit auf mgu-browser** deklariert. AirPlay braucht
keine Chromium-Engine und keinen Browser-Renderer als Medienquelle.

### Die native Runtime bleibt separat

Dieses Repository veröffentlicht weiterhin Quellcode. Die native Runtime
wird nicht vom Store-Frontend-Builder kompiliert oder heruntergeladen und
ist nicht als vorgefertigtes öffentliches Tool in dieser Repo-Datei enthalten.

Für eine neue Headunit muss mgu-airplay 0.2.4 separat korrekt gebaut,
installiert und an die tatsächliche App-UID gebunden sein. Eine gleiche
Versionsnummer allein überprüft nicht die UID-Bindung eines bereits
vorhandenen individuell installierten Dienstes.

Eine fehlende Runtime ist deshalb eine echte Installationsvoraussetzung.
Die Manifest-Abhängigkeit soll dieses Problem sichtbar machen, nicht es
durch ein scheinbar vollständiges Frontend-Paket verdecken.

## Ablauf des Frontend-Builds

1. Der Store stellt eine beschreibbare Quellkopie und einen lokalen SDK-Donor bereit.
2. Das Skript prüft App-ID, Version, Quellpfad, Donor-Modul und Ausgabeverzeichnis.
3. Das öffentliche idrive7-apps-Kit wird an einem festen Commit heruntergeladen.
4. Der SHA-256-Wert des Archivs muss exakt mit dem festgelegten Wert übereinstimmen.
5. Nur Kit-Dateien und dessen Lizenz werden begrenzt extrahiert.
6. Die privaten AirPlay-Renderer-/Vollbild-Anpassungen werden angewendet.
7. Die vorbereiteten deutschen Schriftatlanten werden mit Prüfsumme übernommen.
8. Das vom Benutzer/Store bereitgestellte SDK baut die OAP-Oberfläche.
9. Das Ergebnis erhält ID7-Metadaten und die Kit-Lizenz.
10. Genau ein pllana_airplay@0.2.6.tgz wird nach MGU_OUT geschrieben.

Der Builder verwendet keine SSH-Verbindung, keine Fahrzeug-Konfiguration
und keine nativen Cross-Compiler. Er startet auch keine Dienste.

## Festgelegtes öffentliches Kit

| Wert | Inhalt |
| --- | --- |
| Repository | cauliflowermossgrape/idrive7-apps |
| Commit | 9b5e9cf8a49399939d51d3458fb29b6a3cec8346 |
| Archiv-SHA-256 | 153634148de77dfa88b21a3c7d9c1afd6d27ad528f932f79f98666e02dfeb150 |
| Download | GitHub codeload, HTTPS |
| Komprimiertes Budget | 64 MiB |
| Extrahiertes Kit-Budget | 32 MiB |

Ein optionales MGU_KIT_ARCHIVE kann für einen Offline-Test auf ein lokales
Archiv zeigen. Auch dann gilt dieselbe verpflichtende Prüfsumme.
Ein beliebiges anderes Kit wird nicht ungeprüft ausgeführt.

## Warum ein vorbereiteter Schriftatlas enthalten ist

Der dokumentierte MGU-Python-Interpreter enthält die Standardbibliothek,
aber keine vorausgesetzte Pillow-Installation. Die normale Workstation-
Schriftgenerierung darf daher nicht zum Pflichtschritt des Store-Builds werden.

assets/fonts/airplay.json enthält die aus der mitgelieferten freien
Ubuntu-Schrift erzeugten Glyphen einschließlich Umlauten, ß und deutschen
Anführungszeichen. atlas-manifest.json dokumentiert Schrift- und Atlas-
Prüfsumme sowie den Kit-Stand. Das ist keine extrahierte BMW-Schrift.

Der Store-Build erzeugt daraus auch die eigene label-Familie und kopiert
die Ubuntu-Lizenzhinweise in das App-Paket. Der Workstation-Build kann den
Atlas mit Pillow weiterhin selbst erzeugen.

## Lokale Prüfung vom 7. November 2026

Folgende Schritte wurden auf dem Entwicklungsrechner erfolgreich ausgeführt:

- Lesen der Quelle mit repoCatalog aus dem tatsächlichen MGU-Updater-Code;
- Erkennung genau einer App: pllana_airplay, Version 0.2.6;
- Erkennung von ID7, Build-Skript und den Runtime-/Infrastruktur-Abhängigkeiten;
- kompletter Offline-Fixture-Build mit geprüftem Original-Kit-Archiv;
- Ausführung als UID 65534 statt Root;
- Python mit -S, also ohne zusätzliche site-packages/Pillow;
- genau ein Frontend-Artefakt mit rund 1,2 MB;
- Prüfung von Paket-ID/-Version und ID7-Metadaten;
- Prüfung deutscher Glyphen, Vollbild-Patch und Renderer-Präferenz;
- Prüfung, dass weder CarPlay-Steuerung noch native Runtime mitgepackt sind.

Das ist ein vollständiger lokaler Build-/Discovery-Test. Es ist **kein**
Nachweis einer Installation durch die echte MGU-Store-Sandbox auf einer
weiteren Headunit. Insbesondere wurden dabei der Live-Download über deren
Build-Proxy, deren Ressourcenlimits und ein vollständiger Update-/Rollback-
Ablauf am Fahrzeug nicht erneut qualifiziert.

## Manuelle lokale Wiederholung

In einer frischen Arbeitskopie als normaler Linux-Benutzer:

~~~sh
mkdir -p .local/store-output
# Das rechtmäßig bereitgestellte SDK-Modul muss unter ./oap-sdk liegen.
MGU_OUT="$PWD/.local/store-output" \
  python3 -S tools/build_store.py \
  --app pllana_airplay --version 0.2.6 --source apps/pllana_airplay
~~~

Das Ausgabeverzeichnis muss leer sein. Ohne lokale Archiv-Fixture ist
Internet für den überprüften Kit-Download erforderlich.

Der Builder unterstützt keine umbenannten parallelen AirPlay-Instanzen:
die separate Runtime ist an die installierte Haupt-App und deren UID gebunden.
