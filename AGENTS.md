# 88API 独立任务插件维护

## 维护边界与当前分发方式

- 本仓库 `blackdm666/88api-task-plugins` 是 Minimax-H3、XM-Video 等 NewAPI 任务插件的日常源码维护入口，源分支为 `main`，发布分支为 `marketplace`。这是 NewAPI 的 JavaScript 任务插件，不是 Codex 插件。
- 仓库已于 2026-09-17 改为私有。当前 NewAPI 市场由浏览器直接读取索引和源码，没有 GitHub 私有仓库认证能力；既有 Raw 地址无法匿名加载。CI 发布成功只表示私有仓库的版本存档已更新，不能据此宣称生产市场已可用或插件已升级。
- 当前可用交付方式：维护者经 GitHub 认证取得指定发布版本的 `plugin.js`，核对 SHA-256，再通过目标 NewAPI 官方任务插件页面或管理 API 上传。私有市场授权分发尚未实现；未经用户要求，不公开镜像仓库、源码副本或包含 GitHub Token 的市场 URL。
- `../new-api-seedance25/plugins/tasks/` 中的对应文件是主镜像基础快照，只有用户明确要求同步基础版时才更新。主仓目前公开，私有化独立仓库不会隐藏其中已有的基础快照或历史副本。
- 日常插件制作、修复、升级和回滚不构建 NewAPI 镜像、不重启服务。管理页面、路由/权限/计费框架、宿主 API 或镜像基础快照确需变化时，才进入 NewAPI 主仓流程。

## 开工检查

1. 在本工作区先读 `../new-api-maintenance/AGENTS.md`、`PROJECT_CONTEXT.md`，涉及 XM-Video/XinMeng 时完整阅读 `XINMENG_CHANNEL_INTEGRATION.md`；再读本文件、`README.md`、`host.lock.json` 与 `.github/workflows/publish.yml`。独立克隆缺少维护工作台时，以仓库文件和经核验的目标实例信息为准，不臆造线上状态。
2. 检查 `git status`、当前分支和远端，保护已有未提交修改。需要新建工作分支时使用 `codex/` 前缀；只有进入 `main` 的提交才会触发版本发布。
3. 确定是制作新插件、更新已有插件、发布版本还是更新目标实例。沿用当前会话已给出的授权；用户已要求安装/部署时直接完成必要验证与操作，不重复询问。仅修改文档、源码或发布存档的任务不自动改生产。
4. 先核对上游协议文档、脱敏请求/响应及现有适配器；无法确认的参数、状态、价格与用量不能猜测。处理开源宿主问题时查阅官方 GitHub Issues/PR，评估是否已有修复。

## 制作与修改插件

1. 新插件放在 `plugins/<key>/plugin.js`，使用单文件 ES module 和宿主支持的接口。`meta.key` 必须与目录名一致，符合 `[a-z0-9][a-z0-9-]{0,29}`，源码不超过 1 MiB，`meta.apiVersion` 与锁定宿主兼容。
2. 新 key 和显示名称使用中性业务名称，避免暴露内部渠道商信息。已有插件升级保持 `meta.key` 不变，防止渠道绑定和历史任务失联；更换 key 必须作为有明确迁移方案的独立改动处理。
3. 修改源码必须递增 `meta.version`，当前发布器仅接受稳定 `x.y.z`。通常修复递增 patch、兼容新增能力递增 minor；不兼容变更须说明迁移影响。文档或测试修改未改变插件源码时不人为抬版本。
4. 新增插件时同步 `host.lock.json` 的 `plugins` 清单和 README 目录；只有宿主兼容性发生变化时才更新锁定提交、最低版本或所需能力。不能把“API v1 相同”当成全部宿主扩展均可用。
5. 按协议实现并验证提交、轮询、结果/错误转换、参数边界、模型映射与用量提取。非终态进度必须低于 100%，只有终态返回 100%；保持幂等请求与历史任务读取兼容，避免改动导致重复生成或错误计费。
6. 保留 AGPL 许可证和 NewAPI/QuantumNous 来源说明；不提交渠道密钥、令牌、Cookie、账号数据或生产配置。针对实际行为变化补充有意义的回归，不为纯文档修改增加业务测试。

## 本地验证与 CI

1. 使用 Node.js 24 或以上版本。本仓库当前无 npm 依赖，执行：

   ```sh
   git diff --check
   npm test
   npm run build
   ```

2. `.publish/index.json` 与 `.publish/plugins/<key>/<version>/plugin.js` 是本地构建产物。发布器将 CRLF 统一为 LF 后计算 SHA-256，上传时应使用版本存档原始字节，不另行格式化。`npm run build` 默认没有载入历史市场，只能验证当前目录，不能代替发布阶段的历史不可变校验。
3. 把 `host.lock.json.repository` 对应仓库检出到隔离的 `.host/`，HEAD 必须等于锁定的完整 `commit`。已有 `.host` 先检查状态，不丢弃不明修改；不得复制候选源码到真正的 NewAPI 工作仓库做测试。按以下顺序运行：

   ```sh
   npm run prepare:host
   cd .host
   GOWORK=off go test ./plugins ./pkg/jsplugin ./relay/channel/task/jsplugin ./controller -run 'IndependentPluginCatalogue|BuiltIn|XinMeng|TestDynamicPluginHTTPRetryAndBilling' -count=1 -timeout 10m
   ```

   上述环境变量写法适用于 Bash；PowerShell 使用 `$env:GOWORK = 'off'` 后运行相同的 `go test`，结束后恢复原环境变量值。Go 版本以 `.host/go.mod` 为准。
