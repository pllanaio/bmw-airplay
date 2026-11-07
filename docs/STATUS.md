# Projektstand – 7. November 2026

## Einordnung

BMW AirPlay by pllana.io ist ein funktionierender Entwicklungsprototyp für
eine konkrete BMW-MGU/iDrive-7-Headunit. Er kombiniert eine native OAP-App mit
einem separat installierten UxPlay-Empfänger und BMW-Audiorouting.
Die bisherige Erprobung ist keine Freigabe für alle MGU-Hardwarestände,
Fahrzeugausstattungen, iPhone-Apps oder iOS-Versionen.

Der vorbereitete Quellstand für App und Laufzeit ist **0.4.4**. Die neuen
Änderungen sind lokal geprüft, noch nicht am Fahrzeug abgenommen. Die
Fahrzeugbestätigungen weiter unten beziehen sich auf die dort genannten
älteren Versionen.

Der historische Git-Tag v0.2.6 bezeichnet den ersten veröffentlichten
Quellcode-Snapshot. Die nachträgliche Store-Anbindung und diese ausführliche
Dokumentation stehen auf main. Der Tag wird dafür nicht nachträglich verschoben.

## Änderungen in 0.4.4 – stoppbare Videomodi und reines Audio

- Ausdrückliche Stop-/Pause-/Medien-Teardown-Anfragen werden respektiert.
  Die bisherige Entkopplung darf bewusste Bedienung nicht übergehen.
- Der tatsächliche Ursprung bestimmt das Rückkehrziel: Video aus Spiegelung
  kehrt zu dieser zurück; direktes Video wartet auf einen neuen Inhalt.
  Alte Spiegelungspakete übernehmen den Direktmodus nicht unbeabsichtigt.
- „Video beenden“ beendet den Inhalt ohne vollständiges Trennen.
- Videos füllen die 1920×504-Fläche durch zentrierten Beschnitt statt
  zusätzlicher Ränder. Normale Bildschirmspiegelung behält ihr vollständiges Bild.
- „Nur Audio“ startet den Empfänger ohne Video/HLS und ohne Ankündigung
  von Bildschirmspiegelung. RAOP-Musik bleibt nach Ende der Oberfläche aktiv.
  Ein ausdrückliches „Trennen“ oder „Schließen“ beendet den Empfang.
- Musikansicht mit Cover, Titel, Interpret und Album aus AirPlay-Metadaten.
  Play/Pause, vorheriger/nächster Titel, Shuffle und Repeat werden über den
  authentifizierten Sender gesteuert, wenn dessen DACP-Fähigkeiten bestätigt sind.
  Shuffle und Repeat zeigen ausschließlich abgefragte Zustände.
- Lokale Prüfungen umfassen beide Videomodi, echte Stop-/Pause-Steuerung,
  Audiofähigkeiten, tatsächliche ALAC-Dekodierung vor/nach Stop/Neustart,
  Metadaten-/Cover-Verarbeitung und DACP-Befehle mit Sitzungswechseln.

Die Fahrzeugabnahme mit YouTube, Spotify und YouTube Music steht aus.
Identische Stop-Anfragen enthalten keinen Nachweis, ob die iPhone-App in
Hintergrund ging oder der Benutzer stoppte; der Empfänger respektiert sie.
[Modi und Testmatrix](MEDIA_MODES.md). Beide Pakete auf 0.4.4 aktualisieren.

## Änderungen in 0.4.3 – BMW-WLAN und Video aus der Spiegelung

- Persönlicher iPhone-Hotspot ist für lokale Spiegelung nicht nötig:
  iPhone mit dem vorhandenen BMW-WLAN verbinden. Ohne Uplink-Lease wird
  HLS beim Verbindungsstart nicht beworben; YouTube bleibt gespiegelt und
  kann das Internet des iPhones nutzen. Der direkte YouTube-AirPlay-Knopf
  liefert ohne HLS nur Audio. Nach Zuschalten eines Uplinks neu verbinden.
