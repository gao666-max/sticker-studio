# 后端接入说明

> 本目录的 `server.py` 已经实现下面的订单、队列、状态回写、复核与 ZIP 接口。默认 `IMAGE_PROVIDER=demo`，复制 `.env.example` 为 `.env` 并填入 `DASHSCOPE_API_KEY`、改为 `dashscope` 即切真实生成。

前端已经把「客户选什么、每个表情什么状态、提示词长什么样、最后交付什么」跑通了。真实生成需要后端补上四件事：存储、队列、模型调用、交付打包。

## 推荐架构

```text
静态前端
  ↓ POST /api/orders
API 服务（FastAPI / Node）
  ↓ 写订单 + 入队
任务队列（Redis / BullMQ / Celery）
  ↓
Worker（DSH image-gen / DashScope qwen-image-3.0）
  ↓ 生成、去底、切帧、GIF、素材
对象存储（S3 / OSS / R2）
  ↓ 签名 URL
前端轮询订单状态
```

## 订单状态

| 状态 | 含义 |
|---|---|
| `draft` | 客户还在编辑 |
| `queued` | 客户已提交，等待生成 |
| `generating` | 正在生成 |
| `review` | 生成完成，等待工作室复核 |
| `done` | 复核通过，可交付 |
| `failed` | 失败，需要重试或人工处理 |

前端目前用同一个枚举。后端返回时保持字段一致即可。

## API

### 1. 创建订单

```http
POST /api/orders
Content-Type: multipart/form-data

character: <file>
pack: {"name":"...","intro":"...","copyright":"...","reward":"..."}
states: [{"id":"night","word":"晚安","caption":"晚安","action":"...","prompt":"..."}]
```

返回：

```json
{ "orderId": "ord_123", "status": "queued" }
```

### 2. 开始生成

```http
POST /api/orders/{orderId}/generate
```

返回：

```json
{ "jobId": "job_123", "status": "queued" }
```

### 3. 查询订单

```http
GET /api/orders/{orderId}
```

返回：

```json
{
  "orderId": "ord_123",
  "status": "generating",
  "items": [
    { "id": "night", "status": "done", "gif": "https://cdn/.../night.gif" },
    { "id": "thanks", "status": "review", "gif": "https://cdn/.../thanks.gif" },
    { "id": "cheer", "status": "failed", "error": "text mismatch" }
  ]
}
```

前端轮询这个接口即可更新状态看板。

### 4. 复核

```http
POST /api/orders/{orderId}/review
{ "items": [{"id":"thanks","status":"done"}] }
```

### 5. 打包下载

```http
GET /api/orders/{orderId}/zip
```

返回 `application/zip`，结构：

```text
表情图/01.gif ... 08.gif
聊天面板图标.png
封面图.png
详情页横幅.png
赞赏引导图.png
赞赏致谢图.png
上架文案.md
pack.json
```

### 6. 用量与成本

```http
GET /api/usage
```

返回累计、今日、本月调用次数，成功 / 失败，按官方单价估算的 USD / CNY 成本，近 14 天趋势，按类型拆分，以及最近调用记录。

每次真实 DashScope 调用都会写入 `api_calls` 表，由 `pipeline.py` 的 `CALL_LOGGER` 上报。金额按 `DASHSCOPE_PRICE_INPUT_USD`、`DASHSCOPE_PRICE_OUTPUT_USD` 与 `USD_TO_CNY` 估算，失败请求按 0 计。演示模式不调用模型，因此 API 次数与成本为 0。

### 7. 后台设置

```http
GET /api/settings
```

返回非敏感配置：provider、model、endpoint、Key 是否已配置、价格、内容风格与字幕语气。**不返回 Key 内容。**

```http
POST /api/settings
{
  "provider": "dashscope",
  "model": "qwen-image-3.0",
  "endpoint": "https://dashscope.aliyuncs.com/api/v1",
  "apiKey": "optional-new-key",
  "priceInputUsd": 0.00275,
  "priceOutputUsd": 0.024754,
  "usdToCny": 7.1,
  "contentStyle": "cute",
  "captionTone": "short",
  "promptExtra": ""
}
```

