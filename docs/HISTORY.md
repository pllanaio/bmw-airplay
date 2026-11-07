# Verlauf und getroffene Entscheidungen

Dies ist eine Zusammenfassung der Entwicklung, kein vollständiger
Commit-Verlauf aller Fahrzeugversuche. Der erste öffentliche Git-Snapshot
wurde erst nach diesen Arbeiten angelegt.

## Ausgangsziel und Eingrenzung

Das ursprüngliche Ziel war die drahtlose Übertragung von iPhone-Inhalten
auf die BMW-Headunit, einschließlich verschiedener Streamingdienste.
Ein bloßes Browserfenster auf der MGU entsprach diesem Wunsch nicht.

UxPlay wurde als softwarebasierter AirPlay-Empfänger gewählt. Eine
Waydroid-/Android-Variante wurde diskutiert, ist aber kein Bestandteil
dieses Standes. Es gibt hier weder ein gebautes Binder-Kernelmodul noch
eine durch Waydroid bereitgestellte DRM-Lösung.

Die aktive Umsetzung konzentrierte sich auf ungeschützte Spiegelung und
Video-Inhalte. Eine Zusage für geschützte Streamingdienste wurde daraus nicht.

## Grobe Versionsfolge

| Stand | Ergebnis / Bedeutung |
| --- | --- |
| Frühe Audio-Prototypen | PCM-/SmartX-Pfad und eigener BMW-Audiomanager-Anschluss untersucht |
| App 0.1.3 | Spiegelung, Fotos-App-Videoton und sauberes manuelles Trennen bestätigt |
| Frühe 0.2.x | Modernisierte Oberfläche, Vollbild, Schriftzeichen, Branding und HLS-Arbeiten |
| 0.2.2 | Korrigierter Titelrest und störende schwarze Leiste am Fahrzeug bestätigt entfernt |
| 0.2.3 | Direkte HLS-Wiedergabe teilweise möglich; mehrere Übergangs-/Absturzprobleme weiter vorhanden |
| Runtime 0.2.4 | Renderer-/Audio-Lebensdauer und Übergabepfade überarbeitet; getesteter Mirror-/HLS-Wechsel und YouTube-Hintergrundwiedergabe möglich |
| App 0.2.5 | Vorübergehende automatische CarPlay-Freigabe; anschließend zurückgenommen |
| App 0.2.6 | CarPlay-Automatik, Modul und zusätzliche Berechtigungen entfernt; Runtime bleibt 0.2.4 |
| Öffentlicher Tag v0.2.6 | Erster AirPlay-only-Quellcode-Snapshot, ohne lokale Fahrzeugdaten und ohne proprietäres SDK |
| Aktueller main-Stand | Store-Repo-Datei, eigener Store-Builder und ausführliche Dokumentation ergänzt; App-Version weiterhin 0.2.6 |

## Audio: Schreiben ist nicht dasselbe wie Hören

Mehrere frühe, technisch durchgelaufene Tonpipelines blieben unhörbar.
Erst nach Prüfung des gesamten BMW-Pfades und einem geeigneten,
anschließend zurückgesetzten Lautstärketest wurde der Ton bestätigt.

Daraus folgen zwei Entscheidungen:

- Hörnachweise getrennt von PCM-/GStreamer-Ergebnissen führen.
- Im normalen App-Betrieb keine automatische Lautstärkeänderung einführen.

Die achtkanalige PCM-Ausgabe ist ein bewährter Prototyp-Pfad; eine
allgemeine Aussage über jedes einzelne Lautsprecherpaar folgt daraus nicht.

## Pairing: Passwort statt problematischem älteren PIN-Pfad

Nach Freigabe der lokalen AirPlay-Ports erschien zunächst der PIN-Dialog.
Der ältere Kopplungspfad forderte die PIN aber wiederholt an.
Mit dem sechsstelligen Passwortmodus wurde die Spiegelung angenommen.

