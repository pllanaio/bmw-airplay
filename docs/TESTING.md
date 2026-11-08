# Tests und Aussagekraft

## Drei getrennte Nachweise

1. **Quell-/Paketprüfung:** Eine erwartete Datei, Berechtigung oder
   Manifest-Abhängigkeit ist vorhanden beziehungsweise entfernt.
2. **Lokaler Verhaltenstest:** Ein konkreter Protokoll-, Renderer- oder
   Lebenszykluspfad funktioniert mit einer kontrollierten Quelle.
3. **Fahrzeugbestätigung:** Der Inhalt war auf der MGU sichtbar/hörbar
   beziehungsweise ein konkreter Bedienablauf wurde dort bestätigt.

Diese Ebenen werden nicht gegeneinander ausgetauscht. Ein bestandener
synthetischer HLS-Test ist zum Beispiel keine Netflix- oder ARD-Freigabe.

## Node-Tests ohne Fahrzeug

~~~sh
npm test
~~~

Alternativ die folgenden Dateien einzeln mit Node ausführen:

| Test | Relevanter Nachweis |
| --- | --- |
| airplay/test_audio_route.js | Eigentum am Audiopfad, Wiederherstellung, fremde Quellen erhalten, keine Lautstärkeänderung |
| airplay/test_backend.js | Empfängerstart trotz belegtem Audio, erneute Audioanforderung, Fokusverlust ohne Netzwerkende, ausdrückliches Stoppen |
| airplay/test_receiver.js | Node-8-Startverhalten, stabiler Gerätename/-kennung, Passwortmodus, Modus-/Rückkehrzustände, begrenzte Absturzdiagnose |
| airplay/test_frontend_lifecycle.js | Automatische Musik-/Videoansicht; UI-/Fokuswechsel erhalten die Sitzung, Stop/Schließen warten auf Bestätigung und bleiben bei Fehler bedienbar |
| airplay/test_receiver_disconnect.js | Tatsächliche Prozessgruppen mit TCP-Verbindung, TERM/KILL, beendeten Gruppenleitern und offenen/verwaisten Unterprozessen |
| airplay/test_video_bridge.js | Neuer Frame-Transport, geändertes Layout und Renderer-Wiederverbindung |
| airplay/test_backend_client.js | Profilwahl, getrenntes Videoende/Trennen und Ende der Oberfläche ohne impliziten Stop |
| airplay/test_network.js | BMW-WLAN ohne Startadresse, wlan1, eigene Regeln nach Uplink-Neuaufbau, keine Änderung fremder Regeln und Monitor-Lebenszyklus |
| airplay/test_resolver.js | Kein Uplink, Hotspot-Verlust, USB-/WLAN-DNS-Wechsel und Erhalt der privaten Resolver-Inode |
| airplay/test_logo_bridge.js | Native Logo-Nachrichten, Alpha-Behandlung und Wiederverwendung |
| airplay/test_audio_metadata.js | Begrenzte DMAP-Zustände, privater JPEG-/PNG-Export, asynchroner Decoder, veraltete Jobs und Aufräumen |
| airplay/test_music_artwork_bridge.js | Begrenztes privates RGBA, native Alpha-Behandlung, Wiederverbindung und Entfernen alter Cover |
| airplay/test_music_view.js | Titelansicht und fünf Touch-/iDrive-Ziele nur bei bestätigten Senderfähigkeiten |
| airplay/test_music_controls.js | Echte HTTP-DACP-Anfragen, Statusabfragen, begrenzte Befehle, Authentifizierung und veraltete Sitzungen |

Das sind Verhaltensprüfungen mit gezielten Ersatzschnittstellen. Sie
führen weder echte BMW-Audiomanager-Aufrufe noch einen iPhone-Handshake aus.

## Gebautes Frontend

Nach dem Workstation-Build:

~~~sh
node airplay/test_presentation.js
~~~

Geprüft werden die tatsächliche private SDK-Kopie, 1920×504-/1920×720-Präsentation,
Rückkehr der Bedienelemente und vorhandene deutsche Glyphen.

## Native Tests

~~~sh
sh airplay/tools/test_lifecycle.sh
python3 airplay/tools/test_hls.py --split --legacy
~~~

Der Lebenszyklustest kompiliert gegen die tatsächlich gepatchten nativen
Quelldateien unter .build/airplay/uxplay-source. Ein reiner Ersatz der
Implementierung würde die gefundenen Pointer-/Thread-Rennen nicht abdecken.

Die Prüfungen umfassen:

- Spiegelungspakete während zwölf aufeinanderfolgender Mirror-/HLS-Neuaufbauten;
- hundert Audio-Stop/Start-Zyklen bei gleichzeitig eintreffenden Paketen;
- Abweisen verspäteter Audio-Bus-Ereignisse nach dem Stop;
- Audio-Start-Sperre während der HLS-Übernahme;
- tatsächliche ALAC-Dekodierung vor und nach Audio-Stop/Neustart;
- nativer DMAP-/Artwork-Export und echte private JPEG-/PNG-Dekodierung zu 256×256 RGBA;
- automatische Musik-/Spiegelungs-/HLS-Übergänge ohne Empfänger-Neustart,
  mit Schutz vor altem Spiegelungston und alter Videodarstellung;
