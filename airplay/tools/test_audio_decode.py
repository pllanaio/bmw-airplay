"""Decode a local synthetic ALAC frame before/after receiver audio stop/start."""
from pathlib import Path
import os
import subprocess

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.build/airplay/audio-decode-test'


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    # One 352-sample, 44.1 kHz stereo frame matching the RAOP ALAC caps.
    packet = subprocess.check_output([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'sine=frequency=440:sample_rate=44100', '-af', 'atrim=end_sample=352',
        '-ac', '2', '-c:a', 'alac', '-sample_fmt', 's16p', '-map', '0:a:0',
        '-f', 'data', 'pipe:1'], timeout=20)
    if not 8 < len(packet) < 65536 or packet[0] != 0x20:
        raise RuntimeError('Unexpected synthetic ALAC frame')
    fixture = WORK / 'sine.alac'
    fixture.write_bytes(packet)
    flags = subprocess.check_output(
        ['pkg-config', '--cflags', '--libs', 'gstreamer-app-1.0'], text=True).split()
    binary = WORK / 'test-audio-decode'
    subprocess.run(['gcc', '-O2', '-w', str(ROOT / 'airplay/native/test_audio_decode.c'),
                    '-o', str(binary), *flags, '-lm'], check=True)
    subprocess.run([str(binary), str(fixture)], check=True, timeout=15,
                   env=dict(os.environ, G_DEBUG='fatal-warnings'))


if __name__ == '__main__':
    main()
