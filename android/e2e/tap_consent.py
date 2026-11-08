"""Answers Android's screen-capture consent dialog in the emulator (CI only).

Reads a uiautomator dump on stdin and prints "x y" of the next element to tap,
or nothing. Prefers "entire screen", opens the share-mode spinner if needed,
then presses the start button."""
import re
import sys
import xml.etree.ElementTree as ET

ENTIRE = re.compile(r'^(entire screen|share entire screen|gesamter bildschirm|gesamten bildschirm teilen)$', re.I)
SINGLE = re.compile(r'^(a single app|single app|eine einzelne app|einzelne app)$', re.I)
START = re.compile(r'^(start|start now|share screen|next|starten|jetzt starten|bildschirm teilen|weiter)$', re.I)

root = ET.fromstring(sys.stdin.read())
nodes = [n for n in root.iter('node') if n.get('package', '') != 'io.pllana.cast']
texts = [(n.get('text') or n.get('content-desc') or '').strip() for n in nodes]

def center(node):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    return (x1 + x2) // 2, (y1 + y2) // 2

mode = sys.argv[1] if len(sys.argv) > 1 else ''
for node, text in zip(nodes, texts):
    if ENTIRE.match(text) and mode != 'picked':
        print('%d %d entire' % center(node)); sys.exit()
for node, text in zip(nodes, texts):
    if SINGLE.match(text) and mode == '' and not any(ENTIRE.match(t) for t in texts):
        print('%d %d spinner' % center(node)); sys.exit()
for node, text in zip(nodes, texts):
    if START.match(text) and node.get('clickable') == 'true' or (START.match(text) and node.get('class', '').endswith('Button')):
        print('%d %d start' % center(node)); sys.exit()
