# Fehlerdiagnose

Die folgenden Schritte unterscheiden die bereits beobachteten Fehlerklassen.
Historische Diagnose-Skripte sind kein Anlass, serienmäßige Fahrzeugdienste
neu zu starten oder deren Konfiguration zu verändern.

## Empfänger fehlt auf dem iPhone

Prüfen:

1. Ist die App geöffnet und wurde „Verbinden“ gedrückt?
2. Läuft der private mgu-airplay-Dienst und sein Receiver?
3. Sind iPhone und MGU tatsächlich über denselben erreichbaren Netzpfad verbunden?
4. Hat der MGU-WiFi-Uplink bei Verwendung des iPhone-Hotspots eine IP-Lease?
5. Funktioniert mDNS/DNS-SD über den vorhandenen BMW-Dienst?
6. Sind die eigenen AirPlay-Ports im lokalen WLAN erreichbar?

Ein früherer Fehler koppelte den gesamten Empfängerstart an eine freie
Audioverbindung. Dadurch verhinderte audio_route_in_use sogar die
WLAN-Anmeldung. Dieser Zusammenhang wurde entfernt. Eine besetzte
Lautsprecherroute soll nicht mehr die AirPlay-Erkennung verhindern.

Die Runtime verwendet die festen Portnummern 7100–7102 für ihre
TCP-/UDP-Dienste. Der jeweilige Dienst und der Verbindungsablauf müssen
trotzdem anhand des laufenden Receivers geprüft werden; bloße Portzahlen
beweisen keine erfolgreiche Kopplung.

## Wiederholte PIN-Abfrage

Der ältere PIN-/SRP-Modus führte im Entwicklungsaufbau wiederholt zu
fehlgeschlagener Kopplung. Der funktionierende Aufbau verwendet stattdessen
den sechsstelligen Code als UxPlay-Passwort.

Den aktuellen Code auf der MGU verwenden und einen alten iPhone-Dialog
abbrechen. Ein erneuter Receiverstart kann einen neuen Code erzeugen.
Ein Medienmoduswechsel allein soll dagegen nicht neu koppeln müssen.

Bei einem Paketvergleich kontrollieren, dass die App nicht versehentlich
auf den älteren -pin-Modus zurückgestellt wurde.

## Spiegelung funktioniert, direktes Video lädt nicht

Spiegelung und direkte Video-Wiedergabe sind unterschiedliche Datenpfade.
Bei direkter Wiedergabe lädt die Headunit den Medieninhalt selbst.

Prüfen:

- Uplink wirklich online, nicht nur Funkverbindung „connected“;
- vorhandene DHCP-/IP-Lease und erreichbarer Router;
- Zugriff der App-UID über die Uplink-Regeln;
- privater Backend-DNS-Resolver enthält die aktuelle Lease;
- HTTPS-Zertifikatsprüfung und CA-Store;
- erfolgreicher Playlist-Austausch;
- tatsächlich verwendeter Demuxer und unterstützter Mediencodec.

Ein bereits beobachteter Zustand war eine bestehende WLAN-Funkverbindung
ohne IP-Adresse. Daraus darf kein funktionierender Internetzugang abgeleitet werden.
Auch eine im iPhone-Menü gewählte AirPlay-Route beweist noch kein Bild auf der MGU.

## HLS-Demuxer

Der ursprüngliche neuere HLS-Pfad scheiterte an konkreten
Codec-/Streams-Kontext-Problemen. Der derzeitige Stand verwendet playbin2
und setzt zusätzlich den hlsdemux2-Feature-Rang auf 0.

Ein lokaler Test soll die tatsächlich instanziierte Elementklasse
prüfen. Nur die Zeichenfolge playbin2 in einem Startargument reicht nicht.

## Nach einem App-/Video-Wechsel bleibt ein altes Bild stehen

Prüfen, ob:

- ein neuer /play-Request angekommen ist;
- der FCUP-/direkte Request-Pfad passend gewählt wurde;
- das neue Video eine eigene lokale Playlist-Route besitzt;
- der alte Frame beim Laden ausgeblendet wurde;
- der neue Transport eine andere Dateiidentität erhalten hat;
- der Renderer die neue Datei und deren Abmessungen übernommen hat.

