# AirPlay über den MGU-Uplink und den iPhone-Hotspot

Die HeadUnit kann den persönlichen Hotspot des iPhones sowohl für Internet
als auch für die lokale AirPlay-Verbindung nutzen. Das iPhone muss dafür
nicht zusätzlich mit dem BMW-WLAN verbunden sein. MGU-Uplink verbindet die
HeadUnit als WLAN-Client mit dem Hotspot; die AirPlay-App verwendet denselben
Weg. Der Hotspot-Betrieb des iPhones und die Erkennung des Empfängers sind
noch mit dem konkreten iPhone/iOS-Stand am Fahrzeug zu prüfen.

## Einrichtung über den persönlichen Hotspot

1. Den persönlichen Hotspot am iPhone aktivieren. Falls er nicht gefunden
   wird, „Kompatibilität maximieren“ einschalten.
2. Im MGU Store den WLAN-Uplink mit diesem Hotspot verbinden. Der Uplink
   muss eine gültige Adresse und DNS-Server erhalten.
3. App und „PllanaCast for BMW Empfänger“ gemeinsam auf 0.4.7 aktualisieren. In der App
   „Verbinden“ drücken und den Empfänger am iPhone unter AirPlay bzw.
   „Bildschirmsynchronisierung“ auswählen.
4. Ein direkt gestartetes YouTube-/HLS-Video lädt die HeadUnit über den
   freigegebenen Uplink. Das iPhone kann währenddessen anderweitig benutzt
   werden, sofern YouTube einen eigenständigen Videostream übergibt.

Ein Hotspot, der Verkehr zwischen seinem eigenen iPhone und WLAN-Clients
unterbindet, verhindert auch diesen Aufbau. Die App ersetzt keine
Funkverbindung und richtet keinen zusätzlichen Access Point ein.

## Alternativ: vorhandenes BMW-WLAN

Das iPhone kann weiterhin im BMW-WLAN senden. Für Bildschirmspiegelung,
lokale Fotos/Videos und Musik ist kein Internet an der HeadUnit nötig.
YouTube kann dabei Mobilfunk am iPhone nutzen und den Bildschirm spiegeln.
Ein direkter AirPlay-/HLS-Videostream benötigt dagegen Internet an der
HeadUnit, etwa einen getrennten WLAN-Uplink oder einen unterstützten
USB-/LTE-Uplink.

| Aufbau | Zusätzliche BMW-WLAN-Verbindung am iPhone | Internet für direkte HLS-Videos |
| --- | --- | --- |
| iPhone-Hotspot → WLAN-Uplink der HeadUnit | Nicht erforderlich | Über denselben Uplink |
| iPhone → BMW-WLAN, separater Internet-Uplink | Erforderlich | Über den separaten Uplink |
| iPhone → BMW-WLAN, kein Internet-Uplink | Erforderlich | Nur Spiegelung; kein direkter HLS-Abruf |

Ohne gültige Uplink-Lease bewirbt die App beim Verbindungsstart kein HLS.
YouTube dafür nach **Kontrollzentrum → Bildschirmsynchronisierung** öffnen;
der direkte AirPlay-Knopf in YouTube liefert in diesem Modus nur Audio.
Nach dem Zuschalten eines Uplinks einmal „Trennen“ und „Verbinden“ wählen.
Eine Lease ist kein Nachweis für die Erreichbarkeit eines konkreten CDN.

UxPlay bezieht Playlists teilweise über das iPhone (FCUP), lädt die
Videofragmente jedoch vom CDN. Ein allgemeiner FCUP-Medienproxy und ein
Zugriff auf BMW-internen Mobilfunk sind nicht implementiert.

## Erkennung und Routing ab 0.4.7

- Die App hat bereits die Store-Freigabe `mguInternet`. Internetverkehr und
  privates DNS folgen MGU-Uplink; BMWs Default-Route und System-DNS bleiben
  unverändert.
- TCP/UDP 7100–7102 bleiben auf den lokalen WLAN-Schnittstellen
  `wlan_bridge`, `wlan0` und `wlan1` für AirPlay erreichbar.
