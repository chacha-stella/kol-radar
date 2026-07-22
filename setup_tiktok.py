import getpass
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SETTINGS_PATH = ROOT / "config" / "local-settings.json"


def main():
    token = getpass.getpass("Paste TikTok msToken (hidden): ").strip()
    if not token:
        raise SystemExit("TikTok msToken is required.")

    try:
        settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        settings = {}
    settings["tiktokMsToken"] = token
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    print("TikTok token saved to the private local settings file.")
    print("This file is excluded from GitHub.")


if __name__ == "__main__":
    main()
