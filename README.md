# PageLens AI

PageLens AI 是一个 Chrome Manifest V3 扩展，用侧边面板和悬浮球把当前网页变成可提问、可总结、可追问的 AI 阅读助手。

本项目基于 [Airmomo/WebChat](https://github.com/Airmomo/WebChat) 二次开发，已清理默认密钥、私有端点和本地个人配置。

## 功能

- 基于当前网页正文、选中文本或纯聊天进行问答
- 支持 PDF 页面（Chrome 原生阅读器 / `application/pdf` / `.pdf` 链接）通过 pdf.js 抽取正文
- 流式输出，支持 Markdown 渲染
- 支持 OpenAI 兼容 API、Anthropic Claude 和 Ollama 本地模型
- 支持 `Cmd/Ctrl+Shift+K` 打开或关闭侧边面板
- 支持 `/commands` 快捷提示词、自定义 Slash 指令
- 支持学习带教模式、网页关键概念标注、选中回答后继续追问
- 支持自定义悬浮球图案
- 支持通过本地桥接服务把会话保存为 Markdown 日志

## 安装

1. 下载代码：`git clone https://github.com/KitschYoung/pagelens-ai.git`
2. 打开 `chrome://extensions/`
3. 开启“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择项目根目录

## 使用

- 刷新网页后会出现悬浮球，点击打开侧边面板
- 在设置页填写 API 类型、请求地址、模型和密钥
- 在网页上选中文字后，可使用“选中 + 临时”模式只围绕选区提问
- 输入 `/` 可打开快捷指令菜单
- 设置页可上传图片作为悬浮球图案

## 会话模式

- `网页 + 入库`：使用整页正文，允许写入 Markdown 日志
- `网页 + 临时`：使用整页正文，不写入日志
- `选中 + 临时`：只使用页面选中文本，不写入日志
- `纯聊 + 入库`：不使用网页正文，允许写入日志
- `纯聊 + 临时`：不使用网页正文，不写入日志

## 本地日志

日志功能需要先启动本地桥接服务：

```bash
python3 tools/session_log_bridge.py
```

默认服务地址是 `http://127.0.0.1:8765/log-session`，默认输出目录是 `~/pagelens-session-logs`。Chrome 扩展不能直接写任意本地路径，所以日志通过这个本地服务落盘。

## 隐私

- 仓库不包含 API 密钥、访问令牌、私有端点或个人账号配置
- API 配置保存在用户自己的 `chrome.storage` 中
- 网页内容只在用户发起问答或标注时发送给已配置的模型服务
- Markdown 日志只写入用户配置的本地目录

## 开发

本项目没有 npm 构建步骤，直接以未打包扩展加载。修改 Python 日志桥后可运行：

```bash
python3 -m py_compile tools/session_log_bridge.py
```

修改扩展代码后，在 `chrome://extensions/` 重载扩展并刷新目标网页。
