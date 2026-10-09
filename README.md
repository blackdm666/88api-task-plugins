# 88API Task Plugins

独立维护和发布 NewAPI 任务插件。日常更新插件不需要重新构建 NewAPI 镜像，也不需要重启服务。

| 插件 | 稳定标识 | 初始独立版本 |
| --- | --- | --- |
| Grok Video | `grok-video` | `1.0.2` |
| GX-Video | `gx-video` | `1.0.0` |
| Seedream Pro | `seedream-pro` | `1.1.8` |
| Minimax-H3 | `minimax-h3` | `2.0.0` |
| Minimax-H3 Async | `minimax-h3-async` | `1.0.0` |
| H3-Video | `h3-video` | `1.0.0` |
| SD-Video | `sdgo-video` | `1.0.3` |
| XM-Video | `xm-video` | `3.0.0` |
| Vertex Omni (isolated QA) | `vertex-omni` | `1.0.0` |
| Alibaba Bailian (factory-compatible override) | `alibaba` | `1.4.2` |

Minimax-H3 与 XM-Video 的初始独立版本与当时88API镜像和生产自定义插件源码一致，仅迁移维护及发布位置；Minimax-H3 Async 是另行新增的插件。

## Alibaba Bailian：Wan3 超宽画幅修正

`alibaba@1.4.2` 保留 QuantumNous 出厂插件 `1.4.1` 的 key、名称、
渠道类型17、模型清单、所有图像/视频协议和用量计费接口。
唯一功能变化是为 `wan3.0-video` 和 `wan3.0-video-prime` 放行官方
`21:9`；其他 Wan2.x 模型的比例白名单不扩大。已有任务读取兼容。

来源：QuantumNous/NewAPI 的 `plugins/tasks/alibaba/plugin.js`，
1.4.1 原始 SHA-256
`c8f217afe6fe79bb0db3e723730a86399cee74e8087f474859e39e52a6acb55d`。
保留原作者与AGPL许可证，不把此修正伪装为官方发布版本。
官方依据为阿里云《万相3.0-视频生成API参考》中的 ratio 枚举。

通过标准任务插件上传接口以同 key 覆盖出厂版，不修改NewAPI镜像。
同 key 覆盖适用于该插件现有全部绑定，不能描述为仅渠道183的私有副本；
发布测试必须证明非Wan3模型的行为保持。需要回退时，通过官方上传
接口恢复规范备份的原始 `1.4.1` 源码；如果已存在 `1.4.1` 覆盖存档，
也可从官方版本历史激活。出厂版没有数据库存档时，不能直接调用版本
激活接口。不通过停用整个 Alibaba 插件实现回滚。

## Vertex Video（key `vertex-omni`）

`vertex-omni@1.5.0` 是独立的 Vertex 视频插件，显示名为 Vertex Video。它不覆盖
`vertex-ai`，不声明渠道类型 41，也不启用动态模型接管。
插件 key 保持 `vertex-omni` 不变，以免已有渠道绑定和历史任务失联。

1.5.0 起插件**接管四个正式模型名**，同时保留隔离测试名（两者共用同一套规格、
上游型号和计价）。插件一旦声明某个模型名，该名字的全部新流量都固定到绑定本插件的
Task Plugin 渠道（类型 63）；类型 41 的 Go 适配器不再处理这些名字的新任务，
已提交的旧任务仍按原平台轮询。

| 正式名 | 测试名 | 上游型号 | 接口 | 分辨率 | 时长 | 任务 |
|---|---|---|---|---|---|---|
| `gemini-omni-flash-1.1` | `vertex-omni-1.1-test` | `gemini-omni-1.1-flash-preview` | Interactions（global） | 720p/1080p/4k | 3–10s，延长每次+10s（720p/1080p） | 文生、首尾帧、参考、编辑、延长、多轮 |
| `gemini-omni-flash` | `vertex-omni-flash-test` | `gemini-omni-flash-preview` | Interactions（global） | **仅 720p** | 3–10s | 文生、首尾帧、参考 |
| `veo-3.1` | `vertex-veo-3.1-test` | `veo-3.1-generate-001` | predictLongRunning（us-central1） | 720p/1080p/4k | 4/6/8s，延长每次+7s | 文生、首帧/首尾帧、参考图（1–3 张，仅 8s）、延长 |
| `veo-3.1-fast` | `vertex-veo-3.1-fast-test` | `veo-3.1-fast-generate-001` | predictLongRunning（us-central1） | 720p/1080p/4k | 同上 | 同上 |

