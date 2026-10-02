# -*- coding: utf-8 -*-
"""Meta-自动化预填助手 - GitHub 版本检查/打包/上传工具"""
from pathlib import Path
import json, os, shutil, subprocess, sys, zipfile

REPO_URL = "https://github.com/bstbuku-ship-it/meta-autofill.git"
ROOT = Path(__file__).resolve().parent
VERSIONS = ROOT / "versions"
RELEASES = ROOT / "releases"


def run(cmd, check=True):
    print("\n> " + " ".join(cmd))
    p = subprocess.run(cmd, cwd=ROOT, text=True, encoding="utf-8", errors="replace")
    if check and p.returncode != 0:
        raise RuntimeError(f"命令执行失败，退出码：{p.returncode}")
    return p.returncode


def pause():
    try:
        input("\n按 Enter 键退出...")
    except EOFError:
        pass


def git_available():
    try:
        p = subprocess.run(["git", "--version"], text=True, capture_output=True, encoding="utf-8", errors="replace")
        print(p.stdout.strip() or p.stderr.strip())
        return p.returncode == 0
    except FileNotFoundError:
        return False


def version_key(v):
    try:
        return tuple(int(x) for x in v.split('.'))
    except Exception:
        return (-1,)


def find_versions():
    if not VERSIONS.exists():
        raise RuntimeError(f"找不到版本目录：{VERSIONS}")
    items=[]
    for d in VERSIONS.iterdir():
        if not d.is_dir():
            continue
        parts=d.name.split('.')
        if len(parts)==3 and all(x.isdigit() for x in parts):
            items.append(d)
    if not items:
        raise RuntimeError("versions 文件夹里没有找到类似 1.0.0 的版本目录。")
    return sorted(items, key=lambda p: version_key(p.name))


def validate_version(vdir):
    manifest=vdir/'manifest.json'
    if not manifest.exists():
        raise RuntimeError(f"{vdir} 缺少 manifest.json")
    try:
        data=json.loads(manifest.read_text(encoding='utf-8'))
    except Exception as e:
        raise RuntimeError(f"manifest.json JSON 无法解析：{e}")
    declared=str(data.get('version',''))
    if declared != vdir.name:
        raise RuntimeError(f"版本不一致：文件夹是 {vdir.name}，manifest.json 是 {declared}")
    required=['content.js','manifest.json','background.js','popup.js','popup.html','meta-autofill-config.json','icons']
    missing=[x for x in required if not (vdir/x).exists()]
    if missing:
        raise RuntimeError(f"{vdir.name} 缺少：{', '.join(missing)}")
    json.loads((vdir/'meta-autofill-config.json').read_text(encoding='utf-8'))


def make_release(vdir):
    RELEASES.mkdir(exist_ok=True)
    out=RELEASES/f"meta-autofill-v{vdir.name}.zip"
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
        for p in vdir.rglob('*'):
            if p.is_file():
                z.write(p, p.relative_to(vdir).as_posix())
    print(f"已生成：{out}")
    return out


def git_setup():
    if not (ROOT/'.git').exists():
        print("\n首次运行：初始化 Git 仓库")
        run(['git','init'])
    # main branch
    run(['git','branch','-M','main'])
    p=subprocess.run(['git','remote','get-url','origin'],cwd=ROOT,text=True,capture_output=True,encoding='utf-8',errors='replace')
    if p.returncode != 0:
        run(['git','remote','add','origin',REPO_URL])
    elif p.stdout.strip() != REPO_URL:
        print(f"发现 origin：{p.stdout.strip()}，将改为：{REPO_URL}")
        run(['git','remote','set-url','origin',REPO_URL])


def main():
    print('='*62)
    print(' Meta-自动化预填助手｜GitHub 版本检查 / 打包 / 上传')
    print('='*62)
    print(f'本地仓库：{ROOT}')
    print(f'GitHub：  {REPO_URL}')

    if not git_available():
        raise RuntimeError('找不到 Git。请确认 Git 已安装，并且 git.exe 已加入 PATH。')

    versions=find_versions()
    latest=versions[-1]
    print('\n检测到版本：')
    for v in versions:
        print('  -',v.name)
    print(f'\n当前最高版本：{latest.name}')
    validate_version(latest)
    release=make_release(latest)

    git_setup()
    print('\n当前 Git 状态：')
    run(['git','status','--short'],check=False)

    # Add everything. This repo is intentionally versioned as source + release zip.
    run(['git','add','-A'])
    p=subprocess.run(['git','diff','--cached','--quiet'],cwd=ROOT)
    if p.returncode == 0:
        print('\n没有新的 Git 变更需要提交。')
    else:
        msg=f'Update Meta-自动化预填助手 v{latest.name}'
        run(['git','commit','-m',msg])

    print('\n开始推送到 GitHub...')
    # First try normal push; if upstream is missing, set it.
    p=subprocess.run(['git','push','-u','origin','main'],cwd=ROOT,text=True,encoding='utf-8',errors='replace')
    if p.returncode != 0:
        raise RuntimeError('GitHub 推送失败。请检查 GitHub 登录/认证状态，以及仓库是否为空或你是否有写入权限。')

    print('\n' + '='*62)
    print(f'✅ 完成！已上传版本：{latest.name}')
    print(f'📦 发布包：{release.relative_to(ROOT)}')
    print(f'🌐 仓库：{REPO_URL[:-4]}')
    print('='*62)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('\n' + '!'*62)
        print('❌ 操作没有完成')
        print(f'原因：{e}')
        print('!'*62)
        pause()
        sys.exit(1)
    else:
        pause()
