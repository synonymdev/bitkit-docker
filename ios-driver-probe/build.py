#!/usr/bin/env python3
"""Build only. Install and drive on the test run's own lane."""
import pathlib
import plistlib
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
app = root / ".ios-driver-probe" / "DriverProbe.app"
app.mkdir(parents=True, exist_ok=True)
sdk = subprocess.check_output(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"], text=True).strip()
subprocess.run([
    "xcrun", "--sdk", "iphonesimulator", "swiftc", "-parse-as-library", "-sdk", sdk,
    "-target", "arm64-apple-ios17.0-simulator", "-module-name", "DriverProbe",
    str(root / "ios-driver-probe" / "Probe.swift"), "-o", str(app / "DriverProbe"),
], check=True)
with (app / "Info.plist").open("wb") as stream:
    plistlib.dump({
        "CFBundleIdentifier": "dev.bitkit.qa.driver-probe",
        "CFBundleExecutable": "DriverProbe", "CFBundleName": "DriverProbe",
        "CFBundlePackageType": "APPL", "CFBundleVersion": "1",
        "CFBundleShortVersionString": "1.0", "MinimumOSVersion": "17.0",
        "CFBundleSupportedPlatforms": ["iPhoneSimulator"], "UIDeviceFamily": [1, 2],
        "UIApplicationSceneManifest": {"UIApplicationSupportsMultipleScenes": False},
        "UILaunchScreen": {},
    }, stream)
subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
print(app)
