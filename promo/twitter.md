# Twitter / X copy · DSH-PaperReading

> 主线只有一句：**有人给 DeepSeek Harness 写了个读论文的插件**。
> 配图：`images/x-1-cover.png`（单条）／`images/xhs-3-shot.png`（thread 第 2 条）。

---

## 一、主推：Emoji 清单体（中文，一条发完）

> 有人给 DeepSeek Harness 写了个读论文的插件 🐳📖
>
> 📥 PDF / arXiv 链接拖进去
> 🀄 左边中文页，右边原版页，一页对一页
> 🖱 拖选一句 → 光标旁直接出译文
> 💬 问它这篇论文，回答带 [p.12]，点了跳过去
> 📝 笔记 🧭 框架图 ☁️ 同步 🔢 token 记账
> 🔒 全在本机跑，开源 MIT
>
> github.com/wuke-luke/DSH-PaperReading

---

## 二、主推：Emoji 清单体（English, one tweet）

> Someone built a paper-reading plugin for DeepSeek Harness 🐳📖
>
> 📥 drop a PDF or an arXiv link
> 🀄 Chinese page left, original page right, page by page
> 🖱 drag a sentence → translation appears next to the cursor
> 💬 ask the paper, answers cite [p.12] and jump there
> 📝 notes 🧭 diagrams ☁️ sync 🔢 token usage
> 🔒 local-first, MIT
>
> github.com/wuke-luke/DSH-PaperReading

---

## 三、更长一点的中文版（想多讲一句"为什么"时用）

> 有人给 DeepSeek Harness 写了读论文的插件 🐳📖
>
> 以前读一篇英文论文：PDF 查词 → 浏览器翻译整页 → 复制段落问 GPT → 笔记记在第四个 app。
>
> 它把这四件事塞进一个侧栏：
> 🀄 左中文页 / 右原版页，逐页对照，公式图表不动
> 🖱 划词即译，不用开新窗口
> 💬 对话带页码，点一下跳回原文
> 🔒 翻译和对话都在本机发起
>
> 开源 MIT 👉 github.com/wuke-luke/DSH-PaperReading

---

## 四、Thread（Emoji 版，4 条）

**1/**
> 🐳 Someone built a paper-reading plugin for DeepSeek Harness.
>
> One sidebar: PDF + translation + chat + notes. No more four-window shuffle.
>
> DSH-PaperReading 🧵

**2/**
> 🀄 The translation is the clever part.
>
> It doesn't re-flow the paper — it writes Chinese back into the original paragraph boxes and samples the background colour from the page. Two-column layouts, tinted abstract boxes, figures: all stay.

**3/**
> What you get inside:
>
> 📥 local PDF / arXiv ID / arXiv link
> 🖱 drag a sentence → translation at the cursor
> 💬 paper chat citing [p.12]
> 📝 notes 🧭 diagrams ☁️ sync 🔢 token usage

**4/**
> 🔒 PDFs, translations and notes never leave your machine. MIT, no keys baked in.
>
> Install: `dsh plugin --profile web add https://github.com/wuke-luke/DSH-PaperReading`
>
> github.com/wuke-luke/DSH-PaperReading

---

## 五、备选开场（换开头，正文不变）

- 🐳 有人做了个读论文的插件，专治「四个窗口来回切」。
- 📄 把论文丢给 AI 的时代结束了——现在是把 AI 装进论文阅读器。
- 🀄 左边中文，右边原文，一页对一页。有人真把它做出来了。
- 🔍 划一句翻一句，比复制到翻译软件快十倍（不夸张，真的）。

## 六、发布技巧

| 做法 | 原因 |
|---|---|
| 第一行就是「有人做了个插件」+ emoji | 时间线只露前两行，钩子必须是"发现有东西"的信号 |
| emoji 每行一个，行内不超过 20 字 | 手机上一眼扫完，信息密度高但不挤 |
| 单条不放链接，链接放第一条回复 | 带外链的推曝光更低 |
| 具体数字（[p.12] / 四个窗口 / 一页对一页） | 抽象形容词不如可验证的细节 |
| thread 第 2 条单独讲"不破坏版式" | 这是和普通整页翻译的唯一差异，也是最值得转的一句 |
