#!/bin/bash
set -euo pipefail
cd -- "$(dirname "$0")"
SOURCE_APP="$PWD/贾维斯.app"
DESTINATION="$HOME/Applications/贾维斯.app"
finish() { printf '\n按回车关闭此窗口。'; read -r _ || true; }
trap finish EXIT
if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '请在 Mac 上运行这个安装程序。\n'; exit 1
fi
if [[ ! -d "$SOURCE_APP/Contents" ]]; then
  printf '请先完整解压 ZIP，让此脚本和“贾维斯.app”位于同一个文件夹。\n'; exit 1
fi
if [[ -e "$DESTINATION" ]]; then
  printf '安装位置已有贾维斯：%s\n请先退出并手动移走旧程序，再重新安装。现有数据不会删除。\n' "$DESTINATION"; exit 1
fi
if [[ ! -x /usr/bin/codesign ]]; then
  printf '未找到 macOS 自带签名工具，无法完成本地安装。\n'; exit 1
fi
printf '正在将贾维斯安装到：%s\n' "$DESTINATION"
mkdir -p "$HOME/Applications"
/usr/bin/ditto "$SOURCE_APP" "$DESTINATION"
# Ad-hoc signatures require no account, certificate, key, or network service.
# Sign each bundled native extension before sealing the enclosing Electron app.
while IFS= read -r -d '' binary; do
  if /usr/bin/file -b "$binary" | /usr/bin/grep -q 'Mach-O'; then
    /usr/bin/codesign --force --sign - "$binary"
  fi
done < <(/usr/bin/find "$DESTINATION/Contents/Resources/app" -type f -print0)
/usr/bin/codesign --force --deep --sign - --entitlements "$DESTINATION/Contents/Resources/app/entitlements.mac.plist" "$DESTINATION"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$DESTINATION"
printf '\n安装完成。没有导入任何发送者的 API、照片或文档。\n'
printf '如 macOS 提示来源未验证，请按系统“隐私与安全性”提示处理。\n'
/usr/bin/open "$DESTINATION"
