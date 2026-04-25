#!/usr/bin/env python3
"""Local bridge that persists PageLens AI sessions as markdown files."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


DEFAULT_OUTPUT_DIR = Path("~/pagelens-session-logs").expanduser()
DEFAULT_WORKSPACE_ROOT = Path("~/pagelens-workspace").expanduser()


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
    """兼容回退：老 payload 没有 turns 只有扁平 messages 时使用。"""
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


def chapter_for_turn(turn_index: int, preamble_chain: list[dict[str, Any]]) -> int:
    """找到 turn_index 所属的章节下标；没有匹配则返回 -1。

    preamble.anchor 记录的是"这段正文被追加时的 session.history.length"，
    而 session.history 每轮会增加 2 条（user + assistant），所以
    anchor <= 2 * turn_index 的最后一段 preamble 就是当前 turn 所属章节。
    """
    found = -1
    for idx, pre in enumerate(preamble_chain):
        if pre.get("anchor", 0) <= 2 * turn_index:
            found = idx
        else:
            break
    return found


def render_chapters(preamble_chain: list[dict[str, Any]]) -> str:
    """章节正文区块：每段 preamble 一个二级小节，放进来的是结构化好的 Markdown。"""
    if not preamble_chain:
        return "_本次会话未触发任何页面上下文_"

    sections: list[str] = []
    for pre in preamble_chain:
        idx = pre.get("index", 0) + 1
        title = (pre.get("pageTitle") or "未命名页面").strip()
        url = (pre.get("pageUrl") or "").strip()
        content = (pre.get("content") or "").strip()

        lines = [f"### 章节 {idx}：{title}"]
        if url:
            lines.append(f"> 来源：{url}")
        lines.append("")
        if content:
            lines.append(content)
        else:
            lines.append("_正文为空_")
        sections.append("\n".join(lines))

    return "\n\n".join(sections)


def render_learning_path(preamble_chain: list[dict[str, Any]], turns: list[dict[str, Any]]) -> str:
    """学习轨迹：按章节列出每章对应的轮次范围。"""
    if not preamble_chain:
        return "_本次会话未切换章节_"

    # 收集每个章节的轮次分布（只看 type=turn 的条目）
    turn_entries = [t for t in turns if t.get("type") == "turn"]
    per_chapter_turns: dict[int, list[int]] = {}
    for i, turn in enumerate(turn_entries, start=1):
        ch = chapter_for_turn(turn.get("turnIndex", i - 1), preamble_chain)
        per_chapter_turns.setdefault(ch, []).append(i)

    lines = [f"本次会话经过 **{len(preamble_chain)} 个章节**："]
    lines.append("")
    for pre in preamble_chain:
        idx = pre.get("index", 0)
        title = (pre.get("pageTitle") or "未命名页面").strip()
        url = (pre.get("pageUrl") or "").strip()
        round_nums = per_chapter_turns.get(idx, [])
        if round_nums:
            rng = f"第 {round_nums[0]} ~ {round_nums[-1]} 轮" if len(round_nums) > 1 else f"第 {round_nums[0]} 轮"
        else:
            rng = "尚无对话"
        url_suffix = f" — `{url}`" if url else ""
        lines.append(f"{idx + 1}. **{title}** — {rng}{url_suffix}")

    return "\n".join(lines)


def render_turns(turns: list[dict[str, Any]], preamble_chain: list[dict[str, Any]]) -> str:
    """对话全文：每轮仅列对话本身 + 章节标签；完整页面正文不再重复塞进来。"""
    sections: list[str] = []
    turn_ordinal = 0  # 用于人类阅读的第几轮（gap 不计数）

    for turn in turns:
        if turn.get("type") == "gap":
            sections.append(
                "\n".join(
                    [
                        "### 日志说明",
                        "",
                        turn.get("note", "中间存在未入库回合，已省略。"),
                    ]
                )
            )
            continue

        turn_ordinal += 1
        ch_idx = chapter_for_turn(turn.get("turnIndex", turn_ordinal - 1), preamble_chain)

        header_suffix = ""
        if ch_idx >= 0 and ch_idx < len(preamble_chain):
            ch_title = (preamble_chain[ch_idx].get("pageTitle") or "").strip() or f"章节 {ch_idx + 1}"
            header_suffix = f"（章节 {ch_idx + 1}：{ch_title}）"

        lines = [f"### 第 {turn_ordinal} 轮{header_suffix}"]

        if turn.get("chatMode"):
            lines.extend([f"- 模式：`{turn['chatMode']}`"])
        if turn.get("createdAt"):
            lines.append(f"- 时间：`{turn['createdAt']}`")

        for message in turn.get("messages", []):
            role = message.get("role", "assistant")
            content = (message.get("content") or "").strip() or "_空消息_"
            lines.extend(["", f"**{message_heading(role)}**", "", content])

        sections.append("\n".join(lines))

    return "\n\n".join(sections)


def build_markdown(payload: dict[str, Any], output_file: Path) -> str:
    session = payload["session"]
    page = session.get("page", {})
    assistant = session.get("assistant", {})
    messages = session.get("messages", [])
    turns = session.get("turns", [])
    preamble_chain = session.get("preambleChain", []) or []

    title = page.get("title") or "未命名页面"
    session_id = session.get("sessionId", "unknown-session")
    started_at = session.get("startedAt", "")
    updated_at = session.get("updatedAt", "")
    saved_at = payload.get("savedAt", "")
    relative_output = output_file

    # frontmatter：把 chapters 列表作为结构化元数据，方便 Obsidian/Logseq 检索
    frontmatter = [
        "---",
        "type: source",
        "source_kind: pagelens-session",
        "source_app: PageLens AI",
        "source_label: 灵思日志",
        f"session_id: {yaml_quote(session_id)}",
        f"created_at: {yaml_quote(started_at)}",
        f"updated_at: {yaml_quote(updated_at)}",
        f"saved_at: {yaml_quote(saved_at)}",
        f"status: {yaml_quote(session.get('status', 'completed'))}",
    ]

    if page.get("title"):
        frontmatter.append(f"page_title: {yaml_quote(page.get('title') or '')}")
    if page.get("url"):
        frontmatter.append(f"page_url: {yaml_quote(page.get('url') or '')}")
    if page.get("domain"):
        frontmatter.append(f"page_domain: {yaml_quote(page.get('domain') or '')}")

    frontmatter.extend(
        [
            f"model: {yaml_quote(assistant.get('model') or '')}",
            f"api_type: {yaml_quote(assistant.get('apiType') or '')}",
            f"turn_count: {session.get('turnCount', 0)}",
            f"chapter_count: {len(preamble_chain)}",
        ]
    )

    if preamble_chain:
        frontmatter.append("chapters:")
        for pre in preamble_chain:
            ch_title = (pre.get("pageTitle") or "").strip() or "未命名页面"
            ch_url = (pre.get("pageUrl") or "").strip()
            frontmatter.append(f"  - title: {yaml_quote(ch_title)}")
            if ch_url:
                frontmatter.append(f"    url: {yaml_quote(ch_url)}")

    frontmatter.extend(
        [
            "tags:",
            "  - pagelens",
            "  - 会话日志",
            "  - 灵思日志",
            "  - browser",
            "---",
            "",
        ]
    )

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
        f"- 章节数量: `{len(preamble_chain)}`",
        f"- 对话轮数: `{session.get('turnCount', 0)}`",
    ]

    metadata_lines.extend(
        [
            "",
            "## 学习轨迹",
            "",
            render_learning_path(preamble_chain, turns),
            "",
            "## 章节正文",
            "",
            render_chapters(preamble_chain),
            "",
            "## 对话全文",
            "",
            render_turns(turns, preamble_chain) if turns else render_messages(messages),
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
                    "chapterCount": len(preamble_chain),
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

    filename = f"{started_date}-pagelens-{domain}-{title}-{session_id[-6:]}.md"
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
        server_version = "PageLensSessionBridge/1.0"

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
                    "service": "pagelens-session-bridge",
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
    parser = argparse.ArgumentParser(description="Persist PageLens AI session logs to markdown files.")
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
