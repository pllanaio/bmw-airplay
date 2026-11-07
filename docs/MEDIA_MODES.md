# Video, Bildschirmspiegelung und reine Musikwiedergabe

App und Empfänger **0.4.5** erkennen Audio und Video automatisch,
unterscheiden den Ursprung eines Videos und
respektieren ausdrückliche Wiedergabesteuerung. Das sechsstellige Passwort
und der bereitstehende Empfänger bleiben beim Beenden eines einzelnen
Videos erhalten.

| Start | Beim Wechsel in eine andere iPhone-App | Nach Video beenden / natürlichem Ende |
| --- | --- | --- |
| Bildschirmsynchronisierung, danach AirPlay-Video | Video nutzt den eigenständigen Medienpfad; Spiegelungspakete übernehmen nicht die Ausgabe | Zur vorhandenen Bildschirmspiegelung zurück |
| AirPlay-Video direkt aus YouTube | Video kann unabhängig vom sichtbaren iPhone-Bildschirm weiterlaufen | Empfang wartet auf das nächste Video; keine automatische Spiegelung |
| AirPlay-Audio am iPhone auswählen | Automatische Musikansicht; Wiedergabe unabhängig von der MGU-Oberfläche | Nach Pause/Audioende weiter auf Musik oder Video warten |

## Bedienung

- **Verbinden:** Gemeinsamer Empfang mit Bild und Ton. Am iPhone entweder
  Bildschirmsynchronisierung oder AirPlay direkt in der Video-App wählen.
  Für Musik denselben Empfänger als Audioausgabe wählen. Der Empfänger
  erkennt den Transport und wechselt automatisch zur passenden Ansicht,
  ohne die AirPlay-Verbindung für den Moduswechsel neu zu starten.
- **Video beenden:** Nur das aktuelle Video bzw. dessen Ladevorgang beenden.
  Der Ursprung bestimmt die Rückkehr zur Spiegelung oder zum Warten.
- **Zur Spiegelung:** Ausdrücklich zur Bildschirmspiegelung zurückkehren,
  auch nach einem direkt gestarteten Video. Dafür muss das iPhone eine
  Spiegelung liefern; die MGU kann sie nicht auf dem iPhone einschalten.
- **Trennen / Schließen:** Den gesamten Empfang und den eigenen BMW-Audiopfad
  beenden. Die Bestätigung folgt erst nach dem tatsächlichen Empfängerende
  und der Audiofreigabe. Laufende oder geplante Wiederherstellungen werden
  verworfen. Bei fehlender Bestätigung bleibt „Schließen“ geöffnet und
  zeigt einen erneut versuchbaren Fehler. BMW Home beendet den Empfang nicht.

Musikwiedergabe verwendet den vorhandenen RAOP-Audiopfad. Das iPhone lädt seine
Musik; Internet an der MGU ist dafür nicht erforderlich. Die Auswahl als
AirPlay-Ziel in Spotify oder YouTube Music ist am konkreten iPhone noch zu
prüfen. Spotify Connect und AirPlay-2-Multiroom sind nicht Teil dieser Änderung.

Die Musikansicht zeigt Cover, Titel, Interpret und Album, soweit das iPhone
diese AirPlay-Metadaten sendet. Ohne Cover erscheint ein Musikzeichen.
Beim Titelwechsel oder Trennen wird ein altes Cover entfernt. Empfangene
JPEG-/PNG-Cover werden begrenzt und außerhalb des Audiothreads in ein
256-×-256-Thumbnail umgewandelt.

**Zurück, Play/Pause, Weiter, Shuffle und Repeat** sind per Touch und
iDrive erreichbar. Der Empfänger steuert dafür den gekoppelten Sender über
DACP. Tasten werden erst nach bestätigter Fernsteuerung aktiv; Shuffle und
Repeat zeigen den abgefragten Zustand. Repeat wechselt zwischen aus,
allen Titeln und einem Titel. Sendet das iPhone keine unterstützte
Fernsteuerung, bleiben die entsprechenden Tasten inaktiv und die Bedienung
am iPhone verfügbar. Eine App kann ihre AirPlay-Metadaten und Fernsteuerung
je nach iOS-Version unterschiedlich bereitstellen.

## Hintergrund und Stoppen

Der Empfänger ignoriert keine ausdrücklichen Stop-/Pause-Anfragen mehr.
`/stop`, Medien-TEARDOWN und Pause bleiben wirksam. Das Beenden eines
Spiegelungstransports und reine Bereinigung eines Playlist-Eintrags dürfen
hingegen ein noch eigenständig laufendes Video nicht pauschal beenden.

