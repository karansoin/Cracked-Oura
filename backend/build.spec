# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the local backend. Built by `npm run build:backend`.
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

hidden = []
for pkg in ("uvicorn", "bleak", "cryptography", "langchain", "langchain_core", "langchain_community",
            "langchain_ollama", "langchain_openai", "langgraph", "pydantic", "sqlalchemy", "pandas"):
    try:
        hidden += collect_submodules(pkg)
    except Exception:
        pass
for pkg in ("backend.src.ble", "backend.src.analysis", "backend.src.api", "numpy"):
    try:
        hidden += collect_submodules(pkg)
    except Exception:
        pass
hidden += ["backend.src.ble.manager", "backend.src.ble.live", "backend.src.ble.simulator", "backend.src.api.ble_routes",
           "backend.src.api.live_routes", "backend.src.api.insights_routes", "backend.src.analysis.session_metrics",
           "multipart", "python_multipart"]

datas = [('src', 'backend/src')]
for pkg in ("langchain", "langchain_core", "langchain_community", "langchain_ollama", "langchain_openai", "langgraph", "bleak"):
    try:
        datas += collect_data_files(pkg)
    except Exception:
        pass

a = Analysis(
    ['src/api/main.py'],
    pathex=['..'],
    binaries=[],
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'PyQt5', 'PySide2', 'IPython', 'notebook', 'pytest'],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='backend', debug=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='backend')
