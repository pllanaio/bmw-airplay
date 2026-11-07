# Architektur

## Komponenten

~~~text
iPhone
  ├─ Bildschirmspiegelung: AirPlay/RTP, Video + Audio
  └─ direkte Videowiedergabe: AirPlay-Steuerung / HLS
                     │
           BMW-WLAN / gemeinsames WLAN
                     │
          UxPlay + GStreamer, ohne Root
           ├─ I420-Frames → Shared Memory → MGU-Renderer → iDrive-Display
           └─ PCM → OEM-ALSA/SmartX → BMW-Audiopfad → Lautsprecher
                     │
           Node-Backend derselben App-UID
                     │
          privater Unix-Socket mit Zuständen
                     │
            OAP-Frontend / App-Kit
~~~

Die App und der native Empfänger sind getrennte Pakete. Die OAP-App bleibt
dadurch klein; Bibliotheken und Decoder müssen nicht bei jedem UI-Update
erneut durch MainApp geladen werden.

## Frontend

Die App-Dateien liegen in apps/pllana_airplay.

| Datei | Aufgabe |
| --- | --- |
| app.json | Identität, Version, ID7-Oberfläche, Audiomanager-Berechtigungen |
| main.js | UI-Lebenszyklus, Vollbild, Laden/Übergang, Benutzeraktionen |
| view.js | Verbindungsseite, Status und verständliche Fehlermeldungen |
| backend_client.js | Privater Backend-Socket, Heartbeat, Wiederverbindung |
| video_bridge.js | Verbindung des aktuellen Frame-Transportes zum Renderer |
| logo_bridge.js | Native Logo-Nachrichten und Ressourcenverwaltung |
| music_artwork_bridge.js | Privates RGBA-Thumbnail, Renderer-Upload und Freigabe alter Cover |
| audio_metadata.js | Begrenzte Metadaten und asynchrone Cover-Dekodierung |
| music_controls.js | An den gekoppelten Sender gebundene DACP-Steuerung |
| brand_logo.js | Komprimierte Pixel des eigenen Logos |

Der sichtbare Name lautet durchgängig „BMW AirPlay by pllana.io“.
Das OAP-Symbol hat 140×140 Pixel und passt in den BMW-Auswahlrahmen.
Die Verbindungssicht ist auf 1600×520 logischen Pixeln aufgebaut.
Die native Präsentationsansicht verwendet die tatsächliche Displaygröße,
einschließlich 1920×504 und 1920×720.

Ein Touch- oder Controller-Ereignis blendet die normalen Bedienelemente
für acht Sekunden ein. Das erste Ereignis wird nicht zusätzlich als Klick
auf eine zuvor versteckte Schaltfläche ausgeführt.

Der App-eigene SDK-Build wird gepatcht; die externe SDK-Installation bleibt
unverändert. Die Patches ergänzen Videofähigkeiten, Vollbild und die
Abdeckung der zuvor störenden Titel-/Zurück-Flächen.

Das Frontend bevorzugt /run/mgu-render/render.sock und fällt bei fehlendem
Socket auf /run/mgu-renderd/renderd.sock zurück. Im getesteten Aufbau ist
die neuere Store-Variante vorhanden. Der Fallback ist kein Nachweis, dass
jede ältere Renderer-Version das benötigte native Video-Protokoll beherrscht.

## Backend und Lebenszyklus

backend.js läuft unter der dynamisch vergebenen App-UID. Es startet genau
einen Receiver, verwaltet die eigene Audioverbindung und liefert Zustände
an das Frontend. Der Kontrollsocket ist nur für diese Identität zugänglich.

- Frontend-Heartbeat: alle zwei Sekunden.
- Backend-Heartbeat-Timeout: zwölf Sekunden.
- Frontend-Socket-Wiederverbindung: nach zwei Sekunden.
- Medienmoduswechsel sollen denselben nativen Receiver erhalten.
- Ein Bildschirm-/Fokuswechsel beendet die Sitzung nicht absichtlich.
- „Trennen“, „Schließen“ oder ein Backend-Ende räumen auf.

Ein verlorenes Frontend erhält im Videoprofil eine Wiederverbindungsfrist
von 30 Sekunden. Das gewählte Audioprofil bleibt ohne Oberfläche aktiv,
bis es ausdrücklich beendet wird oder der Backend-Dienst endet.

Beim regulären Beenden wird die eigene Receiver-Prozessgruppe zunächst
mit SIGTERM beendet; nach einem kurzen Timeout folgt gegebenenfalls SIGKILL.
Das ist keine Steuerung serienmäßiger BMW-/CarPlay-Prozesse.

## Zustände und gewünschtes Verhalten

Der Zustand enthält getrennte Informationen:

