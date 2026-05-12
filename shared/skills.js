/*
 * 内置 Skills 系统
 *
 * 与 mentor 模式正交：可以同时启用一个 skill + 一个 mentor flavor。
 * 系统提示词的最终拼装顺序：
 *   [skill prompt]
 *   ---（用户启用了带教模式，参考下方）
 *   [mentor prompt]
 *   ---（用户基础系统提示词，作为背景）
 *   [base systemPrompt]
 *
 * 设计要点：
 * - 元数据（id/label/icon/description）放在 JS 里、随 importScripts 同步加载。
 * - 长系统提示词放在 `shared/skills/<id>.md`，懒加载并缓存（避免开发时
 *   维护 30KB 字符串的转义噩梦）。
 * - 仅 background / options 需要 prompt 实文本；content / popup 只用元数据。
 *
 * 共用于 background.js / content.js / popup.html / options.html
 */
(function (global) {
    const SKILL_OFF = 'off';
    const DEFAULT_SKILL_ID = SKILL_OFF;

    // id -> { id, label, icon, description, hint, promptUrl?, systemPrompt?, isBuiltIn }
    const REGISTRY = new Map();
    REGISTRY.set(SKILL_OFF, {
        id: SKILL_OFF,
        label: '不使用',
        icon: '—',
        description: '关闭 Skill。仅使用基础系统提示词（叠加 mentor 时仍然生效）。',
        hint: '关闭 Skill。',
        systemPrompt: '',
        isBuiltIn: true
    });

    // id -> Promise<string> （懒加载缓存，命中后即拿现成）
    const PROMPT_CACHE = new Map();

    function isExtensionContext() {
        return typeof chrome !== 'undefined'
            && chrome.runtime
            && typeof chrome.runtime.getURL === 'function';
    }

    function register(skill) {
        if (!skill || typeof skill !== 'object') return;
        const id = String(skill.id || '').trim();
        if (!id || id === SKILL_OFF) return;
        if (!/^[\w-]+$/.test(id)) return;
        REGISTRY.set(id, {
            id,
            label: skill.label || id,
            icon: skill.icon || '🛠️',
            description: skill.description || '',
            hint: skill.hint || skill.description || '',
            promptUrl: skill.promptUrl || '',
            systemPrompt: typeof skill.systemPrompt === 'string' ? skill.systemPrompt : '',
            // 是否需要把当前页面的图片清单（URL + alt + 邻近标题）一并注入到 pageContent。
            // 仅当用户启用此 skill 时才采集，避免给所有对话增加 token。
            wantsImages: Boolean(skill.wantsImages),
            isBuiltIn: skill.isBuiltIn !== false
        });
    }

    function getAll() {
        // 保持注册顺序；OFF 永远在最前
        const list = [];
        const off = REGISTRY.get(SKILL_OFF);
        if (off) list.push(off);
        for (const [id, skill] of REGISTRY.entries()) {
            if (id === SKILL_OFF) continue;
            list.push(skill);
        }
        return list;
    }

    function getSkill(id) {
        return REGISTRY.get(normalizeSkillId(id)) || REGISTRY.get(SKILL_OFF);
    }

    function normalizeSkillId(id) {
        if (typeof id === 'string' && REGISTRY.has(id)) return id;
        return DEFAULT_SKILL_ID;
    }

    function isSkillActive(id) {
        const norm = normalizeSkillId(id);
        return Boolean(norm && norm !== SKILL_OFF);
    }

    // 异步：从 .md / 内嵌字段拿到默认 prompt（带缓存）
    async function getDefaultSkillPrompt(id) {
        const skill = getSkill(id);
        if (!skill || !isSkillActive(id)) return '';
        if (skill.systemPrompt) return skill.systemPrompt;
        if (!skill.promptUrl) return '';
        if (PROMPT_CACHE.has(id)) return PROMPT_CACHE.get(id);
        if (!isExtensionContext()) return '';
        const url = chrome.runtime.getURL(skill.promptUrl);
        const promise = fetch(url)
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.text();
            })
            .catch((error) => {
                console.warn(`加载 skill prompt 失败 (${id}):`, error);
                return '';
            });
        PROMPT_CACHE.set(id, promise);
        return promise;
    }

    // 同步：拿缓存里的（必须先 preload 过）
    function peekCachedSkillPrompt(id) {
        const skill = getSkill(id);
        if (!skill || !isSkillActive(id)) return '';
        if (skill.systemPrompt) return skill.systemPrompt;
        const cached = PROMPT_CACHE.get(id);
        if (!cached) return '';
        // 我们存的是 Promise；只有 resolved 才能同步取值
        // 这里依赖一个 sidecar 缓存：preload 完成后写入
        return cached.__resolved || '';
    }

    // 预热：解析 promise 并把结果写到 sidecar，方便同步取值
    async function preloadSkill(id) {
        const norm = normalizeSkillId(id);
        if (!isSkillActive(norm)) return '';
        const promise = (async () => {
            const text = await getDefaultSkillPrompt(norm);
            return text;
        })();
        // 缓存里放的就是这条 promise（带 __resolved 副作用）
        const wrapped = promise.then((text) => {
            wrapped.__resolved = text;
            return text;
        });
        PROMPT_CACHE.set(norm, wrapped);
        return wrapped;
    }

    // overrides: { [id]: string } —— 用户在设置页填的覆盖
    async function resolveSkillPrompt(id, overrides) {
        const norm = normalizeSkillId(id);
        if (!isSkillActive(norm)) return '';
        if (overrides && typeof overrides === 'object') {
            const raw = overrides[norm];
            if (typeof raw === 'string' && raw.trim()) return raw.trim();
        }
        const def = await getDefaultSkillPrompt(norm);
        return (def || '').trim();
    }

    function resolveSkillPromptSync(id, overrides) {
        const norm = normalizeSkillId(id);
        if (!isSkillActive(norm)) return '';
        if (overrides && typeof overrides === 'object') {
            const raw = overrides[norm];
            if (typeof raw === 'string' && raw.trim()) return raw.trim();
        }
        return (peekCachedSkillPrompt(norm) || '').trim();
    }

    function resolveSkillLabel(id, labelOverrides) {
        const norm = normalizeSkillId(id);
        if (labelOverrides && typeof labelOverrides === 'object') {
            const raw = labelOverrides[norm];
            if (typeof raw === 'string' && raw.trim()) return raw.trim();
        }
        const skill = REGISTRY.get(norm);
        return (skill && skill.label) || norm;
    }

    // 把 skill prompt 包到 downstreamPrompt 外层
    // downstreamPrompt 通常已经是 mentor + base 的拼接结果
    function buildSkillSystemPrompt(id, downstreamPrompt, overrides) {
        const norm = normalizeSkillId(id);
        if (!isSkillActive(norm)) return downstreamPrompt || '';
        const skillPrompt = resolveSkillPromptSync(norm, overrides);
        if (!skillPrompt) return downstreamPrompt || '';
        const tail = (downstreamPrompt || '').trim();
        if (!tail) return skillPrompt;
        return `${skillPrompt}\n\n---\n（以下是用户的其他系统提示词 / 带教模式提示词，仅作为背景参考；请优先遵守上方 Skill 的指令。）\n${tail}`;
    }

    const api = {
        SKILL_OFF,
        DEFAULT_SKILL_ID,
        register,
        getAll,
        getSkill,
        normalizeSkillId,
        isSkillActive,
        getDefaultSkillPrompt,
        preloadSkill,
        peekCachedSkillPrompt,
        resolveSkillPrompt,
        resolveSkillPromptSync,
        resolveSkillLabel,
        buildSkillSystemPrompt
    };

    global.WebChatSkills = api;
})(typeof self !== 'undefined' ? self : this);