- 渠道 `model_mapping` 只能映射到同一行的上游型号。上游型号名、Veo 3.1 Lite 都不由插件声明。
- **360p 不上架**：Omni 请求 360p（含 `640x360` 等尺寸）时，按 720p 生成并按 720p 计费；
  计费枚举 `resolution` 只有 720p/1080p/4k。其他不支持的分辨率（例如 Flash 的 1080p/4k）
  在插件里直接拒绝，计价表达式也不为它们分档。
- 插件只适用于单独绑定它的 Task Plugin 渠道，不支持 New API 中继渠道。
- 1.3.0 起声明 `task-preflight@1`（不再声明 `query-sse-delta@1`）。1.5.0 已在锁定宿主
  `1debc5f3` 和生产宿主 `f5f882e` 上运行回归。

### 1.5.0：正式名迁移与旧请求格式兼容

迁移前，类型 41 渠道上约 70% 的请求是图生视频，因此 1.5.0 保留旧 Go 适配器接受的格式：

- **图片**：除 HTTP(S) 链接外，还接受 Data URI、PNG/JPEG/WebP 的裸 Base64，以及
  multipart 图片文件。multipart 字段可以是 `input_reference`、`image`、`images`、`image[]`、
  `images[]`、`first_frame`、`last_frame`。
  - 这些图片直接内联给 Google，单张 20MiB 以内，不经过 Worker 转存。
  - multipart 文件由宿主在发送前展开为 Base64（`__fileRef`）。
  - 文件分片没有图片类型（或为 `application/octet-stream`）时，按文件扩展名判断。
  - 链接仍然通过预检转存到中央桶。
- **视频**：仍然只接受 HTTP(S) 链接。Data URI、Base64、multipart 视频文件一律拒绝，
  因为延长计费需要 Worker 实测输入时长。
- **Omni**：一张图片、没有视频、没有指定 `task` 时，按首帧（image_to_video）处理，
  与旧适配器一致；两张及以上图片按参考图处理。
- **Veo**：
  - 支持旧字段 `metadata.video_mode`：`frames` 表示首帧/首尾帧，`reference` 表示参考图。
    与显式 `task` 冲突时拒绝。
  - 不传任务时，1–2 张图片按首帧/首尾帧处理，3 张按参考图处理。
  - 内联图片以 `bytesBase64Encoded` 发送。
- `gs://` 输入、带账号密码的链接、不支持的图片类型（如 GIF/SVG）一律拒绝。

### 1.4.0：Omni Flash 与 Veo 3.1 / Fast（2026-10-09 生产账号实测）

- **账号可用性**：Veo 3.0、3.0 Fast、2.0 已返回 404，不再可用。Veo 3.1 Lite 是预览版，
  按"只上架正式版"的要求不接入；Omni 两个型号是预览版，按用户要求保留。
- **Omni Flash** 与 1.1 共用 Interactions 新格式（`response_format` 为数组、不需要
  `Api-Revision`）。上游只接受 720p，其他分辨率报 `Only 720p resolution is supported by this model`。
  延长报 `Internal error`，所以只开放文生、首尾帧、参考图。
- **Veo 3.1 和 Veo 3.1 Fast**：
  - 时长只接受 4/6/8 秒，其他值上游异步拒绝，不计费；默认 8 秒。
  - 两个型号都实测产出 3840×2160。Fast 的官方型号页没写 4K，但实际支持。
  - 首帧、首尾帧、参考图（素材类，1–3 张，只能 8 秒）、延长都用 `gcsUri` 输入，
    成品经 `storageUri` 写入中央桶 `gs://88api-omni-media/vertex-omni/<task_id>/<n>/sample_0.mp4`。
  - Veo 图片只接受 JPEG/PNG，转存结果若是其他类型，提交前就会拒绝。
  - 不传任务时，一张图默认按首帧处理（OpenAI `input_reference` 语义），2–3 张按参考图处理。
  - 不提供带遮罩的编辑。