- Beenden tatsächlicher TCP-/PTTH-Verbindungen bei voller Abschaltung,
  einschließlich unvollständig gesendeter Anfragen;
- Anfangspufferung und ausdrückliche Pause;
- mehrfaches Zerstören und spätere Playback-Info-Anfragen;
- getrennte alte/neue lokale Playlist-Routen;
- direkte textbasierte und binäre Play-Requests;
- Erhalt des YouTube-FCUP-Pfades;
- Ablehnen nicht unterstützter direkter Medien-URLs;
- native Erkennung beider Video-Ursprünge, Beachten von Telefon-Pause/Stop/Medien-TEARDOWN,
  Abbruch bereits während FCUP-Laden, Erhalt laufender Videos bei reiner
  Spiegelungsbereinigung und korrekte Rückkehr über Ende/„Zur Spiegelung“;
- drei aufeinanderfolgende Titel über den tatsächlichen AirPlay-HTTP-Server,
  `playlistInsert` und erhaltene Steuer-/Rückkanalverbindungen;
- fragmentierte ACK-Header und ACK-Body ohne vorzeitiges Senden des nächsten
  Ereignisses; weiter bedienbare Steuerverbindung während unvollständiger ACKs;
- Endposition, Reihenfolge der Ende-Ereignisse, Wiederholung desselben Titels,
  Abbruch, Wiederverbindung und Ablauf einer ausstehenden Bestätigung;
- nicht blockierender 503-/Retry-Pfad bei gleichzeitigem Renderer-Reset,
  weiter bedienbare lokale HLS-GETs und Wiederholung auf derselben Verbindung.

test_video_sink.c deckt I420-Transport und Layout-/Stride-Fragen ab.
Die zugehörigen Format-/Orientierungsprüfungen verwenden synthetische Frames.
Sie beweisen nicht die Kompatibilität jedes iPhone-Rotationsablaufs.

### HTTP-/HTTPS-HLS

test_hls.py erzeugt lokal H.264/AAC-Testmaterial und kann getrennte
Video-/Audio-fMP4-Playlists bereitstellen. Es prüft die private Laufzeit:

- tatsächliche Verwendung des alten hlsdemux statt hlsdemux2;
- I420-Frames mit 1920×504;
- Audio mit acht Kanälen, 48 kHz und S16LE;
- Ende der Wiedergabe und Aufräumen;
- Ablehnen eines nicht vertrauten HTTPS-Zertifikats;
- Akzeptieren derselben Testquelle, nachdem deren Testzertifikat ausdrücklich
  als vertrauenswürdig hinterlegt wurde.

Diese Prüfung deaktiviert die TLS-Verifikation nicht.

## Store-Build

Der tatsächliche lokale Discovery-/Build-Test ist in [STORE.md](STORE.md)
beschrieben. Die kleinen zusätzlichen Vertragsprüfungen laufen ohne SDK:

~~~sh
python3 -m unittest discover -s test -p 'test_*.py'
~~~

Sie prüfen unter anderem manipulierte Kit-Eingaben und problematische
Archivpfade. Ein vollständiger Store-Build braucht weiterhin einen lokalen
SDK-Donor und das festgelegte öffentliche Kit.

## Aktuelle Fahrzeug-Testmatrix

| Ablauf | Stand |
| --- | --- |
| Spiegelung, Fotos-App-Videoton, manuelles Trennen | Bestätigt |
| Spiegelung → YouTube-Video → Spiegelung | Mit nativer Laufzeit 0.2.4 bestätigt |
| Direkter YouTube-Start und iPhone-App im Hintergrund | Bestätigt |
| Manuelles Trennen von CarPlay vor AirPlay | Bestätigter Arbeitsablauf |
| Aktuelle CarPlay-Automatik | Entfernt, keine Qualifikation vorgesehen |
| YouTube → ARD → YouTube | Erneute explizite Bestätigung offen |
| Früher problematische breite Videos | Erneute Qualifikation offen |
| Fotos im Vollbild und systematische Rotation | Ausgabe implementiert, abschließende Testserie offen |
| Viele Stunden / viele Video-Wechsel / Kaltstart | Offen |
| Erholung von echten Downloadfehlern ohne nativen Absturz | Bekannter offener Fehler |
| Neue Store-Installation auf realer MGU | Offen |
| 0.4.3: YouTube-Playlist mit mehreren Titeln automatisch fortsetzen | Drei Titel mit synthetischem Sender lokal geprüft, Fahrzeugabnahme offen |
| 0.4.3: BMW-WLAN ohne iPhone-Hotspot, YouTube mit iPhone-Mobilfunk als Spiegelung | Lokale Startoptionen geprüft, Fahrzeugtest offen |
| 0.4.3: Spiegelung → HLS, dann App-Wechsel/Sperren, mit eigenem MGU-Uplink | Native Regressionstests vorhanden, Fahrzeugtest offen |

