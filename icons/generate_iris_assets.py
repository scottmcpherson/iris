#!/usr/bin/env python3
from pathlib import Path
from collections import deque
import json
import subprocess
from PIL import Image

SRC = Path('/Users/agent/Documents/95CCDF97-BB00-4280-A465-5EE5A7D874A2.png')
OUT = Path('/Users/agent/Documents/iris-assets')
TAURI = OUT / 'tauri-icons'
WEB = OUT / 'web'
IOS = OUT / 'ios-appicon-opaque'
MASTER = OUT / 'master'
for d in [TAURI, WEB, IOS, MASTER]:
    d.mkdir(parents=True, exist_ok=True)

img = Image.open(SRC).convert('RGBA')
w, h = img.size
pix = img.load()

# Flood-fill only the connected near-white outer background so pale stone inside the artwork is preserved.
def is_outer_bg(r, g, b, a):
    if a < 10:
        return True
    # Conservative: white/off-white source background; avoids eating into stone relief.
    return r >= 244 and g >= 244 and b >= 244 and ((255-r) + (255-g) + (255-b) <= 36)

bg = bytearray(w*h)
q = deque()
for x in range(w):
    for y in (0, h-1):
        r,g,b,a = pix[x,y]
        if is_outer_bg(r,g,b,a):
            i = y*w + x
            if not bg[i]:
                bg[i] = 1; q.append((x,y))
for y in range(h):
    for x in (0, w-1):
        r,g,b,a = pix[x,y]
        if is_outer_bg(r,g,b,a):
            i = y*w + x
            if not bg[i]:
                bg[i] = 1; q.append((x,y))

while q:
    x,y = q.popleft()
    for nx,ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
        if 0 <= nx < w and 0 <= ny < h:
            i = ny*w + nx
            if not bg[i]:
                r,g,b,a = pix[nx,ny]
                if is_outer_bg(r,g,b,a):
                    bg[i] = 1
                    q.append((nx,ny))

transparent = img.copy()
tp = transparent.load()
xs=[]; ys=[]
for y in range(h):
    for x in range(w):
        if bg[y*w+x]:
            r,g,b,a = tp[x,y]
            tp[x,y] = (r,g,b,0)
        else:
            xs.append(x); ys.append(y)
if not xs:
    raise RuntimeError('No foreground detected')

bbox = (min(xs), min(ys), max(xs)+1, max(ys)+1)
cropped = transparent.crop(bbox)

# Save exact transparent cropped logo; this is best for website/Tauri logo rendering.
cropped_path = MASTER / 'iris-logo-transparent-cropped.png'
cropped.save(cropped_path)

# Square transparent master: artwork scaled to touch at least one border, no extra visual padding.
side = max(cropped.size)
square = Image.new('RGBA', (side, side), (255,255,255,0))
square.alpha_composite(cropped, ((side-cropped.width)//2, (side-cropped.height)//2))
square_path = MASTER / 'iris-icon-master-transparent-1024.png'
square1024 = square.resize((1024,1024), Image.Resampling.LANCZOS)
square1024.save(square_path)

# Optional opaque master for platforms that reject alpha (iOS AppIcon). Use a sampled warm stone color.
opaque_bg = (246, 242, 235, 255)
opaque1024 = Image.new('RGBA', (1024,1024), opaque_bg)
opaque1024.alpha_composite(square1024)
opaque_path = MASTER / 'iris-icon-master-opaque-1024.png'
opaque1024.convert('RGB').save(opaque_path)

# Website/logo assets
web_sizes = {
    'iris-logo-transparent.png': None,
    'favicon-16x16.png': 16,
    'favicon-32x32.png': 32,
    'favicon-48x48.png': 48,
    'apple-touch-icon-180x180.png': 180,
    'logo-256x256.png': 256,
    'logo-512x512.png': 512,
}
for name, size in web_sizes.items():
    if size is None:
        cropped.save(WEB / name)
    else:
        square1024.resize((size,size), Image.Resampling.LANCZOS).save(WEB / name)
# Apple touch icons often render best as opaque even on the web.
opaque1024.resize((180,180), Image.Resampling.LANCZOS).convert('RGB').save(WEB / 'apple-touch-icon-180x180-opaque.png')

# Tauri common icons
for name, size in [
    ('32x32.png', 32),
    ('128x128.png', 128),
    ('128x128@2x.png', 256),
    ('icon.png', 512),
    ('icon-1024.png', 1024),
    ('Square30x30Logo.png', 30),
    ('Square44x44Logo.png', 44),
    ('Square71x71Logo.png', 71),
    ('Square89x89Logo.png', 89),
    ('Square107x107Logo.png', 107),
    ('Square142x142Logo.png', 142),
    ('Square150x150Logo.png', 150),
    ('Square284x284Logo.png', 284),
    ('Square310x310Logo.png', 310),
    ('StoreLogo.png', 50),
]:
    square1024.resize((size,size), Image.Resampling.LANCZOS).save(TAURI / name)

# ICO with several embedded sizes.
ico_path = TAURI / 'icon.ico'
square1024.save(ico_path, sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])

# macOS ICNS via iconutil if available.
iconset = TAURI / 'icon.iconset'
iconset.mkdir(exist_ok=True)
iconset_specs = [
    ('icon_16x16.png',16),('icon_16x16@2x.png',32),('icon_32x32.png',32),('icon_32x32@2x.png',64),
    ('icon_128x128.png',128),('icon_128x128@2x.png',256),('icon_256x256.png',256),('icon_256x256@2x.png',512),
    ('icon_512x512.png',512),('icon_512x512@2x.png',1024)
]
for name, size in iconset_specs:
    square1024.resize((size,size), Image.Resampling.LANCZOS).save(iconset/name)
try:
    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(TAURI/'icon.icns')], check=True, capture_output=True, text=True)