4. 目录契约只证明插件可加载、身份与哈希一致；新插件或新协议必须增加提交、轮询和结果等对应回归，并确保它们会被宿主准备脚本复制且被 CI 的测试过滤器实际执行，不能只新增不会运行的测试文件。现有准备脚本只复制目录契约及宿主已有的对应插件文件。
5. 本机缺少 Go 或某项检查无法执行时，如实记录；仓库 Actions 的 `validate` 会检出同一锁定宿主并执行真实测试。相关验证失败不得宣称版本可交付，不以 Docker 构建替代插件验证。

## 版本发布

1. 审查源码差异、版本号、回归与兼容性后提交。按任务授权推送/合入 `main`，由 `.github/workflows/publish.yml` 先执行 `validate`，通过后才执行 `publish`；PR 只验证，不发布。
2. `scripts/publish-marketplace.mjs` 仅用于 main 分支 GitHub Actions。不得伪造 Actions 环境在本地绕过发布入口，不手改 `marketplace` 存档或强推历史。
3. 发布器读取已有 `marketplace`，保留旧版本和 SHA-256；同版本不同源码、静默降级 `latest` 或移除已发布插件均会拒绝。失败应修复源分支并递增必要版本，不能覆盖历史绕过限制。
4. 等待该源提交对应的 `validate` 与 `publish` 成功，再通过认证读取 `marketplace` 的发布提交、目标 key/version、存档和 SHA-256。记录源提交、Actions run、发布提交与校验值；仅推送成功不等于发布成功。
5. 私有仓库内发布不等于可匿名访问。没有配置并验证授权分发之前，交付说明必须使用下方的手动上传方式。

## 安装、更新与回滚

1. 确认目标实例和本次授权的 key/version，读取当前实际宿主版本、插件活动版本/启用状态、渠道绑定及运行中任务。沿用会话明确的部署范围；服务器名称不能唯一匹配时才请求澄清。
2. 按工作区 SSH 与宝塔规则连接和检测，先告知规范备份路径，再备份插件源、版本/启用状态及相关渠道配置。远程备份使用 `/www/wwwroot/work/backups/<项目名>/<时间戳>/` 并校验；临时文件只放 `/www/wwwroot/work`，持久项目不能放在那里。不得直接修改生产数据库。
3. 经认证从已核验的 `marketplace` 发布提交取得 `plugins/<key>/<version>/plugin.js`，使用索引 SHA-256 校验；随后从 NewAPI“任务插件”的上传/上传新版本入口导入，或调用官方 `POST /api/plugin/task`，传入 `source`、`sourceSha256`、`remark`，按目标启用状态显式设置 `enabled`。
4. 上传接口默认 `enabled=true`，会保存新版本并同步运行时；后台上传也未显式传入禁用值。因此上传本身可能立即切换活动版本，不能描述成仅暂存待审核；`enabled=false` 也不能当作无影响的暂存开关。操作前必须确定目标启用状态和运行任务兼容性，不默认 `force` 绕过冲突。
5. 回读实际活动版本、源码哈希、运行时状态及错误，核对渠道绑定和既有配置。按改动验证提交、轮询、终态、视频内容访问及相关计费；未执行真实业务调用时明确说明，不把 HTTP 200 或编译通过当作端到端通过。付费验证遵守当前任务已授权范围。
6. 需要回滚时，先核对旧版与当前任务/宿主兼容，从版本历史激活已验证旧版，或使用 `POST /api/plugin/task/<key>/activate` 和 `{ "version": "旧版本" }`；回读活动版本及启用状态并验证。实例回滚不修改市场 `latest`，不删除版本来代替回滚。
7. 更新不顺带清理旧插件或历史任务。出厂基础版不能直接删除；删除自定义覆盖版可能恢复出厂版，执行删除前必须核对依赖和实际回退结果。用户此前要求暂不清理线上旧插件，继续遵守直到明确变更。
8. 清理远程中转文件，仅保留规范备份和最终业务文件。日常插件更新通过应用 API 生效，不执行 Docker 生命周期操作；如确需主程序部署，另外走维护工作台及宝塔 Docker 流程。

## 交付记录

- 在工作区的 `../new-api-maintenance/VERSION_HISTORY.md` 和对应 `reports/` 记录发布/部署/回滚事实；需要时更新 `PROJECT_CONTEXT.md`。通用插件使用说明放本仓库，实例运维记录不提交到插件或 NewAPI 源码仓库。
- 最终说明 key、新旧版本、源/发布提交、测试和 Actions 结果、是否安装到目标实例、回滚版本及未验证项。涉及服务器时补充实际 SSH 别名/主机名、管理入口、修改文件/配置、备份路径和验证结果。
- 明确区分“本地完成”“私有仓库已发布”“目标实例已启用”，不混用完成状态。建议用户复盘一次从制作、版本发布到安装验证和回滚的完整流程。
