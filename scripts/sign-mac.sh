#!/bin/bash
# Local ad-hoc sign + DMG builder — mirrors what the GitHub Action does
set -e

ARCH=${1:-arm64}   # arm64 or x64

echo "→ Building for $ARCH..."
npm run build

echo "→ Packaging..."
npx electron-builder --mac dir --$ARCH --publish never

if [ "$ARCH" = "arm64" ]; then
  APPDIR="dist/mac-arm64"
else
  APPDIR="dist/mac"
fi

APP=$(find "$APPDIR" -maxdepth 1 -name "*.app" | head -1)
if [ -z "$APP" ]; then
  echo "Error: no .app found in $APPDIR"
  exit 1
fi

echo "→ Writing entitlements..."
cat > /tmp/local-ai.entitlements <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
EOF

echo "→ Signing $APP ..."
codesign \
  --entitlements /tmp/local-ai.entitlements \
  --force \
  --deep \
  --sign - \
  "$APP"

echo "→ Creating DMG..."
STAGING=$(mktemp -d)
cp -r "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

VERSION=$(node -p "require('./package.json').version")
DMG="dist/local-ai-v${VERSION}-${ARCH}.dmg"

hdiutil create \
  -volname "local-ai" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  -imagekey zlib-level=9 \
  "$DMG"

rm -rf "$STAGING"

echo ""
echo "✓ Done: $DMG"
echo "  Open with: open \"$DMG\""