except Exception as e:
    (TAURI/'ICNS_GENERATION_FAILED.txt').write_text(str(e))

# iOS AppIcon PNGs must be opaque/no alpha. Generate a reusable opaque appicon set.
ios_sizes = [20,29,40,58,60,76,80,87,120,152,167,180,1024]
for size in sorted(set(ios_sizes)):
    opaque1024.resize((size,size), Image.Resampling.LANCZOS).convert('RGB').save(IOS / f'AppIcon-{size}x{size}.png')

# Minimal Contents.json for Xcode AppIcon.appiconset. Includes common iPhone/iPad slots.
contents = {
  'images': [
    {'idiom':'iphone','size':'20x20','scale':'2x','filename':'AppIcon-40x40.png'},
    {'idiom':'iphone','size':'20x20','scale':'3x','filename':'AppIcon-60x60.png'},
    {'idiom':'iphone','size':'29x29','scale':'2x','filename':'AppIcon-58x58.png'},
    {'idiom':'iphone','size':'29x29','scale':'3x','filename':'AppIcon-87x87.png'},
    {'idiom':'iphone','size':'40x40','scale':'2x','filename':'AppIcon-80x80.png'},
    {'idiom':'iphone','size':'40x40','scale':'3x','filename':'AppIcon-120x120.png'},
    {'idiom':'iphone','size':'60x60','scale':'2x','filename':'AppIcon-120x120.png'},
    {'idiom':'iphone','size':'60x60','scale':'3x','filename':'AppIcon-180x180.png'},
    {'idiom':'ipad','size':'20x20','scale':'1x','filename':'AppIcon-20x20.png'},
    {'idiom':'ipad','size':'20x20','scale':'2x','filename':'AppIcon-40x40.png'},
    {'idiom':'ipad','size':'29x29','scale':'1x','filename':'AppIcon-29x29.png'},
    {'idiom':'ipad','size':'29x29','scale':'2x','filename':'AppIcon-58x58.png'},
    {'idiom':'ipad','size':'40x40','scale':'1x','filename':'AppIcon-40x40.png'},
    {'idiom':'ipad','size':'40x40','scale':'2x','filename':'AppIcon-80x80.png'},
    {'idiom':'ipad','size':'76x76','scale':'1x','filename':'AppIcon-76x76.png'},
    {'idiom':'ipad','size':'76x76','scale':'2x','filename':'AppIcon-152x152.png'},
    {'idiom':'ipad','size':'83.5x83.5','scale':'2x','filename':'AppIcon-167x167.png'},
    {'idiom':'ios-marketing','size':'1024x1024','scale':'1x','filename':'AppIcon-1024x1024.png'}
  ],
  'info': {'version': 1, 'author': 'xcode'}
}
(IOS / 'Contents.json').write_text(json.dumps(contents, indent=2))

manifest = {
    'source': str(SRC),
    'source_size': [w,h],
    'detected_foreground_bbox': bbox,
    'cropped_logo_size': list(cropped.size),
    'outputs': {
        'master_transparent_logo': str(cropped_path),
        'master_transparent_icon_1024': str(square_path),
        'master_opaque_icon_1024': str(opaque_path),
        'web_dir': str(WEB),
        'tauri_dir': str(TAURI),
        'ios_opaque_dir': str(IOS),
    },
    'notes': [
        'Outer connected white/off-white background was made transparent.',
        'Transparent master is intended for website/logo/Tauri desktop use.',
        'Opaque iOS set is provided because iOS AppIcon assets must not contain alpha.'
    ]
}
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest, indent=2))
