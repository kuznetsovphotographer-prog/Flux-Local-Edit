"""Start the configured Stability Matrix ComfyUI without opening its GUI."""
import json
import logging
import msvcrt
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.request import ProxyHandler, build_opener


COMFY = Path(os.environ["LOCAL_EDIT_COMFYUI_DIR"])
HOST = "127.0.0.1"
PORT = 8188
DATA = Path(os.environ["LOCALAPPDATA"]) / "LocalEdit"
OPENER = build_opener(ProxyHandler({}))


def listening():
    try:
        with socket.create_connection((HOST, PORT), timeout=1):
            return True
    except OSError:
        return False


def ready():
    try:
        with OPENER.open(f"http://{HOST}:{PORT}/system_stats", timeout=2) as response:
            data = json.load(response)
            return bool(data.get("system", {}).get("comfyui_version"))
    except (OSError, ValueError, AttributeError):
        return False


def launch():
    if listening():
        logging.info("Port %s already has a listener; existing process was not changed.", PORT)
        return
    python = COMFY / "venv" / "Scripts" / "python.exe"
    entry = COMFY / "main.py"
    if not python.is_file() or not entry.is_file():
        raise FileNotFoundError(f"ComfyUI with a Windows venv is not present at {COMFY}")
    cmd = [str(python), "-s", str(entry), "--listen", HOST, "--port", str(PORT),
           "--disable-auto-launch", "--dont-print-server", "--preview-method", "taesd"]
    with (DATA / "comfy-server.log").open("wb") as output:
        child = subprocess.Popen(cmd, cwd=COMFY, stdin=subprocess.DEVNULL, stdout=output,
                                 stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    logging.info("Started ComfyUI (PID %s).", child.pid)
    deadline = time.monotonic() + 150
    while True:
        if child.poll() is not None:
            raise RuntimeError(f"ComfyUI exited with code {child.returncode}; see comfy-server.log")
        if ready():
            logging.info("ComfyUI ready on port %s.", PORT)
            return
        if deadline is not None and time.monotonic() >= deadline:
            logging.warning("Startup exceeded 150 seconds; retaining the launch lock while ComfyUI starts.")
            deadline = None
        time.sleep(1)


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=DATA / "comfy-launch.log", encoding="utf-8", level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        with (DATA / "comfy-launch.lock").open("a+b") as lock:
            if lock.tell() == 0:
                lock.write(b"1")
                lock.flush()
            lock.seek(0)
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                logging.info("A Local Edit launcher is already starting ComfyUI.")
                return
            launch()
    except Exception:
        logging.exception("Could not start ComfyUI.")
        raise


if __name__ == "__main__":
    main()
