#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
gcc -O2 -w airplay/native/test_hls_lifecycle.c -o .build/airplay/test-hls-lifecycle $(pkg-config --cflags --libs gstreamer-app-1.0 gstreamer-video-1.0 gio-2.0)
G_DEBUG=fatal-warnings .build/airplay/test-hls-lifecycle
gcc -O2 -w airplay/native/test_audio_lifecycle.c -o .build/airplay/test-audio-lifecycle $(pkg-config --cflags --libs gstreamer-app-1.0) -lm
G_DEBUG=fatal-warnings .build/airplay/test-audio-lifecycle
gcc -DPLIST_210 -O2 -w -ffunction-sections -fdata-sections -Wl,--gc-sections -I .build/airplay/uxplay-source/lib airplay/native/test_hls_routes.c .build/airplay/uxplay-build/lib/libairplay.a .build/airplay/uxplay-build/lib/llhttp/libllhttp.a -o .build/airplay/test-hls-routes $(pkg-config --cflags --libs libplist-2.0 openssl) -lpthread -lm
.build/airplay/test-hls-routes
g++ -O2 -w -ffunction-sections -fdata-sections -Wl,--gc-sections airplay/native/test_detach.cpp .build/airplay/uxplay-build/renderers/librenderers.a .build/airplay/uxplay-build/lib/libairplay.a .build/airplay/uxplay-build/lib/llhttp/libllhttp.a .build/airplay/uxplay-build/lib/playfair/libplayfair.a .local/airplay/mDNSResponder/mDNSPosix/build/prod/libdns_sd.so -Wl,-rpath,"$PWD/.local/airplay/mDNSResponder/mDNSPosix/build/prod" -o .build/airplay/test-detach $(pkg-config --cflags --libs gstreamer-app-1.0 gstreamer-video-1.0 gio-2.0 libplist-2.0 openssl) -lpthread -lm
G_DEBUG=fatal-warnings .build/airplay/test-detach
node airplay/test_backend.js
node airplay/test_receiver.js
node airplay/test_frontend_lifecycle.js