- Für direkte/abgelöste HLS-Videos benötigt die MGU weiterhin eigenes
  Internet über MGU-Uplink. iPhone-Mobilfunk wird nicht automatisch über
  das BMW-WLAN geteilt. [Aufbau und Grenzen](NETWORK.md).
- Eigene Firewallregeln unterstützen wlan_bridge/wlan0/wlan1. Der
  Root-Supervisor repariert sie nach Uplink-Tabellenwechseln, ohne
  unveränderte Regeln neu zu schreiben. DNS folgt auch einem USB-Uplink;
  beim Verlust der Lease bleiben keine alten Hotspot-DNS-Server zurück.
- Der native Empfänger erkennt den Wechsel von tatsächlichen Spiegelungs-
  paketen zu HLS direkt beim Videoaufruf. Kein 1,5-s-Timer, der während
  des Ladens feuert oder auf den nächsten Inhalt übergreift.
- Bei einem abgelösten Video werden Telefon-Pause, Stop, HLS-TEARDOWN
  und Playlist-Entfernen abgefangen; die lokalen Playlist-Routen und
  das Bild bleiben auch beim Schließen der Telefon-Steuersockets bestehen.
  „Zur Spiegelung“ und natürliches Videoende beenden die Ablösung.
- Normale direkte AirPlay-Videos behalten ihre Steuerung über das iPhone.
  Reine Bildschirmspiegelung lässt sich nicht in ein unabhängiges Video
  verwandeln, wenn die iPhone-App keinen AirPlay-Videostream sendet.

- YouTube-Titelübergaben über `playlistInsert` und der Rückkanal-Abschluss
  unterstützen sendergesteuertes Fortsetzen einer Playlist. Die Verbindung
  wird am natürlichen Videoende erhalten; Pause, Fehler und ausdrückliches
  Beenden lösen keinen normalen Ende-/Weiter-Handshake aus.
  [Protokollpfad und Fahrzeugabnahme](PLAYLISTS.md).

Beide Pakete auf 0.4.3 aktualisieren. Die neuen lokalen Regressionstests
prüfen Startoptionen, Offline-/Online-Leasewechsel, Firewall-Wiederherstellung,
Spiegelungsursprung und die nativen Stop-/Playlist-/Rückkehrpfade. Sie ersetzen
keinen iPhone-/MGU-Test; insbesondere das Verhalten bei realem App-Wechsel
und beim Sperren des iPhones bleibt am Fahrzeug zu bestätigen.

## Änderungen in 0.4.2 – Video aus der Spiegelung vom iPhone lösen

Startet während der Bildschirmspiegelung ein YouTube-/AirPlay-Video, löst
der Empfänger es etwa 1,5 s nach Wiedergabestart vom iPhone: Stopp-, Pause-
und Playlist-Entfernen-Anfragen, die iOS beim Verlassen der App sendet,
werden ignoriert; das Video läuft bis zum Ende weiter, Spiegelungston ist
währenddessen stumm. „Zur Spiegelung“ (Leiste unter dem Video) oder das
Videoende kehren zur Spiegelung zurück. Ein direkt per AirPlay gestartetes
Video ist unverändert. Nur Laufzeiten ab 0.4.2 melden die Fähigkeit
(`MGU_FEATURES detach`); ältere erhalten kein Signal.

Noch nicht am Fahrzeug geprüft: welche Anfragen iOS beim App-Wechsel
während der Spiegelung tatsächlich sendet. Die Diagnose protokolliert sie
(`mgu_phone_stop_ignored`, `mgu_phone_pause_ignored`).

## Änderungen in 0.3.1

Nach einem App-Update über den Store verschiebt mgu-deploy das alte App-
Verzeichnis samt Steuer-Socket. Der weiterlaufende Empfangsdienst war danach
für die neue App unerreichbar („Empfangsdienst startet noch“). Das Backend
erkennt jetzt einen ersetzten Socket oder ersetzten Code und beendet sich mit
Code 75; systemd startet es mit dem neuen Code neu. Wirksam ab dem ersten
Start des 0.3.1-Backends (danach einmalig Dienst oder Headunit neu starten).

