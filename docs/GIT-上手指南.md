# 把这个项目放上 GitHub（新手向）

## 0. 先分清四个词

| 词 | 是什么 | 在哪 |
| --- | --- | --- |
| 仓库（repository） | 一个被 git 管理的历史记录库，所有提交都在里面 | `.git` 目录 + GitHub 上的对应仓库 |
| 工作区（working tree） | 你看到的这些文件 | `D:\video-downloader` |
| 暂存区（staging） | 你挑出来"准备放进这次提交"的改动 | `git add` 之后 |
| 提交（commit） | 一次带说明的快照，本地历史就靠它 | `git commit` 之后 |

**commit 和 push 是两件事**：commit 只写本机，push 才把它送到 GitHub。没 push 成功，别人（和网页版）都看不到。

## 1. 现在这个仓库的状态

```powershell
cd D:\video-downloader
git status
git log --oneline
git remote -v
```

- 已经做过一次 `git init` 和一个初始提交（README / LICENSE / .gitignore）。
- `git remote -v` 目前是空的：**还没有关联任何 GitHub 仓库**。
- `.gitignore` 已排除 `node_modules/`、`dist/`、`lib/`、`extension/build/`、`release/`、`tools/ffmpeg.exe` 等可再生成的东西——这些不该进仓库。

## 2. 在 GitHub 上建一个空仓库

1. 登录 GitHub → 右上角 `+` → **New repository**。
2. Repository name：`video-downloader`。
3. 可见性：先选 **Private**（只有你能看到，随时能改公开）。
4. **不要勾** "Add a README file / .gitignore / license"——本地已经有内容了，勾了会造成第一次推送冲突。
5. Create repository，然后复制页面上给出的地址，形如
   `https://github.com/你的用户名/video-downloader.git`

## 3. 把本地仓库和远端关联

```powershell
git remote add origin https://github.com/你的用户名/video-downloader.git
git remote -v          # 应能看到 origin 一行
```

如果以后地址写错了：
```powershell
git remote set-url origin <新地址>
```

## 4. 提交现在这批代码

```powershell
git add -A                       # 把当前所有改动放进暂存区（.gitignore 里的会被自动跳过）
git status                       # 确认要提交的文件清单，别把不该提交的带进去
git commit -m "feat: 独立版可运行（本机服务 + 面板 + 浏览器扩展 + 托盘 + 打包）"
```

> 提交信息写法不限，建议 `类型: 说明`，类型用 `feat`（新功能）/ `fix`（修 bug）/ `docs`（文档）/ `chore`（杂活）。

## 5. 推送上去

```powershell
git push -u origin main
```

- `-u` 的意思是"记住这条对应关系"，以后直接 `git push` 就行。
- **推到哪个分支？** 看当前分支：`git branch --show-current`。
  在你现在这个仓库里它就是 `main`，所以 `git push -u origin main` 会把内容送到 GitHub 的 `main`。
  如果你以后在别的分支上开发，推的就该是那个分支（`git push -u origin 分支名`），**不会**自动进 `main`；要进 main 得合并（`git switch main` → `git merge 分支名` → `git push`）。
- 如果默认分支叫 `master` 而你想用 `main`：
  ```powershell
  git branch -M main
  git push -u origin main
  ```

## 6. 认证：密码不行，要用令牌或密钥

GitHub 早就不收账号密码了，两种方式选一个：

**方式 A：HTTPS + 个人访问令牌（省事）**
1. GitHub → 头像 → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → Generate new token。
2. 只给这个仓库的 **Contents: Read and write** 权限，设个过期时间。
3. 生成后**立刻复制**（只显示一次），push 时：
   - Username：你的 GitHub 用户名
   - Password：**粘贴这个令牌**（不是账号密码）

Windows 上第一次输完，凭据管理器会记住，后面不用再输。

**方式 B：SSH 密钥（一次配好，长期不用管）**
```powershell
ssh-keygen -t ed25519 -C "你的邮箱"      # 一路回车，已有密钥可跳过
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard
```
把剪贴板内容贴到 GitHub → Settings → **SSH and GPG keys** → New SSH key，然后把远端换成 SSH 地址：
```powershell
git remote set-url origin git@github.com:你的用户名/video-downloader.git
ssh -T git@github.com     # 出现 "Hi 用户名!" 就成了
```

> 你机器上已经有 `~/.ssh/id_rsa`，但不确定那把公钥有没有加到 GitHub；没加过就按上面生成一把新的 ed25519。

## 7. 日常循环

```powershell
git status                     # 看改了什么
git add -A                     # 或 git add 具体文件
git commit -m "fix: 修 xxx"
git push                       # 第一次之后不需要再写 origin main
```

看历史 / 看差异：
```powershell
git log --oneline --graph
git diff                       # 工作区与暂存区
git diff --staged              # 暂存区与上次提交
```

## 8. 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Updates were rejected because the remote contains work you do not have` | GitHub 上那个仓库不是空的（建仓时勾了 README） | `git pull --rebase origin main` 之后再 `git push` |
| `Authentication failed` | 用了账号密码 | 改用令牌（第 6 节）或 SSH |
| 推送超大文件失败 | 把 `node_modules/`、`release/`、`ffmpeg.exe` 提交了 | 先 `git rm -r --cached 路径`，确认 `.gitignore` 有对应规则，再提交 |
| 文件在 `git status` 里看不到 | 被 `.gitignore` 排除了 | `git check-ignore -v 路径` 查是哪条规则 |
| 想撤销还没提交的改动 | — | `git restore 文件`（丢弃工作区改动，慎用） |
| 提交了不该提交的文件（还没 push） | — | `git reset --soft HEAD~1` 退回，改完再提交 |

## 9. 这个项目建议先别放的东西

- `%APPDATA%\video-downloader\config.json`（本机路径与偏好）
- `release/` 下打出来的 exe（要发版就用 GitHub **Releases** 传附件，不要塞进 git 历史）
- 任何令牌、cookie、登录态

`.gitignore` 已经覆盖了这些目录；提交前扫一眼 `git status` 就够了。
