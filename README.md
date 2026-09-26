# 88API Task Plugins

独立维护和发布 NewAPI 任务插件。日常更新插件不需要重新构建 NewAPI 镜像，也不需要重启服务。

| 插件 | 稳定标识 | 初始独立版本 |
| --- | --- | --- |
| Minimax-H3 | `minimax-h3` | `2.0.0` |
| Minimax-H3 Async | `minimax-h3-async` | `1.0.0` |
| XM-Video | `xm-video` | `3.0.0` |

Minimax-H3 与 XM-Video 的初始独立版本与当时88API镜像和生产自定义插件源码一致，仅迁移维护及发布位置；Minimax-H3 Async 是另行新增的插件。

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

## 私有仓库的安装与更新

本仓库为私有仓库。现有 NewAPI 市场由浏览器读取索引和源码，没有 GitHub 私有仓库认证能力；不能仅添加 Raw 地址就宣称市场可用，也不能在市场 URL 中放 GitHub Token。

当前支持的交付流程：

1. 经 GitHub 认证读取通过 CI 的 `marketplace` 发布提交。
2. 获取 `plugins/<key>/<version>/plugin.js` 原始字节，核对同一提交索引的 SHA-256，不重新格式化。
3. 备份目标实例，通过 NewAPI 官方“任务插件”上传入口或 `POST /api/plugin/task` 安装。
4. 上传默认启用并同步运行时，不是无影响暂存；核验实际活动版本、源码哈希、启用状态、渠道及业务结果。

插件源和安装记录保存在实例数据库，同 key 自定义版本覆盖基础版。私有仓库发布成功不等于已安装，也不等于已有可匿名访问的在线市场。未经授权不要公开源码或镜像副本。

## 日常维护

1. 修改 `plugins/<key>/plugin.js`，递增 `meta.version`，保持key不变。
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

`host.lock.json`固定已测试的NewAPI源提交。当前插件使用API v1、`dynamicModels`及`openai_video`，要求88API派生版本`v1.0.0-rc.37-88api.6`或具备相同能力的宿主。仅看到API v1不代表所有早期NewAPI版本都支持这些扩展。

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
