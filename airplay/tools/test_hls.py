"""Synthetic, locally served HLS; exercise the private runtime without a phone."""
from pathlib import Path
import functools
import http.server
import os
import subprocess
import threading
import ssl

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.build/airplay/hls-test'
RUNTIME = ROOT / '.build/airplay/runtime'
WORK.mkdir(parents=True, exist_ok=True)
def run(args, **kw):
    return subprocess.run([str(a) for a in args], check=True, **kw)
run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
     '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3',
     '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac',
     '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', WORK / 'video.m3u8'])
if '--split' in __import__('sys').argv:
    run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
         '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-f', 'hls',
         '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_type', 'fmp4',
         '-hls_fmp4_init_filename', 'v-init.mp4', WORK / 'v.m3u8'])
    run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
         '-t', '3', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
         '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'a-init.mp4', WORK / 'a.m3u8'])
    (WORK / 'video.m3u8').write_text('#EXTM3U\n#EXT-X-VERSION:7\n'
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Original",DEFAULT=YES,AUTOSELECT=YES,URI="a.m3u8"\n'
        '#EXT-X-STREAM-INF:BANDWIDTH=1800000,CODECS="avc1.42c01e,mp4a.40.2",RESOLUTION=640x360,AUDIO="audio"\nv.m3u8\n')
flags = subprocess.check_output(['pkg-config', '--cflags', '--libs', 'gstreamer-1.0', 'gio-2.0'], text=True).split()
binary = WORK / 'test-hls'
run(['gcc', '-O2', '-Wall', '-Wextra', '-Werror', ROOT / 'airplay/native/test_hls_output.c', '-o', binary] + flags)
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
handler = functools.partial(Handler, directory=str(WORK))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
import sys
sys.path.insert(0, str(ROOT / 'apps/pllana_airplay'))
# Use exactly the app's mixer, replacing only the final hardware sink.
audio = subprocess.check_output(['node', '-e', 'process.stdout.write(require("./apps/pllana_airplay/audio_route").AUDIO_SINK)'], cwd=ROOT, text=True)
audio = audio[:audio.index('alsasink')] + 'identity name=mgu-audio-probe ! fakesink'
env = dict(os.environ, GST_PLUGIN_SYSTEM_PATH_1_0='', GST_PLUGIN_PATH_1_0=str(RUNTIME / 'plugins'),
           GST_REGISTRY=str(WORK / 'registry.bin'), GST_REGISTRY_FORK='no',
           GIO_MODULE_DIR=str(RUNTIME / 'gio'), G_TLS_CA_FILE=str(RUNTIME / 'etc/ca-certificates.crt'),
           MGU_HLS_AUDIO_SINK=audio)
if '--legacy' in sys.argv: env['GST_PLUGIN_FEATURE_RANK'] = 'hlsdemux2:0'
try:
    run([RUNTIME / 'lib/ld-linux-x86-64.so.2', '--library-path', RUNTIME / 'lib', binary,
         'http://127.0.0.1:%d/video.m3u8' % server.server_port] + (['2'] if '--legacy' in sys.argv else []), env=env, timeout=40)
finally:
    server.shutdown(); server.server_close()
cert, key = WORK / 'cert.pem', WORK / 'key.pem'
run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
     '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
     '-keyout', key, '-out', cert], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(cert, key)
server.socket = tls.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
args = [str(p) for p in [RUNTIME / 'lib/ld-linux-x86-64.so.2', '--library-path', RUNTIME / 'lib', binary,
        'https://127.0.0.1:%d/video.m3u8' % server.server_port]]
if '--legacy' in sys.argv: args.append('2')
try:
    result = subprocess.run(args, env=dict(env, GST_DEBUG='souphttpsrc:3'), capture_output=True, timeout=40, text=True)
    if result.returncode != 2:
        raise RuntimeError('Untrusted HLS TLS certificate was not rejected: ' + result.stderr)
    print('Untrusted HTTPS certificate correctly rejected')
    run(args, env=dict(env, G_TLS_CA_FILE=str(cert)), timeout=40)
    print('Trusted HTTPS HLS passed with certificate validation enabled')
finally:
    server.shutdown(); server.server_close()
