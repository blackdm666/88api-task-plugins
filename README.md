# 88API Task Plugins

独立维护和发布 NewAPI 任务插件。日常更新插件不需要重新构建 NewAPI 镜像，也不需要重启服务。

| 插件 | 稳定标识 | 初始独立版本 |
| --- | --- | --- |
| Grok Video | `grok-video` | `1.0.2` |
| GX-Video | `gx-video` | `1.0.0` |
| Seedream Pro | `seedream-pro` | `1.1.8` |
| Minimax-H3 | `minimax-h3` | `2.0.0` |
| Minimax-H3 Async | `minimax-h3-async` | `1.0.0` |
| SD-Video | `sdgo-video` | `1.0.3` |
| XM-Video | `xm-video` | `3.0.0` |
| Vertex Omni (isolated QA) | `vertex-omni` | `1.0.0` |

Minimax-H3 与 XM-Video 的初始独立版本与当时88API镜像和生产自定义插件源码一致，仅迁移维护及发布位置；Minimax-H3 Async 是另行新增的插件。

## Vertex Omni：独立隔离测试版

`vertex-omni@1.1.0` 是独立的 Vertex Interactions 视频插件，不覆盖
`vertex-ai`，不声明渠道类型41，不注册Veo、旧Omni或正式1.1模型名，
也不启用动态模型接管。当前只声明 `vertex-omni-1.1-test`；默认发送精确
上游ID `gemini-omni-1.1-flash-preview`，也允许测试渠道显式映射到该ID。
它只适用于单独绑定此插件的 Task Plugin 渠道，不支持 New API 中继渠道。

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

### 1.1.0 模式和边界

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
- 输入支持指定MIME的Data URI、multipart文件及`gs://`对象。图片20MiB，
  视频64MiB；multipart还受宿主累计文件大小限制。
  支持PNG/JPEG/WebP/HEIC/HEIF图片和MP4/MOV/WebM视频。
- **暂不支持HTTP(S)输入URL或无MIME的裸Base64**。宿主当前没有提供此
  插件可直接复用的安全下载/媒体时长预检接口，不能把Google对gs://的
  支持当作任意HTTPS URL可用。assets站链接须先由客户端转为Data URI、
  文件或GCS对象。普通参考视频及文件/GCS的实际输入时长由Google校验。
- 顶层或`metadata.previous_interaction_id`支持继续Interaction，必须是Google ID，
  不是本站task_id；客户端须保留同账号/项目的上轮上下文。
  可选`metadata.output_gcs_uri`要求服务账号有相应存储权限。
- edit/extend不能指定比例或size，避免Google真实400；edit默认使用最小输出格式，
  显式resolution按官方编辑示例写入output。普通生成才发送duration/aspect_ratio/resolution。
- **延长计费为成品完整时长，不是新增时长。** 请求duration是预扣估计，
  不冒充任意精确最终时长控制；省略时预扣40秒，完成后按MP4电影时间轴mvhd
  实测总秒数（保留毫秒）结算。3秒原片延长成6秒，按6秒重新计费；
  成品实际9.024秒则按9.024秒，而不是3秒、请求估计6秒或其中一条短轨道。
  价格及组倍率仍由宿主执行，本仓库不写售价。
- 延长仅接受单段输入；内联MP4会校验1–30秒。输出需要内联可测时长的MP4，
  因此extend不允许output_gcs_uri；不会猜测URI视频时长或把token换算为秒数。
  不可测量的成品返回UNKNOWN等待核验，不按预估量伪装成功。
- 普通生成/编辑保持请求秒数计费；延长才覆盖完成usage。旧任务无extend状态，
  不会因插件升级改变原计费。回调宿主接线问题不在本插件更新中解决。

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

内联视频通过轮询交给宿主现有视频缓存/私有存储流程；插件返回的提交快照
不保存素材、thought内容或Base64。轮询快照由宿主保存并移除媒体字节，
可能仍含上游thought元数据；插件的公开呈现器不回显这些内容。
必须在测试宿主开启视频对象缓存，
否则内联结果的持久读取不可保证。JSON提交读取上限为1MiB；
若Google不遵守后台请求而直接返回大型内联成品，现有宿主会拒绝该响应。
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
`5c04ea0d2ae92b6e0f0454719fbd5f37c4453f49` /
`v1.0.0-rc.39-88api.1`；各插件按实际声明使用API v1、`dynamicModels`
及`openai_video`等能力。仅看到API v1不代表所有早期版本都支持这些扩展。

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