- **Veo 输入与成品**：
  - 输入同样只接受 HTTP(S) URL，经预检由 Worker 转存，跨项目读写同样以 Vertex 服务代理身份进行。
  - Veo 成品的 `moov` 在文件末尾（不是 faststart），Worker 探测会逐个读取 box 定位。
  - 关闭音频时成品没有音轨；但延长的成品实测带有音轨。
- **Veo 计费**：上报秒数、分辨率和 `generate_audio`（默认 true）。
  - 普通生成按请求的秒数计费。
  - 延长预扣 8 秒；完成后按"成品实测时长 − 输入实测时长"结算（实测 4→11 秒，即 7 秒），
    分辨率取成品实测值，音频取请求值。
  - 价格由宿主的计价表达式按 `u("resolution")` 和 `u("generate_audio")` 分档，本仓库不写售价。
- **Veo 任务编号**：操作名经 base64url 编码后存为任务编号。轮询时解码并校验格式和型号，
  再调用 `fetchPredictOperation`；上游会过滤结果时，返回 `raiMediaFilteredReasons` 里的原因。

### 1.3.0：HTTP(S)输入、中央GCS桶交付、延长按新增秒数计费

依据2026-10-09生产账号实测（3s/10s 4K、720p、1080p、延长链10→40s、跨项目读写）：

- Google的JSON查询视图会丢弃大型内联视频：10s 4K约60MB时，视频整段缺失。
  SSE回放也只是把整段Base64放进单个事件（约80MB），并不分片。
  `response_format`带`delivery:"uri"`和`gcs_uri`时，从720p到10s 4K都会返回`gs://`。
- Interactions输入**只接受GCS URI**（HTTPS输入会被拒：
  `Only GCS URIs are supported`）。因此输入**只接受HTTP(S) URL**（图片20MiB、
  视频64MiB）。插件声明`task-preflight@1`，在提交前把URL交给传输Worker的
  `POST https://assets.88api.ai/gcs/ingest`：
  - Worker下载时做SSRF校验，重定向逐跳校验，且不携带任何凭据；
  - 下载内容流式写入`gs://88api-omni-media/vertex-omni-inputs/<日期>/<UUID>`；
  - 延长任务会顺带实测输入MP4的时长。

  插件用这些`gs://`副本组装Google请求。以下情况都在调用Google**之前**就失败，
  不会产生费用：转存失败、结果不一致、延长输入不是1–30秒。
  1.3.0–1.4.0 拒绝 Data URI、multipart 文件和 `gs://` 输入；1.5.0 起图片恢复兼容
  Data URI、Base64 和 multipart（见上文）。
- 转存时，渠道当前的Google令牌放在预检JSON**请求体**里（不放请求头）。
  Worker只用它向Google写白名单桶，不存储、不回显。中央桶上的IAM写权限就是
  转存授权，未授权的令牌无法写入，接口因此不会被外人滥用。
- 所有成品都写入中央桶`gs://88api-omni-media/vertex-omni/<task_id>/`
  （GCP项目`api-505117`，私有、2天自动删除、关闭软删除）。插件读不到渠道
  自定义设置，所以桶名固定写在插件里，客户端不能覆盖（会拒绝`metadata.output_gcs_uri`）。
  视频字节不经过NewAPI内存。
- **跨项目权限**：Google读输入、写成品使用的是渠道项目的**Vertex服务代理**
  `service-<项目号>@gcp-sa-aiplatform.iam.gserviceaccount.com`，而不是渠道服务账号本身
  （实测：只给服务账号授权时报`storage.objects.get`被拒）。每个批量账号要在中央桶上
  给两个身份授予objectCreator和objectViewer：服务代理（用于Google读写）和渠道服务
  账号（用于转存）。用传输Worker目录下的`grant-omni-bucket.sh`批量补授权。
  桶的IAM策略上限1500个成员，大约够700个账号。
- 宿主拿到`storage.googleapis.com`结果地址后，按既有流程调用`/transfer`。Worker用
  只读服务账号`omni-media-worker@api-505117`（无项目级角色，只有该桶的objectViewer）
  把成品复制到R2。Worker不可用时，宿主回退为由NewAPI经插件内容请求中转。
