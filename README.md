<img src="airplay/branding/pllana-airplay-logo.png" alt="pllana.io AirPlay logo" width="140">

# BMW AirPlay by pllana.io

Ein experimenteller, nativer AirPlay-Empfänger für BMW MGU / iDrive 7 von
**[Leon Pllana IT-Solutions](https://pllana.io)**.

**Aktueller Stand:** App **0.2.6**, native Laufzeit **0.2.4**.
Dies ist der Quellcode des auf der Entwicklungs-Headunit eingesetzten Standes.
Keine allgemeine Hardwarefreigabe und kein offizielles BMW- oder Apple-Produkt.

**Der ausführliche Entwicklungsstand steht in [docs/STATUS.md](docs/STATUS.md):**
Fahrzeugbestätigungen, lokale Testergebnisse, noch offene Fehler,
zurückgenommene CarPlay-Versuche und nächste Arbeitsschritte.

**MGU Store:** GitHub-Quelle **pllanaio/bmw-airplay**, Kanal **branch:main**.
Die neue [mgu-repo.json](mgu-repo.json) und der Frontend-Builder sind vorhanden.
Die native Laufzeit 0.2.4 bleibt separat erforderlich.
[Einrichtung und Grenzen der Store-Anbindung](docs/STORE.md).

## Funktionen und bestätigter Stand

- iPhone-Bildschirmspiegelung mit Ton über die BMW-Lautsprecher.
- YouTube per direkter AirPlay-/HLS-Wiedergabe; das iPhone bleibt parallel bedienbar.
- Am Entwicklungsfahrzeug bestätigt: Spiegelung → Video → Spiegelung sowie
  direkte YouTube-Wiedergabe bei im Hintergrund laufender iPhone-App.
- Native Vollbildausgabe mit erhaltenem Seitenverhältnis und Unterstützung
  wechselnder Bildabmessungen; Fotos und Videos nutzen dieselbe Ausgabe.
- Eigene pllana.io-Oberfläche, 140×140-App-Symbol und deutsche Schriftzeichen.
- Passwortbasierte Kopplung mit einem auf der MGU angezeigten sechsstelligen Code.

## Verwendung

1. **CarPlay manuell im iDrive trennen.** Die App steuert oder unterdrückt CarPlay nicht.
2. iPhone und MGU benötigen eine gemeinsame Netzwerkverbindung. Im getesteten
   Aufbau stellt das iPhone den persönlichen Hotspot bereit; die MGU verbindet
   sich über den MGU-WiFi-Uplink damit.
3. Auf der MGU „BMW AirPlay by pllana.io“ öffnen und „Verbinden“ drücken.
4. Am iPhone denselben Empfänger unter „Bildschirmsynchronisierung“ oder direkt
   im AirPlay-Menü von YouTube auswählen und gegebenenfalls den Code eingeben.
5. „Trennen“ beendet den Empfang und gibt die eigene Audioverbindung frei.

## Bekannte Grenzen

- DRM-geschützte Streams werden nicht unterstützt; insbesondere gibt es keine
  allgemeine Netflix-, Disney+-, Prime- oder Paramount+-Wiedergabe über UxPlay.
- CarPlay kann die Medienwiedergabe übernehmen. Die automatische Unterdrückung
  aus 0.2.5 wurde in 0.2.6 vollständig entfernt.
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