## Änderungen in 0.3.0 (App und Laufzeit, noch nicht am Fahrzeug abgenommen)

Ziel: weniger Verbindungsabbrüche, flüssigere YouTube-Wiedergabe und schnellere
Wechsel zwischen Spiegelung und Video. Alle Punkte sind lokal getestet; die
Abnahme am Entwicklungsfahrzeug steht aus.

| Bereich | Änderung |
| --- | --- |
| Absturz des Empfängers | Unerwartetes Ende von UxPlay (z. B. Code 139 nach fehlgeschlagenem HLS-Abruf) startet den Empfänger automatisch neu: 1 s, 2 s, 4 s, 8 s, dann alle 15 s; nach 60 s stabilem Lauf zurückgesetzt. Das bisherige Passwort bleibt gültig, das iPhone kann sich ohne neue Code-Eingabe wieder verbinden. Ein manuelles „Verbinden“ erzeugt weiterhin einen neuen Code. |
| App-Oberfläche getrennt | Verliert das Backend die Verbindung zur App (Neustart durch den App-Manager, blockierte Ereignisschleife), läuft die AirPlay-Sitzung 30 s weiter. Eine neu verbundene Oberfläche übernimmt sie nahtlos. „Trennen“ und „Schließen“ beenden weiterhin sofort. Heartbeat-Toleranz 12 s statt 7 s, Wiederverbindung nach 0,5 s statt 2 s. |
| Firewall | Regeln gelten für wlan0/wlan_bridge und private bzw. Link-Local-Adressbereiche statt für das beim Dienststart zufällig vorhandene Subnetz. Vorher hatte wlan0 keine Regel, wenn der Dienst vor dem iPhone-Hotspot startete: Der Empfänger war sichtbar, aber nicht erreichbar. Der Dienststart scheitert nicht mehr ohne WLAN-Adresse. |
| YouTube/HLS | Ein gemeinsamer Konvertier-/Skalierschritt (videoconvertscale, 2 Threads, eigener Queue-Thread) statt zwei Einzelschritten. 5 s statt 3 s Vorpuffer gegen Hotspot-Schwankungen. |
| Dienstressourcen | CPUQuota 250 % statt 150 %, Nice 0 statt 5, CPUShares 512 statt 128. Softwaredekodierung bekam vorher nur 1,5 Kerne mit niedriger Priorität. Für die BMW-Oberfläche bleibt mindestens ein Kern frei. |
| Wechsel Spiegelung ↔ Video | Bildwechsel werden alle 100 ms statt 250 ms erkannt, die Oberfläche läuft mit 10 statt 4 Bildern pro Sekunde. |
| Videoausgabe | Eng gepackte Bildebenen (720p-Ausgabe) werden mit einer Kopie statt zeilenweise übertragen. |

Für die native Laufzeit 0.3.0 ist ein neuer Build mit `airplay/tools/build_runtime.py`
und eine Installation über `deploy_runtime.py` erforderlich.

## Getestete Umgebung

| Bestandteil | Entwicklungsaufbau |
| --- | --- |
| Headunit | BMW MGU, iDrive 7 / ID7 |
| Kernel | 4.14.198-apl |
| CPU-/Laufzeitarchitektur | x86-64 Linux |
| App-Laufzeit auf der MGU | Node 8 |
| Display | 1920 × 720 |
| iPhone-Software | iOS 27.0.2 |
| Netzwerk | iPhone Personal Hotspot → MGU WiFi-Uplink |
| Uplink-Schnittstelle | wlan0 im erprobten Aufbau |
| Build-Umgebung | Debian 12 unter WSL, Python, Node und native Build-Werkzeuge |
| Grafik | Vorhandener MGU-Renderer, bevorzugt Store-Socket |
| Audio | OEM-SmartX/ALSA und GENIVI/BMW-Audiomanager |

