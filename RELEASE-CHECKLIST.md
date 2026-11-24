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
