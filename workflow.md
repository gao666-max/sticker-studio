# DSH Image Studio / 可复用工作流 v1

一条从角色图到 8 张微信表情、5 张配套素材、预览与交付 zip 的生产线。

工具：DSH + dsh-image-gen + DashScope qwen-image-3.0 + Python / Pillow。

## 0. 适用与边界

适合：原创角色、本人、客户已授权的角色。

不适合：明星、影视动漫游戏角色、网络二创形象、他人画作、未成年人公开投稿。

不承诺过审。注册、实名、投稿由用户本人完成。

## 1. 输入

| 输入 | 说明 |
|---|---|
| character.png | 角色锚点，1024 透明底 |
| pack.json | 8 句话、8 个动作、风格 |
| 参考图 | 客户照片或已有角色图 |

## 2. 目录

```text
project/
├─ character.png
├─ pack.json
├─ prompts/
│  ├─ 00_character.txt
│  └─ 01_receive.txt ... 08_tea.txt
├─ sheets/
│  └─ 01.png ... 08.png
├─ assets_raw/
│  ├─ cover.png
│  ├─ icon.png
│  ├─ banner.png
│  ├─ reward_guide.png
│  └─ reward_thanks.png
├─ submit/
├─ 预览.html
├─ 预览.png
├─ 上架文案.md
└─ 交付给客户.zip
```

## 3. 五段式提示词

提示词不是作文，是参数。顺序固定：角色锚定、画布结构、动作分镜、文字系统、负面约束。

### 3.1 角色锚定

```text
Turn the subject of this photo into an original, heavily stylized cute cartoon sticker character: cute cartoon, thick clean dark outlines, flat colors, warm 1990s Chinese retro palette. Keep the identifying features: {{hair}}, {{face}}, {{accessories}}, {{outfit}}. It must clearly read as a drawing, never photorealistic. Front-facing full body, centered, fully transparent background, no text, no border.
```

1024 x 1024，透明底。先确认像不像、是不是明显卡通、背景是否真透明。

### 3.2 4×4 精灵图

```text
Use the character in the input image exactly: {{character_lock}}.

Draw ONE square image: exactly 4 columns x 4 rows = 16 equal square cells. Read left to right, top to bottom, each cell is the next frame of one short looping animation. No grid lines, no borders, no numbers.

Background must be truly transparent (PNG alpha). Do NOT paint a grey-and-white checkerboard pattern.

In every cell the character stays exactly the same size and on the same ground line, fully inside the cell with at least 8% empty margin on all four sides.

Row 1 (frames 1-4): {{row1}}
Row 2 (frames 5-8): {{row2}}
Row 3 (frames 9-12): {{row3}}
Row 4 (frames 13-16): {{row4}}

Frame 16 must flow smoothly back into frame 1.

Every cell has the same bold hand-lettered caption "{{caption}}" at the bottom, with a thick white sticker outline around both the caption and the character. No other text.

Absolutely no watermark, no logo, no signature, no "AI generated" mark anywhere in the image.
```

输出 1:1、1024。生成后先数格、再看水印、再看字幕，最后才看动作。

### 3.3 4×1 关键帧

关键道具不能消失、角色不能变形时，把 16 格拆成 4 格。

```text
Use the character in the reference image exactly: {{character_lock}}.

Draw ONE wide image: exactly 4 equal square cells in a single horizontal row (4 columns x 1 row). No grid lines, no borders, no frames, no dividing lines between cells. One continuous warm beige background.

All four cells contain the SAME girl at exactly the same size, same ground line, fully inside her cell with at least 8% empty margin on all four sides. Each cell contains the SAME one big red heart, held with both hands; the heart must never be missing, deformed, or hidden behind her arms.

Do NOT draw any arc, curved path, trajectory, dotted line, dashed line, motion line, arrow, or swirl. Add exactly 4 small pink hearts per cell, scattered along the route; never connect them with a line.

Cell 1: {{pose1}}
Cell 2: {{pose2}}
Cell 3: {{pose3}}
Cell 4: {{pose4}}

No text, numbers, letters, logos, signatures, or watermarks anywhere.

Wide 4:1 composition, 2048x512.
```

### 3.4 中间姿势

4 个关键姿势不够丝滑时，补左上 / 右上两个位置。

```text
Use the character in the reference image exactly: {{character_lock}}.

Draw ONE wide image: exactly 4 equal square cells in a single horizontal row. No grid lines, no borders. One continuous warm beige background.

All four cells: same girl, same size, same ground line, 8% empty margin. Each cell: the SAME one big red heart, held with both hands; never missing, never deformed, never hidden behind her arms.

Do NOT draw any arc, path, trajectory, dotted line, motion line, arrow, or swirl. Add exactly 4 small pink hearts per cell.

Cell 1: heart at the UPPER-LEFT diagonal, between chest and overhead; arms bent up-left; body leans left; looks up-left.
Cell 2: heart at the UPPER-RIGHT diagonal, between chest and overhead; arms bent up-right; body leans right; looks up-right.
Cell 3: exactly the same pose as Cell 1.
Cell 4: exactly the same pose as Cell 2.

No text, numbers, letters, logos, signatures, or watermarks.

Wide 4:1 composition, 2048x512.
```

### 3.5 单图 + 指定中文

