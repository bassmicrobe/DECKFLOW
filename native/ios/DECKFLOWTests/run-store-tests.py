#!/usr/bin/env python3
"""Run the actual USB store tests in a temporary macOS Swift package.

This exercises Foundation file coordination, staging, rollback and reconnect
without a Simulator or connected USB. It does not test UIKit's folder picker
or WKWebView; those remain in the iOS test target.
"""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    if sys.platform != "darwin":
        raise SystemExit("NativeUSBStore tests require macOS Foundation and Swift.")
    ios = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="deckflow-usb-tests-") as temporary:
        package = Path(temporary)
        source = package / "Sources" / "DECKFLOW"
        tests = package / "Tests" / "DECKFLOWTests"
        source.mkdir(parents=True)
        tests.mkdir(parents=True)
        (package / "Package.swift").write_text(
            '// swift-tools-version: 5.9\n'
            'import PackageDescription\n'
            'let package = Package(name: "USBStoreTests", platforms: [.macOS(.v13)], '
            'targets: [.target(name: "DECKFLOW"), '
            '.testTarget(name: "DECKFLOWTests", dependencies: ["DECKFLOW"])])\n',
            encoding="utf-8",
        )
        shutil.copy2(ios / "DECKFLOW" / "NativeUSBStore.swift", source)
        shutil.copy2(ios / "DECKFLOWTests" / "NativeUSBTests.swift", tests)
        return subprocess.run(["swift", "test", "--package-path", str(package)], check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