| Feld | Bedeutung |
| --- | --- |
| phase | stopped, starting, waiting, loading, mirroring, audio, recovering, stopping oder error |
| profile | video oder audio |
| mode | mirror, hls, waiting, audio oder kein Modus |
| returnMode | Rückkehr zur Spiegelung oder zum Warten nach einem Video |
| playlistPending | Natürlicher Titelabschluss gemeldet; die Sitzung erwartet einen möglichen Folgetitel |
| frame/file | Aktuell freigegebener Frame und sein Transport |
| audio/audioError | Eigene Audioverbindung und deren Verfügbarkeit |
| music | Titel, Interpret, Album, privates Thumbnail und bestätigte Fernsteuerfähigkeiten/-zustände |
| error | Bekannter Empfangs-/Medienfehler |

phase=mirroring bezeichnet im aktuellen Code eine aktive Frame-Ausgabe;
mode unterscheidet dabei Spiegelung und HLS.

Die beiden Nutzungsarten sind unterschiedlich:

1. Aus bestehender Spiegelung ein Video starten: während des Videos dessen
   Inhalt anzeigen; anschließend wieder den iPhone-Bildschirm anzeigen.
2. Ein Video direkt aus YouTube an den Empfänger senden: nur die Medien
   dieser Sitzung anzeigen; nach deren Ende auf weitere Wiedergabe warten.

Das sind beabsichtigte Zustandsübergänge. Die erfolgreich getesteten
konkreten Abläufe und noch offenen Gegenbeispiele stehen in STATUS.md.

## Native Laufzeit

build_runtime.py verwendet UxPlay 1.73.7 am festgelegten Commit
df67c212a433cf6dda3676dd40c097900d24e645. Es patcht eine private Quellkopie,
nicht den ausgecheckten Upstream.

Die Laufzeit enthält UxPlay, einen privaten glibc-Loader, benötigte
GStreamer-Plugins, Bibliotheken, einen GIO-TLS-Provider und einen CA-Store.
Sie startet keinen zusätzlichen Avahi-Daemon, sondern benutzt den
vorhandenen BMW-mDNS-Dienst über die passende Clientbibliothek.

Das synthetische AirPlay-Gerätekennzeichen bleibt über Sitzungen erhalten.
Der angezeigte sechsstellige Code wird als UxPlay-Passwort verwendet.
Das ist bewusst nicht der ältere PIN-/SRP-Pfad, bei dem der Benutzer
wiederholt zur PIN-Eingabe aufgefordert wurde.

## Spiegelung

UxPlay nimmt den normalen AirPlay-Transport entgegen und übergibt
dekodierte Frames an den eigenen GStreamer-Videosink. Die Fähigkeit,
diesen Transport zu verarbeiten, bedeutet keine Unterstützung geschützter
Streaming-Inhalte.

Der Renderer passt das Seitenverhältnis anhand der aktuellen Frame-
Abmessungen an. Ein gedrehtes iPhone oder ein neuer Transport darf nicht
an einem alten Dateihandle oder alten Texturabmessungen hängen bleiben.

VideoBridge berücksichtigt deshalb Dateiidentität, Frame-Generation,
Renderer-Verbindung und Layout. Ein neu erstellter Transport wird erneut
an den Renderer übergeben.

## Direkte Video-/HLS-Wiedergabe

Bei direkter Wiedergabe erhält der Empfänger die Mediensteuerung und
holt die Videodaten selbst. Das gilt auch für ein Video, das während der
Bildschirmspiegelung in den HLS-Modus wechselt. Deshalb benötigt die MGU Internet und DNS;
eine funktionierende lokale Spiegelung allein beweist diesen Zugang nicht.

YouTube verwendet einen FCUP-Austausch für Playlists. UxPlay stellt
angepasste lokale Playlists für den eigenen GStreamer-Player bereit.
Jedes zwischengespeicherte Video bekommt einen eigenen lokalen Pfad
unter /mgu-hls-N. Alte Playlist-Anfragen sollen dadurch nicht auf das
halb geladene nächste Video zugreifen.

Zusätzlich sind Standard-Requests mit Content-Location für ungeschützte
HTTP-/HLS-/MP4-Inhalte implementiert. Das ersetzt keine reale Prüfung
jeder Mediathek-App. Synthetische master.m3u8-URLs mit angehängten
AirPlay-Untertitelparametern werden für den lokalen Pfad normalisiert.

Die Runtime verwendet playbin2 und unterdrückt hlsdemux2 ausdrücklich
über dessen Feature-Rang. Nur die Wahl von playbin2 reichte im getesteten
GStreamer-Aufbau nicht aus, um hlsdemux2 zu vermeiden.

Die HLS-Ausgabe nutzt:

- Softwaredekodierung;
- I420 mit 1920×504 Ausgabefläche;
- zentrierter Beschnitt auf 80:21 bei erhaltenem Seitenverhältnis, ohne zusätzliche Ränder;
- drei Sekunden Pufferdauer und vier MiB Pufferbudget;
- eine Verbindungsratenempfehlung von 2500 kbit/s;
- keine unbeschränkte Download-Datei als Videocache.

