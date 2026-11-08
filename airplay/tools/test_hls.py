"""Synthetic, locally served HLS; exercise the private runtime without a phone."""
from pathlib import Path
import argparse
import functools
import http.server
import json
import os
import struct
import subprocess
import threading
import ssl
import sys

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.build/airplay/hls-test'
RUNTIME = ROOT / '.build/airplay/runtime'
WORK.mkdir(parents=True, exist_ok=True)
def viewport(text):
    try:
        width, height = (int(word) for word in text.split('x'))
    except (ValueError, TypeError):
        raise argparse.ArgumentTypeError('expected WIDTHxHEIGHT')
    if (min(width, height) < 16 or max(width, height) > 2048 or
            width % 2 or height % 2 or width * height > 2048 * 1080):
        raise argparse.ArgumentTypeError('viewport must be even 16..2048 with at most 2048*1080 pixels')
    return width, height
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--stretch', action='store_true')
parser.add_argument('--cover', action='store_true', help=argparse.SUPPRESS)
parser.add_argument('--split', action='store_true')
parser.add_argument('--legacy', action='store_true')
parser.add_argument('--viewport', type=viewport, default=(1920, 720))
parser.add_argument('--resize', type=viewport, help='update the viewport after real video buffers arrive')
parser.add_argument('--retain-dir', type=Path, help='retain each actual output frame for full-renderer pixel tests')
parser.add_argument('--resets', type=int, default=0, help='verify filter lifecycle release repeatedly before playback')
options = parser.parse_args()
viewport_file = WORK / 'viewport.bin'
def write_viewport(size):
    temporary = WORK / 'viewport.bin.tmp'
    with temporary.open('wb') as output:
        output.write(struct.pack('<II', *size))
    temporary.chmod(0o600)
    temporary.replace(viewport_file)
write_viewport(options.viewport)
if options.retain_dir:
    options.retain_dir = options.retain_dir.resolve()
    options.retain_dir.mkdir(parents=True, exist_ok=True)
retained = []
def run(args, **kw):
    return subprocess.run([str(a) for a in args], check=True, **kw)
fixtures = [(640, 360, 'video')]
if options.stretch or options.cover:  # old CI flag remains an alias
    fixtures += [(840, 360, 'cinema'), (640, 400, '16-10'), (360, 640, 'portrait'),
                 (1280, 252, 'ultrawide'), (960, 252, 'screen')]
for width, height, name in fixtures:
    # Distinct corners prove no source edge was removed. The asymmetric
    # gradient proves independent scaling on both axes rather than a crop.
    luma = ("if(lt(X,W/8)*lt(Y,H/8),40,"
            "if(gte(X,7*W/8)*lt(Y,H/8),88,"
            "if(lt(X,W/8)*gte(Y,7*H/8),160,"
            "if(gte(X,7*W/8)*gte(Y,7*H/8),208,64+72*X/W+40*Y/H))))")
    pattern = "nullsrc=size=%dx%d:rate=25,geq=lum='%s':cb=128:cr=128" % (width, height, luma)
    run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', pattern,
         '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3',
         '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac',
         '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', WORK / (name + '.m3u8')])
    if options.split:
        run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', pattern,
             '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-f', 'hls',
             '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_type', 'fmp4',
             '-hls_fmp4_init_filename', name + '-v-init.mp4', WORK / (name + '-v.m3u8')])
        run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
             '-t', '3', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
             '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', name + '-a-init.mp4', WORK / (name + '-a.m3u8')])
        (WORK / (name + '.m3u8')).write_text('#EXTM3U\n#EXT-X-VERSION:7\n'
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Original",DEFAULT=YES,AUTOSELECT=YES,URI="%s-a.m3u8"\n'
            '#EXT-X-STREAM-INF:BANDWIDTH=1800000,CODECS="avc1.42c01e,mp4a.40.2",RESOLUTION=%dx%d,AUDIO="audio"\n%s-v.m3u8\n'
            % (name, width, height, name))