```text
Use the character in the reference image exactly: {{character_lock}}.

A cute, exaggerated, funny "totally broke" scene: she leans forward slightly, holding an empty wallet upside down with both hands and shaking it; only one small coin and one dry autumn leaf fall out. Her eyebrows droop, her eyes are big and teary, her mouth is pursed in a pitiful but comical expression. Warm beige background with subtle radial speed lines behind her. Cute and meme-like, not sad, not realistic, not photographic.

At the bottom of the image, two lines of bold hand-lettered Chinese text, dark brown with a thick white sticker outline, centered, not covering the character:
Line 1, large: 「老爸，给点钱吧」
Line 2, smaller: 「我真的没钱了」

Use exactly these characters and punctuation, no typos. Apart from these two lines, absolutely no other text, numbers, letters, logos, signatures, or watermarks anywhere in the image.

Square 1:1 composition, 1024x1024.
```

中文长句先出图，再逐字校。错一个字就重抽，或后期补字。

### 3.6 负面约束

```text
NO grid lines, NO borders, NO panel frames, NO cell numbers.
NO watermark, NO logo, NO signature, NO "AI generated" mark.
NO text except the one specified caption.
NO grey-and-white checkerboard pretending to be transparency.
NO motion blur, NO dust clouds, NO semi-transparent effects.
NO extra fingers, NO extra limbs, NO redesign of the character.
NO clipping at cell edges; keep at least 8% empty margin.
NO arc / path / trajectory / dotted line / motion line when the brief says "only small hearts".
```

只写你真的会验收的项。全部大写，一行一条，放在最后。

## 4. 参数

| 项目 | 值 |
|---|---|
| 精灵图 | 2048 x 2048，4 x 4，512/格 |
| 精灵图留白 | 8% |
| GIF | 240 x 240，16 帧 |
| GIF 帧率 | 120ms/帧（表情包），80-100ms/帧（梗图） |
| GIF 体积 | ≤500KB |
| GIF 调色板 | 128 色（表情包），256 色（高清） |
| 封面 | 240 x 240，透明底 |
| 图标 | 50 x 50，≤100KB |
| 横幅 | 750 x 400 |
| 赞赏引导 | 750 x 560 |
| 赞赏致谢 | 750 x 750 |
| 单图 | 1024 x 1024，1:1 |

## 5. 质检闸门

硬闸门，任何一条不过就不进入后处理：

- 4 x 4 = 16 格，格数正确
- 无网格线、分格线、数字
- 无水印、logo、签名
- 字幕逐字正确，无错别字
- 角色身份一致：脸、发型、服装、配饰
- 关键物体每格都在：爱心、钱包、道具
- 不压边，至少 8% 留白
- 同一角色身高、脚底线
- GIF 240 x 240、16 帧、≤500KB
- 5 张配套素材尺寸正确、无文字

软闸门，人眼逐条看：

- 首尾帧能循环，不跳帧
- 表情在 240px 下可读
- 动作差异足够，不是只换字
- 深色背景无白边
- 色彩统一，不脏、不糊
- 横幅不切头，人物完整
- 中文手写体不挡主体

## 6. 后处理

1. 假透明：`tools_detach.py` 按亮度与饱和度抠底，补 8px 白边。
2. 留白：逐格缩到 94%，四周留出安全边。
3. 切帧：4 x 4 等分，左上到右下，每格 512。
4. 归一化：按角色身高 330、脚底线 470 统一 4 个关键姿势。
5. GIF：240 x 240，16 帧，全局调色板，128 色，压到 500KB 以内。
6. 深色背景看白边，首尾帧看循环。

## 7. 构建与交付

```bash
python sticker.py build "项目目录"
python sticker.py check "项目目录"
```

产物：

- `submit/表情图/01.gif ... 08.gif`
- `submit/封面图.png`
- `submit/聊天面板图标.png`
- `submit/详情页横幅.png`
- `submit/赞赏引导图.png`
- `submit/赞赏致谢图.png`
- `预览.html` / `预览.png`
- `上架文案.md`
- `交付给客户.zip`

`check` 的 FAIL 必须清零。WARN 逐条人眼复核。

## 8. 失败规则

| 症状 | 根因 | 修法 | 规则 |
|---|---|---|---|
| 假透明 | 模型把棋盘格当视觉提示 | tools_detach.py 抠底 | 先看 alpha 通道 |
| 水印 | 模型默认加水印 | 换模型 / 循环帧替换 | 水印是硬否决 |
| 8 格而不是 16 格 | 模型把 4x4 理解成 4x2 | 重抽，先数格 | 格数是第一眼检查项 |
| 16 格漏画爱心 / 网格线 | 一次生成注意力不够 | 4x1 关键帧 + 拼装 | 关键物体少格多次 |
| 人物大小漂移 / 压边 | 没有全局网格约束 | 按身高 / 脚线归一化 | 一致性靠后处理 |
| 横幅切头 | 方形原图居中裁切 | 保留头顶的顶部裁切 | 横图先留头部空间 |
| 4 姿势不丝滑 | 关键帧太少 | 补左上 / 右上中间姿势 | 丝滑 = 密度 x 节奏 |
| 中文错字 | 中文是生成结果 | 逐字校，错字重抽 | 中文是验收项 |

## 9. 30 分钟 Quickstart

1. 换角色：替换 `character.png`，先看像不像、是不是明显卡通、背景是否真透明。
2. 换文案：改 `pack.json` 的 word、caption、action。每张动作必须不同，含义词 ≤4 字。
3. 跑一张试样：先用 4x4 或 4x1 出一张，过格数、水印、字幕、压边四道闸门，再批量。
4. 过闸门：硬项全过才进入后处理。失败写一句话，带着原因重抽，不整批重来。
5. 构建交付：build、check、人眼复核、打包。把失败与参数写回复盘页。

## 10. 复盘

下一次先做三件事：

- 先出一张试样，再批量。
- 把失败写进提示词，而不是留在聊天记录。
- 能用 4x1 就不用 4x4。

---

角色与素材版权归原作者 / 客户所有。分享时请保留出处与上下文。
