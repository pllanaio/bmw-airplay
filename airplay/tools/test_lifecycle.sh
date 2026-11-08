#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
gcc -O2 -w airplay/native/test_hls_lifecycle.c -o .build/airplay/test-hls-lifecycle $(pkg-config --cflags --libs gstreamer-app-1.0 gstreamer-video-1.0 gio-2.0)
G_DEBUG=fatal-warnings .build/airplay/test-hls-lifecycle
gcc -O2 -w airplay/native/test_audio_lifecycle.c -o .build/airplay/test-audio-lifecycle $(pkg-config --cflags --libs gstreamer-app-1.0) -lm
G_DEBUG=fatal-warnings .build/airplay/test-audio-lifecycle
gcc -DPLIST_210 -O2 -w -ffunction-sections -fdata-sections -Wl,--gc-sections -I .build/airplay/uxplay-source/lib airplay/native/test_hls_routes.c .build/airplay/uxplay-build/lib/libairplay.a .build/airplay/uxplay-build/lib/llhttp/libllhttp.a -o .build/airplay/test-hls-routes $(pkg-config --cflags --libs libplist-2.0 openssl) -lpthread -lm
.build/airplay/test-hls-routes
gcc -DPLIST_210 -O2 -w -ffunction-sections -fdata-sections -Wl,--gc-sections -I .build/airplay/uxplay-source/lib airplay/native/test_httpd_shutdown.c .build/airplay/uxplay-build/lib/libairplay.a .build/airplay/uxplay-build/lib/llhttp/libllhttp.a -o .build/airplay/test-httpd-shutdown $(pkg-config --cflags --libs libplist-2.0 openssl) -lpthread -lm
timeout 20s .build/airplay/test-httpd-shutdown
g++ -O2 -w -ffunction-sections -fdata-sections -Wl,--gc-sections airplay/native/test_detach.cpp .build/airplay/uxplay-build/renderers/librenderers.a .build/airplay/uxplay-build/lib/libairplay.a .build/airplay/uxplay-build/lib/llhttp/libllhttp.a .build/airplay/uxplay-build/lib/playfair/libplayfair.a .local/airplay/mDNSResponder/mDNSPosix/build/prod/libdns_sd.so -Wl,-rpath,"$PWD/.local/airplay/mDNSResponder/mDNSPosix/build/prod" -o .build/airplay/test-detach $(pkg-config --cflags --libs gstreamer-app-1.0 gstreamer-video-1.0 gio-2.0 libplist-2.0 openssl) -lpthread -lm
G_DEBUG=fatal-warnings .build/airplay/test-detach
g++ -O2 -w -ffunction-sections -fdata-sections -Wl,--gc-sections airplay/native/test_shutdown.cpp .build/airplay/uxplay-build/renderers/librenderers.a .build/airplay/uxplay-build/lib/libairplay.a .build/airplay/uxplay-build/lib/llhttp/libllhttp.a .build/airplay/uxplay-build/lib/playfair/libplayfair.a .local/airplay/mDNSResponder/mDNSPosix/build/prod/libdns_sd.so -Wl,-rpath,"$PWD/.local/airplay/mDNSResponder/mDNSPosix/build/prod" -o .build/airplay/test-shutdown $(pkg-config --cflags --libs gstreamer-app-1.0 gstreamer-video-1.0 gio-2.0 libplist-2.0 openssl) -lpthread -lm
G_DEBUG=fatal-warnings timeout 20s .build/airplay/test-shutdown
g++ -O2 -w -ffunction-sections -fdata-sections -Wl,--gc-sections airplay/native/test_audio_mode.cpp .build/airplay/uxplay-build/renderers/librenderers.a .build/airplay/uxplay-build/lib/libairplay.a .build/airplay/uxplay-build/lib/llhttp/libllhttp.a .build/airplay/uxplay-build/lib/playfair/libplayfair.a .local/airplay/mDNSResponder/mDNSPosix/build/prod/libdns_sd.so -Wl,-rpath,"$PWD/.local/airplay/mDNSResponder/mDNSPosix/build/prod" -o .build/airplay/test-audio-mode $(pkg-config --cflags --libs gstreamer-app-1.0 gstreamer-video-1.0 gio-2.0 libplist-2.0 openssl) -lpthread -lm
G_DEBUG=fatal-warnings .build/airplay/test-audio-mode
g++ -O2 -w -ffunction-sections -fdata-sections -Wl,--gc-sections airplay/native/test_auto_media.cpp .build/airplay/uxplay-build/renderers/librenderers.a .build/airplay/uxplay-build/lib/libairplay.a .build/airplay/uxplay-build/lib/llhttp/libllhttp.a .build/airplay/uxplay-build/lib/playfair/libplayfair.a .local/airplay/mDNSResponder/mDNSPosix/build/prod/libdns_sd.so -Wl,-rpath,"$PWD/.local/airplay/mDNSResponder/mDNSPosix/build/prod" -o .build/airplay/test-auto-media $(pkg-config --cflags --libs gstreamer-app-1.0 gstreamer-video-1.0 gio-2.0 libplist-2.0 openssl) -lpthread -lm
G_DEBUG=fatal-warnings .build/airplay/test-auto-media
g++ -std=c++11 -O2 -Wall -Wextra airplay/native/test_audio_metadata.cpp -o .build/airplay/test-audio-metadata $(pkg-config --cflags --libs glib-2.0)
.build/airplay/test-audio-metadata
g++ -O2 -Wall -Wextra -Werror airplay/native/test_music_control.cpp -lpthread -o .build/airplay/test-music-control
.build/airplay/test-music-control
gcc -DPLIST_210 -O2 -w -ffunction-sections -fdata-sections -Wl,--gc-sections -I .build/airplay/uxplay-source/lib airplay/native/test_music_control_session.c .build/airplay/uxplay-build/lib/libairplay.a .build/airplay/uxplay-build/lib/llhttp/libllhttp.a .build/airplay/uxplay-build/lib/playfair/libplayfair.a .local/airplay/mDNSResponder/mDNSPosix/build/prod/libdns_sd.so -Wl,-rpath,"$PWD/.local/airplay/mDNSResponder/mDNSPosix/build/prod" -o .build/airplay/test-music-control-session $(pkg-config --cflags --libs libplist-2.0 openssl) -lpthread -lm
.build/airplay/test-music-control-session
node airplay/test_audio_metadata_runtime.js
python3 airplay/tools/test_audio_decode.py
for test in playlist playlist_events; do
    gcc -DPLIST_210 -O2 -w -ffunction-sections -fdata-sections -Wl,--gc-sections -I .build/airplay/uxplay-source/lib "airplay/native/test_$test.c" .build/airplay/uxplay-build/lib/libairplay.a .build/airplay/uxplay-build/lib/llhttp/libllhttp.a .build/airplay/uxplay-build/lib/playfair/libplayfair.a .local/airplay/mDNSResponder/mDNSPosix/build/prod/libdns_sd.so -Wl,-rpath,"$PWD/.local/airplay/mDNSResponder/mDNSPosix/build/prod" -o ".build/airplay/test-$test" $(pkg-config --cflags --libs libplist-2.0 openssl) -lpthread -lm
    ".build/airplay/test-$test"
done
node airplay/test_backend.js
node airplay/test_receiver.js
node airplay/test_frontend_lifecycle.js