## Testregeln für weitere Entwicklung

- Native Runtime-Bibliotheken während eines laufenden Tests nicht überschreiben.
- Versionen, genaue Quelle, Modus und Ausgangszustand zu jedem Ergebnis notieren.
- Beim Fehler unterscheiden: Entdeckung, Authentifizierung, Renderer,
  Audiopfad, Internet/DNS, TLS, Playlist, Decoder oder Prozessende.
- Keine Fahrzeuglautstärke in gewöhnlichen Wiedergabetests automatisch verändern.
- Den serienmäßigen CarPlay-Dienst nicht als Testschalter stoppen.
- Rohprotokolle, vollständige URLs mit Tokens, Pairing-Daten und
  Fahrzeugidentifikatoren nicht in öffentliche Testberichte übernehmen.

## Zusätzliche Prüfungen für 0.4.6

`test_lifecycle.sh` führt auch `test_audio_mode.cpp` (native Audiofähigkeiten,
Flush/Teardown und kein Videopfad) sowie `test_audio_decode.py` aus. Letzterer
erzeugt mit FFmpeg einen lokalen ALAC-Frame und prüft echte dekodierte
PCM-Ausgabe vor und nach Audio-Stop/Neustart.

`test_auto_media.cpp` prüft die tatsächlichen gemischten Audio-/Video-
Callbacks. `test_httpd_shutdown.c` hält einen Verbindungsdestruktor an,
während alle Peer-Sockets bereits geschlossen sein müssen.
`test_shutdown.cpp` startet die tatsächliche native Hauptschleife mit
RAOP-/PTTH-/unvollständigen TCP-Verbindungen und echten RTP-UDP-Sockets;
SIGTERM/SIGINT/SIGHUP müssen den Empfänger ohne Neustart beenden und die
Ports freigeben.

`test_audio_handoff.py` erzeugt echte HLS- und ALAC-Fixtures. Ein laufendes,
tatsächlich dekodiertes Video wird durch einen geparsten RAOP-SETUP-96-
Request abgelöst; verschlüsselte UDP-RTP-Pakete werden bis zur PCM-Ausgabe
dekodiert. Derselbe Kontroll-/RTP-Transport, ein anderer ausgewählter
Transport, noch ladende Videos, alte Flush-/Metadatenpakete und die
anschließende Rückkehr zu Video gehören zum Test. Ein manueller Wechsel
der HLS-Ownership-Variablen oder ein nur pausierter Preroll genügt nicht.

`test_connection_status.c` prüft tatsächliche akzeptierte SETUP-/Play-
Sitzungen, Pause/Teardown, gebundene Rückkanäle und abschließendes
Disconnect. Pairing-/OPTIONS-Probes, fremde Peer-/UUID-Kombinationen und
lokale HLS-GETs dürfen keinen verbundenen iPhone-Status erzeugen.

`python3 airplay/tools/test_hls.py --stretch` prüft tatsächliche dekodierte
an die Zielgröße angepasste Pixel für 16:9, 21:9, 16:10, Hochformat, ein breiteres Format und
80:21. Vier unterschiedlich markierte Bildecken und ein asymmetrischer
Farbverlauf müssen nach dem Dehnen/Stauchen erhalten bleiben. Die
Bridge-Tests verbieten vergrößerte oder abgeschnittene Zielrechtecke.
Die Referenz ist ein synthetisches Quellbild; künstliche Balken sind nicht erlaubt.

`python3 airplay/tools/test_video_composite.py --store-root .store`
prüft anschließend die tatsächliche vollständige Bildausgabe: echte
HLS-Frames werden über VideoBridge und den unveränderten festgelegten
mgu-render bis in dessen EGL-Framebuffer gerendert. Für 1920×720,
1920×504 und 1600×520 werden alle Pixel auf zusätzliche leere Ränder
sowie neun markierte Quellpunkte geprüft. 1600×560 als randlose Bedienfläche
und Live-Größenwechsel in beide
Richtungen gehören dazu. Eine 1920×504-Ausgabe in einem 1920×720-Viewport
erzeugte im reproduzierten Vorher-Zustand exakt 108 leere Pixel oben und unten.
Die CI verwendet dafür den VideoBridge-Code aus dem extrahierten App-Paket.

Die Paket-Präsentationsprüfung prüft außerdem die private Display-Kopie:
keine linke/obere BMW-Chrome-Fläche, vollständiger Body, erhaltene untere
Bedienung und passende Touch-/iDrive-Koordinaten.

Die iPhone-/Fahrzeugmatrix für Stop, beide Videomodi, reines Audio und die
neue Bildfüllung steht in [MEDIA_MODES.md](MEDIA_MODES.md).
