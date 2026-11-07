#!/bin/sh
set -eu
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
/usr/bin/node --check "$BASE/launch.js"
/usr/bin/node --check "$BASE/network.js"
/usr/bin/node --check "$BASE/activate.js"
/usr/bin/node --check "$BASE/deactivate.js"
"$BASE/runtime/lib/ld-linux-x86-64.so.2" --library-path "$BASE/runtime/lib" --list "$BASE/runtime/bin/uxplay" >/dev/null
test -f "$BASE/runtime/plugins/libgstalsa.so"
test -f "$BASE/runtime/plugins/libgstmguvideo.so"
test ! -e "$BASE/runtime/lib/libasound.so.2"
echo "AirPlay runtime: Node syntax and private ELF runtime verified"