flags = subprocess.check_output(['pkg-config', '--cflags', '--libs', 'gstreamer-1.0', 'gio-2.0'], text=True).split()
binary = WORK / 'test-hls'
run(['gcc', '-O2', '-Wall', '-Wextra', '-Werror', ROOT / 'airplay/native/test_hls_output.c', '-o', binary] + flags)
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
handler = functools.partial(Handler, directory=str(WORK))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
sys.path.insert(0, str(ROOT / 'apps/pllana_airplay'))
# Use exactly the app's mixer, replacing only the final hardware sink.
audio = subprocess.check_output(['node', '-e', 'process.stdout.write(require("./apps/pllana_airplay/audio_route").AUDIO_SINK)'], cwd=ROOT, text=True)
audio = audio[:audio.index('alsasink')] + 'identity name=mgu-audio-probe ! fakesink'
env = dict(os.environ, GST_PLUGIN_SYSTEM_PATH_1_0='', GST_PLUGIN_PATH_1_0=str(RUNTIME / 'plugins'),
           GST_REGISTRY=str(WORK / 'registry.bin'), GST_REGISTRY_FORK='no',
           GIO_MODULE_DIR=str(RUNTIME / 'gio'), G_TLS_CA_FILE=str(RUNTIME / 'etc/ca-certificates.crt'),
           MGU_HLS_AUDIO_SINK=audio, MGU_HLS_VIEWPORT_FILE=str(viewport_file))
if options.legacy: env['GST_PLUGIN_FEATURE_RANK'] = 'hlsdemux2:0'
if options.resize: env['MGU_HLS_TEST_RESIZE'] = '%dx%d' % options.resize
if options.resets: env['MGU_HLS_TEST_RESETS'] = str(options.resets)
try:
    for width, height, name in fixtures:
        write_viewport(options.viewport)
        playback_env = dict(env)
        if options.retain_dir:
            target = options.resize or options.viewport
            frame = options.retain_dir / ('%dx%d-to-%dx%d.mgvf' % (width, height, *target))
            playback_env['MGU_HLS_TEST_FRAME_FILE'] = str(frame)
            retained.append({'source': [width, height], 'viewport': list(target), 'file': str(frame)})
        run([RUNTIME / 'lib/ld-linux-x86-64.so.2', '--library-path', RUNTIME / 'lib', binary,
             'http://127.0.0.1:%d/%s.m3u8' % (server.server_port, name), width, height]
             + (['legacy'] if options.legacy else []), env=playback_env, timeout=40)
finally:
    server.shutdown(); server.server_close()
if options.retain_dir:
    (options.retain_dir / 'frames.json').write_text(json.dumps(retained, indent=2) + '\n')
cert, key = WORK / 'cert.pem', WORK / 'key.pem'
run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
     '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
     '-keyout', key, '-out', cert], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(cert, key)
server.socket = tls.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
args = [str(p) for p in [RUNTIME / 'lib/ld-linux-x86-64.so.2', '--library-path', RUNTIME / 'lib', binary,
        'https://127.0.0.1:%d/video.m3u8' % server.server_port, 640, 360]]
if options.legacy: args.append('legacy')
try:
    write_viewport(options.viewport)
    result = subprocess.run(args, env=dict(env, GST_DEBUG='souphttpsrc:3'), capture_output=True, timeout=40, text=True)
    if result.returncode != 2:
        raise RuntimeError('Untrusted HLS TLS certificate was not rejected: ' + result.stderr)
    print('Untrusted HTTPS certificate correctly rejected')
    write_viewport(options.viewport)
    run(args, env=dict(env, G_TLS_CA_FILE=str(cert)), timeout=40)
    print('Trusted HTTPS HLS passed with certificate validation enabled')
finally:
    server.shutdown(); server.server_close()
