#!/bin/bash
# pllana Cast end to end in the Android emulator (CI): install the app, start
# a cast to the host receiver (10.0.2.2:7104), answer the consent dialog,
# then check that real H.264 frames arrived and decode.
set -u
cd "$(dirname "$0")/../.."
OUT=$PWD/cast-e2e
rm -rf "$OUT"; mkdir -p "$OUT"
node airplay/tools/cast_e2e_receiver.js "$OUT" 246810 150 > "$OUT/receiver.out" 2>&1 &
RECEIVER=$!
APK=android/app/build/outputs/apk/debug/app-debug.apk
adb install -r -g "$APK"
adb shell pm grant io.pllana.cast android.permission.RECORD_AUDIO || true
adb shell pm grant io.pllana.cast android.permission.POST_NOTIFICATIONS || true
adb shell appops set io.pllana.cast PROJECT_MEDIA allow || true
adb shell input keyevent KEYCODE_WAKEUP; adb shell wm dismiss-keyguard || true
adb logcat -c
adb shell am start -n io.pllana.cast/.MainActivity --es host 10.0.2.2 --es code 246810 --ez autostart true
mode=""
for i in $(seq 1 40); do
  sleep 2
  if adb logcat -d -s pllanaCast | grep -q "Bildschirmaufnahme erlaubt"; then echo "consent granted"; break; fi
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 && adb shell cat /sdcard/ui.xml > "$OUT/ui-$i.xml"
  tap=$(python3 android/e2e/tap_consent.py "$mode" < "$OUT/ui-$i.xml" 2>/dev/null)
  if [ -n "$tap" ]; then
    set -- $tap; echo "tap $3 at $1,$2"; adb shell input tap "$1" "$2"
    [ "$3" = entire ] && mode=picked
  fi
done
# Stream with movement (settings list scrolling), rotate to exercise the
# encoder resize path, and come back to portrait.
sleep 5
adb shell am start -a android.settings.SETTINGS > /dev/null
for i in $(seq 1 10); do adb shell input swipe 160 500 160 150 300; adb shell input swipe 160 150 160 500 300; done
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1
sleep 4
for i in $(seq 1 6); do adb shell input swipe 500 250 500 80 300; adb shell input swipe 500 80 500 250 300; done
adb shell settings put system user_rotation 0
sleep 4
for i in $(seq 1 6); do adb shell input swipe 160 500 160 150 300; done
sleep 3
adb logcat -d -s pllanaCast > "$OUT/logcat.txt"
adb exec-out screencap -p > "$OUT/phone.png" || true
adb shell am start -n io.pllana.cast/.MainActivity > /dev/null
sleep 2
adb exec-out screencap -p > "$OUT/app.png" || true
kill $RECEIVER 2>/dev/null; sleep 2
echo "== app log"; cat "$OUT/logcat.txt"
echo "== receiver"; cat "$OUT/receiver.out"
echo "== stats"; cat "$OUT/stats.json" 2>/dev/null; echo
python3 - "$OUT" <<'PY'
import json, subprocess, sys
out = sys.argv[1]
try: stats = json.load(open(out + '/stats.json'))
except Exception: sys.exit('FAIL: no media reached the receiver')
assert stats['configs'] >= 1, 'no H.264 configuration'
assert stats['keyFrames'] >= 2, 'no key frames'
assert stats['frames'] >= 150, 'only %d frames' % stats['frames']
log = open(out + '/logcat.txt').read()
receiver = open(out + '/receiver.out').read()
assert receiver.count('session:') == 1, 'the cast was interrupted and restarted'
assert 'Größe' in log, 'rotation did not resize the encoder'
assert 'Beendet' not in log.split('Größe')[-1].split('\n')[0], 'rotation ended the cast'
first = [l for l in log.splitlines() if 'Erstes Bild kodiert' in l]
assert first, 'no frame encoded'
assert stats['invalid'] == 0, 'invalid frame types'
probe = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,nb_read_frames', '-of', 'json', out + '/stream.h264'], capture_output=True, text=True)
info = json.loads(probe.stdout)['streams'][0]
print('decoded', info)
assert int(info['nb_read_frames']) >= 120, 'decodable frames: %s' % info['nb_read_frames']
assert int(info['width']) <= 1280 and int(info['height']) <= 720, 'frame larger than 1280x720'
print('PASS: %d frames, %d key frames, %d audio blocks' % (stats['frames'], stats['keyFrames'], stats['audioBlocks']))
PY
