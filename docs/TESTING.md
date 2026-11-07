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
| airplay/test_frontend_lifecycle.js | UI-/Fokuswechsel erhalten die Sitzung, Stop/Schließen beenden sie |
| airplay/test_video_bridge.js | Neuer Frame-Transport, geändertes Layout und Renderer-Wiederverbindung |
| airplay/test_network.js | BMW-WLAN ohne Startadresse, wlan1, eigene Regeln nach Uplink-Neuaufbau, keine Änderung fremder Regeln und Monitor-Lebenszyklus |
| airplay/test_resolver.js | Kein Uplink, Hotspot-Verlust, USB-/WLAN-DNS-Wechsel und Erhalt der privaten Resolver-Inode |
| airplay/test_logo_bridge.js | Native Logo-Nachrichten, Alpha-Behandlung und Wiederverwendung |

Das sind Verhaltensprüfungen mit gezielten Ersatzschnittstellen. Sie
führen weder echte BMW-Audiomanager-Aufrufe noch einen iPhone-Handshake aus.

## Gebautes Frontend

Nach dem Workstation-Build:

~~~sh
node airplay/test_presentation.js
~~~

Geprüft werden die tatsächliche private SDK-Kopie, 1920×720-Präsentation,
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
- Anfangspufferung und ausdrückliche Pause;
- mehrfaches Zerstören und spätere Playback-Info-Anfragen;
- getrennte alte/neue lokale Playlist-Routen;
- direkte textbasierte und binäre Play-Requests;
- Erhalt des YouTube-FCUP-Pfades;
- Ablehnen nicht unterstützter direkter Medien-URLs;
- native Erkennung Spiegelung → HLS, Ignorieren von Telefon-Pause/Stop/HLS-TEARDOWN,
  Erhalt der Playlist bei playlistRemove und Rückkehr über Ende/„Zur Spiegelung“.

test_video_sink.c deckt I420-Transport und Layout-/Stride-Fragen ab.
Die zugehörigen Format-/Orientierungsprüfungen verwenden synthetische Frames.
Sie beweisen nicht die Kompatibilität jedes iPhone-Rotationsablaufs.

### HTTP-/HTTPS-HLS

test_hls.py erzeugt lokal H.264/AAC-Testmaterial und kann getrennte
Video-/Audio-fMP4-Playlists bereitstellen. Es prüft die private Laufzeit:

- tatsächliche Verwendung des alten hlsdemux statt hlsdemux2;
- I420-Frames mit 1280×720;
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