Sendet eine iPhone-App beim Wechsel in den Hintergrund exakt dieselbe
Stop-/Pause-Anfrage wie bei einer bewussten Bedienung, gibt es darin keinen
zuverlässigen Unterschied. Der Empfänger respektiert dann die Steuerung des
Senders. Ein Weiterlaufen gegen einen ausdrücklich angeforderten Stop ist
kein Hintergrundmodus. Das tatsächliche Verhalten der verwendeten YouTube-
und iOS-Version muss am Fahrzeug geprüft werden.

Wird AirPlay bzw. die Spiegelung am iPhone vollständig getrennt, bleibt der
MGU-Empfänger verfügbar. Er kann keine vom iPhone getrennte Verbindung oder
Bildschirmspiegelung selbst wiederherstellen.

## Vollständige Videos in 1920 × 504 ohne Beschnitt

Ab 0.4.5 werden HLS-Videos als vollständiges I420-Bild auf **1920 × 504**
skaliert. Horizontale und vertikale Skalierung dürfen sich unterscheiden:
Das Bild wird passend gedehnt oder gestaucht. Es gibt keinen Zoom,
keinen Aspect-Ratio-Crop und keine abgeschnittenen oberen, unteren oder
seitlichen Bildteile. Das ersetzt den zentrierten Beschnitt aus 0.4.4.

Die Ausgabe erzeugt keine zusätzlichen Letterbox-/Pillarbox-Ränder.
Bereits in der Quelle kodierte schwarze Bildinhalte bleiben als Teil des
vollständigen Bildes erhalten. In abweichenden Oberflächenlayouts bleibt
ebenfalls der vollständige Frame sichtbar. Normale Bildschirmspiegelung
zeigt weiterhin die gesamte iPhone-Oberfläche.

## Audio bei geschlossener Oberfläche

Eine erkannte Musiksitzung läuft nach Fokusverlust, BMW Home oder dem
Ende der Oberfläche weiter. Auch neue Titel können ohne offene Oberfläche
Audio anfordern. „Trennen“ und „Schließen“ beenden ihn ausdrücklich.
Nach einem unerwarteten nativen Empfängerende wird der gewünschte Empfang
mit demselben Passwort wieder gestartet.

## Abnahme am Fahrzeug

Die lokalen Tests prüfen beide Video-Ursprünge, Pause/Stop, Ladeabbruch,
Rückkehrziel, den Erhalt der Steuerverbindung, unterdrückte alte
Spiegelungspakete, Audiofähigkeiten, Audio-Flush/Teardown sowie tatsächliche
ALAC-Dekodierung vor und nach Stop/Neustart. Sie ersetzen noch keinen
Spotify-/YouTube-Music- oder YouTube-Test am iPhone.

1. Spiegelung → YouTube-Video → andere App → Video am iPhone beenden:
   bei weiter bestehender Spiegelung wieder deren Bild und Ton.
2. YouTube direkt → andere App → Video beenden: Empfang wartet auf einen
   neuen Titel, ohne Bildschirmspiegelung. Danach einen weiteren Titel senden.
3. Beide Abläufe mit Pause/Fortsetzen, „Video beenden“, natürlichem Ende
   und einer YouTube-Playlist prüfen.
4. „Verbinden“ → Musik senden: ohne weitere Auswahl automatisch Cover und
   Musiktasten sehen. BMW Home → Pause/Fortsetzen und nächster Titel.
   Anschließend „Trennen“ prüfen; am iPhone darf die aktive Audioverbindung
   nicht bestehen bleiben.
5. Videos in 16:9, 21:9 und 16:10 auf der 1920-×-504-Fläche prüfen;
   vollständige obere/untere/seitliche Kanten und alle vier Bildecken
   prüfen. Dehnung/Stauchung ist beabsichtigt; Beschnitt ist nicht erlaubt.
6. In derselben Empfängersitzung Musik → Video/Spiegelung → Musik wechseln;
   Anzeige, Audiopfad und Kopplungscode prüfen. Videoton darf die
   Musikansicht nicht ungewollt öffnen.
7. Cover und Titelwechsel einschließlich fehlender Metadaten, Pause/Play,
   vorherigem/nächstem Titel sowie bestätigtem Shuffle-/Repeat-Zustand
   in Spotify und YouTube Music prüfen. Nach Trennen dürfen kein altes
   Cover und keine Steuerbefehle an die vorige Sitzung verbleiben.
8. „Trennen“ und „Schließen“ während Musik, Spiegelung, laufendem Video
   und Video-Laden prüfen; ohne automatischen Neustart, anschließend
   ausdrücklich „Verbinden“ für eine neue Sitzung wählen.
