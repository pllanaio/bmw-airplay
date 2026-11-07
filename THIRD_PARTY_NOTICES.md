# Drittanbieter

- **UxPlay** — https://github.com/FDH2/UxPlay, Version 1.73.7,
  Commit df67c212a433cf6dda3676dd40c097900d24e645. GPL-3.0-or-later
  für die entsprechend gekennzeichneten Teile; einzelne Bibliotheksdateien
  tragen eigene LGPL-Hinweise. Die Build-Patches enthalten abgeleitete
  Quelltextausschnitte; deren Upstream-Lizenzhinweise gelten weiter.
  Die privaten HLS-Integrationsheader nennen ihre GPL-Lizenz im Quelltext.
- **Apple mDNSResponder** — https://github.com/apple-oss-distributions/mDNSResponder,
  Commit 67390998bac34f1e203b0ad7fea72f7e2063066e.
  Überwiegend Apache-2.0; die zur Laufzeit eingebundene Clientbibliothek
  verwendet laut Upstream die Three-Clause BSD License. Quellen werden beim
  lokalen Build separat bezogen.
- **GStreamer, GLib/GIO, FFmpeg/libav und weitere Laufzeitbibliotheken** —
  separat installierte Build-Abhängigkeiten. Der Laufzeit-Builder übernimmt
  vorhandene Paket-Lizenzhinweise in die erzeugte private Laufzeit.
  Deren vollständige Quell- und Lizenzpflichten gelten bei Binärverteilung
  zusätzlich; dieses Repository verteilt diese Laufzeitbinärdateien nicht.
- **idrive7-apps** — https://github.com/cauliflowermossgrape/idrive7-apps.
  Externes App-Kit; nicht mit diesem Repository gebündelt. Die Integration
  patcht nur eine lokale Build-Kopie des vom Benutzer bereitgestellten Kits.
- **MGU-Store, robertnisipeanu, IterioDev und Mitwirkende** —
  https://github.com/robertnisipeanu/mgu-store.
  Rendering-, Uplink- und Deployment-Infrastruktur. Nicht hier gebündelt;
  die jeweiligen Upstream-Lizenzen bleiben maßgeblich.
- **Ubuntu-Regular.ttf** — Ubuntu Font Licence 1.0. Schrift, Copyright-
  und Lizenzdateien liegen vollständig unter assets/fonts. Der dort
  enthaltene vorbereitete airplay.json-Glyphenatlas ist aus dieser
  freien Schrift abgeleitet und unterliegt ebenfalls deren Bedingungen.

Das App-Logo wurde für Leon Pllana IT-Solutions erstellt; Herkunft und Prompt
sind unter airplay/branding dokumentiert. BMW und Apple/AirPlay sind Marken
ihrer jeweiligen Inhaber. Es wird keine offizielle Unterstützung behauptet.
