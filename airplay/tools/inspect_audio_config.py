"""Inspect locally copied routing protobufs without modifying vehicle files."""
from pathlib import Path
import json


def varint(data, pos):
    value = 0
    for shift in range(0, 70, 7):
        if pos >= len(data):
            raise ValueError('truncated varint')
        byte = data[pos]
        pos += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, pos
    raise ValueError('varint overflow')


def fields(data):
    pos = 0
    result = []
    while pos < len(data):
        key, pos = varint(data, pos)
        number, wire = key >> 3, key & 7
        if number == 0:
            raise ValueError('zero field number')
        if wire == 0:
            value, pos = varint(data, pos)
        elif wire in (1, 2, 5):
            if wire == 2:
                size, pos = varint(data, pos)
            else:
                size = 8 if wire == 1 else 4
            if size > len(data) - pos:
                raise ValueError('truncated field')
            value = data[pos:pos + size]
            pos += size
        else:
            raise ValueError('unsupported wire type')
        result.append((number, wire, value))
    return result


def scalar_fields(data):
    result = []
    for number, wire, value in fields(data):
        if wire == 0:
            result.append([number, value])
        elif wire == 2 and value and all(32 <= c <= 126 for c in value):
            result.append([number, value.decode('ascii')])
    return result


if __name__ == '__main__':
    folder = Path(__file__).resolve().parents[2] / '.local/airplay/audio-config'
    for file in sorted(folder.glob('*.bin')):
        print(file.name)
        for number, wire, value in fields(file.read_bytes()):
            if wire == 2:
                record = scalar_fields(value)
                if any(isinstance(v, str) for _, v in record):
                    print(json.dumps({'tag': number, 'fields': record}))
