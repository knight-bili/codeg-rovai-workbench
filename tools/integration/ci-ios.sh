#!/usr/bin/env bash
set -Eeuo pipefail
root="$GITHUB_WORKSPACE"
role=codeg-ios
evidence="$FOUNDATION_CI_EVIDENCE"
mkdir -p "$evidence"
stage=toolchain
mark() { python3 "$root/tools/integration/record-ci-stage.py" "$role" "$stage" "$1"; }
trap 'mark failed' ERR
export DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer
{ sw_vers; xcodebuild -version; xcodebuild -showsdks; } > "$evidence/toolchain.txt"
brew install xcodegen > "$evidence/xcodegen-install.log" 2>&1
xcodegen --version >> "$evidence/toolchain.txt"
mark passed
cd "$RUNNER_TEMP/codeg-ios"
cp foundation-source.json "$evidence/source.json"
stage=compile_simulator
xcodegen generate > "$evidence/project.log" 2>&1
xcodebuild -project CodegiOS.xcodeproj -scheme CodegiOS -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$RUNNER_TEMP/codeg-ios-derived" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= build > "$evidence/compile.log" 2>&1
app="$RUNNER_TEMP/codeg-ios-derived/Build/Products/Debug-iphonesimulator/Codeg.app"
test -d "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$evidence/codeg-simulator.app.zip"
mark passed
stage=simulator_launch
xcrun simctl list devices available --json > "$evidence/simulators.json"
udid=$(python3 - "$evidence/simulators.json" <<'PY'
import json,sys
devices=json.load(open(sys.argv[1]))['devices']
candidates=[d for runtime,rows in devices.items() if 'iOS-26' in runtime for d in rows if d['isAvailable'] and d['name'].startswith('iPhone')]
assert candidates,'No iOS 26 iPhone simulator runtime'
print(candidates[0]['udid'])
PY
)
trap 'xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true' EXIT
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b > "$evidence/boot.log" 2>&1
xcrun simctl install "$udid" "$app"
xcrun simctl launch "$udid" app.codeg.ios > "$evidence/launch.txt"
sleep 5
xcrun simctl spawn "$udid" launchctl list > "$evidence/processes.txt"
grep -F app.codeg.ios "$evidence/processes.txt" > "$evidence/app-process.txt"
xcrun simctl io "$udid" screenshot "$evidence/startup.png"
mark passed
