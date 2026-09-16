# 88API 独立任务插件维护

- 本仓库是 Minimax-H3、XM-Video 等自定义任务插件的日常源码维护入口；NewAPI镜像中的对应文件仅是随主程序发布的基础快照。
- 日常插件变更只在 `plugins/<key>/plugin.js` 进行，必须递增 `meta.version`；保持key稳定以保留渠道和历史任务关联。
- 运行 `npm test`、`npm run build`，再用 `.host` 中host.lock.json锁定的NewAPI运行时验证。不得覆盖工作区真正的NewAPI源码仓库来做测试。
- `marketplace` 分支由通过验证的GitHub Actions发布，保存不可变版本和SHA-256索引；不要手动改写已发布版本、强推历史或静默回退latest。
- 首次接入市场不会自动升级生产插件。发布到市场与在NewAPI后台安装/激活是不同动作；运行中的实例只在用户授权后更新。
- 不为插件代码更新触发NewAPI镜像构建。只有主程序、管理页面或插件宿主API需要变化时，才转到NewAPI维护仓库。
- 保留AGPL许可证与NewAPI/QuantumNous来源说明，不提交渠道密钥、令牌、Cookie、账号数据或生产配置。
- 远程操作继续遵守工作区SSH与宝塔规则，使用NewAPI官方管理API及规范备份，不直接改生产数据库。
