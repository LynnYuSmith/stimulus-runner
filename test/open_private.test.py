"""The runner opens in a PRIVATE window: Chrome with --incognito, Edge with --inprivate, on every OS.
Nothing is launched: the process calls are replaced and the argv they would have run is checked.

    python3 test/open_private.test.py
"""
import os
import subprocess
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import serve  # noqa: E402

calls = []


class FakeProc:
    returncode = 0


def fake_popen(argv, *a, **k):
    calls.append(list(argv))
    return FakeProc()


def run_case(system, exists=(), mac_apps=(), which=()):
    calls.clear()
    serve.platform.system = lambda: system
    serve.os.path.exists = lambda p: any(p.endswith(e) for e in exists)
    serve.shutil.which = lambda name: f"/usr/bin/{name}" if name in which else None

    def fake_run(argv, *a, **k):
        r = types.SimpleNamespace(returncode=0 if (argv[:2] == ["open", "-Ra"] and argv[2] in mac_apps) else 1)
        if argv[:2] != ["open", "-Ra"]:
            calls.append(list(argv))
        return r
    serve.subprocess.run = fake_run
    serve.subprocess.Popen = fake_popen
    serve.os.startfile = lambda url: calls.append(["startfile", url])
    serve.webbrowser.open = lambda url: calls.append(["webbrowser", url]) or True
    label = serve.open_in_browser("http://127.0.0.1:8000/")
    return label, calls[-1] if calls else None


real = (serve.platform.system, os.path.exists, serve.shutil.which, subprocess.run, subprocess.Popen)
try:
    label, argv = run_case("Windows", exists=("chrome.exe", "msedge.exe"))
    assert label == "Chrome, private window" and argv[0].endswith("chrome.exe") and "--incognito" in argv, (label, argv)

    label, argv = run_case("Windows", exists=("msedge.exe",))
    assert label == "Edge, private window" and "--inprivate" in argv, (label, argv)

    label, argv = run_case("Windows")
    assert label == "default browser (NOT private)" and argv[0] == "startfile", (label, argv)

    label, argv = run_case("Darwin", mac_apps=("Google Chrome",))
    assert label == "Chrome, private window" and argv[:3] == ["open", "-na", "Google Chrome"] and "--incognito" in argv, (label, argv)

    label, argv = run_case("Darwin", mac_apps=("Microsoft Edge",))
    assert label == "Edge, private window" and "--inprivate" in argv, (label, argv)

    label, argv = run_case("Linux", which=("chromium",))
    assert label == "Chromium, private window" and "--incognito" in argv, (label, argv)
finally:
    serve.platform.system, os.path.exists, serve.shutil.which, subprocess.run, subprocess.Popen = real

print("open_private: 6 cases ok")
