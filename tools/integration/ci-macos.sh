#!/usr/bin/env bash
set -Eeuo pipefail
root="$GITHUB_WORKSPACE"
role="$FOUNDATION_APP-macos-$FOUNDATION_ARCH"
evidence="$FOUNDATION_CI_EVIDENCE"
mkdir -p "$evidence"
stage=toolchain
mark() { python3 "$root/tools/integration/record-ci-stage.py" "$role" "$stage" "$1"; }
trap 'mark failed' ERR
{ sw_vers; xcodebuild -version; rustc -Vv; node --version; pnpm --version; df -h .; } > "$evidence/toolchain.txt"
mark passed
stage=dependencies
if [[ "$FOUNDATION_APP" == rovai ]]; then
  cd "$root"
else
  cd "$RUNNER_TEMP/codeg-macos"
  cp foundation-source.json "$evidence/source.json"
fi
if [[ "$FOUNDATION_APP" == rovai ]]; then
  pnpm install --frozen-lockfile > "$evidence/dependencies.log" 2>&1
else
  pnpm install --frozen-lockfile --ignore-scripts > "$evidence/dependencies.log" 2>&1
fi
mark passed
stage=compile
if [[ "$FOUNDATION_APP" == rovai ]]; then
  pnpm "build:macos:$FOUNDATION_ARCH" > "$evidence/compile.log" 2>&1
  mark passed
  stage=package
  CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --"$FOUNDATION_ARCH" --publish never -c.mac.identity=- > "$evidence/package.log" 2>&1
  app="dist/mac-arm64/Rovai AI.app"
  if [[ "$FOUNDATION_ARCH" == x64 ]]; then app="dist/mac/Rovai AI.app"; fi
  node scripts/verify-macos-app.mjs "$FOUNDATION_ARCH" "$app" >> "$evidence/package.log" 2>&1
  ditto -c -k --sequesterRsrc --keepParent "$app" "$evidence/rovai-preview.app.zip"
  mark passed
  stage=electron_fixtures
  ROVAI_REQUIRE_ELECTRON_INTEGRATION=1 pnpm test:desktop-bridge > "$evidence/electron.log" 2>&1
  ROVAI_REQUIRE_ELECTRON_INTEGRATION=1 pnpm test:window-close >> "$evidence/electron.log" 2>&1
  mark passed
else
  pnpm run postinstall > "$evidence/assets.log" 2>&1
  # 使用固定源的原生sidecar和桌面构建；不启用Updater签名或正式发布。
  pnpm tauri build --ci --debug --bundles app --no-sign --config '{"bundle":{"createUpdaterArtifacts":false}}' > "$evidence/compile.log" 2>&1
  mark passed
  stage=package
  app="src-tauri/target/debug/bundle/macos/codeg.app"
  test -d "$app"
  lipo -archs "$app/Contents/MacOS/codeg" > "$evidence/architecture.txt"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$evidence/codeg-preview.app.zip"
  mark passed
fi