Die MGU verbindet sich als Client mit dem Hotspot des iPhones. Das iPhone
ist gleichzeitig der AirPlay-Sender. Der interne BMW-Access-Point auf
wlan_bridge ist eine andere Netzwerkfunktion. Er ist nicht die Voraussetzung
dieses tatsächlich getesteten Aufbaus.

Öffentlich dokumentiert werden die Netzstruktur und die benötigten
Schnittstellen. Persönliche SSIDs, Hostschlüssel, Hardwareadressen,
Zugangsdaten, Pairing-Schlüssel und vollständige Fahrzeugprotokolle sind
bewusst nicht Bestandteil des Repositories.

## Was am Fahrzeug bestätigt wurde

Diese Aussagen beruhen auf Rückmeldungen am Entwicklungsfahrzeug. Sie sind
von später ergänzten Implementierungen und lokalen Simulationen zu unterscheiden.

| Ablauf | Bestätigung | Grenze der Aussage |
| --- | --- | --- |
| Empfänger wird am iPhone gefunden | Ja | Lokaler WLAN-/Firewall-Aufbau muss stimmen |
| Sechsstelliger Code im Passwortmodus | Ja | Älterer vierstelliger PIN-Modus war problematisch |
| iPhone-Bildschirmspiegelung | Ja | Keine Zusage für DRM-Inhalte |
| Ton eines Fotos-App-Videos über BMW-Lautsprecher | Ja | Kanalzuordnung noch nicht vollständig qualifiziert |
| „Trennen“ beendet die Übertragung sauber | Ja | Basistest erfolgte bereits vor den späteren HLS-Arbeiten |
| App-Titel und angepasstes App-Symbol | Ja | Titel exakt „BMW AirPlay by pllana.io“ |
| Entfernung des orangefarbenen Titelrests und der rechten schwarzen Leiste | Ja | Auf dem Entwicklungsdisplay überprüft |
| Bestehende Spiegelung → YouTube-Video → zurück zur Spiegelung | Ja, mit Laufzeit 0.2.4 | Einzelner bestätigter Ablauf, keine allgemeine Fehlerfreiheit |
| Direkte YouTube-AirPlay-Wiedergabe | Ja, mit Laufzeit 0.2.4 | CarPlay war dabei im iDrive getrennt |
| Direkte YouTube-Wiedergabe bei YouTube im Hintergrund | Ja | Test betraf den direkten AirPlay-Modus |
| Manuelles Trennen von CarPlay beseitigt dessen Übernahme | Ja | Ist weiterhin der vorgesehene Arbeitsablauf |

Bei der Bestätigung des Wechsels von Spiegelung zu Video wurde kurz die
Verbindungsseite angezeigt. Die App hat danach eine neutrale Vollbild-
Übergangsanzeige erhalten. Deren Erscheinen ist implementiert; ein gesonderter
abschließender Fahrzeugtest dieses optischen Details ist nicht dokumentiert.

## Implementiert, aber noch nicht vollständig am Fahrzeug qualifiziert

| Funktion | Stand |
| --- | --- |
| Vollbild für Video und Fotos | Gemeinsamer nativer Ausgabepfad vorhanden |
| Reaktion auf wechselnde Bildabmessungen | Renderer, Shared-Memory-Format und Dateiwechsel lokal getestet |
| Hoch-/Querformat | Technische Renegotiation lokal getestet; erneuter systematischer iPhone-Test offen |
| Sehr breite Filmformate | Ausgabe erhält das Seitenverhältnis; reale problematische Quellen erneut testen |
| Andere ungeschützte HTTP-/HLS-/MP4-AirPlay-Apps | Direkter Request-Pfad ergänzt; keine allgemeine App-Kompatibilitätszusage |
| YouTube → ARD → YouTube innerhalb einer Sitzung | Ursprünglich fehlerhaft; nach den Änderungen noch nicht ausdrücklich bestätigt |
| Warten nach Ende direkt gestarteter Video-Wiedergabe | Zustände und Sitzungsbeibehaltung implementiert; umfassender Dauertest offen |
| Viele aufeinanderfolgende Video-/App-Wechsel | Lokale Lebenszyklustests vorhanden; realer Belastungstest offen |
| Rückkehr nach BMW-Home oder einer Fokusüberlagerung | Frontend beendet die Sitzung dabei nicht absichtlich |
| Fehlerdiagnose nach nativem Absturz | Begrenzte Adressausgabe und korrigierter Log-Filter vorhanden |

