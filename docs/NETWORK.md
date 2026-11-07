# AirPlay im BMW-WLAN ohne persönlichen Hotspot

Die Verbindung zum iPhone und der Internetzugang des Empfängers sind zwei
getrennte Wege. Ein MGU-Uplink ist ein Internet-Client, kein zusätzlicher
AirPlay-Funkstandard und keine automatische Freigabe des iPhone-Mobilfunks.

| Nutzung | iPhone im BMW-WLAN | Internet an der MGU |
| --- | --- | --- |
| Bildschirmspiegelung, lokale Fotos/Videos | Ja | Nicht erforderlich |
| YouTube wird auf dem iPhone geladen und als Bildschirm gespiegelt | Ja | Nicht erforderlich; iOS muss Mobilfunk für das Laden verwenden können |
| YouTube als direkter AirPlay-/HLS-Videostream | Ja | Erforderlich |
| Spiegelung → AirPlay-/HLS-Video, iPhone danach frei bedienbar | Ja | Erforderlich |

## Einrichtung

1. CarPlay wie bisher im iDrive manuell trennen.
2. Den vorhandenen BMW-WLAN-Zugang einschalten und das iPhone mit dessen
   SSID verbinden. Der persönliche iPhone-Hotspot kann ausgeschaltet bleiben.
   Die App richtet keinen eigenen Access Point ein.
3. BMW AirPlay öffnen, „Verbinden“ wählen und den Empfänger am iPhone unter
   „Bildschirmsynchronisierung“ auswählen. Die Passwortkopplung bleibt erhalten.
4. Für direkten YouTube-/HLS-Empfang benötigt die MGU einen online befindlichen
   MGU-Uplink, etwa einen LTE-Router über USB-Ethernet, einen unterstützten
   LTE-Stick oder ein anderes WLAN mit Internet. Das iPhone kann dabei im
   BMW-WLAN bleiben. Der Store vergibt den Internetzugang an die App über
   `mguInternet`; DNS wird nur im privaten Empfangsdienst aktualisiert.

Ohne solchen Internetzugang kann das iPhone YouTube über seine eigene
Mobilfunkverbindung laden und den Bildschirm spiegeln. Sobald YouTube aber in
den direkten AirPlay-/HLS-Modus wechselt, lädt die MGU die Mediensegmente selbst.
Die Mobilfunkverbindung des iPhones wird dabei **nicht** durch das BMW-WLAN
geteilt. Das freie Benutzen des iPhones bei unabhängig weiterlaufendem Video
ist für diesen Aufbau ohne MGU-Internet nicht zugesagt.

UxPlay bezieht YouTube-Playlists teilweise über das iPhone (FCUP), lädt die
Videofragmente im aktuellen Protokollpfad jedoch vom CDN. Ein allgemeiner
FCUP-Medienproxy ist nicht implementiert und ohne iPhone-Prüfung keine
belastbare Alternative. Auch der Zugriff auf BMW-internen Mobilfunk ist nicht
Bestandteil des MGU-Uplinks.

Ohne gültige Uplink-Lease lässt die App beim „Verbinden“ die HLS-Fähigkeit
weg. So bleibt YouTube bei der Bildschirmspiegelung und übergibt keine für
die MGU unerreichbaren Video-URLs. YouTube dafür nach **Kontrollzentrum →
Bildschirmsynchronisierung** öffnen; der AirPlay-Knopf in YouTube liefert in
diesem Modus nur Audio. Die Oberfläche zeigt den Spiegelungsmodus an.

Nach dem Zuschalten eines Uplinks einmal „Trennen“ und „Verbinden“ wählen,
um direkten Videoempfang freizuschalten. Eine aktive Sitzung wird durch
eine neue Lease nicht automatisch neu gestartet. Eine Lease ist ein Hinweis
auf die konfigurierte Verbindung, kein Nachweis, dass ein konkretes CDN
oder die Internetverbindung erreichbar ist.

## Netzwerkverhalten der App

- Lokaler Empfang wird nicht an eine vorhandene Uplink-Lease gebunden.
- Begrenzte Firewallregeln erlauben TCP/UDP 7100–7102 aus privaten bzw.
  Link-Local-Netzen auf `wlan_bridge`, `wlan0` und `wlan1`.
- Die Regeln sind auch bei Dienststart ohne WLAN-Adresse vorhanden. Ein
  regelmäßiger Abgleich repariert eigene Regeln nach Uplink-Tabellenwechseln.
- Die Regeln öffnen keine USB-Eingangsverbindung, richten kein Forwarding
  oder NAT ein und ersetzen keine BMW-Default-Route.
- Internet-DNS folgt der jeweils gültigen Uplink-Lease, unabhängig davon,
  über welches lokale WLAN das iPhone sendet. Fehlende Lease entfernt die
  alten DNS-Server; die BMW-Systemkonfiguration bleibt unverändert.
- Die Erkennung benutzt weiterhin BMWs vorhandenen mDNS-Dienst. Auf einem
  gemeinsamen externen WLAN über das vom Uplink bewachte `wlan1` sind dessen
  mDNS-Firewall-/Routingbedingungen gesondert zu prüfen. Die AirPlay-Portregeln
  allein garantieren dort keine Erkennung. Der BMW-WLAN-Pfad vermeidet diese
  Abhängigkeit vom Uplink-Interface für die lokale Verbindung.

## Abnahme am Fahrzeug

Die neuen Abläufe sind noch nicht auf der MGU bestätigt. Prüfen:

1. Persönlichen Hotspot und MGU-Uplink ausschalten; iPhone im BMW-WLAN:
   Erkennung, Kopplung, Spiegelung und Ton müssen lokal funktionieren.
2. Unabhängigen Internet-Uplink zuschalten, „Trennen“ und „Verbinden“ wählen:
   YouTube direkt starten und das
   iPhone in einer anderen App benutzen. Bild und Ton müssen weiterlaufen.
3. Aus der Spiegelung ein AirPlay-Video starten, Wiedergabebeginn abwarten,
   dann am iPhone die App wechseln bzw. das Gerät sperren. Anschließend
   „Zur Spiegelung“, natürliches Videoende und „Trennen“ prüfen.
4. Uplink bei weiter bestehendem BMW-WLAN wechseln oder neu verbinden.
   Lokaler Empfang muss weiter erreichbar bleiben; neue Videoabrufe müssen
   die neue Internetverbindung und deren DNS nutzen. Ein laufender externer
   Download ist bei einem Verbindungswechsel nicht unterbrechungsfrei zugesagt.

## Protokollquellen

- [UxPlay am festgelegten Commit](https://github.com/FDH2/UxPlay/blob/df67c212a433cf6dda3676dd40c097900d24e645/README.md):
  `-hls` lädt YouTube-Videos direkt auf den Empfänger; ohne diese Option
  wird YouTube-Video über Bildschirmspiegelung übertragen.
- [UxPlay #596](https://github.com/FDH2/UxPlay/issues/596): automatischer
  Wechsel zu HLS bei Spiegelung und der Fallback ohne `-hls`.
- [MGU-Uplink](https://github.com/robertnisipeanu/mgu-store/tree/main/native/mgu-uplink):
  Internetquellen, UID-Routing, Lease-Datei und Firewall.
