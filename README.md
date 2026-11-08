<img src="airplay/branding/pllana-airplay-logo.png" alt="pllana.io AirPlay logo" width="140">

# PllanaCast for BMW

Ein experimenteller, nativer AirPlay-Empfänger für BMW MGU / iDrive 7 von
**[Leon Pllana IT-Solutions](https://pllana.io)**.

**Quellstand:** App und native Laufzeit **0.4.7**.
Die Änderungen in 0.4.7 sind lokal geprüft; die Fahrzeugabnahme steht aus.
Keine allgemeine Hardwarefreigabe und kein offizielles BMW- oder Apple-Produkt.

**Lizenz:** [GPL-3.0-or-later](LICENSE.md), entsprechend Roberts mgu-store.

**Der ausführliche Entwicklungsstand steht in [docs/STATUS.md](docs/STATUS.md):**
Fahrzeugbestätigungen, lokale Testergebnisse, noch offene Fehler,
zurückgenommene CarPlay-Versuche und nächste Arbeitsschritte.

**MGU Store:** GitHub-Quelle **pllanaio/bmw-airplay**, Kanal **Releases**.
Der Store-Katalog liefert App und Empfänger als getrennte Pakete.
App und native Laufzeit müssen gemeinsam aktualisiert werden.
[Einrichtung und Grenzen der Store-Anbindung](docs/STORE.md).

## Funktionen und bestätigter Stand

- iPhone-Bildschirmspiegelung mit Ton über die BMW-Lautsprecher.
- **Android** (ab 0.5.0): Videos, Musik und Fotos per „Streamen auf“ (DLNA/UPnP),
  z. B. aus Samsung Galerie, BubbleUPnP, Web Video Caster oder VLC; siehe [docs/ANDROID.md](docs/ANDROID.md).
- **PllanaCast for BMW** (ab 0.6.0): eigene Android-App überträgt den ganzen Bildschirm mit Ton,
  auch vom Pixel; APK im Release, Quellcode in `android/`.
- YouTube per direkter AirPlay-/HLS-Wiedergabe; das iPhone bleibt parallel bedienbar.
- Am Entwicklungsfahrzeug bestätigt: Spiegelung → Video → Spiegelung sowie
  direkte YouTube-Wiedergabe bei im Hintergrund laufender iPhone-App.
- Vollständige Videos ohne Beschnitt auf der tatsächlichen Displayfläche;
  Bildschirmspiegelung behält ihr Seitenverhältnis.
- Übergabepfad für YouTube-Playlists: Ende-Meldung an das iPhone und Erhalt
  der Sitzung für den nächsten Titel; Fahrzeugabnahme steht aus.
  [Verwendung und Testmatrix](docs/PLAYLISTS.md).
- Eigene pllana.io-Oberfläche, 140×140-App-Symbol und deutsche Schriftzeichen.
- Passwortbasierte Kopplung mit einem auf der MGU angezeigten sechsstelligen Code.

## Automatische Wiedergabe ab 0.4.5

Einmal „Verbinden“ drücken. Der Empfänger erkennt anhand des empfangenen
AirPlay-Transports, ob Musik, Bildschirmspiegelung oder ein Video ankommt,
und wechselt die Anzeige ohne Neustart der Verbindung. Eine manuelle
Auswahl von „Nur Audio“ ist nicht mehr nötig.

- **Spiegelung → Video:** Video im Hintergrund weitergeben; bewusstes
  Beenden führt zur vorhandenen Bildschirmspiegelung zurück.
- **Direktes YouTube-AirPlay:** Video im Hintergrund weitergeben; nach
  Beenden auf den nächsten Titel warten, ohne eine Spiegelung zu starten.
- **Musik:** AirPlay-Audio über BMW-Lautsprecher, auch mit geschlossener
  Oberfläche. Cover, Titel, Interpret und Album sowie Play/Pause, vor/zurück,
  Shuffle und Repeat, soweit der gekoppelte Sender die Funktionen bereitstellt.
  Der Musikempfang wird automatisch erkannt; Videoton schaltet die
  Anzeige nicht versehentlich auf die Musikansicht.

„Video beenden“ beendet nur den Medieninhalt. „Trennen“ beendet die gesamte
AirPlay-Sitzung und wird erst nach beendetem Empfänger samt Audiofreigabe
bestätigt. „Schließen“ wartet auf dieselbe Bestätigung; bei einem Fehler
bleibt die Oberfläche für einen erneuten Versuch geöffnet.
Die Sendersteuerung bleibt wirksam. [Bedienung, Protokollgrenzen und Tests](docs/MEDIA_MODES.md).

Videos werden vollständig auf die **tatsächlich genutzte Videofläche**
gedehnt beziehungsweise gestaucht, etwa 1920 × 720 im Vollbild oder
1920 × 504 auf einer entsprechend hohen Fläche. Der Empfänger schneidet
keine Bildinhalte ab und vermeidet zusätzliche Ränder durch eine erneut
seitenverhältnistreue Renderer-Anpassung. Das Seitenverhältnis kann sich
dabei ändern. Für die
Bildschirmspiegelung bleibt der ganze iPhone-Bildschirm sichtbar.

Der Hauptbildschirm zeigt „Mit iPhone verbunden“, sobald eine tatsächliche
AirPlay-Sitzung besteht. Der Kopplungscode wird dann ausgeblendet.
„Empfang bereit“ bezeichnet einen gestarteten Empfänger ohne verbundene Sitzung.
Der linke BMW-Rahmen und die obere Titel-/Statusleiste werden in der
App-Darstellung verdeckt; die unteren Bedientasten bleiben erreichbar.

## Verwendung

1. HeadUnit über MGU-Uplink mit dem **persönlichen iPhone-Hotspot** verbinden.
   Eine zusätzliche Verbindung des iPhones zum BMW-WLAN ist dabei nicht nötig.
   Alternativ funktioniert das bisherige BMW-WLAN mit separatem Uplink weiter.
   Ohne Uplink bleibt lokale Spiegelung möglich; direkte HLS-Videos benötigen
   Internet an der HeadUnit. [Aufbau und Testgrenzen](docs/NETWORK.md).
2. Eine parallele CarPlay-Sitzung wird von der App nicht beendet. Automatische
   Fokusübergabe und nahtloses Umschalten mit CarPlay sind noch offen. Falls
   CarPlay die Wiedergabe übernimmt, muss es vorerst im iDrive getrennt werden.
3. Auf der MGU „PllanaCast for BMW“ öffnen und „Verbinden“ drücken.
4. Am iPhone denselben Empfänger unter „Bildschirmsynchronisierung“ oder direkt
   im AirPlay-Menü von YouTube auswählen und gegebenenfalls den Code eingeben.
5. Ein aus der Spiegelung gestartetes AirPlay-Video läuft im eigenen Medienpfad.
   Stoppen bleibt am iPhone und über „Video beenden“ möglich. Danach geht es
   zur vorhandenen Spiegelung zurück. Ein direkt gestartetes Video kehrt zum
   Warten auf den nächsten Titel zurück; YouTube kann auch Playlist-Titel übergeben. Dies setzt einen
   tatsächlichen AirPlay-Videostream und Internet für dessen Abruf voraus.
6. „Trennen“ beendet den Empfang und gibt die eigene Audioverbindung frei.

## Bekannte Grenzen

- DRM-geschützte Streams werden nicht unterstützt; insbesondere gibt es keine
  allgemeine Netflix-, Disney+-, Prime- oder Paramount+-Wiedergabe über UxPlay.
- CarPlay kann die Medienwiedergabe übernehmen. Für sichere Fokusübergabe,
  Lenkradtasten und Titel im Tacho fehlt noch der bestätigte BMW-Vertrag.
  Die reine Schnittstellendiagnose stellt diese Funktionen nicht bereit.
  [Benötigte Schnittstellen](docs/BMW_MEDIA_CONTRACT.md).
- Ein fehlgeschlagener Medienabruf kann noch einen nativen Empfängerabsturz
  auslösen. Dieser Fehler ist offen; die Diagnose erfasst begrenzte Absturzadressen.
- App-Wechsel etwa zwischen YouTube und ARD sowie besonders breite Videos
  benötigen weitere Fahrzeugtests.
- Ausgabe auf andere MGU-Versionen und die genaue Lautsprecherzuordnung sind
  noch nicht allgemein qualifiziert.

## Entwicklung

- [Ausführlicher aktueller Stand](docs/STATUS.md)
- [MGU-Store-Anbindung](docs/STORE.md)
- [Build und Installation](docs/BUILD.md)
- [Architektur und Protokollpfade](docs/ARCHITECTURE.md)
- [Tests und Aussagekraft](docs/TESTING.md)
- [Fehlerdiagnose](docs/TROUBLESHOOTING.md)
- [Versionsgeschichte und Entscheidungen](docs/HISTORY.md)
- [Kompakte Implementierungsübersicht](docs/IMPLEMENTATION.md)
- [Drittanbieter und Lizenzhinweise](THIRD_PARTY_NOTICES.md)
- [Lizenzstatus](LICENSE.md)

Die App benötigt das externe SDK aus
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps),
[MGU-Store-Werkzeuge](https://github.com/robertnisipeanu/mgu-store) und einen
vorbereiteten Zugriff auf die eigene Headunit. BMW-Firmware, das proprietäre
OAP-SDK, Zugangsdaten und Fahrzeugprotokolle sind nicht Bestandteil dieses Repositories.