Ein lokaler Test einer Funktion bedeutet nicht automatisch, dass die
entsprechende iPhone-App denselben Protokollablauf verwendet.

## Aktueller CarPlay-Stand

**Die App unterdrückt und steuert CarPlay nicht.**

CarPlay kann die Medienwiedergabe automatisch übernehmen. Der am Fahrzeug
bestätigte Weg ist deshalb:

1. CarPlay im iDrive manuell trennen.
2. Den persönlichen Hotspot und den MGU-WiFi-Uplink bestehen lassen.
3. BMW AirPlay by pllana.io öffnen und „Verbinden“ drücken.
4. Den eigenen AirPlay-Empfänger am iPhone auswählen.

Die vorübergehende Anforderung „AirPlay hat immer Vorrang“ wurde als
Automatik erprobt und anschließend auf ausdrücklichen Wunsch zurückgenommen.
Sie ist keine noch versteckte oder standardmäßig deaktivierte Option.

Mit App 0.2.6 wurden auf der MGU überprüft:

- kein CarPlay-Steuerungsmodul im App-Paket;
- keine entsprechenden Aufrufe im Backend;
- keine zusätzlichen DevicePresentation-Steuerungsberechtigungen;
- keine alte entsprechende generierte Schnittstellenkonfiguration;
- kein verbliebener Wiederherstellungs-Claim;
- AirPlay-Dienst und serienmäßiger CarPlay-Dienst laufen unabhängig.

### Zurückgenommener Diensttest

Ein zeitlich begrenzter Versuch, den serienmäßigen carplay.service normal
zu stoppen, führte auf dieser Headunit zu Crash-Einträgen von CarPlay und
anschließend mediaddpserver sowie einem automatischen MGU-Neustart.
Ein vorher eingerichteter Wiederherstellungstimer war nur flüchtig und nach
dem Neustart nicht mehr vorhanden.

Dieser Diagnoseweg ist verworfen. Der normale App-Start, die Store-Anbindung
und die Deployment-Skripte sollen den serienmäßigen CarPlay-Dienst nicht stoppen.
Auch der nachfolgende Versuch einer gerätebezogenen automatischen Freigabe
über DevicePresentation wurde wieder vollständig entfernt.

## Offene Fehler

### P1 – Absturz bei der Erholung von einem fehlgeschlagenen Medienabruf

Beobachtet wurde eine Folge von HLS-Fragment-/GStreamer-Abruffehlern,
anschließend MGU_MEDIA_FAILED, MGU_CRASH und ein Empfängerende mit Code 139.
Das Backend blieb davon getrennt; diese Beobachtung ist kein Nachweis eines
allgemeinen MGU-Neustarts durch den normalen AirPlay-Player.

Die genaue Absturzstelle ist noch nicht bestimmt. Der erste Filter für
Backtrace-Zeilen erwartete fälschlich ein Leerzeichen zwischen Modulname und
Adresse und erfasste deshalb die benötigten Zeilen nicht. Der Filter wurde
korrigiert und lokal geprüft. Ein danach vollständig ausgewerteter neuer
Fahrzeug-Backtrace liegt noch nicht als bestätigte Fehlerursache vor.

Nächster sinnvoller Schritt ist eine Reproduktion mit passendem Laufzeit-
Build und Symbolen, danach Adressauflösung und ein gezielter Fehlerpfad-Test.
Ein Downloadfehler darf den Medieninhalt beenden; der Empfänger soll weiter
für eine neue Wiedergabe verfügbar bleiben.

