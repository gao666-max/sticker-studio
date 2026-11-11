# 硬件接入说明

这份文档是周五接硬件前的协议约定。现在硬件还没到，`device_agent.py` 用 stub 跑通了事件、打印、支付三条链路。

## 架构

```text
kiosk.html（浏览器）
   │  EventSource http://127.0.0.1:8788/events
   │  POST /event /print /payment/intent
   ▼
device_agent.py（本机设备代理，只监听 127.0.0.1:8788）
   ├─ 快门 / 确认 / 旋钮
   ├─ 打印机
   ├─ 支付
   └─ 串口 / HID 适配层（周五接）
   │
   ▼
server.py（业务后端，8787）
   ├─ 会话、AI 队列
   ├─ 角色 / GIF
   └─ 二维码 / 领取页
```

不要从浏览器直接开串口、打印机或现金模块。浏览器权限、驱动和异常恢复都不可靠。设备代理负责这些，页面只发事件。

## 事件协议

`POST http://127.0.0.1:8788/event`

```json
{"action": "shutter", "source": "hardware"}
{"action": "confirm", "source": "hardware"}
{"action": "rotate", "delta": 1, "source": "hardware"}
```

允许的 action：

- `shutter`：拍照页按下快门
- `confirm`：角色页 / 动作页确认
- `rotate`：动作选择旋钮，`delta` 为 +1 / -1

代理会把事件通过 `GET /events` 的 SSE 推给所有打开的 kiosk 页面。页面里的 `connectDeviceAgent()` 收到后调用与键盘相同的处理函数。

## 打印协议

`POST http://127.0.0.1:8788/print`

```json
{"sessionId": "ks_xxx", "imageUrl": "http://127.0.0.1:8787/api/kiosk/sessions/ks_xxx/files/01.gif", "copies": 1}
```

返回：

```json
{"id": "pr_xxx", "status": "queued", "copies": 1}
```

`GET /print/{id}` 查询状态。现在 stub 1 秒后变 `printed`。

周五要替换的部分在 `device_agent.py` 的 `handle_print`：

- DNP DS-RX1HS：用 DNP 驱动 / SDK 打 4×6
- 热敏：Windows 驱动或 ESC/POS
- 打印前先让客户看到取片口提示
- 卡纸、缺纸、开盖要回传 `failed`，运营台能看见

## 支付协议

`POST http://127.0.0.1:8788/payment/intent`

```json
{"amount": 1990}
```

返回 `id`、`status: pending`、`qrText`。现在 `qrText` 是 `sticker-demo://pay/...`，不是真支付。

周五要替换的部分：

- 支付宝 / 微信：创建预下单，返回真实二维码内容
- `GET /payment/{id}` 轮询支付结果
- 支付成功才进拍照流程，失败 / 超时要能退单
- 现金模块走串口脉冲，单独做防作弊和找零

## 硬件映射

| 硬件 | 现在 | 周五接法 |
|---|---|---|
| 摄像头 | `getUserMedia` | 保持 UVC，优先 1080P |
| 快门按钮 | 键盘 Space / `/event` | USB HID 键盘模式，或串口代理 |
| 旋钮 | 方向键 / `/event` | USB HID 或串口编码器 |
| 打印机 | `/print` stub | DNP / 热敏 SDK |
| 扫码支付 | `/payment/intent` stub | 支付网关 API |
| 补光 | 无 | 串口 / DMX / 继电器 |
| 现金 | 无 | 串口脉冲 + 找零模块 |

## 周五检查清单

1. 跑 `start-device-agent.bat`，打开 `http://127.0.0.1:8787/hardware.html`，点快门、确认、旋钮，kiosk 要响应。
2. 接真实快门和旋钮，确认一次动作只触发一次，不连击。
3. 接打印机，先打一张测试图，确认 4×6、边距、颜色、透明背景处理。
4. 接支付，先跑 0.01 元测试单，确认回调、超时、退款。
5. 断网测试：AI 不可用时页面要停在可恢复状态，不能白屏。
6. 断电测试：重启后队列自动续跑，原图按设置删除。
7. 连续跑 20 单，记录平均时长、失败率、卡纸率。

## 现在就能测

```powershell
python device_agent.py
python test_smoke.py
```

浏览器打开：

- 现场模式：`http://127.0.0.1:8787/kiosk.html`
- 硬件模拟器：`http://127.0.0.1:8787/hardware.html`
- 运营台：`http://127.0.0.1:8787/booth.html`，PIN `2468`

## 还没做

- 真实串口 / HID 驱动
- 真实打印机 SDK
- 真实支付网关
- 多设备集中队列
- 设备许可证 / 远程 OTA
