# Twitter / X copy · DSH-PaperReading

> 三个原则：**第一句就要扎人**；第二句给证据；第三句给去处。
> 配图：`images/x-1-cover.png`（单条）或 `images/xhs-3-shot.png`（thread 第 2 条）。

---

## 一、中文单条（选一条直接发）

### A · 痛点开场（推荐）

> 读英文论文最痛苦的不是看不懂，
> 是你要同时开四个窗口：PDF、翻译、GPT、笔记。
>
> 试了个 DeepSeek Harness 的插件 DSH-PaperReading：左中文页右原版页逐页对照，划词就出译文，对话回答带 [p.12] 页码能跳回原文。
>
> 开源 MIT，数据全在本机。
> github.com/wuke-luke/DSH-PaperReading

### B · 反常识开场

> 别再用翻译软件读论文了。
>
> 整页翻译会把公式、图表、双栏全打碎。
> 这个插件换了个思路：原文不动，中文按原位置回填，右边还是原版。
>
> DeepSeek Harness 插件 DSH-PaperReading，开源 MIT。
> github.com/wuke-luke/DSH-PaperReading

### C · 数字对比

> 一篇 40 页的论文，我以前要开着 PDF + 翻译 + GPT + 笔记四个窗口读一晚上。
>
> 现在：一个侧栏。
> 对照、划词、提问（带页码）、记笔记，全在里面。
>
> 开源 DSH 插件，数据不出本机。
> github.com/wuke-luke/DSH-PaperReading

### D · 一句话暴论

> AI 时代最离谱的浪费，是让研究生一边读论文一边复制粘贴。
>
> 装了个 DeepSeek Harness 插件 DSH-PaperReading，四件事收进一个侧栏：对照翻译 / 划词即译 / 带页码的论文对话 / 笔记。
> github.com/wuke-luke/DSH-PaperReading

---

## 二、English single (pick one)

### A · Pain hook

> The worst part of reading papers isn't the math.
> It's the four-window shuffle: PDF → translator → ChatGPT → notes.
>
> Found a DeepSeek Harness plugin that collapses it into one sidebar — bilingual pages, select-to-translate, chat with page citations.
>
> MIT, runs locally.
> github.com/wuke-luke/DSH-PaperReading

### B · Contrarian hook

> Stop feeding papers to a translator that shreds the layout.
>
> This one keeps the original page and writes the translation back into the same boxes — formulas, figures and two-column text stay put.
>
> DSH-PaperReading, open source.
> github.com/wuke-luke/DSH-PaperReading

### C · Short & punchy

> 40 pages. One sidebar.
> Translate ⇄ original page by page, drag to translate, ask the paper and get answers with page numbers.
>
> Open-source plugin for DeepSeek Harness.
> github.com/wuke-luke/DSH-PaperReading

---

## 三、Thread（最强形态，4 条）

**1/**
> Reading a paper shouldn't require four windows.
>
> I tried a DeepSeek Harness plugin that puts the PDF, the translation, the chat and the notes in one sidebar: DSH-PaperReading.

**2/**
> The translation is the interesting part.
>
> It doesn't re-flow the paper. It writes Chinese back into the original paragraph boxes, with the background colour sampled from the page — so two-column layouts, tinted abstract boxes and figures survive.

**3/**
> And it does the boring-but-vital stuff:
> • arXiv ID / link / local PDF import
> • drag a sentence → translation next to the cursor
> • paper chat that cites [p.12] and jumps there
> • notes, diagrams, sync, per-paper token usage

**4/**
> Everything stays on your machine — PDFs, translations, notes. MIT licensed, no keys baked in.
>
> Install: `dsh plugin --profile web add https://github.com/wuke-luke/DSH-PaperReading`
>
> github.com/wuke-luke/DSH-PaperReading

---

## 四、发布技巧（为什么这么写）

| 做法 | 原因 |
|---|---|
| 第一行不超过 12 个字就断句 | 时间线只露前两行，钩子必须在折叠线以上 |
| 先讲"痛"，再讲"它怎么解决" | 直接列功能没人看，痛点才有共鸣 |
| 单条不放链接，链接放回复 | 带外链的推文曝光更低 |
| 具体数字（4 个窗口 / 40 页 / [p.12]） | 抽象形容词不如可验证的细节 |
| 一条只讲一个点 | thread 第 2 条单独讲"翻译不破坏版式"，这是和竞品的差异 |
| 结尾给可复制的安装命令 | 降低行动成本，转推的人也能直接试 |

## 五、可选的钩子素材（自己再组合）

- "把 PDF 丢给 AI 的时代，早该结束了。"
- "你读论文的时间，一半花在窗口切换上。"
- "翻译软件把你的公式翻没了，对吧？"
- "Open source, no cloud, no keys."（英文收尾很好用）
