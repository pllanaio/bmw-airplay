# Video, Bildschirmspiegelung und reine Musikwiedergabe

App und Empfänger **0.4.4** unterscheiden den Ursprung eines Videos und
respektieren ausdrückliche Wiedergabesteuerung. Das sechsstellige Passwort
und der bereitstehende Empfänger bleiben beim Beenden eines einzelnen
Videos erhalten.

| Start | Beim Wechsel in eine andere iPhone-App | Nach Video beenden / natürlichem Ende |
| --- | --- | --- |
| Bildschirmsynchronisierung, danach AirPlay-Video | Video nutzt den eigenständigen Medienpfad; Spiegelungspakete übernehmen nicht die Ausgabe | Zur vorhandenen Bildschirmspiegelung zurück |
| AirPlay-Video direkt aus YouTube | Video kann unabhängig vom sichtbaren iPhone-Bildschirm weiterlaufen | Empfang wartet auf das nächste Video; keine automatische Spiegelung |
| „Nur Audio“, anschließend AirPlay-Audio am iPhone | Musikwiedergabe ist unabhängig von der MGU-Oberfläche | Nach Pause/Audioende weiter als Audioempfänger bereit |

## Bedienung

- **Verbinden:** Empfang mit Bild und Ton. Am iPhone entweder
  Bildschirmsynchronisierung oder AirPlay direkt in der Video-App wählen.
  Der Empfänger erkennt den Ursprung des Videostreams.
- **Video beenden:** Nur das aktuelle Video bzw. dessen Ladevorgang beenden.
  Der Ursprung bestimmt die Rückkehr zur Spiegelung oder zum Warten.
- **Zur Spiegelung:** Ausdrücklich zur Bildschirmspiegelung zurückkehren,
  auch nach einem direkt gestarteten Video. Dafür muss das iPhone eine
  Spiegelung liefern; die MGU kann sie nicht auf dem iPhone einschalten.
- **Nur Audio:** Empfang als AirPlay-Audioziel. Im iPhone-Kontrollzentrum
  oder in einer Musik-App den BMW-Empfänger als Ausgabe auswählen. Es wird
  kein Video- oder Spiegelungsempfänger angekündigt und keine Videofläche
  erzeugt. Ein Profilwechsel startet den Empfänger mit denselben
  Kopplungsdaten und den geänderten Fähigkeiten neu.
- **Trennen / Schließen:** Den gesamten Empfang und den eigenen BMW-Audiopfad
  beenden. Das unterscheidet sich vom bloßen Wechsel zu BMW Home.

„Nur Audio“ verwendet den vorhandenen RAOP-Audiopfad. Das iPhone lädt seine
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

## Bildfüllende Videos in 1920 × 504

HLS-Videos werden als I420 mit **1920 × 504** Bildpunkten ausgegeben. Vor
Skalierung und Farbumwandlung wird das Bild mittig auf das Verhältnis 80:21
beschnitten. Bei 16:9, 21:9 und 16:10 werden überstehende Bildteile entfernt,
sodass der Empfänger keine zusätzlichen Letterbox-/Pillarbox-Ränder erzeugt.
Das Seitenverhältnis des Motivs bleibt erhalten; das Bild wird nicht gestreckt.
Die native Ausgabe enthält rund fünf Prozent mehr Bildpunkte als 1280 × 720.

Die Oberfläche verwendet die tatsächliche Größe der Videofläche und
beschneidet die zentrierte Cover-Darstellung an deren Grenzen. Die normale
Bildschirmspiegelung behält ihre vollständige Darstellung,
damit die iPhone-Oberfläche nach einem Video wieder bedienbar sichtbar ist.
Bereits in der Quelldatei kodierte schwarze Bildinhalte werden nicht als
separate Balken erkannt.

## Audio bei geschlossener Oberfläche

Ein gestarteter Audioempfänger läuft nach Fokusverlust, BMW Home oder dem
Ende der Oberfläche weiter. Auch neue Titel können ohne offene Oberfläche
Audio anfordern. „Trennen“ und „Schließen“ beenden ihn ausdrücklich.
Nach einem unerwarteten nativen Empfängerende wird das gewählte Profil
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
4. „Nur Audio“ → Musik senden → BMW Home → Pause/Fortsetzen und nächster
   Titel. Anschließend „Trennen“ prüfen.
5. Videos in 16:9, 21:9 und 16:10 auf der 1920-×-504-Fläche prüfen;
   füllendes Bild, zentrierter Beschnitt und unverzerrte Motive vergleichen.
6. Zwischen Bild-/Tonempfang und reinem Audio wechseln; Audiopfad,
   Kopplungscode und erneut auswählbaren AirPlay-Empfänger prüfen.
7. Cover und Titelwechsel einschließlich fehlender Metadaten, Pause/Play,
   vorherigem/nächstem Titel sowie bestätigtem Shuffle-/Repeat-Zustand
   in Spotify und YouTube Music prüfen. Nach Trennen dürfen kein altes
   Cover und keine Steuerbefehle an die vorige Sitzung verbleiben.
