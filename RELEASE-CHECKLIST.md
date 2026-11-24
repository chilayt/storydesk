# 首发验收

## 2.0.14-beta.2

- [x] 从清单导出到空目录，执行 `npm ci` 与 `npm run installer`。打包器自行准备 Electron，Python 嵌入运行时通过 SHA-256 校验。
- [x] 188 项核心测试通过。打包版用虚构作品验收首次启动、阅读编辑、云端与本机模拟模型切换及密钥隔离。
- [x] 内置 MemLayer 0.2.4 beta。验证记忆确认、跨作品隔离、实际召回来源、反馈、重启和撤回。
- [x] 用《北岸电台》和《远灯录》验证两类目录。后一种使用拆章文件和 `novel-kb`，可发现正文、人物及章纲。
- [x] 安装 beta.1，写入虚构稿件、对话与记忆，原位升级到 beta.2，再卸载重装。复核作品和文档 ID、草稿版本、对话、模型配置和已确认记忆。新对话能实际召回升级前的记忆。
- [x] 检查公开源码与安装包，生成安装包 SHA-256。源码使用 Apache-2.0，随包组件保留许可和署名。

测试在一台 Windows 上完成。安装测试使用独立的作品和应用配置，模型请求使用模拟接口。本次预览包未签名。后续需要覆盖另一台普通权限 Windows 上的交互式安装。

## 复验命令

使用 `npm test` 跑核心测试。`npm run test:connections`、`npm run test:memory` 和 `npm run test:reader` 使用 `NOVEL_PACKAGED_EXE` 指定打包版可执行文件。安装升级回归使用 `node scripts/public-upgrade-smoke.mjs <beta.1安装包> <beta.2安装包>`，在没有安装开源版的隔离 Windows 测试环境运行。使用 `node scripts/audit-public.mjs <产物目录>` 检查文件并生成 SHA-256。

## 后续迭代

用可复现样例追踪已确认的偏好是否正确召回、纠正过的问题是否重犯、无关偏好是否误入请求。更新 MemLayer 时复跑记忆、升级和发布验收。跟踪打包工具的开发依赖更新。

## Windows 代码签名

`npm run installer:signed` 使用 electron-builder 构建 Windows x64 安装包，要求成功签名并将产物写入 `release-signed/`。签名时在受保护的环境中提供代码签名凭据。可由 `WIN_CSC_LINK` 与 `WIN_CSC_KEY_PASSWORD` 传入已有证书文件的凭据，或通过 `npm run installer:signed -- -c.win.signtoolOptions.certificateSha1=<指纹>` 选择 Windows 证书库中已有的证书。证书及私钥由发布者或授权签名服务保管。配置细节见 [electron-builder v26 签名文档](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/)。随包 Python 保留 Python Software Foundation 的原签名。

签名会改变文件的 SHA-256。发布前验证 Windows Authenticode 及时间戳，复验签名版安装，再从签名产物重新生成 SHA-256。签名后的产物以新版本发布，已公开的下载和校验文件继续对应原版本。

## GitHub 托管的 Windows 构建

在 GitHub 的 **Actions → Windows build → Run workflow** 运行构建。流程用 `windows-2025` 托管运行器安装锁定依赖，执行核心测试，构建并扫描 Windows x64 安装包。运行摘要注明源码提交与 SHA-256。安装包和校验文件分别保存在 `storydesk-windows-x64-unsigned` 与 `storydesk-windows-x64-unsigned-sha256` 产物中。

接入 SignPath Foundation 时，从同一托管工作流把安装包产物 ID 传给签名动作，维护者审批签名请求。签名产物需要重新计算 SHA-256，再验收与发布。签名服务的项目和授权由审核后的配置提供。 [SignPath GitHub 接入说明](https://docs.signpath.io/trusted-build-systems/github)
