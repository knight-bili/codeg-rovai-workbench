#!/usr/bin/env bash
set -Eeuo pipefail
root="$GITHUB_WORKSPACE"
role=codeg-android
evidence="$FOUNDATION_CI_EVIDENCE"
mkdir -p "$evidence"
stage=toolchain
mark() { python3 "$root/tools/integration/record-ci-stage.py" "$role" "$stage" "$1"; }
trap 'mark failed' ERR
{ java -version; echo "SDK=$ANDROID_HOME"; } > "$evidence/toolchain.txt" 2>&1
mark passed
cd "$RUNNER_TEMP/codeg-android"
cp foundation-source.json "$evidence/source.json"
export GRADLE_USER_HOME="$RUNNER_TEMP/foundation-gradle"
chmod +x gradlew
stage=compile_and_unit_tests
./gradlew --no-daemon --console=plain :app:assembleDebug :app:testDebugUnitTest :app:lintDebug > "$evidence/gradle.log" 2>&1
cp app/build/outputs/apk/debug/app-debug.apk "$evidence/app-debug.apk"
cp -R app/build/test-results/testDebugUnitTest "$evidence/unit-tests"
cp app/build/reports/lint-results-debug.* "$evidence/"
python3 - "$evidence/unit-tests" "$evidence/unit-counts.json" <<'PY'
from pathlib import Path
import json,sys,xml.etree.ElementTree as E
counts={k:0 for k in ['tests','failures','errors','skipped']}
for p in Path(sys.argv[1]).glob('TEST-*.xml'):
    suite=E.parse(p).getroot()
    for k in counts: counts[k]+=int(suite.get(k,'0'))
assert counts['tests']>0 and counts['failures']==counts['errors']==0,counts
Path(sys.argv[2]).write_text(json.dumps(counts,indent=2))
PY
mark passed
stage=emulator_launch
# 已保存APK/测试报告后清理本次构建中间件，给标准runner的模拟器留空间。
python3 - "$RUNNER_TEMP" "$GRADLE_USER_HOME" "$PWD/app/build" "$PWD/.gradle" <<'PY'
from pathlib import Path
import shutil,sys
temporary=Path(sys.argv[1]).resolve()
for value in sys.argv[2:]:
    target=Path(value).resolve()
    assert target!=temporary and target.is_relative_to(temporary)
    if target.exists():shutil.rmtree(target)
PY
export ANDROID_USER_HOME="$RUNNER_TEMP/foundation-android-config"
export ANDROID_AVD_HOME="$RUNNER_TEMP/foundation-avds"
mkdir -p "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME"
image='system-images;android-36;default;x86_64'
printf '%s\n' "$image" > "$evidence/system-image.txt"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "$image" 'emulator' 'platform-tools' > "$evidence/sdk-install.log" 2>&1
export PATH="$ANDROID_HOME/platform-tools:$PATH"
test -x "$ANDROID_HOME/platform-tools/adb"
adb version > "$evidence/adb-version.txt"
echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n foundation-api36 -p "$ANDROID_AVD_HOME/foundation-api36.avd" -k "$image" --device pixel_6 > "$evidence/avd.log" 2>&1
python3 - "$ANDROID_AVD_HOME/foundation-api36.avd/config.ini" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
settings={'disk.dataPartition.size':'2048M','hw.lcd.width':'720','hw.lcd.height':'1280','hw.lcd.density':'320','hw.ramSize':'2048','hw.cpu.ncore':'2'}
lines=[line for line in p.read_text().splitlines() if line.partition('=')[0] not in settings]
p.write_text('\n'.join(lines+[f'{key}={value}' for key,value in settings.items()])+'\n')
PY
"$ANDROID_HOME/emulator/emulator" -list-avds > "$evidence/avd-list.txt"
grep -Fx foundation-api36 "$evidence/avd-list.txt"
test -e /dev/kvm
sudo chmod 666 /dev/kvm
df -h "$RUNNER_TEMP" > "$evidence/space-before-emulator.txt"
"$ANDROID_HOME/emulator/emulator" -avd foundation-api36 -port 5554 -partition-size 2048 -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect > "$evidence/emulator.log" 2>&1 &
emulator_pid=$!
trap 'kill "$emulator_pid" >/dev/null 2>&1 || true' EXIT
export ANDROID_SERIAL=emulator-5554
sleep 5
kill -0 "$emulator_pid"
timeout 300s bash -e -c 'adb wait-for-device; until [[ "$(adb shell getprop sys.boot_completed | tr -d "\r")" == 1 ]]; do sleep 2; done'
sleep 30
adb shell input keyevent 82
adb install "$evidence/app-debug.apk" > "$evidence/install.txt"
adb shell am start -W -n app.codeg.android.debug/app.codeg.android.MainActivity > "$evidence/launch.txt"
sleep 5
adb shell pidof app.codeg.android.debug > "$evidence/app-process.txt"
adb shell uiautomator dump /sdcard/foundation-window.xml > "$evidence/ui-dump.log"
adb pull /sdcard/foundation-window.xml "$evidence/startup.xml" > "$evidence/ui-pull.log" 2>&1
adb exec-out screencap -p > "$evidence/startup.png"
adb shell dumpsys activity activities > "$evidence/activities.txt"
adb logcat -d -b crash > "$evidence/crash-log.txt"
python3 - "$evidence/startup.xml" "$evidence/system-ui-recovery.json" <<'PY'
import json,re,subprocess,sys,xml.etree.ElementTree as E
nodes=list(E.parse(sys.argv[1]).iter('node'))
system_anr=any(n.get('package')=='android' and n.get('resource-id')=='android:id/alertTitle' and n.get('text')=="System UI isn't responding" for n in nodes)
wait=next((n for n in nodes if n.get('package')=='android' and n.get('resource-id')=='android:id/aerr_wait'),None)
recovered=system_anr and wait is not None
if recovered:
    x1,y1,x2,y2=map(int,re.findall(r'\d+',wait.get('bounds','')))
    subprocess.run(['adb','shell','input','tap',str((x1+x2)//2),str((y1+y2)//2)],check=True)
with open(sys.argv[2],'w') as output:json.dump({'systemUiAnrObserved':system_anr,'systemWaitTapped':recovered},output)
PY
if python3 - "$evidence/system-ui-recovery.json" <<'PY'
import json,sys
sys.exit(0 if json.load(open(sys.argv[1]))['systemWaitTapped'] else 1)
PY
then
  cp "$evidence/startup.xml" "$evidence/system-ui-blocked.xml"
  cp "$evidence/startup.png" "$evidence/system-ui-blocked.png"
  sleep 30
  adb shell am start -W -n app.codeg.android.debug/app.codeg.android.MainActivity >> "$evidence/launch.txt"
  adb shell uiautomator dump /sdcard/foundation-window.xml >> "$evidence/ui-dump.log"
  adb pull /sdcard/foundation-window.xml "$evidence/startup.xml" >> "$evidence/ui-pull.log" 2>&1
  adb exec-out screencap -p > "$evidence/startup.png"
fi
python3 - "$evidence/startup.xml" <<'PY'
import sys,xml.etree.ElementTree as E
nodes=list(E.parse(sys.argv[1]).iter('node'))
assert any(n.get('package')=='app.codeg.android.debug' for n in nodes),'Application is not foreground'
assert not any(n.get('resource-id')=='android:id/alertTitle' for n in nodes),'Application or system error dialog present'
PY
adb shell pidof app.codeg.android.debug > "$evidence/app-process.txt"
mark passed
