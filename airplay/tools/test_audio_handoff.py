"""Real SETUP96/UDP/ALAC regression across production HLS renderer handoff."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import subprocess
import threading

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.build/airplay/audio-handoff-test'


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    packet = subprocess.check_output([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'sine=frequency=440:sample_rate=44100', '-af', 'atrim=end_sample=352',
        '-ac', '2', '-c:a', 'alac', '-sample_fmt', 's16p', '-map', '0:a:0',
        '-f', 'data', 'pipe:1'], timeout=20)
    if not 8 < len(packet) < 65536 or packet[0] != 0x20:
        raise RuntimeError('Unexpected synthetic RAOP ALAC frame')
    fixture = WORK / 'sine.alac'
    fixture.write_bytes(packet)
    playlist = WORK / 'video.m3u8'
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
        'testsrc=size=128x72:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100',
        '-t', '60', '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-c:v', 'libx264',
        '-threads', '1', '-preset', 'ultrafast', '-g', '20', '-pix_fmt', 'yuv420p',
        '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
        '-hls_segment_filename', str(WORK / 'video-%03d.ts'), str(playlist)], check=True, timeout=30)
    flags = subprocess.check_output([
        'pkg-config', '--cflags', '--libs', 'gstreamer-app-1.0', 'gstreamer-video-1.0',
        'gio-2.0', 'libplist-2.0', 'openssl'], text=True).split()
    bridge = WORK / 'handoff-bridge.o'
    subprocess.run([
        'gcc', '-DPLIST_210', '-O2', '-w', '-ffunction-sections', '-fdata-sections',
        '-I', str(ROOT / '.build/airplay/uxplay-source/lib'), '-c',
        str(ROOT / 'airplay/native/test_audio_handoff_bridge.c'), '-o', str(bridge), *flags], check=True)
    binary = WORK / 'test-audio-handoff'
    dns = ROOT / '.local/airplay/mDNSResponder/mDNSPosix/build/prod'
    subprocess.run([
        'g++', '-O2', '-w', '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections',
        str(ROOT / 'airplay/native/test_audio_handoff.cpp'), str(bridge),
        str(ROOT / '.build/airplay/uxplay-build/renderers/librenderers.a'),
        str(ROOT / '.build/airplay/uxplay-build/lib/libairplay.a'),
        str(ROOT / '.build/airplay/uxplay-build/lib/llhttp/libllhttp.a'),
        str(ROOT / '.build/airplay/uxplay-build/lib/playfair/libplayfair.a'),
        str(dns / 'libdns_sd.so'), '-Wl,-rpath,' + str(dns), '-o', str(binary),
        *flags, '-lpthread', '-lm'], check=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(WORK)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        env = dict(os.environ, G_DEBUG='fatal-warnings', GST_PLUGIN_FEATURE_RANK='hlsdemux2:0')
        # Every media URL in this test is the loopback fixture above. libsoup
        # can otherwise route it through an inherited CI proxy despite no_proxy.
        for name in list(env):
            if name.lower() in ('http_proxy', 'https_proxy', 'all_proxy'):
                env.pop(name)
        env['no_proxy'] = env['NO_PROXY'] = '127.0.0.1,localhost,::1'
        subprocess.run([
            str(binary), str(fixture), 'http://127.0.0.1:%d/video.m3u8' % server.server_port],
            check=True, timeout=60, env=env)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == '__main__':
    main()
