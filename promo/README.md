# 宣传物料 · DSH-PaperReading

给小红书 / Twitter 用的图片与文案。图片都是真实界面截图 + 品牌卡片，用无头浏览器渲染（`promo/cards.html`），改完 UI 重新生成即可。

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `images/xhs-1-cover.png` | 1080×1440 | 小红书首图 |
| `images/xhs-2-features.png` | 1080×1440 | 四宫格：导入 / 对照 / 划词 / 对话 |
| `images/xhs-3-shot.png` | 1080×1440 | 真实界面（对照模式） |
| `images/xhs-4-install.png` | 1080×1440 | 安装三步 + 命令 |
| `images/x-1-cover.png` | 1200×675 | Twitter / X 单条配图 |
| `xiaohongshu.md` | — | 标题 / 正文 / 标签 / 发布技巧 |
| `twitter.md` | — | 中英单条 + 3 条 thread + alt text |

## 重新生成图片

```bash
# 需要先起本地预览
node dev/server.mjs

node dev/shot.mjs "file:///D:/.../promo/cards.html?card=cover"    promo/images/xhs-1-cover.png   1400 1080 1440
node dev/shot.mjs "file:///D:/.../promo/cards.html?card=features" promo/images/xhs-2-features.png 1400 1080 1440
node dev/shot.mjs "file:///D:/.../promo/cards.html?card=shot"     promo/images/xhs-3-shot.png     1400 1080 1440
node dev/shot.mjs "file:///D:/.../promo/cards.html?card=install"  promo/images/xhs-4-install.png  1400 1080 1440
node dev/shot.mjs "file:///D:/.../promo/cards.html?card=cover&ratio=x&w=1200&h=675" promo/images/x-1-cover.png 1400 1200 675
```

`cards.html` 支持 `?card=cover|features|shot|install`、`?ratio=x`（紧凑版）、`?w=&h=`（画布尺寸，必须与截图视口一致）。

## 口径

- 一律写成**推荐/使用体验**，不要出现「我们做的」「官方」这类表述；
- 事实要能对得上：开源 MIT、数据留在本机、模型可用 DSH 账号或自己的 API Key、需要 DSH 0.2+ 与 Node 22+；
- 小红书正文不放外链，GitHub 地址放评论区；Twitter 第 1 条不放链接。
