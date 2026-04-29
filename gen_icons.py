#!/usr/bin/env python3
"""Generate PWA icons for StudyFlow"""
import struct, zlib, base64, os

def create_png(size, color=(108, 99, 255)):
    """Create a simple solid color PNG icon"""
    width = height = size
    
    def chunk(name, data):
        c = zlib.crc32(name + data) & 0xffffffff
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', c)
    
    # IHDR
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    
    # Image data
    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter type
        for x in range(width):
            # Draw rounded square logo pattern
            cx, cy = width // 2, height // 2
            pad = size // 5
            # Four quadrant squares
            in_sq = False
            sq_size = (size - pad * 2) // 2 - pad // 4
            sq_gap = pad // 2
            for qx, qy in [(0, 0), (1, 0), (0, 1), (1, 1)]:
                sx = pad + qx * (sq_size + sq_gap)
                sy = pad + qy * (sq_size + sq_gap)
                if sx <= x < sx + sq_size and sy <= y < sy + sq_size:
                    in_sq = True
            if in_sq:
                r, g, b = color
            else:
                r, g, b = 13, 15, 20  # bg color
            raw += bytes([r, g, b])
    
    idat = chunk(b'IDAT', zlib.compress(raw))
    
    png = (
        b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', ihdr) +
        idat +
        chunk(b'IEND', b'')
    )
    return png

os.makedirs('icons', exist_ok=True)

for size in [192, 512]:
    png_data = create_png(size)
    with open(f'icons/icon-{size}.png', 'wb') as f:
        f.write(png_data)
    print(f'Created icons/icon-{size}.png ({size}x{size})')

print("Icons generated!")
