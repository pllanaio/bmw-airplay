# Android-Streaming (ab 0.5.0, pllana Cast ab 0.6.0)

BMW AirPlay by pllana.io empfängt neben dem iPhone (AirPlay) auch Android-
Handys. Beides läuft in derselben App, über denselben Video- und Tonweg zum
iDrive-Display und zu den BMW-Lautsprechern.

## Was funktioniert

| Weg | Status | Typische Apps |
| --- | --- | --- |
| **DLNA/UPnP-Renderer** („Streamen auf …“, „Wiedergabe auf Gerät“) | ab 0.5.0 | Samsung Galerie und Musik, BubbleUPnP, Web Video Caster, VLC, Plex/Jellyfin/Kodi-Clients, Mediatheken-Apps mit DLNA |
| **pllana Cast** (eigene App, Bildschirm + Ton) | ab 0.6.0 | jedes Android ab 10, z. B. **Pixel** (dessen „Übertragen“ ist Google Cast) und Samsung |
| AirPlay-Sender-Apps auf Android | bereits mit AirPlay | z. B. AirScreen-/AllCast-artige Apps, die an AirPlay-Empfänger senden |
| **Miracast / Samsung Smart View** (Bildschirmspiegelung) | in Vorbereitung | Systemfunktion „Smart View“ bzw. „Bildschirm übertragen“ |
| Google Cast / Chromecast | nicht möglich | Google verlangt eine Geräte-Zertifizierung; ein freier Empfänger wird von Android und YouTube nicht angenommen |

## Bedienung

1. In der App „Verbinden“ drücken. Ab jetzt ist der Empfänger als
   **BMW AirPlay by pllana.io** im Netz sichtbar, für AirPlay und DLNA.
2. Das Android-Handy ist im BMW-WLAN, oder die HeadUnit hängt über mgu-uplink
   am Hotspot des Handys.
3. In der Android-App „Streamen auf“, „Wiedergabe auf“ oder das Cast-/DLNA-
   Symbol antippen und **BMW AirPlay by pllana.io** wählen.

Videos laufen im Vollbild, Musik zeigt Titel/Interpret/Album in der Musik-
ansicht. „Play/Pause“ und „Weiter“ (bei einer Wiedergabeliste) bedienen die
Android-Wiedergabe direkt aus dem Auto. „Video beenden“ und „Zur Spiegelung“
beenden die Android-Wiedergabe und kehren zum iPhone-Zustand zurück. Fotos
bleiben angezeigt, bis das Handy das nächste sendet oder beendet.

Das Handy liefert nur die Adresse des Inhalts. Die HeadUnit lädt Video oder
Musik selbst: vom Handy (lokale Dateien) oder aus dem Internet über den
Uplink. Das Handy kann währenddessen frei benutzt werden.

## pllana Cast: den ganzen Bildschirm übertragen (ab 0.6.0)

Pixel-Handys übertragen über das System nur per Google Cast, und das lässt
Google nur auf zertifizierten Geräten zu. Dafür gibt es die eigene App
**pllana Cast** (Quellcode in `android/`).

**Installation:** Auf GitHub unter *Releases* die Datei
`pllana-cast-<Version>.apk` am Handy herunterladen und öffnen. Android fragt
einmalig, ob der Browser Apps installieren darf.

**Benutzung:**

1. Im Auto in der AirPlay-App „Verbinden“ drücken. Das Display zeigt den
   6-stelligen Code.
2. Das Handy ist im BMW-WLAN, oder die HeadUnit hängt am Hotspot des Handys.
3. pllana Cast öffnen. Die App sucht den BMW automatisch; alternativ die
   Adresse eintragen.
4. Code eingeben und „Übertragung starten“ wählen. Android fragt, ob der
   ganze Bildschirm oder nur eine App geteilt werden soll.

Bild und Ton laufen dann auf dem iDrive-Display und über die BMW-
Lautsprecher. Drehen des Handys wird übernommen. Beenden geht in der App,
über die Benachrichtigung oder im Auto mit „Video beenden“.

Grenzen: Android liefert bei kopiergeschützten Inhalten (manche
Streamingdienste) ein schwarzes Bild oder keinen Ton. Apps, die den
Mitschnitt ihres Tons verbieten, bleiben stumm. Ob der Handylautsprecher
mitspielt, hängt vom Handy ab; im Zweifel am Handy leiser stellen.

