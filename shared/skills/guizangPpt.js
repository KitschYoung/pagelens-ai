/*
 * 内置 Skill：guizang-ppt-skill
 *
 * 来源：~/.agents/skills/guizang-ppt-skill/SKILL.md
 * Prompt 文本保留原始 Markdown 在 shared/skills/guizang-ppt.md，
 * 由 background / options 在使用时通过 fetch + chrome.runtime.getURL 加载。
 */
(function (global) {
    if (!global.WebChatSkills || typeof global.WebChatSkills.register !== 'function') {
        // skills.js 必须先于本文件加载
        return;
    }

    global.WebChatSkills.register({
        id: 'guizang-ppt',
        label: '杂志风网页 PPT',
        icon: '🪄',
        description: '生成"电子杂志 × 电子墨水"风格的横向翻页网页 PPT（单 HTML 文件）。',
        hint: '适合分享 / 演讲 / 发布会风格的网页 PPT；多轮迭代体验最佳。',
        promptUrl: 'shared/skills/guizang-ppt.md',
        // PPT 需要把当前页面的图片 URL 清单注入到 pageContent，AI 可直接 <img src> 嵌入。
        wantsImages: true,
        isBuiltIn: true
    });
})(typeof self !== 'undefined' ? self : this);