### P1 – Fliegender Wechsel zwischen Wiedergabe-Apps

Beim Wechsel von YouTube zur ARD Mediathek zeigte das iPhone bereits den
neuen AirPlay-Inhalt an, während auf der MGU ein altes Bild stehen blieb.
Es wurden getrennte lokale Playlist-Routen, direkter Medien-Request-Support
und das Ausblenden alter Frames beim Laden ergänzt.

Diese Änderungen sind keine abschließende Bestätigung des gesamten
YouTube-/ARD-Wechsels. Dieser Ablauf muss ausdrücklich erneut getestet werden.

### P2 – Breite Videos und Startlast

Breite YouTube-Videos führten in früheren Versuchen zu Ruckeln, Einfrieren
oder Abbruch. Die Ausgabe wird ab 0.4.4 auf I420/1920×504 begrenzt,
vorab gepuffert und mit einer Bandbreitenempfehlung gestartet.

Die Empfehlung ist **keine harte Eingangsauflösungs- oder Codec-Grenze**.
Ein breiter oder hochauflösender Quellstream kann weiterhin teuer zu
dekodieren sein. Die Quelle darf erst nach Messung von tatsächlichem Codec,
Auflösung, Bildrate, Decoderlast und Pufferzustand als Ursache gelten.

Ein älterer CPU-Beobachter erfasste nur den Backend-Prozess, weil eine
erwartete /proc-Unterdatei auf diesem Kernel fehlte. Diese Messung ist kein
Beleg für eine niedrige Decoderlast.

### P2 – Vollständige Hardware- und Langzeitqualifikation

Offen bleiben unter anderem verschiedene Headunit-/Displayvarianten,
Kaltstarts, wiederholte Verbindungswechsel, lange Sitzungen, endgültige
Lautsprecherzuordnung und das Verhalten bei wechselndem Internetzugang.

## Was ausdrücklich nicht enthalten ist

- Keine allgemeine FairPlay-/Widevine-/DRM-Lösung.
- Kein Versprechen für Netflix, Disney+, Prime Video oder Paramount+.
- Kein Waydroid, kein Android-Container und kein Binder-Kernelmodul.
- Kein Ersatz der BMW-System-DNS-Konfiguration.
- Keine automatische CarPlay-Deaktivierung.
- Kein allgemeiner Root-/SSH-Installer.
- Keine allgemeine Hardwarefreigabe durch die Veröffentlichung der
  App-/Empfängerpakete im Store-Katalog.

Die öffentlich sichtbaren Quellen dokumentieren den tatsächlichen
Entwicklungsstand einschließlich seiner Grenzen.

## Nächste Arbeitsschritte in Reihenfolge

1. Nativen Fehler bei fehlgeschlagenem Medienabruf reproduzieren und beheben.
2. YouTube-/ARD-App-Wechsel, nächstes Video und Rückkehr zur Spiegelung prüfen.
3. Problematische breite Videos mit belastbaren Messwerten untersuchen.
4. Portrait/Landscape, Fotos und Übergangsanzeige erneut am iPhone abnehmen.
5. Längere Sitzungen, WLAN-Unterbrechungen und Wiederverbindung prüfen.
6. Store-Frontend auf einer tatsächlichen MGU in deren Build-Sandbox erproben.
7. Native Runtime als separat reproduzierbar verteilbares Tool qualifizieren.
8. Weitere MGU-/Firmwarestände und die Lautsprecherzuordnung testen.

## Weiterführende Dokumentation

- [Architektur und Protokollpfade](ARCHITECTURE.md)
- [Tests und Aussagekraft](TESTING.md)
- [Store-Anbindung](STORE.md)
- [Fehlerdiagnose](TROUBLESHOOTING.md)
- [Versionsgeschichte und Entscheidungen](HISTORY.md)
- [Build und Installation](BUILD.md)