- 延长：Google每次固定追加约10秒（实测10.005–10.032秒），不接受duration
  （传`"40s"`会报`Videos longer than 30s are not supported for extension`）。
  输入须为1–30秒、可测时长的MP4；分辨率可选`720p`（默认）或`1080p`。
  4K延长会在上游约5分钟后报`Internal error`，所以插件直接拒绝。
  原片超过30秒时，由客户端截取末尾片段（建议10秒）后再延长。
- **延长计费 = 实测成品时长 − 实测输入时长**，分辨率取实测成品。
  这与Google的计量一致：10→20、20→30、30→40秒三次延长的输出token完全相同
  （720p均为57,920）。提交时预扣11秒。客户端可选传`input_duration`，与实测相差
  超过0.1秒时拒绝。
- 成品时长来自Worker的只读探测：Google完成后，插件返回非终态95%并记录
  `probe_uri`；下一轮查询请求`https://assets.88api.ai/gcs/probe?id=&uri=`（不携带Google凭据）。
  Worker只用Range读取MP4头部，返回与Interaction同构的`outputs`和`facts`。探测失败
  或结果不一致时返回UNKNOWN、继续轮询：不判失败、不退款、不按预估结算。
- 多轮续接仍按完整成品时长计费（预扣40秒）。1.3.0以前提交的延长任务没有
  `bill_added_seconds`标记，继续按完整时长结算，历史任务不补扣、不改价。
- 返回给客户的是完整MP4。客户端自行拼接时，应保留原片完整内容，只取延长结果中
  输入时长之后的部分接在后面。延长结果的前段是Google重新生成的，与原片相似度约0.985，
  并非逐帧拷贝；直接用它替换原片尾段，会在接缝处产生音频突变。

### 协议与验证边界

- 服务账号JSON只保存在渠道，由宿主 `oauth2_jwt` 获取及刷新Token；
  插件只读取Token和projectId，不接触原始私钥。
- 使用global区域、`v1beta1/projects/<project>/locations/global/interactions`；
  请求为嵌套 `user_input.content`，`response_format` **数组**，包含
  video、aspect_ratio、resolution及带秒单位的字符串duration（如`"3s"`）。
  1.1不强制旧Api-Revision头。
- 使用 `background:true, store:true, stream:false` 提交，小响应后按ID轮询。
  支持 `steps`/`outputs`、嵌套/平铺视频输出，以及上游 `error`/`errors`。
  未知状态不伪装成进行中；不会把回显输入视频当作生成结果。
- `1.0.1`已完成一次3秒720p纯文本真实生成、终态、MP4读取、
  对象存储成品读取及按请求秒数扣费验证。Node/Sobek/模拟HTTP回归
  不能代替其他账号权限、参考图/视频编辑或其他时长的真实验收。
- Google模型文档和Google官方MCP实现存在差异：后者的核验提交使用
  同步 `response_modalities`，未提供请求时长/比例控制；这里依据Google
  视频REST文档采用可明确约束时长的 `response_format`。没有在失败后自动
  切换协议、模型或同步模式，避免重复付费生成。

核验来源（2026-10-08）：

