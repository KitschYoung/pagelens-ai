#!/usr/bin/env python3
"""Local bridge that persists WebChat sessions as markdown files."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


DEFAULT_OUTPUT_DIR = Path("~/webchat-session-logs").expanduser()
DEFAULT_WORKSPACE_ROOT = Path("~/webchat-workspace").expanduser()


def slugify(text: str) -> str:
    value = text.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    return value.strip("-")


def safe_iso_date(value: str | None) -> str:
    if not value:
        return datetime.now().date().isoformat()

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return datetime.now().date().isoformat()


def yaml_quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def message_heading(role: str) -> str:
    return "用户" if role == "user" else "助手"


def render_messages(messages: list[dict[str, Any]]) -> str:
    sections: list[str] = []

    for index, message in enumerate(messages, start=1):
        role = message.get("role", "assistant")
        created_at = message.get("createdAt", "")
        content = (message.get("content") or "").strip()
        content = content or "_空消息_"
        sections.append(
            "\n".join(
                [
                    f"### {index}. {message_heading(role)}",
                    "",
                    f"- 角色: `{role}`",
                    f"- 时间: `{created_at}`" if created_at else "- 时间: `unknown`",
                    "",
                    content,
                ]
            )
        )

    return "\n\n".join(sections)


def render_turns(turns: list[dict[str, Any]]) -> str:
    sections: list[str] = []

    for index, turn in enumerate(turns, start=1):
        if turn.get("type") == "gap":
            sections.append(
                "\n".join(
                    [
                        f"### {index}. 日志说明",
                        "",
                        turn.get("note", "中间存在未入库回合，已省略。"),
                    ]
                )
            )
            continue

        messages = turn.get("messages", [])
        page_snapshot = turn.get("pageSnapshot") or {}
        lines = [f"### {index}. 回合"]

        if turn.get("chatMode"):
            lines.extend(["", f"- 模式: `{turn['chatMode']}`"])

        if page_snapshot.get("title") or page_snapshot.get("url") or page_snapshot.get("excerpt"):
            lines.extend(["", "#### 页面快照"])
            if page_snapshot.get("title"):
                lines.append(f"- 标题: {page_snapshot['title']}")
            if page_snapshot.get("url"):
                lines.append(f"- 地址: {page_snapshot['url']}")
            if page_snapshot.get("domain"):
                lines.append(f"- 域名: `{page_snapshot['domain']}`")
            if page_snapshot.get("excerpt"):
                lines.extend(["", "```text", page_snapshot["excerpt"], "```"])

        for message in messages:
            role = message.get("role", "assistant")
            content = (message.get("content") or "").strip() or "_空消息_"
            lines.extend(
                [
                    "",
                    f"#### {message_heading(role)}",
                    "",
                    content,
                ]
            )

        sections.append("\n".join(lines))

    return "\n\n".join(sections)


def build_markdown(payload: dict[str, Any], output_file: Path) -> str:
    session = payload["session"]
    page = session.get("page", {})
    assistant = session.get("assistant", {})
    messages = session.get("messages", [])
    turns = session.get("turns", [])
    title = page.get("title") or "未命名页面"
    session_id = session.get("sessionId", "unknown-session")
    started_at = session.get("startedAt", "")
    updated_at = session.get("updatedAt", "")
    saved_at = payload.get("savedAt", "")
    excerpt = (page.get("excerpt") or "").strip()
    relative_output = output_file

    frontmatter = [
        "---",
        "type: source",
        "source_kind: webchat-session",
        "source_app: WebChat",
        "source_label: 灵思日志",
        f"session_id: {yaml_quote(session_id)}",
        f"created_at: {yaml_quote(started_at)}",
        f"updated_at: {yaml_quote(updated_at)}",
        f"saved_at: {yaml_quote(saved_at)}",
        f"status: {yaml_quote(session.get('status', 'completed'))}",
        f"model: {yaml_quote(assistant.get('model') or '')}",
        f"api_type: {yaml_quote(assistant.get('apiType') or '')}",
        f"turn_count: {session.get('turnCount', 0)}",
        f"message_count: {session.get('messageCount', 0)}",
        "tags:",
        "  - webchat",
        "  - 会话日志",
        "  - 灵思日志",
        "  - browser",
        "---",
        "",
    ]

    if page.get("title"):
        frontmatter.insert(10, f"page_title: {yaml_quote(page.get('title') or '')}")
    if page.get("url"):
        frontmatter.insert(11, f"page_url: {yaml_quote(page.get('url') or '')}")
    if page.get("domain"):
        frontmatter.insert(12, f"page_domain: {yaml_quote(page.get('domain') or '')}")

    metadata_lines = [
        f"# 灵思会话日志｜{title}",
        "",
        "## 会话信息",
        "",
        f"- 会话 ID: `{session_id}`",
        f"- 会话开始: `{started_at}`" if started_at else "- 会话开始: `unknown`",
        f"- 最近更新: `{updated_at}`" if updated_at else "- 最近更新: `unknown`",
        f"- 最近保存: `{saved_at}`" if saved_at else "- 最近保存: `unknown`",
        f"- 状态: `{session.get('status', 'completed')}`",
        f"- 模型: `{assistant.get('model') or 'unknown'}`",
        f"- API 类型: `{assistant.get('apiType') or 'unknown'}`",
        f"- 上下文对话: `{assistant.get('enableContext', False)}`",
        f"- 上下文轮数: `{assistant.get('maxContextRounds', 0)}`",
        f"- 输出文件: `{relative_output}`",
    ]

    if page.get("title") or page.get("url") or page.get("domain"):
        metadata_lines.extend(
            [
                f"- 页面标题: {title}",
                f"- 页面地址: {page.get('url') or 'unknown'}",
                f"- 页面域名: `{page.get('domain') or 'unknown'}`",
                "",
                "## 页面上下文",
                "",
                f"- 页面文本长度: `{page.get('contentLength', 0)}`",
                "",
            ]
        )

    if excerpt:
        metadata_lines.extend(
            [
                "```text",
                excerpt,
                "```",
                "",
            ]
        )
    elif page.get("title") or page.get("url") or page.get("domain"):
        metadata_lines.append("_页面未提供可用文本摘录_")
        metadata_lines.append("")

    metadata_lines.extend(
        [
            "## 对话全文",
            "",
            render_turns(turns) if turns else render_messages(messages),
            "",
            "## 原始会话摘要",
            "",
            "```json",
            json.dumps(
                {
                    "reason": payload.get("reason"),
                    "workspaceRoot": payload.get("workspaceRoot"),
                    "outputDir": payload.get("outputDir"),
                    "messageCount": session.get("messageCount", 0),
                    "turnCount": session.get("turnCount", 0),
                },
                ensure_ascii=False,
                indent=2,
            ),
            "```",
            "",
        ]
    )

    return "\n".join(frontmatter + metadata_lines)


def build_output_file(payload: dict[str, Any], default_output_dir: Path) -> Path:
    session = payload["session"]
    page = session.get("page", {})
    output_dir = Path(payload.get("outputDir") or default_output_dir).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    started_date = safe_iso_date(session.get("startedAt"))
    domain = slugify(page.get("domain") or "chat") or "chat"
    title = slugify(page.get("title") or "session")[:48] or "session"
    session_id = session.get("sessionId", "session")

    filename = f"{started_date}-webchat-{domain}-{title}-{session_id[-6:]}.md"
    return output_dir / filename


def validate_payload(payload: dict[str, Any]) -> None:
    if "session" not in payload:
        raise ValueError("Missing session object")

    session = payload["session"]

    if not session.get("sessionId"):
        raise ValueError("Missing session.sessionId")

    if not isinstance(session.get("messages"), list):
        raise ValueError("session.messages must be a list")


def make_handler(default_output_dir: Path, default_workspace_root: Path):
    class SessionLogHandler(BaseHTTPRequestHandler):
        server_version = "WebChatSessionBridge/1.0"

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self._send_common_headers()
            self.end_headers()

        def do_GET(self) -> None:
            if self.path != "/health":
                self._send_json(404, {"ok": False, "error": "Not found"})
                return

            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "webchat-session-bridge",
                    "outputDir": str(default_output_dir),
                    "workspaceRoot": str(default_workspace_root),
                },
            )

        def do_POST(self) -> None:
            if self.path != "/log-session":
                self._send_json(404, {"ok": False, "error": "Not found"})
                return

            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length)
                payload = json.loads(raw_body.decode("utf-8"))
                validate_payload(payload)

                output_file = build_output_file(payload, default_output_dir)
                markdown = build_markdown(payload, output_file)
                output_file.write_text(markdown, encoding="utf-8")

                self._send_json(
                    200,
                    {
                        "ok": True,
                        "filePath": str(output_file),
                        "messageCount": payload["session"].get("messageCount", 0),
                    },
                )
            except Exception as error:  # noqa: BLE001
                self._send_json(400, {"ok": False, "error": str(error)})

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
            return

        def _send_common_headers(self) -> None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._send_common_headers()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return SessionLogHandler


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persist WebChat session logs to markdown files.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--workspace-root", default=str(DEFAULT_WORKSPACE_ROOT))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser()
    workspace_root = Path(args.workspace_root).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    handler = make_handler(output_dir, workspace_root)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Session log bridge listening on http://{args.host}:{args.port}")
    print(f"Writing markdown logs to {output_dir}")
    server.serve_forever()


if __name__ == "__main__":
    main()