Altes Bild und neuer im iPhone angezeigter Inhalt können auseinanderlaufen.
Das ist ein Fehlerzustand, kein Erfolg. Der vollständige App-Wechsel
zwischen YouTube und ARD bleibt auf der Liste offener Fahrzeugtests.

## Bild vorhanden, BMW-Lautsprecher stumm

Zwischen erfolgreichem PCM-Schreiben und hörbarem Ton liegen mehrere
BMW-Audiomanager-/SmartX-Schritte.

Prüfen:

- eigene Verbindung OAPGenericMedia → MediaSink_Front;
- bestätigter Verbindungszustand;
- richtige OEM-SmartX-Senke und korrektes PCM-Format;
- Verwendung der serienmäßigen ALSA-Bibliothek;
- tatsächlich gewählte Medienquelle und CarPlay-Zustand;
- Lautstärke am iDrive unter Kontrolle des Benutzers.

Auf dem Entwicklungsfahrzeug wurde ein Testton erst bei passender
Lautstärke hörbar. Ein fehlerfrei durchgelaufener GStreamer-Prozess
allein ist deshalb kein Hörnachweis.

Die App verändert die Fahrzeuglautstärke im normalen Betrieb nicht.
Ein GENIVI-getVolume-Ergebnis erwies sich in der Erprobung außerdem als
ungeeignet, die reale Lautstärke allein zu beurteilen; die Liste der
Main-Senken zeigte den tatsächlich verwendeten Wert.

## CarPlay übernimmt Bild oder Medien

CarPlay manuell im iDrive trennen und Hotspot/Uplink bestehen lassen.
Danach den eigenen Empfänger „BMW AirPlay by pllana.io“ wählen.

Keine automatische Unterdrückung, keine DevicePresentation-Umschaltung
und keinen Dienst-Stopp als Workaround wieder einführen. Die Automatik
wurde auf ausdrücklichen Wunsch aus App 0.2.6 entfernt.

## Breite Videos ruckeln

Tatsächliche Quellauflösung, Bildrate, Codec, gewählte Variante,
Netzwerkpufferung und Decoder-CPU messen. Die 720p-Ausgabe bedeutet nicht,
dass die Quelle bereits mit 720p ankommt.

Nur das Backend zu messen übersieht die UxPlay-/GStreamer-Arbeit.
Auf diesem Kernel ist nicht jede erwartete /proc-Unterdatei verfügbar;
Kindprozesse müssen gegebenenfalls anhand ihrer PPID ermittelt werden.

## Empfänger stürzt nach Abruffehlern ab

Dies ist ein bekannter offener Fehler. Für die weitere Eingrenzung benötigt
werden die passenden Runtime-Symbole und die bereinigten MGU_CRASH-
Adresszeilen. Das Ende mit Code 139 gehört zum nativen Receiver; ein
anderer, weiterhin laufender Node-Dienst beweist nicht, dass die Wiedergabe lebt.

Die Adressen mit dem exakt zugehörigen Build auflösen. Eine Rückverfolgung
mit Symbolen einer anderen Runtime kann irreführend sein.
Keine vollständigen Prozessspeicherabbilder öffentlich hochladen.

## SSH meldet einen anderen Hostschlüssel

Die öffentliche Repository-Version enthält keine eigenen Host-Pins oder
Schlüssel. Der Deployment-Helfer verlangt eine vom Benutzer gepflegte,
verifizierte known_hosts-Datei und strikte Hostprüfung.

Einen anderen Schlüssel nicht pauschal akzeptieren und die Prüfung nicht
abschalten. Geräteidentität, Verbindung und einen möglichen Neustart
separat feststellen. Solche Änderungen sind kein AirPlay-Pairing-Problem.

## Nach Paket-Update erscheint noch keine App-Oberfläche

Die App im BMW-Menü ausdrücklich neu öffnen. Ein Start durch den App-Manager
im reinen Konfigurationsmodus ist von einem Start über den App-Eintrag zu
unterscheiden. In einem CONFIG_STATE-Start kann das SDK ohne RHMI-Oberfläche
aktiv sein; daraus allein folgt noch kein Defekt des Empfängers.