- Für eine tatsächlich aktive private WLAN-Uplink-Lease ergänzt die App
  Bonjour/mDNS auf UDP 5353. Die Freigabe ist auf deren Schnittstelle und
  Subnetz sowie die nachgewiesenen Sockets des vorhandenen BMW-mDNS-Dienstes
  begrenzt. Es startet kein zweiter mDNS-Dienst. Der gemeinsame Dienst kann
  dabei auch andere bereits registrierte Bonjour-Dienste ankündigen; die
  Firewall unterscheidet keine DNS-SD-Diensttypen.
- Eine eigene IPv4-Regel mit Priorität 1099 führt Antworten dieses Dienstes
  an genau dieses lokale Subnetz über Uplink-Tabelle 110. Die Regel gibt
  dem BMW-Dienst keinen allgemeinen Internetzugang. Das setzt die normale
  Uplink-Tabelle 110 voraus; eine benutzerdefinierte Uplink-Routingtabelle
  ist noch nicht unterstützt. Überschneidende lokale
  Subnetze und fremde Regeln an dieser Priorität werden nicht überschrieben.
- Der Root-Supervisor gleicht eigene Regeln nach Lease-/Firewallwechseln
  ab und entfernt sie beim Stoppen. Nur protokollierte eigene Routingregeln
  werden entfernt. Es gibt kein zusätzliches NAT oder Forwarding.
- USB-Uplinks erhalten keine neue AirPlay-Eingangsfreigabe. Bei fehlender
  WLAN-Lease bleibt der bisherige lokale BMW-WLAN-Pfad verfügbar.

## Paralleles CarPlay

CarPlay-Fokus und AirPlay-Netzwerk sind getrennte Aufgaben. Die App stoppt,
startet oder blockiert den BMW-CarPlay-Dienst nicht. Ein automatischer
Wechsel der BMW-Anzeige und Audio-Priorität ist noch nicht implementiert;
dafür fehlt hier der bestätigte BMW-Schnittstellenvertrag.

Kabelloses CarPlay und WLAN-Uplink teilen sich je nach HeadUnit Funkgeräte.
MGU-Uplink überlässt eine von BMW beanspruchte Schnittstelle wieder BMW.
Daher ist die gleichzeitige Verfügbarkeit von iPhone-Hotspot, kabellosem
CarPlay und AirPlay am konkreten Aufbau zu prüfen. Bei USB-CarPlay darf ein
USB-Tethering-Uplink das iPhone nicht aus der CarPlay-Verbindung übernehmen;
MGU-Uplink bietet dafür die Option, USB-Telefone auszuschließen.

## Abnahme am Fahrzeug

1. iPhone-Hotspot → WLAN-Uplink, iPhone ohne BMW-WLAN-Verbindung: Erkennung,
   Kopplung, Spiegelung, Musik und direkte YouTube-Wiedergabe prüfen.
2. Hotspot aus/ein bzw. Uplink wechseln: Bonjour und neue Medienabrufe müssen
   sich erholen. Unterbrechungsfreie laufende Downloads sind nicht zugesagt.
3. Bisheriger Aufbau iPhone → BMW-WLAN: lokale Wiedergabe ohne Uplink sowie
   direkte HLS-Wiedergabe mit separatem Uplink erneut prüfen.
4. „Trennen“ muss die gesamte AirPlay-Sitzung beenden; der Internet-Uplink
   und eine getrennte CarPlay-Sitzung dürfen davon nicht beendet werden.
5. CarPlay parallel gesondert prüfen. Diese Version behauptet keine
   funktionierende BMW-Fokusarbitrierung oder Lenkrad-/Tacho-Anbindung.

## Quellen

- [UxPlay am festgelegten Commit](https://github.com/FDH2/UxPlay/blob/df67c212a433cf6dda3676dd40c097900d24e645/README.md): HLS lädt Video auf den Empfänger.
- [MGU-Uplink](https://github.com/robertnisipeanu/mgu-store/tree/main/native/mgu-uplink): WLAN-Client, UID-Routing, Lease und Firewall.
- [Offener BMW-Medienvertrag](BMW_MEDIA_CONTRACT.md).