- `apiKey` 留空表示不修改
- `clearKey: true` 清除已保存的 Key
- 保存后立即生效，无需重启
- Key 写入本机 `data/settings.json`，`data/` 已 gitignore
- 当前只适配 DashScope 兼容接口，其他厂商需要在 `pipeline.py` 增加 adapter

### 8. 现场拍照亭

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/kiosk/sessions` | 创建会话，body `{photo: dataURL}` |
| GET | `/api/kiosk/sessions` | 最近会话与运营统计 |
| GET | `/api/kiosk/sessions/{id}` | 查询状态、角色、GIF、二维码 |
| POST | `/api/kiosk/sessions/{id}/retry-character` | 重新生成角色 |
| POST | `/api/kiosk/sessions/{id}/retry-gif` | 重新生成上一次动作 |
| POST | `/api/kiosk/sessions/{id}/gif` | 提交动作，body `{action}` |
| POST | `/api/kiosk/sessions/{id}/refresh` | 刷新二维码与有效期 |
| DELETE | `/api/kiosk/sessions/{id}` | 删除会话与文件 |
| POST | `/api/kiosk/cleanup` | 删除超过保留时间的会话 |
| GET | `/api/kiosk/sessions/{id}/qr.png` | 领取二维码 |
| GET | `/api/claims/{token}` | 领取页数据 |
| GET | `/api/claims/{token}/download` | 下载 GIF |
| GET | `/claim/{token}` | 手机领取页 |

运营设置通过 `POST /api/settings` 保存 `publicBaseUrl`、`deviceName`、`retentionHours`。`GET /api/settings` 会返回 `booth.effectiveBaseUrl`、`lanIp`、`port`。

Kiosk 状态：`character_queued / character_processing / character_ready / character_failed / gif_queued / gif_generating / gif_ready / gif_failed / expired`。

角色统一输出 1024×1024 RGBA，严格模式会做 alpha 覆盖率检查。GIF 默认用 `KIOSK_GIF_MODE=motion` 的程序化动作渲染，`ai` 才走 4×4 模型。详见 [KIOSK.md](KIOSK.md)。

## Worker 生成流程

1. 角色图 → 1024 透明底卡通锚点。
2. 每个表情：4×4 精灵图，16 格，无网格线，无字幕错字。
3. 质检：格数、水印、字幕、压边、角色一致、关键道具。
4. 去假透明 → 逐格 94% 留白 → 切 16 帧。
5. 240×240 GIF，128 色，≤500KB。
6. 5 张配套素材：cover / icon / banner / reward guide / reward thanks。
7. 上传对象存储，回写状态。

完整提示词与参数见 `workflow.md`、`workflow.yaml`。

## 安全与边界

- **不要把 DashScope Key 放在前端**。前端只拿订单 ID 与签名 URL。
- 角色图属于客户。存储要私有，下载用短时签名 URL。
- 上传时要求客户确认有权使用该形象。明星、影视动漫游戏角色、网络二创形象、未成年人公开投稿不接。
- 每个订单限制生成次数与重试次数，避免刷额度。
- 交付前由工作室人工复核。模型不保证 alpha、中文零错字、16 格一次成功。
- 不承诺平台过审。实名与投稿由客户本人完成。

## 数据模型建议

```text
orders
  id, status, character_url, pack_json, created_at, updated_at

order_items
  id, order_id, state_id, word, caption, action, prompt, status,
  gif_url, icon_url, error, retries

assets
  id, order_id, type, url, width, height, bytes

api_calls
  id, order_id, kind, asset, state_id, model, status, started_at,
  duration_ms, input_images, output_images, cost_usd, cost_cny, error
```

前端已经按这个结构在跑。后端只要返回同名字段，界面不需要重写。
