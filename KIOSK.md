# 现场拍照亭 / Kiosk

入口：`http://127.0.0.1:8787/kiosk.html`

这是给线下设备用的全屏模式，和工作室工作台共用同一个后端。它只做一条最短链路：

```text
拍照 → 1024 透明卡通角色 → 选动作 → GIF → 二维码 → 手机领取
```

## 屏幕流程

1. **准备**：摄像头实时预览，提示站好、按快门。
2. **拍摄**：3 秒倒计时、闪光、抓拍。
3. **解析**：上传照片，后台做人物解析、卡通化、透明底处理。
4. **确认**：展示 1024 透明 PNG，确认 / 重拍 / 重新生成。
5. **选动作**：旋钮或方向键切换，高亮当前动作，按确认才提交。
6. **生成 GIF**：进度、耗时、失败重试。
7. **领取**：展示 GIF、二维码、领取码和倒计时。
8. **领取页**：下载、分享、有效期。

## 角色生成

后端 `pipeline.generate_character()` 现在做四步：

1. 用 `qwen-image-3.0` 把照片改成卡通角色，要求纯白背景、全身、正面。
2. 去白底，保留白色贴纸描边。
3. 失败时用 GrabCut 兜底。
4. 裁切、居中、统一输出 **1024 × 1024 RGBA PNG**。

输出前会做质量门：

- alpha 覆盖率必须在 2% 到 95% 之间
- 必须有有效人物 bbox
- 不合格就返回 `character_failed`，屏幕给「重新生成 / 重拍」

实测：一张 1024 真实感人物照片，角色生成约 **36 秒**，输出 1024 RGBA，背景透明，人物五官和旗袍都保留。

## GIF 两种模式

`KIOSK_GIF_MODE`：

- `motion`：默认。用角色 PNG + 程序化动作渲染，16 帧，240×240，约 1 到 2 秒出片，不额外调用模型。
- `ai`：走工作室的 4×4 精灵图生成，更灵活但慢，单张可能 1 到 5 分钟。

现场默认 `motion`，保证用户等得住。工作室里的整套 AI 4×4 不变。

## 状态

后端：

```text
character_queued
character_processing
character_ready
character_failed
gif_queued
gif_generating
gif_ready
gif_failed
expired
```

屏幕状态：

```text
PREVIEW → PROCESS → CHARACTER → ACTION → GIF → QR → ERROR
```

## 实体输入

当前支持三种输入，不依赖浏览器专属 SDK：

| 输入 | 映射 |
|---|---|
| 实体快门（USB 键盘模式） | `Space` / `Enter` |
| 实体确认按钮（USB 键盘模式） | `Space` / `Enter` |
| 旋钮（USB 键盘模式） | `←` / `→` |
| 鼠标滚轮 / 触控板 | 动作切换 |
| 页面按钮 | 快门、上一个、下一个、确认 |

如果快门或旋钮是串口 / HID 自定义协议，用一个本地桥接程序发：

```js
window.postMessage({ type: "kiosk-hardware", action: "shutter" }, "*");
window.postMessage({ type: "kiosk-hardware", action: "confirm" }, "*");
window.postMessage({ type: "kiosk-hardware", action: "rotate", delta: 1 }, "*");
```

页面也暴露了：

```js
window.KioskHardware.shutter();
window.KioskHardware.confirm();
window.KioskHardware.rotate(1);
```

以及 DOM 事件：

```js
document.dispatchEvent(new CustomEvent("kiosk:shutter"));
document.dispatchEvent(new CustomEvent("kiosk:confirm"));
document.dispatchEvent(new CustomEvent("kiosk:rotate", { detail: { delta: 1 } }));
```

旋钮做了 120ms 的节流和按压反馈音，切换只高亮，不会自动提交，避免误选。

## 二维码与领取

- 每个作品有唯一 `token`，二维码指向 `/claim/<token>`
- 默认有效期 30 分钟
- 过期可以「重新获取」，换新 token 和二维码
- 领取页支持下载 GIF、系统分享、复制链接
- 下载接口也会检查有效期

本机默认 `127.0.0.1`，手机扫不到。上设备时设置：

```ini
STUDIO_HOST=0.0.0.0
PUBLIC_BASE_URL=http://192.168.1.23:8787
```

`PUBLIC_BASE_URL` 必须是手机能访问的地址；二维码会用它生成。正式部署建议 HTTPS 域名。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/kiosk/sessions` | 上传照片，创建会话 |
| GET | `/api/kiosk/sessions/{id}` | 查询状态、角色、GIF、二维码 |
| POST | `/api/kiosk/sessions/{id}/retry-character` | 重新生成角色 |
| POST | `/api/kiosk/sessions/{id}/gif` | 提交动作，生成 GIF |
| POST | `/api/kiosk/sessions/{id}/refresh` | 刷新二维码与有效期 |
| GET | `/api/kiosk/sessions/{id}/qr.png` | 二维码 PNG |
| GET | `/api/claims/{token}` | 领取页数据 |
| GET | `/api/claims/{token}/download` | 下载 GIF |
| GET | `/claim/{token}` | 手机领取页 |

## 摄像头

- 浏览器要求 HTTPS 或 localhost 才能用 `getUserMedia`
- 没有摄像头时，页面会提示用示例照片继续，方便演示
- 拍摄时从视频中心裁 1024 正方形，JPEG 上传

## 已知限制

- 队列在内存里，服务重启会丢正在处理的 kiosk 会话
- 没有设备鉴权，不要把 kiosk 页面直接暴露公网
- 角色生成 30 到 60 秒，GIF motion 1 到 2 秒
- 真实感照片的抠图仍可能失败，质量门会拦截并提示重拍
- `motion` GIF 是程序化位移和粒子，不改变四肢姿势
- 二维码依赖 `PUBLIC_BASE_URL` 和局域网可达
