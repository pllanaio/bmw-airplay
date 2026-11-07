# YouTube-Warteschlangen über AirPlay

Eine YouTube-Playlist besteht aus mehreren Videos. Die HLS-Playlists eines
Videos beschreiben dagegen dessen Audio-/Videoabschnitte. Für den Sprung
zum nächsten YouTube-Titel muss der Empfänger das Ende des aktuellen Titels
an das iPhone melden und die AirPlay-Sitzung für den nächsten Titel erhalten.
Die Reihenfolge und die Medienadressen liefert weiterhin die YouTube-App.

## Verwendung

1. In YouTube eine Playlist oder Warteschlange starten und AirPlay auswählen.
   Ein während der Bildschirmspiegelung gestarteter AirPlay-Videostream nutzt
   denselben Übergabepfad.
2. YouTube kann im Hintergrund bleiben. Das iPhone muss mit dem Empfänger
   verbunden bleiben, damit es den nächsten Titel und dessen Playlists liefert.
3. Am natürlichen Videoende setzt der Empfänger die Sitzung für die nächste
   Titelübergabe fort. Eine erneute Kopplung ist dafür nicht vorgesehen.

„Trennen“ beendet die Sitzung. „Zur Spiegelung“ beendet die unabhängige
Videowiedergabe. Pause und ein fehlgeschlagener Medienabruf sind kein
natürliches Videoende und dürfen keinen automatischen Titelsprung auslösen.
Zwischen Titeln zeigt die App „Wartet auf YouTube“ und behält die
Bedienelemente. Wenn YouTube keinen nächsten Titel übergibt, wählt der Empfänger nicht
selbstständig ein anderes Video aus und liest keine YouTube-Kontodaten aus.

Der Empfang ungeschützter direkter AirPlay-/HLS-Videos benötigt weiterhin
Internet an der MGU. Die neue Warteschlangenbehandlung ändert den
[Netzwerkpfad](NETWORK.md) nicht.

## Fahrzeugabnahme

Die lokale Protokollprüfung ersetzt keinen Test mit der konkreten YouTube-
und iOS-Version. Noch am Fahrzeug zu prüfen:

- Drei Titel einer Playlist ohne manuelle Auswahl nacheinander abspielen.
- Dasselbe nach Start des ersten Videos aus der Bildschirmspiegelung.
- YouTube im Hintergrund und das iPhone gesperrt; anschließend weitere Titel.
- Pause, Fortsetzen und manuelle Auswahl eines anderen Titels.
- „Zur Spiegelung“ und „Trennen“ während des Titelübergangs.
- Verhalten am letzten Titel und nach einem Downloadfehler.

## Protokollpfad

Der Empfänger verarbeitet `playlistInsert` als Titelübergabe. Die darin
enthaltene Medienbeschreibung nutzt denselben Wiedergabepfad wie `/play`.
Er lädt keine erfundene nächste URL und verwechselt die YouTube-Warteschlange
nicht mit den HLS-Abschnitten eines einzelnen Videos.

Nach natürlichem Wiedergabeende bleiben die Abschlussposition und die
AirPlay-Steuerverbindung verfügbar. Die Ende-Ereignisse werden nacheinander
über den Rückkanal übertragen und vom Sender bestätigt. So kann YouTube
seinen nächsten Titel übergeben, ohne einen neuen Empfängerstart auszulösen.
Fehler und vom Benutzer beendete Wiedergaben werden getrennt behandelt.

Die Diagnose verwendet die festen Kennungen `mgu_playlist_insert` und
`mgu_media_ended`; Titeladressen, Kopplungscodes und Sitzungskennungen werden
für diese Ereignisse nicht aufgezeichnet.

Die Ende-Meldungen orientieren sich am dokumentierten, senderseitig erprobten
[VOD-Ende-Austausch in java-airplay](https://github.com/serezhka/java-airplay/blob/59816100c87212353a4191a922aa97226af2cccd/AGENTS.md).
Das ist eine Protokollreferenz und keine Fahrzeugbestätigung für diese App.
