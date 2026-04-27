/*
 * "/commands" 快捷指令模板共享定义
 *
 * 结构：{ name, title, prompt, autoSubmit? }
 *   - name：不带斜杠的触发词，输入框只输入 "/xxx"（首字符 /）会做 prefix 匹配
 *   - title：弹层里显示的人类可读名称
 *   - prompt：选中后灌入输入框的提示词文本
 *
 * 用户可在设置页里增删改；存储键名 chrome.storage.sync.slashCommands
 * 未初始化时 background/content 会使用下面的 DEFAULT_SLASH_COMMANDS
 */
(function (global) {
    const DEFAULT_SLASH_COMMANDS = [
        { name: 'summarize',    title: '五条要点总结',           prompt: '请用 5 条要点总结这篇内容。' },
        { name: 'tldr',         title: 'TL;DR 一句话概括',       prompt: '请用一句话概括核心观点（不超过 40 字）。' },
        { name: 'translate-zh', title: '翻译为中文',             prompt: '请把上述内容完整翻译成中文，保留原有的 Markdown/列表结构。' },
        { name: 'translate-en', title: '翻译为英文',             prompt: 'Please translate the above content into English, preserving the Markdown structure.' },
        { name: 'explain',      title: '通俗讲解',               prompt: '请用通俗易懂的语言（面向初学者）解释上述内容，适当举例。' },
        { name: 'outline',      title: '生成大纲',               prompt: '请为上述内容生成一个多层级的 Markdown 结构化大纲。' },
        { name: 'keypoints',    title: '抽取核心要点',           prompt: '请列出上述内容中 5-8 个关键信息点，用项目符号呈现。' },
        { name: 'qa',           title: '出 5 道练习题',          prompt: '基于上述内容出 5 道理解题，并在每题后给出参考答案。' },
        { name: 'quiz',         title: '🎯 自测（本次会话）',    prompt: '请基于我们这次会话已经讨论过的知识点，出 3 道自测题（由浅到深）。每题要求：(1) 只出题，先**不要**给答案；(2) 题型用"简答 / 判断 / 应用题"混合；(3) 题目要针对我表达中不够清晰的地方。最后一行加一句："请先尝试作答，回复后我再批改。"' },
        { name: 'feynman',      title: '🧠 费曼：让我讲给你听',  prompt: '从现在开始请扮演一个对这个话题**完全不懂**的学生，我来把刚才学到的内容讲给你听。请严格遵守：(1) 不要主动展示你知道；(2) 每次只追问 1-2 个我讲得最含糊的词或句子；(3) 用"我听不懂…能换个说法吗？"或"能再举个日常例子吗？"这种方式追问。我准备好了，先问我一句："你想给我讲清楚什么？"' },
        { name: 'deepdive',     title: '🔍 针对上一句深挖',      prompt: '请针对你上一条回答中**最关键**或**最不容易理解**的那一句话，深入讲清楚：包括 (1) 它的精确含义；(2) 为什么这么说；(3) 一个最小的具体例子；(4) 常见的误解。' },
        { name: 'rewrite',      title: '改写更清晰',             prompt: '请改写上述内容，让表达更清晰凝练，保留原意。' },
        { name: 'counter',      title: '反驳/质疑角度',          prompt: '请从另一个角度反驳/质疑上述内容，列出 3-5 条潜在问题或反例。' },
        { name: 'greet',        title: 'BOSS 打招呼模板',         prompt: '请基于当前网页的岗位/JD信息，生成打招呼内容。', autoSubmit: true }
    ];

    const AUTO_MERGE_DEFAULT_NAMES = ['greet'];

    // 兜底：剔除空 name / 非对象 / 重复 name，保证下游安全
    function normalizeSlashCommands(list) {
        if (!Array.isArray(list)) return [];
        const seen = new Set();
        const out = [];
        for (const raw of list) {
            if (!raw || typeof raw !== 'object') continue;
            const name = String(raw.name || '').trim();
            const title = String(raw.title || '').trim();
            const prompt = String(raw.prompt || '');
            const autoSubmit = raw.autoSubmit === true;
            if (!name || !prompt) continue;
            // 指令名只允许字母数字连字符（和输入框里的匹配正则一致）
            if (!/^[\w-]+$/.test(name)) continue;
            if (seen.has(name)) continue;
            seen.add(name);
            out.push({ name, title: title || name, prompt, ...(autoSubmit ? { autoSubmit } : {}) });
        }
        return out;
    }

    function mergeNewDefaultSlashCommands(list) {
        const out = normalizeSlashCommands(list);
        const seen = new Set(out.map((item) => item.name));
        for (const name of AUTO_MERGE_DEFAULT_NAMES) {
            if (seen.has(name)) continue;
            const item = DEFAULT_SLASH_COMMANDS.find((cmd) => cmd.name === name);
            if (item) out.push({ ...item });
        }
        return out;
    }

    global.WebChatSlash = {
        DEFAULT_SLASH_COMMANDS,
        normalizeSlashCommands,
        mergeNewDefaultSlashCommands
    };
})(typeof self !== 'undefined' ? self : this);