Diese Ausgabegrenze beschränkt nicht automatisch Auflösung oder Codec
des tatsächlich heruntergeladenen Quellstreams.

## Wiedergabeprofile und Rückkehrziel ab 0.4.4

Das native Video meldet `MGU_ORIGIN mirror|direct` und nach Ende
`MGU_RETURN mirror|waiting`. Ausdrückliche Mediensteuerung bleibt wirksam;
Spiegelungstransport und eigenständiger HLS-Player haben getrennte Lebensdauer.
Nach einem direkten Video dürfen alte RTP-/Codec-Pakete keine Spiegelung
starten. Ein neuer expliziter Spiegelungs-SETUP gibt diesen Pfad wieder frei.

„Video beenden“ sendet ein ausschließlich durch die angekündigte Fähigkeit
`media-stop` freigeschaltetes SIGWINCH an die eigene Receiver-Prozessgruppe.
SIGUSR2 bleibt die ausdrückliche Rückkehr zur Spiegelung. Stop-/Pause-Signale
werden nicht pauschal als Hintergrundereignisse ignoriert.

Das Profil `audio` startet mit `-vs 0`, ohne HLS, und mit `MGU_AUDIO_ONLY=1`.
Die native Ankündigung enthält keine Video-/Foto-/Spiegelungsfähigkeiten.
`MGU_AUDIO_PLAY` und `MGU_AUDIO_WAITING` melden den Empfangsstatus. Das Backend
hält das gewählte Audio-Profil nach einem Verlust der Oberfläche aktiv;
Frontend-Ende trennt dessen Socket, eine ausdrückliche Trennaktion den
Receiver. Das Videoprofil behält seine begrenzte Wiederverbindungsfrist.
[Bedienung und Grenzen](MEDIA_MODES.md).

## YouTube-Warteschlangen

Ein HLS-Medienmanifest beschreibt nur die Abschnitte eines Videos. Für mehrere
YouTube-Titel liefert die iPhone-App neue Wiedergabeaufträge. Der Empfänger
verarbeitet `playlistInsert` über den normalen `/play`-Pfad und hält am
natürlichen Titelende die Steuer-/PTTH-Verbindungen offen. Abschlussposition
und Ende-Ereignisse bleiben verfügbar, während der Sender den Folgetitel
vorbereitet. Rückkanal-Anfragen werden begrenzt gepuffert und erst nach
vollständiger Bestätigung des vorherigen Requests gesendet. Während des
Renderer-Abbaus blockieren Steueranfragen den HTTP-Thread nicht: Sie erhalten
kurzzeitig 503 mit Retry-After, während lokale HLS-GETs weiter bedient werden.
Die Ende-Ereignisse werden erst nach abgeschlossenem Renderer-Reset gesendet.

Ein Ladefehler, Stop oder „Zur Spiegelung“ darf nicht als natürliches
Titelende gemeldet werden. „Zur Spiegelung“ bleibt auch in der Lücke zwischen
zwei Titeln verfügbar und verwirft die ausstehende Fortsetzung. Die eigentliche
Warteschlange und die Auswahl des nächsten Videos bleiben auf dem iPhone.
[Bedienung und Fahrzeug-Testmatrix](PLAYLISTS.md).

Die VideoBridge stellt HLS-Videos bildfüllend dar und beschneidet die
überstehende Cover-Fläche auf das tatsächliche Zielrechteck. Der vorhandene
Renderer bekommt dafür eine größere, proportional skalierte Fläche unter
einem Clip. Für die Bildschirmspiegelung bleibt dessen normale
vollständige Aspect-Fit-Darstellung aktiv. Ein Renderer-Protokollwechsel
ist dafür nicht erforderlich.

## Frame-Transport

gstmguvideosink schreibt einen MGVF-Transport nach /dev/shm.
Er enthält einen Header und drei I420-Frameslots. Die maximale Kantenlänge
beträgt 2048; die maximale Transportdatei ist entsprechend vorallokiert.
Der Sink berücksichtigt tatsächliche Strides statt eine dichte
GStreamer-Speicherbelegung vorauszusetzen.

Das Backend prüft Header, Größe, Abmessungen, Slots und Dateiidentität,
bevor es einen Frame freigibt. Während ein neuer Inhalt lädt, werden
alte Frames zurückgehalten. Ein altes Bild soll nicht als angeblich
bereits laufender neuer Stream angezeigt werden.

## Audio

Die App verbindet OAPGenericMedia mit MediaSink_Front über den
GENIVI/BMW-Audiomanager. Eigentum wird anhand von Verbindungs-ID,
Quell-ID und Senken-ID nachverfolgt. Fremde, inzwischen vom Fahrer
ausgewählte Verbindungen werden beim Aufräumen nicht getrennt.