- [Google Omni 1.1模型页](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/omni-1-1-flash)
- [Google视频生成REST示例](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-text)
- [Google视频编辑REST示例](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/edit-videos)
- [Google首尾帧REST示例](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-first-and-last-frames)
- [Google延长REST示例](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/extend-videos)
- [Google官方参考实现，固定提交50a918c](https://github.com/GoogleCloudPlatform/genmedia-creative-studio/blob/50a918cfba4dc0384b6be474af9c90b6e4846d47/experiments/mcp-genmedia/mcp-genmedia-go/mcp-common/omni.go)

`1.0.1`修正Google REST的duration单位：旧版发送`"3"`，现改为`"3s"`，
与文档的`"5s"`/`"10s"`格式一致。仅修改传输封装；客户端仍传整数3–10，
`extractUsage.seconds`和冻结任务state仍为数值，售价与组倍率不变。
回归服务端显式拒绝无单位duration，避免旧版宽松fixture重复掩盖错误。
这不代表仅凭文档或模拟结果即可断定真实生成已成功；实例验收另行记录。

### 1.1.x 模式和边界

- 单个输出，360p/720p/1080p/4k，两种比例；普通生成时长整数3–10秒，默认3秒；
  冲突的duration/seconds/metadata别名、数量和分辨率覆盖直接拒绝。
- `size` 支持上述四档横屏/竖屏的准确尺寸，并同时约束分辨率和比例。
- `task` 支持 `text_to_video`、`image_to_video`、`reference_to_video`、`edit`、`extend`。
  默认无素材为文生、普通参考图/多个视频或混合参考为reference、一段视频为edit。
  首尾帧字段自动选择image_to_video；最多两图，以顺序而非未文档化role发送，
  明确首尾帧指令追加到提示词，不能与普通参考图片混用。
- 普通参考最多10张图片、3段视频；首尾帧最多2图；edit/extend要求单段视频。
- `temperature`（0–2）和`top_p`/`topP`（0–1）显式转发到generation_config。
  不支持独立音频输入，不再默默忽略这些已知字段。
- 1.3.0起输入只接受HTTP(S) URL（图片20MiB、视频64MiB），由预检转存到中央桶；
  支持PNG/JPEG/WebP/HEIC/HEIF图片和MP4/MOV/WebM视频。
  1.5.0起图片另接受Data URI/Base64/multipart，视频仍只接受链接；均不接受`gs://`。
- 顶层或`metadata.previous_interaction_id`支持继续Interaction，必须是Google ID，
  不是本站task_id；客户端须保留同账号/项目的上轮上下文。
  1.1.3继承前一轮模式，不再同时发送video_config.task（真实接口禁止此组合）；
  多轮不能再显式设置task或首尾帧模式，采样与输出格式控制仍独立保留。
  1.1.4开始，多轮任务也按最终MP4完整电影时长结算；预扣上限40秒，
  成功后用mvhd实测值覆盖，不改变发给Google的请求duration。
  1.3.0起成品统一走GCS交付，时长由Worker探测MP4头部得到。
- edit/extend不能指定比例或size，避免Google真实400；edit默认使用最小输出格式，
  显式分辨率写入resolution。官方编辑示例写成output，但真实接口明确拒绝
  `Unknown parameter 'output' at 'response_format[0]'`；1.1.1据实修正，
  不照抄文档错误，也不在已受理生成后自动重试。普通生成才发送duration/aspect_ratio。
- 1.1.x–1.2.0的延长按成品完整时长计费（预扣40秒）；
  **1.3.0改为按新增秒数计费**，见上文。两者都以MP4电影时间轴mvhd
  （保留毫秒）为准，不采信客户端提示，也不把token换算为秒数。
  价格及组倍率仍由宿主执行，本仓库不写售价。
- **多轮续接计费同样按新成品完整时长。** 旧任务没有该状态标记，
  保留历史请求秒数计费；新任务预扣40秒，完成后按完整MP4结算。
- 1.1.2容纳已实测的40秒视频轨+40.363秒完整MP4音频尾差：
  视频轨仍受40秒（0.1秒元数据容差）约束，完整电影时长额外限制在41秒内，
  不因正常编码尾差误拒绝，也不放开任意时长或把尾差直接抹掉不收费。
- 延长仅接受单段输入，MP4需在1–30秒之间。不可测量的成品返回UNKNOWN
  等待核验，不按预估量伪装成功。
- 普通非多轮生成/编辑保持请求秒数计费；延长与新多轮覆盖完成usage。
  旧任务无extend状态或新多轮计费标记，不会因插件升级改变原计费。
  回调宿主接线问题不在本插件更新中解决。

输入示例：

```json
{
  "model": "vertex-omni-1.1-test",
  "prompt": "A red balloon floats through a quiet room.",
  "duration": 3,
  "size": "1280x720"
}
```

### 结果、安装与复盘门禁

成品以GCS地址交给宿主现有的视频缓存流程（`/transfer` Worker → R2）；
插件返回的提交快照不保存素材、thought内容或Base64。轮询快照可能仍含
上游thought或分镜文本元数据（10s 4K实测有253个文本步骤，约3KB），
插件的公开呈现器不回显这些内容。必须在宿主开启视频对象缓存并配置
传输Worker，否则成品会在每次下载时由NewAPI经OAuth中转。
插件不会绕过宿主上限或自动重新生成。

GCS成品从固定`storage.googleapis.com` JSON下载入口读取并附Google OAuth；
外部HTTPS成品使用`credentialless`读取，绝不向外部域名发送Google凭据。
存储、鉴权、域名访问限制、重定向防护和Range代理仍由NewAPI宿主负责。

扩大用途或正式模型注册之前，仍须验证目标账号权限及相应输入场景。
专用测试名不是权限边界：
仍须测试分组和限额密钥。提交超时、缺ID、响应超限时先查上游受理情况，
不要盲目重发；当前宿主对部分JSON提交解析错误可能按渠道重试，
隔离验收必须禁用该类提交重试，不能声称上游支持幂等。

本插件使用独立key，发布历史可保留此前版本用于协议/版本回退；
未完成真实生成验收的旧版不能被描述为已验证的可用生产版本。
若日后安装失败，先停用测试渠道，再经官方插件状态入口停用独立插件，
不删除历史任务，也不改原vertex-ai。

创建请求可使用管理员固定渠道标记限制一次尝试；查询和内容读取使用
普通Key，交给宿主根据任务记录确定原渠道，不继续附加创建时的手动pin。

## Seedream Pro

`seedream-pro@1.1.7` keeps the Seedream 5.0 Pro task protocol and 1K/2K
billing schema while omitting public price examples. The 1K/2K billing
expression remains configured in NewAPI pricing; this metadata change does
not alter request handling or task billing.

## Grok Video

`grok-video@1.1.2` extracts the upstream error text (`error.message`,
`message`, `detail`, or plain-text response) and uses it as the task failure
reason. NewAPI still wraps that reason in its own task/API response because the
task-plugin contract owns task lifecycle and forbids a plugin from returning an
arbitrary client response.

`grok-video@1.0.4` fixes protected video downloads through Sub2API without a
NewAPI image rebuild. Relative and same-origin HTTP(S) result URLs use the
configured channel Bearer key; external result URLs remain credentialless.
Ambiguous authorities and missing download credentials fail closed.
Since Sub2API's content route supports GET only, protected client HEAD requests
use an upstream GET; the host suppresses the body and closes that stream.
External anonymous URLs retain HEAD. The
existing task snapshots, model selection, resolution limits and billing facts
are unchanged, so earlier `grok-video` tasks can use the corrected reader.

This is a content-proxy fix, not an object-storage implementation. Video
archiving and R2 delivery remain the host's responsibility; upgrading this
plugin does not fix a host's relative/absolute URL cache-mapping mismatch.

## GX-Video

`gx-video` is the independent task-plugin adapter for the GX Seedance-native
API documented at `https://gengxi.ai`. Configure a NewAPI **Task Plugin**
channel with the provider Base URL and API key, then expose the required
models in the channel:

- `artsdance-2-0-fast-260801`
- `artsdance-2-0-mini-260801`
- `artsdance-2-0-pro-260801`
- `artsdance-2-5-pro-260801`

The plugin normalizes the XM-style request fields into the GX contract,
including public HTTPS media URLs, first/last frames, `adaptive` ratios,
smart duration `-1`, audio generation, `auto/edit/extend` task types, and
provider task usage/result fields. It does not modify the existing `xm-video`
plugin or require a NewAPI image rebuild.

## Minimax-H3 Async

`minimax-h3-async` 从 DMC 插件独立派生，使用 `/v1/api/generate` 和
`/v1/api/result?id=...`，不会替换原 `minimax-h3` 或其历史任务。
上游模型固定为 `minimax-h3`；渠道可声明 `minimax-h3-480p`、
`minimax-h3-768p`、`minimax-h3-1080p`，也可映射到这些名称。
只支持横屏/竖屏、9张参考图、3个参考音频；不宣称参考视频或首尾帧语义。
1080p最长10秒，其他档最长15秒；默认5秒、横屏、768p。
每个销售型号必须单独配置价格。上游未返回实际秒数时保留已验证的请求秒数，
不从进度或未文档化字段猜测用量。模型列表手动维护，不代表上游实时发现。
鉴权密钥只使用渠道配置，不写入插件。`Idempotency-Key` 仅作提示，
上游没有承诺幂等，超时后不得盲目重新生成。

## H3-Video

`h3-video` 是对接 MiniMax H3 统一视频接口（`POST /v1/videos`、
`GET /v1/videos/{id}`）的独立插件，不替换原 `minimax-h3` 及其历史任务。
渠道 Base URL 填站点根地址，带 `/v1` 或 `/draw/api/v1` 后缀也会被归一化。

**能力以上游为准。** 插件只做字段转换，不在本地限制分辨率、画幅、时长、
素材数量/组合或工作流；不合规的请求由上游在创建任务前以 400
（`submission_created=false`）拒绝，不会生成或扣费。

- 上游模型使用渠道模型映射后的名称（如销售名 `H3-Video` → `minimax_h3`）。
- 分辨率与画幅来自请求：`output.ratio`（上游格式，如 `1080p-16x9`），或
  `resolution`/`size`（档位如 `2k`，或宽x高换算比例）加 `ratio`/
  `aspect_ratio`。未提供时显式使用上游目录第一档 `480p-16x9`。
- 时长取 `duration`/`seconds`/metadata，默认 5 秒。
- 唯一的本地约束是计费安全：时长须为正整数且不超过宿主上限 3600 秒；
  同一参数的多个别名必须一致，保证扣费数量与发给上游的值相同。
- 计费用量为 `seconds` 与 `resolution`（枚举 480p/768p/1080p/2k/4k，即上游
  计价档位）。管理员须为模型配置按分辨率区分的表达式，例如
  `u("resolution") == "1080p" ? tier("1080p", u("seconds") * 单价) : ...`；
  不在枚举内的分辨率由宿主以 `plugin_usage_invalid` 拒绝，上游新增档位时需
  同步更新插件枚举与价格。
- 未显式传 `workflow_id` 时按素材补默认值：无素材 `text-to-video`、首尾帧
  `fl2v`、参考素材 `multi-reference`，2K/4K 用 `cf-fl2v`/`cf-multi-reference`；
  显式值原样透传。
- 素材：`images` 为首/尾帧（沿用旧插件约定），`metadata.reference_*`、
  `metadata.content`、`media` 与上游格式 `references` 均可使用，全部汇总转发。
  multipart 上传的文件由宿主内联为 data URL。metadata 中未使用的字段
  （如 `prompt_enhance`、`seed`）原样转发给上游。
- 网关任务号作为 `Idempotency-Key`，上游据此去重，宿主重试不会重复生成。
- 上游刚报告完成时只给出需要鉴权的站内下载地址，稍后才出现可匿名访问的
  对象存储签名直链（约 12 小时有效，成品保留 1 天）。插件在直链出现前保持
  99% 进行中继续轮询，最多 60 轮后判失败；内容只通过直链免凭证获取，
  不把渠道密钥发往对象存储。

## SD-Video

`sdgo-video` is the independent task-plugin adapter for the SDGO
Seedance-compatible API documented at `https://sdgo.top/docs`. Configure the
channel base URL as either `https://sdgo.top` or `https://sdgo.top/api/v3`;
the plugin normalizes both forms to the official endpoint
`/api/v3/contents/generations/tasks`.

The adapter keeps XM-style request normalization but emits Ark-native
`content` items (`text`, `image_url`, `video_url`, and `audio_url`). It
supports the documented Seedance 2.5/2.0/1.5/1.0 model limits, gateway
`task_...` IDs, subsequent Ark `cgt-*` IDs, `content.video_url` results,
provider errors, completion token evidence, and completion usage facts.
SDGO image/video asset modes are forwarded unchanged, including existing
`asset://` references and presigned `tos://` sources. When either media type
contains one of those provider asset URLs and its source mode is omitted, the
adapter automatically sends the corresponding `image_source_mode=asset` or
`video_source_mode=asset`; an explicitly supplied `direct_url` or `asset`
mode is preserved. A local multipart image
can be inlined by the NewAPI host for ordinary image input, but it does not
replace SDGO's asset presign flow; local video files still need to be uploaded
to SDGO first because the provider does not accept video Base64.
Provider-native top-level fields outside the XM compatibility surface are
forwarded unchanged, including `callback_url`; the adapter does not rewrite
that callback to a NewAPI or Volcano endpoint. Site-compatible fields are
still normalized so existing XM clients keep working.
Media supplied to the official endpoint must be reachable by both SDGO and
the upstream Ark service. The plugin does not put API keys or channel
configuration in this repository.

## 仓库可见性与安装更新

2026-10-08通过GitHub API核验，本仓库当前为**公开仓库**；历史“私有”
描述不代表当前状态。本次没有修改仓库可见性。仍须确认目标实例的市场
地址和访问权限，不把发布存档存在当作已配置生产市场，也不在URL中放Token。
若仓库再次转为私有，现有NewAPI浏览器市场没有GitHub私有认证能力，
须使用经认证取档和官方上传流程。

当前支持的交付流程：

1. 经 GitHub 认证读取通过 CI 的 `marketplace` 发布提交。
2. 获取 `plugins/<key>/<version>/plugin.js` 原始字节，核对同一提交索引的 SHA-256，不重新格式化。
3. 备份目标实例，通过 NewAPI 官方“任务插件”上传入口或 `POST /api/plugin/task` 安装。
4. 上传默认`enabled=true`并同步运行时，不是通用的无影响暂存。
   首次安装没有活动版本时，新版本会成为活动版；当前锁定宿主已有同key
   活动版时，上传会保留旧活动版，必须经官方
   `POST /api/plugin/task/<key>/activate`选择目标version。
   以实际读回为准，核验活动版本、源码哈希、启用状态、渠道及业务结果，
   不将上传成功当作已完成版本切换。

插件源和安装记录保存在实例数据库，同 key 自定义版本覆盖基础版。
GitHub发布成功不等于目标实例已安装、启用或完成业务验收。
不得提交实例凭据、用户数据或生产配置。

## 日常维护

1. 修改 `plugins/<key>/plugin.js`，递增 `meta.version`，保持key稳定。
2. 执行 `npm test`、`npm run build`；本仓库无npm依赖，要求Node.js 24及以上。
3. 提交并推送main。GitHub Actions会在锁定的真实NewAPI沙箱中运行兼容性和协议测试。
4. 全部通过后，自动更新marketplace分支中的版本存档及index.json。已发布版本不能覆盖，历史版本持续保留。
5. 经认证取得指定版本并核验哈希后，通过目标NewAPI官方后台/API上传。需要回退时，从版本历史激活此前兼容版本。

市场发布目前接受稳定的 `x.y.z` 版本号。不要用相同版本号发布不同源码，否则NewAPI本身也会拒绝这种覆盖。

## NewAPI 与插件的分工

- 本仓库：插件请求转换、结果解析、参数校验、模型适配与用量提取。
- NewAPI：用户界面、渠道分配、权限、计费执行、任务存储和插件运行框架。
- 镜像继续保留原有基础插件，方便首次部署；日常插件更新走认证取档与官方上传流程。只有用户明确要求更新镜像基础快照时，才同步到NewAPI仓库；新独立插件不自动进入主镜像。
- 修改管理页面的文字、按钮或宿主接口，仍然属于NewAPI主程序更新。

## 兼容性与校验

`host.lock.json`固定已测试的NewAPI源提交。当前锁定
`1debc5f3a28eed1e7833aa79455ec0e746d022c1` /
`v1.0.0-rc.39-88api.2`；各插件按实际声明使用API v1、`dynamicModels`、
`openai_video`及可选`query-sse-delta@1`等能力。
仅看到API v1不代表所有早期版本都支持这些扩展。

工作流只验证插件，不构建或发布NewAPI镜像。测试宿主位于隔离的`.host/`目录，镜像源码仓库不会被修改。升级测试宿主时应显式更新host.lock.json并通过相同回归。

如需本地运行宿主测试，先将`blackdm666/new-api`检出到`.host/`并切到host.lock.json指定提交，再执行：

```sh
npm run build
npm run prepare:host
cd .host
GOWORK=off go test ./plugins ./pkg/jsplugin ./relay/channel/task/jsplugin ./controller -run 'IndependentPluginCatalogue|BuiltIn|XinMeng|TestDynamicPluginHTTPRetryAndBilling' -count=1
```

## 来源与许可证

插件源码从 [blackdm666/new-api](https://github.com/blackdm666/new-api) 的88API维护分支分离，遵循 [QuantumNous/new-api](https://github.com/QuantumNous/new-api) 的任务插件API。保留AGPL-3.0-or-later许可证，见LICENSE。仓库不包含任何实例的密钥、渠道配置或用户数据。
