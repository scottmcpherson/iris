Iris image asset package

This directory contains the checked-in Iris app icon and logo assets used by the
desktop app, web surface, and packaging scripts.

Recommended files:

- icons/master/iris-logo-transparent-cropped.png
  Use for website and in-app logo display.

- icons/master/iris-icon-master-transparent-1024.png
  Use as the source for desktop/app icons where alpha is accepted.

- icons/master/iris-icon-master-opaque-1024.png
  Use when alpha is rejected, especially AppIcon-style outputs.

- icons/tauri-icons/
  Tauri desktop icon set. This is the typical copy source for
  desktop/src-tauri/icons/.

- icons/web/
  Website assets, including logo PNGs, favicon sizes, and apple-touch-icon
  variants.

- icons/ios-appicon-opaque/
  Opaque AppIcon-style output with Contents.json and standard icon sizes.

Generation script:

- icons/generate_iris_assets.py

The script is historical and still contains the original local source/output
paths. Update its SRC and OUT values before rerunning it for fresh assets.

Notes:

- Transparent app icons are visually useful on desktop and web, but AppIcon
  outputs should be opaque.
- Transparent previews may show a black or checkerboard background depending on
  the viewer; that area is transparent, not part of the image.
