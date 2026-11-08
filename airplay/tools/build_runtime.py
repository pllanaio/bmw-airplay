"""Build a private x86-64 UxPlay runtime in Linux/WSL; never contacts the vehicle."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
from patch_dnssd_export import patch as patch_dnssd_export
from patch_hls_lifecycle import patch as patch_hls_lifecycle
from patch_detach import patch as patch_detach
from patch_reverse import patch as patch_reverse
from patch_playlist import patch as patch_playlist
from patch_audio_mode import patch as patch_audio_mode
from patch_audio_metadata import patch as patch_audio_metadata
from patch_music_control import patch as patch_music_control
from patch_shutdown import patch as patch_shutdown
from patch_connection_status import patch as patch_connection_status

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.local/airplay'
BUILD = ROOT / '.build/airplay'
RUNTIME = BUILD / 'runtime'
UX_REV = 'df67c212a433cf6dda3676dd40c097900d24e645'
MDNS_REV = '67390998bac34f1e203b0ad7fea72f7e2063066e'


def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    if os.name != 'posix':
        raise SystemExit('Run in the prepared Linux/WSL build environment')
    for name, rev in [('UxPlay', UX_REV), ('mDNSResponder', MDNS_REV)]:
        actual = subprocess.check_output(['git', '-C', str(WORK / name), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != rev:
            raise RuntimeError('Unexpected upstream revision: ' + name)
    BUILD.mkdir(parents=True, exist_ok=True)
    source = BUILD / 'uxplay-source'
    if not source.exists():
        shutil.copytree(WORK / 'UxPlay', source, ignore=shutil.ignore_patterns('.git'))
    cmake = source / 'lib/CMakeLists.txt'
    text = cmake.read_text()
    original = 'pkg_search_module(AVAHI_DNSSD avahi-compat-libdns_sd)'
    replacement = 'set(AVAHI_DNSSD_FOUND FALSE) # MGU: use the Apple mDNSResponder client'
    if original in text:
        if text.count(original) != 1:
            raise RuntimeError('Unexpected DNS-SD CMake source')
        cmake.write_text(text.replace(original, replacement))
    elif replacement not in text:
        raise RuntimeError('DNS-SD patch missing')
    ux_source = source / 'uxplay.cpp'
    ux_text = (WORK / 'UxPlay/uxplay.cpp').read_text()
    for statement in ['open_connections++;', 'open_connections--;']:
        marker = statement + '\n    printf("MGU_CONN %u\\n", open_connections); fflush(stdout);'
        if marker not in ux_text:
            if ux_text.count(statement) != 1:
                raise RuntimeError('unexpected UxPlay connection callback')
            ux_text = ux_text.replace(statement, marker)
    # Explicit mode events contain no URLs, client details, or pairing codes.
    # Mirror mode is announced by codec selection in the renderer below.
    # Always patch the pinned original so repeated builds stay reproducible.
    video_source = source / 'renderers/video_renderer.c'
    video_text = (WORK / 'UxPlay/renderers/video_renderer.c').read_text()
    # gio includes unistd.h: upstream's file-scope `sync` clashes with sync().
    for old in ['static bool sync = false;', '                    sync = true;', '                    sync = false;', 'if (sync)']:
        video_text = video_text.replace(old, old.replace('sync', 'mgu_video_sync'))
    anchor = '} GstPlayFlags;'
    if video_text.count(anchor) != 1:
        raise RuntimeError('Unexpected UxPlay renderer flags')
    video_text = video_text.replace(anchor, anchor + '\n#include "mgu_hls_output.h"')
    anchor = 'g_object_set(renderer_type[i]->pipeline, "flags", flags, NULL);'
    if video_text.count(anchor) != 1:
        raise RuntimeError('Unexpected HLS player setup')
    video_text = video_text.replace(anchor, anchor + '\n            mgu_hls_output(renderer_type[i]->pipeline);')
    anchor = '    renderer = renderer_used;'
    if video_text.count(anchor) != 1:
        raise RuntimeError('Unexpected mirror codec callback')
    video_text = video_text.replace(anchor, anchor + '\n    g_print("MGU_MODE mirror\\n"); fflush(stdout);')
    ux_text, video_text = patch_hls_lifecycle(WORK / 'UxPlay', source, ux_text, video_text)
    ux_text = patch_detach(ux_text, source)
    patch_reverse(source, WORK / 'UxPlay')
    ux_text, video_text = patch_playlist(source, ux_text, video_text)
    ux_text, video_text = patch_audio_mode(source, ux_text, video_text)
    ux_text, video_text = patch_audio_metadata(source, ux_text, video_text)
    ux_text = patch_music_control(source, ux_text)
    ux_text = patch_shutdown(source, ux_text)
    ux_text = patch_connection_status(source, ux_text)
    for name in ['mgu_reverse.h', 'mgu_playlist.h']:
        shutil.copy2(ROOT / 'airplay/native' / name, source / 'lib' / name)
    shutil.copy2(ROOT / 'airplay/native/mgu_direct_play.h', source / 'lib/mgu_direct_play.h')
    ux_text += '\n#include "mgu_crash_trace.h"\n'
    shutil.copy2(ROOT / 'airplay/native/mgu_crash_trace.h', source / 'mgu_crash_trace.h')
    shutil.copy2(ROOT / 'airplay/native/mgu_audio_metadata.h', source / 'mgu_audio_metadata.h')
    shutil.copy2(ROOT / 'airplay/native/mgu_music_control.h', source / 'mgu_music_control.h')
    # Uplink Bonjour: the backend re-announces UxPlay's exact records there.
    dnssd_source = source / 'lib/dnssd.c'
    dnssd_source.write_text(patch_dnssd_export((WORK / 'UxPlay/lib/dnssd.c').read_text()))
    ux_source.write_text(ux_text)
    video_source.write_text(video_text)
    shutil.copy2(ROOT / 'airplay/native/mgu_hls_output.h', source / 'renderers/mgu_hls_output.h')
    cmake_root = source / 'CMakeLists.txt'
    cmake_text = (WORK / 'UxPlay/CMakeLists.txt').read_text()
    cmake_root.write_text(cmake_text + '\npkg_check_modules(MGU_GIO REQUIRED gio-2.0)\n'
                          'target_link_libraries(uxplay ${MGU_GIO_LIBRARIES})\n')
    mdns = WORK / 'mDNSResponder'
    run(['make', '-C', mdns / 'mDNSPosix', 'os=linux', 'libdns_sd'])
    dns = mdns / 'mDNSPosix/build/prod/libdns_sd.so'
    if not dns.exists():
        raise RuntimeError('mDNSResponder client library missing')
    run(['cmake', '-S', source, '-B', BUILD / 'uxplay-build', '-G', 'Ninja',
         '-DCMAKE_BUILD_TYPE=RelWithDebInfo', '-DNO_MARCH_NATIVE=ON', '-DNO_X11_DEPS=ON',
         '-DCMAKE_C_FLAGS=-march=x86-64 -mtune=generic',
         '-DCMAKE_CXX_FLAGS=-march=x86-64 -mtune=generic',
         '-DDNSSD=' + str(dns), '-DDNSSD_INCLUDE_DIR=' + str(mdns / 'mDNSShared')])
    run(['cmake', '--build', BUILD / 'uxplay-build', '-j', '2'])
    for directory in ['bin', 'lib', 'plugins', 'licenses', 'gio', 'etc']:
        (RUNTIME / directory).mkdir(parents=True, exist_ok=True)
    run(['gcc', '-static', '-O2', '-Wall', '-Wextra', ROOT / 'airplay/native/airplay_launch.c',
         '-o', RUNTIME / 'bin/airplay-launch'])
    run(['gcc', '-static', '-O2', '-Wall', '-Wextra', '-Werror', ROOT / 'airplay/native/backend_launch.c',
         '-o', RUNTIME / 'bin/airplay-backend-launch'])
    # The root network controller invokes this fixed-purpose netlink helper.
    # Like the launchers it is static and runs without the private loader.
    run(['gcc', '-static', '-O2', '-march=x86-64', '-mtune=generic', '-Wall', '-Wextra', '-Werror',
         ROOT / 'airplay/native/mdns_route.c', '-o', RUNTIME / 'bin/mgu-airplay-mdns-route'])
    run(['gcc', '-O2', '-Wall', '-Wextra', '-Werror', '-I', mdns / 'mDNSShared',
         ROOT / 'airplay/native/mgu_dacp_resolve.c', '-L' + str(dns.parent), '-ldns_sd',
         '-o', RUNTIME / 'bin/mgu-dacp-resolve'])
    flags = subprocess.check_output(['pkg-config', '--cflags', '--libs', 'gstreamer-video-1.0'], text=True).split()
    run(['gcc', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror',
         ROOT / 'airplay/native/gstmguvideosink.c', '-o', RUNTIME / 'plugins/libgstmguvideo.so'] + flags)
    shutil.copy2(BUILD / 'uxplay-build/uxplay', RUNTIME / 'bin/uxplay')
    shutil.copy2(dns, RUNTIME / 'lib/libdns_sd.so')
    # Mirroring and YouTube HLS; no system plugin discovery on the target.
    plugin_names = ['coreelements', 'app', 'libav', 'videoparsersbad', 'audioparsers',
                    'videoconvertscale', 'videofilter', 'audioconvert', 'audioresample',
                    'volume', 'level', 'typefindfunctions', 'jpeg', 'png', 'imagefreeze', 'pango',
                    'playback', 'autodetect', 'alsa', 'audiotestsrc',
                    'soup', 'adaptivedemux2', 'hls', 'isomp4', 'mpegtsdemux', 'matroska', 'tcp', 'deinterlace']
    plugins = Path('/usr/lib/x86_64-linux-gnu/gstreamer-1.0')
    # Remove the old cropping plugin from an incremental 0.4.4 build too.
    (RUNTIME / 'plugins/libgstvideocrop.so').unlink(missing_ok=True)
    for name in plugin_names:
        src = plugins / ('libgst' + name + '.so')
        if not src.is_file():
            raise RuntimeError('Missing build plugin ' + str(src))
        shutil.copy2(src, RUNTIME / 'plugins' / src.name)
    shutil.copy2('/usr/bin/gst-launch-1.0', RUNTIME / 'bin/gst-launch-1.0')
    # souphttpsrc dlopens libsoup, and GIO loads its TLS backend as a module.
    soup = Path('/usr/lib/x86_64-linux-gnu/libsoup-3.0.so.0')
    tls = Path('/usr/lib/x86_64-linux-gnu/gio/modules/libgiognutls.so')
    shutil.copy2(tls, RUNTIME / 'gio' / tls.name)
    shutil.copy2('/etc/ssl/certs/ca-certificates.crt', RUNTIME / 'etc/ca-certificates.crt')
    roots = list((RUNTIME / 'plugins').glob('*.so')) + [RUNTIME / 'bin/uxplay', RUNTIME / 'bin/gst-launch-1.0',
            RUNTIME / 'bin/mgu-dacp-resolve', dns, soup, tls]
    # Native SmartX plugins load these at runtime. Do not mix the HU's glibc 2.27
    # internals (notably libdl/libpthread) into the private glibc runtime.
    libraries = {name: Path('/usr/lib/x86_64-linux-gnu') / name for name in
                 ['libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'libutil.so.1',
                  'libresolv.so.2', 'libstdc++.so.6', 'libgcc_s.so.1']}
    env = dict(os.environ, LD_LIBRARY_PATH=str(dns.parent))
    libraries[soup.name] = soup
    for item in roots:
        output = subprocess.check_output(['ldd', str(item)], text=True, env=env)
        if 'not found' in output:
            raise RuntimeError('Unresolved dependency: ' + output)
        for name in re.findall(r'(?:=>\s*)?(/[^\s()]+)', output):
            p = Path(name)
            if p.is_file():
                libraries[p.name] = p
    for name, source_lib in libraries.items():
        if name == 'libasound.so.2':
            continue  # Keep the target's ALSA and its SmartX plugin paired.
        dest = RUNTIME / 'lib' / name
        if source_lib.resolve() != dest.resolve():
            shutil.copy2(source_lib, dest)
    (RUNTIME / 'lib/libasound.so.2').unlink(missing_ok=True)
    if not (RUNTIME / 'lib/ld-linux-x86-64.so.2').is_file():
        raise RuntimeError('Private glibc loader missing')
    for name in ['gstreamer1.0-plugins-base', 'gstreamer1.0-plugins-good', 'gstreamer1.0-plugins-bad',
                 'gstreamer1.0-libav', 'libc6', 'libssl3', 'libplist3',
                 'libsoup-3.0-0', 'glib-networking', 'libgnutls30', 'ca-certificates']:
        copyright_file = Path('/usr/share/doc') / name / 'copyright'
        if copyright_file.is_file():
            shutil.copy2(copyright_file, RUNTIME / 'licenses' / (name + '.copyright'))
    shutil.copy2(WORK / 'UxPlay/LICENSE', RUNTIME / 'licenses/UxPlay.GPL-3.0')
    mdns_license = mdns / 'LICENSE'
    if mdns_license.is_file():
        shutil.copy2(mdns_license, RUNTIME / 'licenses/mDNSResponder.LICENSE')
    for executable in (RUNTIME / 'bin').iterdir():
        executable.chmod(0o755)
    (RUNTIME / 'lib/ld-linux-x86-64.so.2').chmod(0o755)
    record = {
        'format': 'mgu-airplay-runtime-v1', 'version': '0.4.8', 'architecture': 'x86_64',
        'uxplay': {'version': '1.73.7', 'revision': UX_REV},
        'mdns_client': {'version': '765.20.4', 'revision': MDNS_REV, 'daemon': 'existing MGU mdnsd'},
        'source_patch': {'file': 'lib/CMakeLists.txt', 'sha256': sha(cmake)},
        'connection_events_patch_sha256': sha(ux_source),
        'hls_renderer_patch_sha256': sha(video_source),
        'features': ['detach', 'native-detach', 'playlist', 'video-modes', 'media-stop', 'audio-only', 'auto-media', 'audio-handoff', 'video-stretch', 'video-viewport', 'session-status', 'audio-metadata', 'music-control', 'full-disconnect', 'mdns-route'],
        'audio_profile_patch_sha256': sha(ROOT / 'airplay/tools/patch_audio_mode.py'),
        'audio_metadata_patch_sha256': sha(ROOT / 'airplay/tools/patch_audio_metadata.py'),
        'audio_metadata_sha256': sha(ROOT / 'airplay/native/mgu_audio_metadata.h'),
        'music_control_patch_sha256': sha(ROOT / 'airplay/tools/patch_music_control.py'),
        'shutdown_patch_sha256': sha(ROOT / 'airplay/tools/patch_shutdown.py'),
        'session_status_patch_sha256': sha(ROOT / 'airplay/tools/patch_connection_status.py'),
        'music_control_sha256': sha(ROOT / 'airplay/native/mgu_music_control.h'),
        'dacp_resolver_sha256': sha(ROOT / 'airplay/native/mgu_dacp_resolve.c'),
        'mdns_route_sha256': sha(ROOT / 'airplay/native/mdns_route.c'),
        'dnssd_export_sha256': sha(source / 'lib/dnssd.c'),
        'network_policy_sha256': sha(ROOT / 'airplay/network.js'),
        'hls_output_sha256': sha(ROOT / 'airplay/native/mgu_hls_output.h'),
        'crash_trace_sha256': sha(ROOT / 'airplay/native/mgu_crash_trace.h'),
        'direct_play_sha256': sha(ROOT / 'airplay/native/mgu_direct_play.h'),
        'playlist_sha256': sha(ROOT / 'airplay/native/mgu_playlist.h'),
        'reverse_sha256': sha(ROOT / 'airplay/native/mgu_reverse.h'),
        'hls_lifecycle_patches': {name: sha(source / name) for name in [
            'lib/raop.c', 'lib/raop.h', 'lib/raop_handlers.h', 'lib/http_handlers.h', 'lib/airplay_video.c',
            'lib/raop_rtp.c', 'lib/raop_rtp_mirror.c', 'lib/httpd.c', 'lib/httpd.h', 'lib/http_response.c', 'lib/http_response.h',
            'lib/fcup_request.h', 'renderers/video_renderer.h', 'renderers/audio_renderer.c']},
        'drm_supported': False, 'hardware_qualified': False,
        'host_dependencies': ['existing mdnsd', 'OEM libasound.so.2 and SmartX plugin'],
        'files': {p.relative_to(RUNTIME).as_posix(): {'sha256': sha(p), 'bytes': p.stat().st_size}
                  for p in RUNTIME.rglob('*') if p.is_file() and p.name != 'build-manifest.json'},
    }
    (RUNTIME / 'build-manifest.json').write_text(json.dumps(record, indent=2))
    print(json.dumps({'runtime': str(RUNTIME), 'files': len(record['files']),
                      'bytes': sum(v['bytes'] for v in record['files'].values())}))


if __name__ == '__main__':
    main()