Der sichtbare Code und die native Empfänger-Konfiguration müssen deshalb
aus demselben tatsächlichen Zustand stammen. Dieser Pfad wurde nicht wieder
auf den früheren PIN-Modus zurückgestellt.

## Darstellung und eigenes Branding

Die App erhielt die Gestaltung von Leon Pllana IT-Solutions / pllana.io
und ein eigenes LP-/Play-/Wireless-Logo. Das App-Symbol wurde anschließend
an die ursprüngliche BMW-Iconfläche von 140×140 Pixeln angepasst.

Titelüberdeckung und private SDK-Flächen wurden korrigiert, bis sowohl
der orangefarbene Rest des Namens als auch die schwarze Zurück-Leiste
am Fahrzeug nicht mehr sichtbar waren.

Die Logoausgabe verwendet das tatsächlich passende native
Nachrichtenformat; eine bloß im Emulator sichtbare Grafik war zuvor
kein ausreichender Nachweis für die Headunit.

## HLS und Wechsel zwischen Medienmodi

Der zunächst gewählte neuere GStreamer-HLS-Pfad erwies sich bei den
tatsächlichen YouTube-Streams als problematisch. Die Runtime wechselte
auf playbin2 plus ausdrückliche Unterdrückung von hlsdemux2.

Weitere Arbeiten betrafen:

- Spiegelungspakete während einer HLS-Übernahme;
- getrennte lokale Playlist-URLs pro Video;
- späte GStreamer-Ereignisse nach Renderer-Abbau;
- Audio-Pakete während Stop/Start;
- Aufbewahrung der für die Rückkehr zur Spiegelung benötigten Informationen;
- tatsächliche neue Frame-Dateien statt alter Renderer-Dateihandles;
- direkte ungeschützte Medien-Requests anderer Apps;
- Anfangspufferung und eine begrenzte native Ausgabefläche.

Mit Runtime 0.2.4 bestätigte der Benutzer den Übergang aus Spiegelung
zur Videowiedergabe und zurück. Ebenso wurde direkte YouTube-Wiedergabe
bei im Hintergrund laufender YouTube-App bestätigt.

Das ist ein wesentlicher Fortschritt, aber kein Abschluss aller HLS-
Fehler. Ein späterer Abruf-/Erholungsfehler mit nativem Absturz bleibt offen.

## CarPlay-Versuche und Rücknahme

CarPlay übernahm automatisch Bild beziehungsweise Medienwiedergabe.
Die frühe Vermutung eines bloßen Display-/WLAN-Konflikts reichte als
Erklärung nicht aus. Der Benutzer bestätigte, dass manuelles Trennen
von CarPlay im iDrive den funktionierenden AirPlay-Pfad ermöglicht.

Ein begrenzter Test mit Stopp des serienmäßigen CarPlay-Dienstes führte
zu einem automatischen MGU-Neustart und passenden Crash-Einträgen.
Dieser Eingriff wurde verworfen.

Anschließend wurde eine gerätebezogene Freigabe über die BMW-Schnittstelle
DevicePresentation implementiert und lokal geprüft. Auf ausdrücklichen
Wunsch wurde auch diese Automatik vollständig entfernt. App 0.2.6 greift
deshalb nicht automatisch in die CarPlay-Verbindung ein.

Die vorübergehende Prioritätsregel „AirPlay schlägt CarPlay“ beschreibt
**nicht** den aktuellen Betrieb. Aktuell gilt manuelles Trennen von CarPlay.

## Öffentliche Veröffentlichung und Store-Metadaten

Der AirPlay-Code wurde aus dem gemeinsamen Entwicklungsordner in ein
eigenständiges öffentliches Repository übernommen. Browser-Code,
Fahrzeugprotokolle, SSH-Material, Host-Pins und das proprietäre SDK blieben außen vor.

Die zunächst fehlende mgu-repo.json wird mit einem passenden Frontend-
Builder ergänzt. Die native Runtime bleibt separat; der Store-Eintrag
deklariert sie als Voraussetzung. Es wird kein vollständiger allgemeiner
Ein-Klick-Installationsweg behauptet.
