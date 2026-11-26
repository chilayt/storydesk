# 发布验收

## 2.1.0-beta.1（章间）

- [x] 194 项核心测试通过。长对话分支保留开头并可查询旧消息，交稿前核对按作品启用。
- [x] Windows x64 打包版通过新书构思、阅读编辑、模型配置和 MemLayer 复验。模型请求使用本机模拟接口，作品与记忆使用虚构数据。
- [x] 用已发布的 `2.0.14-beta.3` 安装包做原位升级及卸载重装。确认作品编号、草稿版本、对话、模型配置和旧记忆保留，旧记忆仍能在新会话召回。
- [x] 内置 MemLayer 0.3.1。核对时传递旧记忆版本，旧版本不匹配时保留待核对候选。
- [x] 公开源码与安装包通过隐私检查，生成 SHA-256。安装包未签名。

## 2.0.14-beta.3

- [x] 189 项核心测试通过。公开版接受直引号，作品可显式启用中文双引号检查。旧版用词裁定文件仍可读取和更新。
- [x] Windows x64 打包版通过阅读器、模拟模型连接和 MemLayer 记忆复验。验收使用虚构稿件和独立应用配置。
- [x] 核对公开源码与安装包，生成 SHA-256。安装包未签名。

## 2.0.14-beta.2

- [x] 从清单导出到空目录，执行 `npm ci` 与 `npm run installer`。打包器自行准备 Electron，Python 嵌入运行时通过 SHA-256 校验。
- [x] 188 项核心测试通过。打包版用虚构作品验收首次启动、阅读编辑、云端与本机模拟模型切换及密钥隔离。
- [x] 内置 MemLayer 0.2.4 beta。验证记忆确认、跨作品隔离、实际召回来源、反馈、重启和撤回。
- [x] 用《北岸电台》和《远灯录》验证两类目录。后一种使用拆章文件和 `novel-kb`，可发现正文、人物及章纲。
- [x] 安装 beta.1，写入虚构稿件、对话与记忆，原位升级到 beta.2，再卸载重装。复核作品和文档 ID、草稿版本、对话、模型配置和已确认记忆。新对话能实际召回升级前的记忆。
- [x] 检查公开源码与安装包，生成安装包 SHA-256。源码使用 Apache-2.0，随包组件保留许可和署名。

测试在一台 Windows 上完成。安装测试使用独立的作品和应用配置，模型请求使用模拟接口。本次预览包未签名。后续需要覆盖另一台普通权限 Windows 上的交互式安装。

## 复验命令

使用 `npm test` 跑核心测试。`npm run test:connections`、`npm run test:memory` 和 `npm run test:reader` 使用 `NOVEL_PACKAGED_EXE` 指定打包版可执行文件。在没有安装开源版的 Windows 测试环境运行 `node scripts/public-upgrade-smoke.mjs <2.0.14-beta.3安装包> <2.1.0-beta.1安装包>`。使用 `node scripts/audit-public.mjs <产物目录>` 检查文件并生成 SHA-256。

## 后续迭代

用可复现样例追踪已确认的偏好是否正确召回、纠正过的问题是否重犯、无关偏好是否误入请求。更新 MemLayer 时复跑记忆、升级和发布验收。跟踪打包工具的开发依赖更新。

## Windows 代码签名

`npm run installer:signed` 使用 electron-builder 构建 Windows x64 安装包，要求成功签名并将产物写入 `release-signed/`。签名时在受保护的环境中提供代码签名凭据。可由 `WIN_CSC_LINK` 与 `WIN_CSC_KEY_PASSWORD` 传入已有证书文件的凭据，或通过 `npm run installer:signed -- -c.win.signtoolOptions.certificateSha1=<指纹>` 选择 Windows 证书库中已有的证书。证书及私钥由发布者或授权签名服务保管。配置细节见 [electron-builder v26 签名文档](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/)。随包 Python 保留 Python Software Foundation 的原签名。

签名会改变文件的 SHA-256。发布前验证 Windows Authenticode 及时间戳，复验签名版安装，再从签名产物重新生成 SHA-256。签名后的产物以新版本发布，已公开的下载和校验文件继续对应原版本。