Der PCM-Pfad verwendet den vorhandenen OEM-SmartX-Eingang
MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL:
48 kHz, S16LE und acht Kanäle. Stereo wird derzeit auf die Kanalpaare
dupliziert. Eine vollständige Bestätigung der physischen Zuordnung
zu jedem einzelnen Lautsprecher fehlt noch.

Die serienmäßige libasound.so.2 bleibt mit dem OEM-SmartX-Plugin gepaart.
Eine Distributions-ALSA-Bibliothek in der privaten Runtime ist dafür
kein kompatibler Ersatz und wird vom Builder entfernt.

Ein belegter Audiopfad darf die AirPlay-Erkennung nicht blockieren.
Der Receiver startet unabhängig davon; Audio wird bei Medienbeginn
oder ausdrücklichem „Verbinden“ erneut angefordert. Die App schreibt
im normalen Betrieb keine Fahrzeuglautstärke.

## Rechte, Netzwerk und DNS

Ein begrenzter Root-Startpfad richtet die eigenen markierten Firewall-
Regeln und einen privaten Mount-Namespace ein. Vor Node und Decoder
werden reale, effektive und gespeicherte Root-Identitäten abgelegt.
Das Backend wurde unter der App-UID mit CapEff=0 und NoNewPrivs=1 geprüft.

Nur der Backend-Namespace erhält die Uplink-DNS-Server. Die globale
BMW-resolv.conf bleibt unverändert. Die private Resolverdatei wird
aus der Uplink-Lease aktualisiert und bei entfallener Lease auf den lokalen
Offline-Resolver zurückgesetzt; ihre Inode bleibt für den Bind-Mount erhalten.

Der Netzwerk-Helfer bearbeitet nur die eigenen markierten Regeln für
die festen AirPlay-Ports und lokalen WLAN-Netze auf wlan_bridge, wlan0 und
wlan1. Für DACP kommt eine ausgehende TCP-Freigabe dieser App-UID zu
privaten/linklokalen WLAN-Zielen auf dynamischen Ports ab 1024 hinzu.
Der Sender veröffentlicht seinen Steuerport über DNS-SD; er ist nicht auf
einen festen Port begrenzt. Die Anwendung verbindet nur zur numerischen
Adresse des authentifizierten Audio-Senders und dessen aufgelöstem DACP-Port.
Die Ausnahme öffnet keine zusätzlichen eingehenden oder weitergeleiteten
Verbindungen. Der Root-Supervisor gleicht die Regeln regelmäßig ab, auch wenn der
Uplink seine Tabelle beim Verbindungswechsel neu erstellt. Unveränderte
Regeln werden nicht neu geschrieben. Er ersetzt keine
globale Firewall-Policy und keine BMW-Default-Route.

Für HTTPS wird der private CA-Store beim TLS-Backend registriert.
Zertifikatsprüfung bleibt eingeschaltet.

## Musiktitel und Fernsteuerung

Nur der authentifizierte Eigentümer einer RAOP-Audiositzung kann einen
privaten DACP-Deskriptor veröffentlichen. Zugangstoken und Senderadresse
verlassen den Backend-Prozess nicht. DNS-SD wird über den bestehenden
BMW-mdnsd und einen begrenzten Resolver-Helfer abgefragt.
Play/Pause und Titelwechsel verwenden feste DACP-Endpunkte. Shuffle und
Repeat werden erst nach erfolgreicher Zustandsabfrage freigegeben; die
Oberfläche übernimmt keine optimistisch gesetzten Werte. Zeitlimits,
begrenzte Warteschlange und Sitzungsepochen verhindern, dass eine alte
oder nicht antwortende Telefonverbindung das Stoppen blockiert.

AirPlay-DMAP-Metadaten und JPEG-/PNG-Cover werden größenbegrenzt in einem
privaten Sitzungsverzeichnis exportiert. Ein separater Decoder erzeugt
höchstens 256×256 RGBA-Pixel, mit Zeit- und Ausgabelimit. Titelwechsel,
Neuverbindung und Trennen räumen alte Cover und Steuerfähigkeiten auf.

## Gleichzeitigkeit und bekannte Grenze

RTP-Pakete, HTTP-Steueranfragen und GStreamer-Ereignisse kommen auf
verschiedenen Threads an. Die Runtime schützt Renderer-Lebensdauern,
blockiert Spiegelungspakete während HLS-Übernahme und ignoriert verspätete
Bus-Nachrichten bereits entfernter Instanzen.

Lokale Konkurrenztests decken konkrete Rennen ab. Der später beobachtete
native Absturz nach einem Medienabruf-Fehler zeigt jedoch, dass damit
noch nicht alle Fehlerpfade behoben sind.
