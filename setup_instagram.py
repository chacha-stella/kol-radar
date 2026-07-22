import getpass
import json
from pathlib import Path

import instaloader


ROOT = Path(__file__).resolve().parents[1]
SETTINGS_PATH = ROOT / "config" / "local-settings.json"


def main():
    username = input("Instagram username: ").strip().lstrip("@")
    if not username:
        raise SystemExit("Instagram username is required.")

    password = getpass.getpass("Instagram password (hidden): ")
    loader = instaloader.Instaloader(download_pictures=False, download_videos=False)
    try:
        loader.login(username, password)
    except instaloader.exceptions.TwoFactorAuthRequiredException:
        code = input("Instagram 2FA code: ").strip()
        loader.two_factor_login(code)
    except Exception as error:
        print("Instagram 拒绝了自动登录，通常是风控或网络限制。")
        print("不要连续重试，也不要把密码发到聊天里。")
        print(f"详细原因：{type(error).__name__}")
        print("本次不保存密码；你可以直接关闭窗口，系统仍可采集 YouTube、TikTok 和部分 Instagram 公开资料。")
        return
    loader.save_session_to_file()

    try:
        settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        settings = {}
    settings["instagramUsername"] = username
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    print("Instagram session saved. The password was not written to the project.")


if __name__ == "__main__":
    main()