**Technik:** H.264 aus dem Hardware-Encoder des Handys (max. 1280×720
bzw. 720×1280, 30 fps), Ton als PCM 48 kHz. Übertragung per TCP 7104 im
lokalen Netz; der Code wird nie im Klartext gesendet (HMAC-SHA256 über eine
Zufallszahl). Nach fünf falschen Codes wird eine Adresse für eine Minute
abgewiesen. Auf der HeadUnit dekodiert `mgu-cast-receiver` (GStreamer) in
denselben Videopfad wie AirPlay-Spiegelung. Die App findet den BMW per SSDP
(`urn:pllana-io:device:CastReceiver:1`).

**Signatur:** Mit dem Repository-Secret `PLLANA_CAST_KEYSTORE_BASE64`
(plus `PLLANA_CAST_KEYSTORE_PASSWORD`, optional `PLLANA_CAST_KEY_ALIAS`,
`PLLANA_CAST_KEY_PASSWORD`) signiert CI jede Version mit demselben Schlüssel,
sodass Updates sich über die alte App installieren. Ohne Secret wird mit
einem wechselnden Debug-Schlüssel signiert; dann vor einem Update die alte
App deinstallieren. Schlüssel erzeugen:

~~~sh
keytool -genkeypair -keystore pllana-cast.jks -alias pllana-cast -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 pllana-cast.jks   # Inhalt als Secret PLLANA_CAST_KEYSTORE_BASE64 speichern
~~~

## Technik

- `apps/pllana_airplay/dlna_renderer.js`: UPnP MediaRenderer (DMR-1.50) mit
  AVTransport, RenderingControl und ConnectionManager, SSDP-Erkennung,
  GENA-Ereignissen, nahtlosem nächstem Titel (`SetNextAVTransportURI`).
- `apps/pllana_airplay/media_player.js` und
  `airplay/native/mgu_media_player.c`: nativer Player (GStreamer playbin)
  mit derselben Ausgabe wie AirPlay-Direktvideo (`mgu_hls_output.h`:
  Skalierung auf die iDrive-Fläche, BMW-ALSA-Senke, Zertifikatsspeicher)
  und dem privaten Shared-Memory-Framepfad (`mguvideosink`).
- Formate: MP4/M4V/MOV, MKV/WebM, MPEG-TS, AVI, HLS; MP3 (mit ID3), AAC/M4A,
  FLAC, WAV, OGG/Opus; JPEG/PNG. Video mit H.264, H.265, VP8/VP9, MPEG-2/4
  (Software-Dekodierung).
- Netz: TCP 7103 (DLNA-Steuerung), TCP 7104 (pllana Cast), UDP 1900 (SSDP), nur auf `wlan_bridge`,
  `wlan0`, `wlan1` und nur für private IPv4-Adressen. Ereignis-Rückrufe gehen
  ausschließlich an die Adresse des abonnierenden Handys. Die Firewall-Regeln
  setzt die Laufzeit (`airplay/network.js`) wie die AirPlay-Regeln.
- Der Renderer läuft nur, solange der Empfang eingeschaltet ist; „Trennen“
  und „Schließen“ beenden ihn mit.

## Miracast: Vorprüfung

Miracast braucht eine Wi-Fi-Direct-Verbindung zwischen Handy und HeadUnit,
also P2P-Unterstützung des WLAN-Chips, idealerweise parallel zum Uplink.
Die Laufzeit prüft das ab 0.5.0 bei jedem Start nur lesend
(`airplay/runtime/p2p_probe.js`, mitgeliefertes `iw`). Das Ergebnis steht in
`/run/pllana-airplay/p2p.json` und unten auf der Startseite der App:

| Anzeige | Bedeutung |
| --- | --- |
| Wi-Fi Direct neben dem Hotspot möglich | Miracast kann parallel zu mgu-uplink laufen |
| Wi-Fi Direct nur ohne Hotspot | Miracast nur, wenn das Funkmodul nicht als Uplink belegt ist |
| WLAN-Chip ohne Wi-Fi Direct | Miracast ist auf dieser HeadUnit nicht möglich |

Je nach Ergebnis folgt der Miracast-Empfänger (WFD-RTSP, MPEG-TS/H.264 in
denselben Videopfad) als nächster Schritt.
