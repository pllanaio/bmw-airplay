# Build und Installation

## Voraussetzungen

Der native Build erfolgt unter x86-64 Linux, im Entwicklungsaufbau Debian 12
unter WSL. Die App läuft auf der MGU mit Node 8; lokale Tests können mit einem
neueren Node ausgeführt werden.

Benötigt werden Git, Python 3 mit Pillow, Node.js, GCC/G++, CMake, Ninja,
pkg-config, OpenSSL- und libplist-Entwicklungspakete, GLib/GIO,
GStreamer-Entwicklungspakete sowie die Plugins base, good, bad und libav.
Die Streamingtests benötigen zusätzlich FFmpeg, OpenSSL und glib-networking.

Das externe SDK wird separat bereitgestellt. Der verwendete Kit-Stand basiert auf
idrive7-apps-Commit 9b5e9cf8a49399939d51d3458fb29b6a3cec8346.
Das proprietäre oap-sdk darin muss selbst rechtmäßig bereitgestellt werden.

## Abhängigkeiten vorbereiten

Im Repository-Stamm ausführen:

~~~sh
mkdir -p .local/airplay
git clone https://github.com/FDH2/UxPlay .local/airplay/UxPlay
git -C .local/airplay/UxPlay checkout --detach df67c212a433cf6dda3676dd40c097900d24e645
git clone https://github.com/apple-oss-distributions/mDNSResponder .local/airplay/mDNSResponder
git -C .local/airplay/mDNSResponder checkout --detach 67390998bac34f1e203b0ad7fea72f7e2063066e
export MGU_SDK_PATH=/path/to/idrive7-apps
~~~

Alternativ config/development.example.json nach .local/development.json kopieren
und sdkPath setzen. Der Build ändert die Original-SDK-Dateien nicht.
Die Ubuntu-Schrift und ihre Lizenz liegen unter assets/fonts.

## Bauen und lokal prüfen

~~~sh
python3 airplay/tools/build_runtime.py
python3 airplay/tools/build_app.py
npm test
node airplay/test_presentation.js
sh airplay/tools/test_lifecycle.sh
python3 airplay/tools/test_hls.py --split --legacy
~~~

Die App-Pakete und ihr Build-Nachweis entstehen unter dist; die separate
Laufzeit liegt unter .build/airplay/runtime. Binärdateien und generierte
SDK-Dateien werden nicht eingecheckt.

Die synthetischen Tests ersetzen keinen iPhone-/Fahrzeugtest. Der gemeldete
Absturz nach einem fehlgeschlagenen echten Medienabruf bleibt offen.

## Deployment auf eine bereits vorbereitete MGU

Die Deployment-Skripte verwenden vorhandenes MGU Deploy. Sie setzen die
Store-/OAP-Struktur und einen bereits separat eingerichteten Renderer,
WiFi-Uplink sowie OEM-SmartX/ALSA voraus. Sie installieren keinen SSH-Zugang.
Die konkrete Firmware und Paketstruktur können Anpassungen erfordern.

config/vehicle.example.json nach .local/vehicle.json kopieren und die eigene
SSH-Identität sowie eine unabhängig verifizierte known_hosts-Datei angeben.
Die Hostschlüsselprüfung bleibt strikt aktiv. Keine Schlüssel oder
Konfigurationsdateien mit Zugangsdaten committen.

~~~sh
python3 airplay/tools/deploy_app.py
python3 airplay/tools/deploy_app.py --install
python3 airplay/tools/deploy_runtime.py
python3 airplay/tools/deploy_runtime.py --install
~~~

Ohne --install erfolgen Übertragung und MGU-Deploy-Prüfung; mit --install
erfolgt die Installation. App und native Laufzeit werden separat versioniert:
App 0.2.6 verwendet Laufzeit 0.2.4.

Die Audio-Probe-Werkzeuge unter airplay/tools sind historische Entwicklungs-
und Diagnosehilfen mit firmwareabhängigen Profilen. Sie gehören nicht zum
normalen Start der App und sind keine allgemeine Installationsanleitung.
