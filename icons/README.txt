Iris image asset package

Source:
/Users/agent/Documents/95CCDF97-BB00-4280-A465-5EE5A7D874A2.png

What was done:
- Removed the connected outer white/off-white background and converted it to transparency.
- Cropped the artwork to the real image bounds so it expands close to the icon/logo borders.
- Generated transparent assets for web/logo/Tauri desktop use.
- Generated opaque iOS AppIcon assets because iOS App Store icons must not contain alpha/transparency.

Recommended files:

Master transparent logo:
/Users/agent/Documents/iris-assets/master/iris-logo-transparent-cropped.png
Use for website and in-app logo display.

Master transparent square icon:
/Users/agent/Documents/iris-assets/master/iris-icon-master-transparent-1024.png
Use as the source for desktop/app icons where alpha is accepted.

Master opaque square icon:
/Users/agent/Documents/iris-assets/master/iris-icon-master-opaque-1024.png
Use when alpha is rejected, especially iOS AppIcon.

Tauri desktop icon set:
/Users/agent/Documents/iris-assets/tauri-icons
Typical copy target: your-app/src-tauri/icons/
Includes: 32x32.png, 128x128.png, 128x128@2x.png, icon.png, icon.ico, icon.icns, Windows Square*.png variants.

Website assets:
/Users/agent/Documents/iris-assets/web
Includes: iris-logo-transparent.png, favicon sizes, transparent apple-touch-icon, opaque apple-touch-icon, 256/512 logo PNGs.

Opaque iOS AppIcon set:
/Users/agent/Documents/iris-assets/ios-appicon-opaque
Use as/inside an Xcode AppIcon.appiconset. Includes Contents.json and standard iPhone/iPad/marketing sizes.

Generation script:
/Users/agent/Documents/iris-assets/generate_iris_assets.py
Rerun with: python3 /Users/agent/Documents/iris-assets/generate_iris_assets.py

Notes:
- Transparent app icons are visually useful on desktop and web, but iOS AppIcon assets should be opaque.
- The transparent preview may show a black or checkerboard background depending on viewer; that area is transparent, not part of the image.
