const DEFAULT_SETTINGS = {
    apiType: 'openai_chat',
    maxTokens: 2048,
    temperature: 0.7,
    enableContext: true,
    maxContextRounds: 5,
    systemPrompt: '你是一个帮助理解网页内容的AI助手。请使用Markdown格式回复。',
    // 请在扩展设置页填写密钥与端点；此处默认值保持为空，避免泄露。
    openai_chat_apiKey: '',
    openai_chat_apiBase: 'https://api.openai.com/v1',
    openai_chat_apiPath: '/chat/completions',
    openai_chat_model: '',
    responses_apiKey: '',
    responses_apiBase: 'https://api.openai.com/v1',
    responses_apiPath: '/responses',
    responses_model: '',
    claude_apiKey: '',
    claude_apiBase: 'https://api.anthropic.com/v1',
    claude_apiPath: '/messages',
    claude_model: 'claude-sonnet-4-5',
    gemini_apiKey: '',
    gemini_apiBase: 'https://generativelanguage.googleapis.com/v1beta',
    gemini_apiPath: '/models/{model}:generateContent',
    gemini_model: '',
    custom_apiKey: '',
    custom_apiBase: '',
    custom_model: '',
    ollama_apiKey: '',
    ollama_apiBase: 'http://127.0.0.1:11434/api/chat',
    ollama_model: 'qwen2.5',
    anthropic_apiKey: '',
    anthropic_apiBase: 'https://api.anthropic.com/v1/messages',
    anthropic_model: 'claude-sonnet-4-5',
    enableSessionLogging: false,
    sessionLogEndpoint: 'http://127.0.0.1:8765/log-session',
    sessionLogOutputDir: '',
    sessionLogWorkspaceRoot: '',
    sessionIdleMinutes: 30,
    mentorPrompts: {},
    mentorLabels: {}
};

const STORAGE_KEYS = {
    sessions: 'webchat_sessions_v5',
    pendingLogs: 'webchat_pending_logs_v2',
    domainModePrefs: 'webchat_domain_mode_prefs_v1',
    // 按 URL 索引的对话归档。只存轻量元数据，便于抽屉列表快速加载。
    // 结构：{ [urlKey]: [ArchiveIndexEntry, ...] }
    archiveIndex: 'webchat_archive_index_v1'
};

// 按域名记忆的默认会话模式：{ [domain]: chatMode }
let domainModePrefs = {};

// 加载共享的会话模式与带教模式定义（供 importScripts 引入）
try {
    importScripts('shared/chatModes.js', 'shared/mentorModes.js');
} catch (e) {
    console.error('加载 shared/chatModes.js / shared/mentorModes.js 失败:', e);
}

const {
    CHAT_MODES,
    DEFAULT_CHAT_MODE,
    CHAT_MODE_META: SHARED_CHAT_MODE_META
} = self.WebChatModes;

const {
    MENTOR_FLAVORS,
    DEFAULT_MENTOR_FLAVOR,
    normalizeMentorFlavor,
    isMentorActive,
    buildMentorSystemPrompt
} = self.WebChatMentor;

const runtimePorts = {};
const runtimeControllers = {};
let sessionsState = {};
let pendingLogsState = {};
let stateLoadedPromise = null;
let saveStateTimer = null;
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_DATA_URL_LENGTH = 1400000;

function normalizeApiType(apiType) {
    if (apiType === 'custom') return 'openai_chat';
    if (apiType === 'anthropic') return 'claude';
    return ['openai_chat', 'responses', 'claude', 'gemini', 'ollama'].includes(apiType)
        ? apiType
        : 'openai_chat';
}

chrome.runtime.onInstalled.addListener(() => {
    console.log('扩展已安装');
});

// 全局快捷键：Cmd/Ctrl+Shift+K 切换侧边面板
if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener(async (command) => {
        if (command !== 'toggle-panel') return;
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || typeof tab.id !== 'number') return;
            await chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' }).catch(() => { /* 页面不受支持 */ });
        } catch (e) {
            console.warn('toggle-panel 快捷键触发失败:', e);
        }
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    void handleRuntimeMessage(request, sender)
        .then(sendResponse)
        .catch((error) => {
            console.error('处理运行时消息失败:', error);
            sendResponse({ status: 'error', error: error.message });
        });
    return true;
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'answerStream') {
        return;
    }

    port.onMessage.addListener((request) => {
        void handlePortMessage(port, request).catch((error) => {
            console.error('处理端口消息失败:', error);
            sendDirectMessage(port, { type: 'error', error: error.message });
        });
    });

    port.onDisconnect.addListener(() => {
        unregisterPort(port);
    });
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync' && namespace !== 'local') {
        return;
    }

    if (namespace === 'sync' && changes.systemPrompt) {
        console.log('系统提示词已更新');
    }
    if (changes.mentorPrompts) {
        console.log('带教提示词已更新');
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) {
        void finalizeAndClearSession(tabId, 'tab-url-changed');
        return;
    }

    if (changeInfo.status === 'loading') {
        void finalizeAndClearSession(tabId, 'tab-loading');
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    void finalizeAndClearSession(tabId, 'tab-removed');
});

async function handleRuntimeMessage(request, sender) {
    await ensureStateLoaded();
    await recoverInterruptedSessions();

    const { action } = request;

    if (action === 'getHistory') {
        return await getHistoryForTab(request.tabId);
    }

    if (action === 'prepareGeneration') {
        return await prepareGeneration(request.tabId, request.pageContent || '', request.question || '');
    }

    if (action === 'stopGeneration') {
        return await stopGeneration(request.tabId, request.reason || 'manual-stop');
    }

    if (action === 'setChatMode') {
        return await setChatMode(request.tabId, request.chatMode);
    }

    if (action === 'promoteSessionToPersist') {
        return await promoteSessionToPersist(request.tabId);
    }

    if (action === 'setMentorFlavor') {
        return await setMentorFlavor(request.tabId, request.mentorFlavor);
    }

    if (action === 'annotateConcepts') {
        return await annotateConcepts(request.pageContent || '', request.pageTitle || '');
    }

    if (action === 'clearHistory') {
        await finalizeAndClearSession(request.tabId, request.reason || 'clearHistory');
        return { status: 'ok' };
    }

    if (action === 'getGeneratingState') {
        const session = getSession(request.tabId);
        return session?.generatingState || { isGenerating: false };
    }

    if (action === 'openPopup') {
        chrome.action.openPopup();
        return { status: 'ok' };
    }

    if (action === 'getCurrentTab') {
        return { tabId: sender.tab?.id };
    }

    if (action === 'openOptions') {
        chrome.runtime.openOptionsPage();
        return { status: 'ok' };
    }

    if (action === 'getContextDump') {
        return await getContextDump(request.tabId);
    }

    if (action === 'saveHistory') {
        return { status: 'ignored' };
    }

    // ===== 对话归档 API =====
    if (action === 'listArchivesForUrl') {
        const list = await listArchivesForUrl(request.url || '');
        return { status: 'ok', items: list };
    }

    if (action === 'restoreArchive') {
        return await restoreArchiveToTab(request.tabId, request.sessionId);
    }

    if (action === 'deleteArchive') {
        return await deleteArchiveEntry(request.sessionId, request.url || '');
    }

    if (action === 'fetchPdfBytes') {
        return await fetchPdfBytesFromBackground(request.url || '');
    }

    if (action === 'fetchText') {
        return await fetchTextFromBackground(request.url || '', request.credentials || 'omit');
    }

    if (action === 'fetchApiModels') {
        return await fetchApiModels(request.config || {});
    }

    if (action === 'testApiConfig') {
        return await testApiConfigFromBackground(request.config || {});
    }

    return { status: 'unknown-action' };
}

async function fetchTextFromBackground(url, credentials = 'omit') {
    if (!url) return { status: 'error', error: 'empty url' };
    try {
        const resp = await fetch(url, {
            credentials: credentials === 'include' ? 'include' : 'omit'
        });
        if (!resp.ok) {
            return { status: 'error', error: `HTTP ${resp.status}` };
        }
        return {
            status: 'ok',
            text: await resp.text(),
            contentType: resp.headers.get('content-type') || ''
        };
    } catch (error) {
        return { status: 'error', error: String(error && error.message || error) };
    }
}

// 从扩展（service worker）上下文 fetch PDF 字节，主要用于绕开
// content script 在 Chrome 原生 PDF 阅读器 / file:// 页面里 fetch 失败的问题。
// 对 file:// URL，需要用户在 chrome://extensions 给本扩展开启"允许访问文件网址"。
async function fetchPdfBytesFromBackground(url) {
    if (!url) return { status: 'error', error: 'empty url' };
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            return { status: 'error', error: `HTTP ${resp.status}` };
        }
        const buf = await resp.arrayBuffer();
        // 用 base64 跨进程传输，避免 ArrayBuffer 在 sendMessage 里被转成空对象
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return { status: 'ok', base64: btoa(binary), byteLength: bytes.length };
    } catch (error) {
        return { status: 'error', error: String(error && error.message || error) };
    }
}

async function handlePortMessage(port, request) {
    await ensureStateLoaded();
    await recoverInterruptedSessions();

    const tabId = request.tabId;
    registerPort(tabId, port);

    if (request.action === 'generateAnswer') {
        await startGenerationFromPort(port, request);
        return;
    }

    if (request.action === 'reconnectStream') {
        await reconnectStream(port, request);
        return;
    }

    if (request.action === 'stopGeneration') {
        await stopGeneration(tabId, request.reason || 'manual-stop');
    }
}

async function loadSettings() {
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    settings.apiType = normalizeApiType(settings.apiType);
    try {
        const local = await chrome.storage.local.get({ mentorPrompts: null });
        if (local.mentorPrompts && typeof local.mentorPrompts === 'object') {
            settings.mentorPrompts = local.mentorPrompts;
        }
    } catch (error) {
        console.warn('读取本地带教提示词失败，使用同步配置:', error);
    }
    return settings;
}

async function ensureStateLoaded() {
    if (!stateLoadedPromise) {
        stateLoadedPromise = Promise.all([
            chrome.storage.local.get({
                [STORAGE_KEYS.sessions]: {},
                [STORAGE_KEYS.pendingLogs]: {}
            }),
            chrome.storage.sync.get({
                [STORAGE_KEYS.domainModePrefs]: {}
            }).catch(() => ({ [STORAGE_KEYS.domainModePrefs]: {} }))
        ]).then(([localItems, syncItems]) => {
            sessionsState = normalizeSessions(localItems[STORAGE_KEYS.sessions] || {});
            pendingLogsState = localItems[STORAGE_KEYS.pendingLogs] || {};
            domainModePrefs = normalizeDomainModePrefs(syncItems[STORAGE_KEYS.domainModePrefs] || {});
        });
    }

    await stateLoadedPromise;
}

function normalizeDomainModePrefs(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [domain, mode] of Object.entries(raw)) {
        if (typeof domain === 'string' && domain) {
            out[domain.toLowerCase()] = normalizeChatMode(mode);
        }
    }
    return out;
}

function getDomainDefaultMode(domain) {
    if (!domain) return null;
    const key = String(domain).toLowerCase();
    return domainModePrefs[key] || null;
}

function resolveInitialChatMode(tabInfo) {
    const pref = getDomainDefaultMode(tabInfo?.pageDomain);
    return normalizeChatMode(pref || DEFAULT_CHAT_MODE);
}

async function rememberDomainMode(domain, chatMode) {
    if (!domain) return;
    const key = String(domain).toLowerCase();
    const normalized = normalizeChatMode(chatMode);
    if (domainModePrefs[key] === normalized) return;
    domainModePrefs[key] = normalized;
    try {
        await chrome.storage.sync.set({
            [STORAGE_KEYS.domainModePrefs]: domainModePrefs
        });
    } catch (e) {
        console.warn('保存域名会话模式偏好失败:', e);
    }
}

function normalizeSessions(rawSessions) {
    const normalized = {};

    for (const [tabId, session] of Object.entries(rawSessions)) {
        normalized[tabId] = normalizeSession(session);
    }

    return normalized;
}

function normalizeSession(session = {}) {
    return {
        sessionMeta: {
            sessionId: session.sessionMeta?.sessionId || createSessionId(session.sessionMeta?.pageTitle || 'webchat'),
            startedAt: session.sessionMeta?.startedAt || new Date().toISOString(),
            updatedAt: session.sessionMeta?.updatedAt || new Date().toISOString(),
            lastActivityAt: session.sessionMeta?.lastActivityAt || new Date().toISOString(),
            pageUrl: session.sessionMeta?.pageUrl || '',
            pageTitle: session.sessionMeta?.pageTitle || '未命名页面',
            pageDomain: session.sessionMeta?.pageDomain || 'unknown',
            pageContentExcerpt: session.sessionMeta?.pageContentExcerpt || '',
            pageContentLength: session.sessionMeta?.pageContentLength || 0,
            // 同一会话内积累的多章正文前缀；每次检测到新章节就 push 一条
            // { excerpt, content, anchor, createdAt }
            // anchor 是"当时 history.length"，用于重放时把 preamble 插回那个位置
            preambleChain: Array.isArray(session.sessionMeta?.preambleChain)
                ? session.sessionMeta.preambleChain
                : [],
            outputFilePath: session.sessionMeta?.outputFilePath || '',
            lastRotationReason: session.sessionMeta?.lastRotationReason || '',
            lastRecoveryReason: session.sessionMeta?.lastRecoveryReason || '',
            currentChatMode: normalizeChatMode(session.sessionMeta?.currentChatMode),
            mentorFlavor: normalizeMentorFlavor(session.sessionMeta?.mentorFlavor),
            isFinalizing: Boolean(session.sessionMeta?.isFinalizing)
        },
        history: normalizeHistory(session.history || []),
        turns: normalizeTurns(session.turns || []),
        generatingState: {
            isGenerating: Boolean(session.generatingState?.isGenerating),
            pendingQuestion: session.generatingState?.pendingQuestion || '',
            requestId: session.generatingState?.requestId || '',
            turnId: session.generatingState?.turnId || '',
            clientId: session.generatingState?.clientId || '',
            startedAt: session.generatingState?.startedAt || '',
            chatMode: normalizeChatMode(session.generatingState?.chatMode)
        },
        currentAnswer: session.currentAnswer || '',
        completedAnswer: session.completedAnswer || '',
        reservation: {
            requestId: session.reservation?.requestId || '',
            createdAt: session.reservation?.createdAt || ''
        }
    };
}

function normalizeHistory(history = []) {
    return history.map((message) => ({
        turnId: message.turnId || '',
        content: message.content || '',
        markdownContent: message.markdownContent || message.content || '',
        attachments: normalizeImageAttachments(message.attachments),
        isUser: Boolean(message.isUser),
        createdAt: message.createdAt || new Date().toISOString()
    }));
}

function normalizeTurns(turns = []) {
    return turns.map((turn) => ({
        turnId: turn.turnId || createTurnId(),
        requestId: turn.requestId || '',
        createdAt: turn.createdAt || new Date().toISOString(),
        chatMode: normalizeChatMode(turn.chatMode),
        usesPageContext: Boolean(turn.usesPageContext),
        shouldPersist: Boolean(turn.shouldPersist),
        pageSnapshot: normalizePageSnapshot(turn.pageSnapshot),
        question: turn.question || '',
        attachments: normalizeImageAttachments(turn.attachments),
        answer: turn.answer || '',
        status: turn.status || 'completed',
        errorMessage: turn.errorMessage || ''
    }));
}

function normalizePageSnapshot(snapshot) {
    if (!snapshot) {
        return null;
    }

    return {
        title: snapshot.title || '',
        url: snapshot.url || '',
        domain: snapshot.domain || '',
        excerpt: snapshot.excerpt || '',
        contentLength: snapshot.contentLength || 0
    };
}

// 使用 shared/chatModes.js 里的定义（避免和前端漂移）
const normalizeChatMode = self.WebChatModes.normalizeChatMode;

function getSession(tabId) {
    return sessionsState[String(tabId)] || null;
}

async function saveSession(tabId, session, flush = false) {
    sessionsState[String(tabId)] = normalizeSession(session);
    if (flush) {
        await flushPersistentState();
        return;
    }
    schedulePersistentStateSave();
}

async function deleteSession(tabId, flush = false) {
    delete sessionsState[String(tabId)];
    if (flush) {
        await flushPersistentState();
        return;
    }
    schedulePersistentStateSave();
}

function schedulePersistentStateSave(delay = 150) {
    if (saveStateTimer) {
        clearTimeout(saveStateTimer);
    }

    saveStateTimer = setTimeout(() => {
        saveStateTimer = null;
        void flushPersistentState();
    }, delay);
}

async function flushPersistentState() {
    if (saveStateTimer) {
        clearTimeout(saveStateTimer);
        saveStateTimer = null;
    }

    await chrome.storage.local.set({
        [STORAGE_KEYS.sessions]: sessionsState,
        [STORAGE_KEYS.pendingLogs]: pendingLogsState
    });
}

async function recoverInterruptedSessions() {
    let changed = false;

    for (const session of Object.values(sessionsState)) {
        if (!session.generatingState.isGenerating || session.sessionMeta.isFinalizing) {
            continue;
        }

        const runtimeController = runtimeControllers[session.sessionMeta.sessionId];
        if (runtimeController) {
            continue;
        }

        materializeCurrentAnswer(session);
        finalizeTurn(session, session.generatingState.turnId, session.currentAnswer, 'stopped', '');
        session.generatingState = createIdleGeneratingState();
        session.sessionMeta.updatedAt = new Date().toISOString();
        session.sessionMeta.lastRecoveryReason = 'service-worker-restart';
        changed = true;
    }

    if (changed) {
        await flushPersistentState();
    }
}

async function getHistoryForTab(tabId) {
    let session = getSession(tabId);

    if (session) {
        const rotated = await rotateSessionIfNeeded(tabId, false);
        session = rotated || getSession(tabId);
    }

    if (!session) {
        const tabInfo = await getTabSnapshot(tabId);
        session = createSession(tabInfo, resolveInitialChatMode(tabInfo));
        await saveSession(tabId, session, true);
    }

    return buildHistoryResponse(session);
}

async function prepareGeneration(tabId, pageContent, question) {
    const settings = await loadSettings();
    await flushPendingLogs(settings);

    let sessionReset = false;
    let sessionResetReason = '';
    let session = getSession(tabId);
    const tabInfo = await getTabSnapshot(tabId, pageContent);

    if (session) {
        const rotationReason = getRotationReason(session, tabInfo, settings, true);
        if (rotationReason) {
            const nextChatMode = session.sessionMeta.currentChatMode;
            await finalizeAndClearSession(tabId, rotationReason);
            session = createSession(tabInfo, nextChatMode);
            sessionReset = true;
            sessionResetReason = rotationReason;
            await saveSession(tabId, session, true);
        }
    }

    if (session?.generatingState.isGenerating) {
        return {
            status: 'busy',
            error: '当前标签已有生成中的回复，请等待完成后再提问。',
            chatMode: session.sessionMeta.currentChatMode,
            usesPageContext: modeUsesPageContext(session.sessionMeta.currentChatMode)
        };
    }

    if (session?.reservation.requestId && !isReservationExpired(session.reservation)) {
        return {
            status: 'busy',
            error: '当前标签已有待开始的请求，请稍后重试。',
            chatMode: session.sessionMeta.currentChatMode,
            usesPageContext: modeUsesPageContext(session.sessionMeta.currentChatMode)
        };
    }

    if (!session) {
        session = createSession(tabInfo, resolveInitialChatMode(tabInfo));
    } else {
        updateSessionPageInfo(session, tabInfo);
    }

    session.reservation = {
        requestId: createRequestId(),
        createdAt: new Date().toISOString()
    };
    touchSession(session);
    await saveSession(tabId, session, true);

    return {
        status: 'ok',
        requestId: session.reservation.requestId,
        sessionReset,
        sessionResetReason,
        sessionId: session.sessionMeta.sessionId,
        question,
        chatMode: session.sessionMeta.currentChatMode,
        usesPageContext: modeUsesPageContext(session.sessionMeta.currentChatMode)
    };
}

async function setChatMode(tabId, chatMode) {
    const normalizedMode = normalizeChatMode(chatMode);
    const tabInfo = await getTabSnapshot(tabId);
    let session = getSession(tabId);

    if (!session) {
        session = createSession(tabInfo, normalizedMode);
    } else {
        session.sessionMeta.currentChatMode = normalizedMode;
        updateSessionPageInfo(session, tabInfo);
        touchSession(session);
    }

    await saveSession(tabId, session, true);
    // 记住当前域名默认模式，下次同域名新开标签会自动应用
    void rememberDomainMode(tabInfo?.pageDomain, normalizedMode);
    broadcastChatModeUpdate(tabId, normalizedMode, 'chat-mode-changed');

    return {
        status: 'ok',
        chatMode: normalizedMode
    };
}

// 手动"入库当前对话"：
// - 把所有已存在的 turn 的 shouldPersist 回填为 true（否则 buildLogPayload 会过滤掉）
// - 把当前模式切到对应的入库变体（web_* → web_persisted；video_* → video_persisted；chat_* → chat_persisted）
// - 立即触发一次 persistSessionLog 写出到本地日志服务
// - 若当前已是入库模式，则只是再手动落一次盘
async function promoteSessionToPersist(tabId) {
    const session = getSession(tabId);
    if (!session) {
        return { status: 'error', error: '当前标签尚无会话可入库。' };
    }

    const settings = await loadSettings();
    const currentMode = session.sessionMeta.currentChatMode;
    const alreadyPersisted = modeShouldPersist(currentMode);

    if (!alreadyPersisted) {
        const targetMode = modeIsVideoContext(currentMode)
            ? CHAT_MODES.VIDEO_PERSISTED
            : (modeUsesPageContext(currentMode)
                ? CHAT_MODES.WEB_PERSISTED
                : CHAT_MODES.CHAT_PERSISTED);

        // 回填历史 turns，让它们都进入本次导出
        session.turns.forEach((turn) => {
            turn.shouldPersist = true;
            turn.chatMode = targetMode;
        });

        session.sessionMeta.currentChatMode = targetMode;
        touchSession(session);
        await saveSession(tabId, session, true);

        const tabInfo = await getTabSnapshot(tabId);
        void rememberDomainMode(tabInfo?.pageDomain, targetMode);
        broadcastChatModeUpdate(tabId, targetMode, 'chat-mode-promoted');
    }

    await persistSessionLog(tabId, 'manual-persist', settings);

    // 手动入库时立刻把完整 blob 也归档一份，保证在关 tab 前就可以回溯
    try { await commitArchiveFromSession(session, 'persisted'); }
    catch (e) { console.warn('archive 归档失败（manual-persist）:', e); }

    const finalMode = session.sessionMeta.currentChatMode;
    return {
        status: 'ok',
        chatMode: finalMode,
        alreadyPersisted,
        turnsPersisted: session.turns.length
    };
}

async function setMentorFlavor(tabId, mentorFlavor) {
    const normalizedFlavor = normalizeMentorFlavor(mentorFlavor);
    const tabInfo = await getTabSnapshot(tabId);
    let session = getSession(tabId);

    if (!session) {
        session = createSession(tabInfo);
        session.sessionMeta.mentorFlavor = normalizedFlavor;
    } else {
        session.sessionMeta.mentorFlavor = normalizedFlavor;
        updateSessionPageInfo(session, tabInfo);
        touchSession(session);
    }

    await saveSession(tabId, session, true);
    broadcastMentorFlavorUpdate(tabId, normalizedFlavor, 'mentor-flavor-changed');

    return {
        status: 'ok',
        mentorFlavor: normalizedFlavor
    };
}

function broadcastMentorFlavorUpdate(tabId, mentorFlavor, reason) {
    const message = {
        action: 'mentorFlavorUpdated',
        tabId,
        mentorFlavor,
        reason
    };
    chrome.runtime.sendMessage(message).catch(() => { });
    if (typeof tabId === 'number') {
        chrome.tabs.sendMessage(tabId, message).catch(() => { });
    }
}

async function startGenerationFromPort(port, request) {
    const tabId = request.tabId;
    const settings = await loadSettings();
    await flushPendingLogs(settings);

    let session = getSession(tabId);
    const pageContent = request.pageContent || '';
    const tabInfo = await getTabSnapshot(tabId, pageContent);

    if (!session) {
        sendDirectMessage(port, {
            type: 'error',
            error: '会话已过期，请重新提问。'
        });
        return;
    }

    const rotationReason = getRotationReason(session, tabInfo, settings, true);
    if (rotationReason) {
        const nextChatMode = session.sessionMeta.currentChatMode;
        await finalizeAndClearSession(tabId, rotationReason);
        const nextSession = createSession(tabInfo, nextChatMode);
        await saveSession(tabId, nextSession, true);
        sendDirectMessage(port, {
            type: 'session-reset',
            reason: rotationReason,
            chatMode: nextChatMode
        });
        sendDirectMessage(port, {
            type: 'error',
            error: '会话已切换，请重新发送问题。'
        });
        return;
    }

    if (session.generatingState.isGenerating) {
        sendDirectMessage(port, {
            type: 'error',
            error: '当前标签已有生成中的回复，请等待完成后再提问。'
        });
        return;
    }

    if (!request.requestId || request.requestId !== session.reservation.requestId || isReservationExpired(session.reservation)) {
        sendDirectMessage(port, {
            type: 'error',
            error: '请求凭证已失效，请重新提问。'
        });
        return;
    }

    const question = (request.question || '').trim();
    const attachments = normalizeImageAttachments(request.attachments);
    if (!question && attachments.length === 0) {
        sendDirectMessage(port, {
            type: 'error',
            error: '问题不能为空。'
        });
        return;
    }

    updateSessionPageInfo(session, tabInfo);

    const chatMode = session.sessionMeta.currentChatMode;
    const usesPageContext = modeUsesPageContext(chatMode);
    const shouldPersist = modeShouldPersist(chatMode);
    const turnId = createTurnId();
    const pageSnapshot = usesPageContext ? createPageSnapshot(tabInfo) : null;

    // 同一会话内换章：若当前页面正文和上次使用的 preamble 不同，追加一段新 preamble。
    // 这样做的好处：(1) 会话连贯——UI 里不打断、历史不清；(2) 每个 preamble 作为稳定前缀
    // 都可以被 Anthropic prompt caching 命中；(3) 模型能同时看到多章上下文，方便回指。
    maybeAppendPreamble(session, tabInfo, pageContent, usesPageContext, chatMode);

    session.turns.push({
        turnId,
        requestId: request.requestId,
        createdAt: new Date().toISOString(),
        chatMode,
        usesPageContext,
        shouldPersist,
        pageSnapshot,
        question,
        attachments,
        answer: '',
        status: 'generating',
        errorMessage: ''
    });
    session.history.push(createMessage(question, true, turnId, attachments));
    session.currentAnswer = '';
    session.completedAnswer = '';
    session.generatingState = {
        isGenerating: true,
        pendingQuestion: question,
        requestId: request.requestId,
        turnId,
        clientId: request.clientId || '',
        startedAt: new Date().toISOString(),
        chatMode
    };
    session.reservation = { requestId: '', createdAt: '' };
    touchSession(session);
    await saveSession(tabId, session, true);

    if (request.sessionReset) {
        broadcastToTab(tabId, {
            type: 'session-reset',
            reason: request.sessionResetReason || 'new-session',
            chatMode
        });
    }

    await persistSessionLog(tabId, 'question-added', settings);
    await handleAnswerGeneration(tabId, question, pageContent, settings);
}

async function reconnectStream(port, request) {
    const session = getSession(request.tabId);

    if (!session) {
        sendDirectMessage(port, { type: 'answer-end' });
        return;
    }

    if (session.completedAnswer) {
        sendDirectMessage(port, {
            type: 'answer-chunk',
            content: session.completedAnswer
        });
        sendDirectMessage(port, { type: 'answer-end' });
        return;
    }

    if (session.currentAnswer) {
        sendDirectMessage(port, {
            type: 'answer-chunk',
            content: session.currentAnswer
        });
        return;
    }

    if (session.generatingState.isGenerating) {
        return;
    }

    sendDirectMessage(port, { type: 'answer-end' });
}

async function handleAnswerGeneration(tabId, question, pageContent, settings) {
    const session = getSession(tabId);
    if (!session) {
        return;
    }

    const turnId = session.generatingState.turnId;
    const turn = getTurnById(session, turnId);
    if (!turn) {
        return;
    }

    const abortController = new AbortController();
    runtimeControllers[session.sessionMeta.sessionId] = abortController;

    try {
        const { requestMessages, promptContent } = buildMessagesForRequest(session, settings, question, pageContent, turn);
        const apiType = normalizeApiType(settings.apiType);
        const model = getApiSetting(settings, 'model');
        const apiKey = getApiSetting(settings, 'apiKey');
        const apiBase = getApiSetting(settings, 'apiBase');
        const apiPath = getApiSetting(settings, 'apiPath');

        if (!apiBase?.trim()) {
            throw new Error('请先在设置页填写请求URL');
        }

        if (!model?.trim()) {
            throw new Error('请先在设置页填写AI模型');
        }

        if (apiRequiresKey(apiType) && !apiKey?.trim()) {
            throw new Error('请先在设置页填写API密钥');
        }

        const requestSettings = { ...settings, apiType };
        const requestBody = buildRequestBody(requestSettings, model, requestMessages);
        const headers = buildRequestHeaders(settings, apiKey);
        const finalUrl = buildEndpointUrl(apiType, apiBase, apiPath, model, apiKey);

        const response = await fetch(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: abortController.signal
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(errorText || 'API请求失败');
        }

        // 粗略估算：对所有 messages 的 content 长度求和后 /4
        const totalChars = requestMessages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
        const inputTokens = Math.ceil(totalChars / 4);
        broadcastToTab(tabId, {
            type: 'input-tokens',
            tokens: inputTokens
        });

        let accumulatedResponse = '';

        if (apiType === 'gemini') {
            const data = await response.json();
            accumulatedResponse = extractContentFromResponse(apiType, data);
            session.currentAnswer = accumulatedResponse;
            touchSession(session);
            if (accumulatedResponse) {
                broadcastToTab(tabId, {
                    type: 'answer-chunk',
                    content: accumulatedResponse,
                    markdownContent: accumulatedResponse,
                    tokens: Math.ceil(accumulatedResponse.length / 4)
                });
            }
        } else {
            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('响应流不可用');
            }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split('\n');
                buffer = parts.pop() || '';

                for (const rawLine of parts) {
                    const content = processStreamLine(apiType, rawLine);
                    if (!content) {
                        continue;
                    }

                    accumulatedResponse += content;
                    session.currentAnswer = accumulatedResponse;
                    touchSession(session);
                    schedulePersistentStateSave();

                    broadcastToTab(tabId, {
                        type: 'answer-chunk',
                        content,
                        markdownContent: accumulatedResponse,
                        tokens: Math.ceil(content.length / 4)
                    });
                }
            }

            const remainingContent = processStreamLine(apiType, buffer);
            if (remainingContent) {
                accumulatedResponse += remainingContent;
                session.currentAnswer = accumulatedResponse;
                touchSession(session);
            }
        }

        if (accumulatedResponse) {
            session.history.push(createMessage(accumulatedResponse, false, turnId));
        }

        finalizeTurn(session, turnId, accumulatedResponse, 'completed', '');
        session.completedAnswer = accumulatedResponse;
        session.currentAnswer = accumulatedResponse;
        session.generatingState = createIdleGeneratingState();
        touchSession(session);
        await saveSession(tabId, session, true);

        await persistSessionLog(tabId, 'answer-complete', settings);

        // 每回合完成后把 index + blob 一起写。
        // 必须写 blob：否则用户在同一 tab 直接打开 📚 点"继续对话"时
        // readArchiveBlob 会返回 null 导致恢复失败（只写 index 不够）。
        try { await commitArchiveFromSession(session); } catch (e) { console.warn('archive 归档失败:', e); }

        broadcastToTab(tabId, {
            type: 'answer-end',
            markdownContent: accumulatedResponse,
            chatMode: session.sessionMeta.currentChatMode
        });
    } catch (error) {
        const latestSession = getSession(tabId);
        const isFinalizing = latestSession?.sessionMeta.isFinalizing;

        if (error.name === 'AbortError') {
            if (latestSession && !isFinalizing) {
                materializeCurrentAnswer(latestSession);
                finalizeTurn(latestSession, turnId, latestSession.currentAnswer, 'stopped', '');
                latestSession.generatingState = createIdleGeneratingState();
                latestSession.completedAnswer = latestSession.currentAnswer;
                touchSession(latestSession);
                await saveSession(tabId, latestSession, true);
                await persistSessionLog(tabId, 'answer-stopped', settings);
            }

            if (!isFinalizing) {
                broadcastToTab(tabId, {
                    type: 'answer-stopped',
                    markdownContent: getSession(tabId)?.currentAnswer || ''
                });
            }
        } else {
            console.error('生成回答时出错:', error);

            if (latestSession && !isFinalizing) {
                latestSession.history.push(createMessage(`发生错误：${error.message}`, false, turnId));
                finalizeTurn(latestSession, turnId, '', 'error', error.message);
                latestSession.generatingState = createIdleGeneratingState();
                touchSession(latestSession);
                await saveSession(tabId, latestSession, true);
                await persistSessionLog(tabId, 'answer-error', settings);
            }

            if (!isFinalizing) {
                broadcastToTab(tabId, {
                    type: 'error',
                    error: error.message
                });
            }
        }
    } finally {
        delete runtimeControllers[session.sessionMeta.sessionId];
    }
}

async function stopGeneration(tabId, reason) {
    const session = getSession(tabId);
    if (!session?.generatingState.isGenerating) {
        return { status: 'idle' };
    }

    const controller = runtimeControllers[session.sessionMeta.sessionId];
    if (controller) {
        controller.abort(reason);
        return { status: 'stopping' };
    }

    materializeCurrentAnswer(session);
    finalizeTurn(session, session.generatingState.turnId, session.currentAnswer, 'stopped', '');
    session.generatingState = createIdleGeneratingState();
    touchSession(session);
    await saveSession(tabId, session, true);
    return { status: 'idle' };
}

// 判断当前页面是否是新章节；若是，则把正文作为新 preamble 追加到 session.preambleChain。
// 锚点 anchor = 当时 session.history.length —— 表示这段 preamble 应该被"插入"到
// history 里那个位置（即该章节的对话从此处开始）。
function maybeAppendPreamble(session, tabInfo, pageContent, usesPageContext, chatMode) {
    if (!usesPageContext) return;
    if (!pageContent || !pageContent.trim()) return;

    const excerpt = (tabInfo?.pageContentExcerpt || buildPageContentExcerpt(pageContent)).trim();
    if (!excerpt) return;

    const chain = session.sessionMeta.preambleChain || [];
    const last = chain[chain.length - 1];
    const contextKey = modeIsVideoContext(chatMode)
        ? buildVideoContextKey(tabInfo?.pageUrl || '', pageContent)
        : '';

    if (contextKey && chain.some((pre) => getPreambleContextKey(pre) === contextKey)) return;

    // 相同 excerpt → 还在同一章，复用现有 preamble。
    if (last && last.excerpt === excerpt) return;

    chain.push({
        excerpt,
        content: pageContent,
        anchor: session.history.length,
        pageTitle: tabInfo?.pageTitle || '',
        pageUrl: tabInfo?.pageUrl || '',
        contextKey,
        createdAt: new Date().toISOString()
    });
    session.sessionMeta.preambleChain = chain;
}

function getPreambleContextKey(pre = {}) {
    return pre.contextKey || buildVideoContextKey(pre.pageUrl || '', pre.content || '');
}

function buildMessagesForRequest(session, settings, question, pageContent, turn) {
    const usesPageContext = Boolean(turn.usesPageContext);

    // 当前这轮的用户问题已在 startGeneration 时被 push 进 session.history，
    // 下方又会显式 push 为最后一条 user，这里先去掉 history 末尾的 user 避免重复。
    let history = [...session.history];
    if (history.length && history[history.length - 1].isUser) {
        history = history.slice(0, -1);
    }

    // 整页上下文模式下完整保留 history，以稳定 preamble 锚点与缓存前缀；
    // 纯聊模式仍按 maxContextRounds 截断节省 token。
    if (!usesPageContext && settings.enableContext) {
        const limit = Math.max(1, settings.maxContextRounds) * 2;
        history = history.slice(-limit);
        while (history.length && !history[0].isUser) history = history.slice(1);
    }

    // system prompt（如启用带教模式则叠加对应风格的提示词）
    const mentorFlavor = session.sessionMeta?.mentorFlavor;
    const systemContent = isMentorActive(mentorFlavor)
        ? buildMentorSystemPrompt(mentorFlavor, settings.systemPrompt, settings.mentorPrompts)
        : settings.systemPrompt;

    const messages = [{ role: 'system', content: systemContent }];

    const fullChain = usesPageContext ? (session.sessionMeta.preambleChain || []) : [];
    // 学习多章时只保留最近 N 章的"正文"发给模型，避免请求体无限膨胀。
    // 被淘汰那些章节的对话记录（history）仍完整保留，模型依然能看见"聊过什么"，
    // 只是不再重新带上那些章节的完整网页正文。
    const MAX_PREAMBLES_IN_REQUEST = 5;
    const preambleChain = fullChain.slice(-MAX_PREAMBLES_IN_REQUEST);
    // 为省 Anthropic cache_control 配额（总共 4 个），只给 system + 链上最后一段 preamble
    // 打断点：这样缓存能覆盖"到最新 preamble 结束"的整段前缀，已是理论最大命中量。
    const lastPreambleIdx = preambleChain.length - 1;

    const pushPreamble = (pre, markCacheable) => {
        messages.push({
            role: 'user',
            content: `以下是当前会话的页面上下文，请作为后续所有问答的共同背景。读完回复"好的"。\n\n---\n\n${pre.content}`,
            ...(markCacheable ? { _cacheable: true } : {})
        });
        messages.push({
            role: 'assistant',
            content: '好的，我已通读页面内容，随时可以提问。'
        });
    };

    // 把 preambleChain 按 anchor 插入到 history 的相应位置，形成
    // [sys, pre1_user, pre1_ack, history[0..a1], pre2_user, pre2_ack, history[a1..a2], ...]
    let pi = 0;
    for (let hi = 0; hi <= history.length; hi += 1) {
        while (pi < preambleChain.length && preambleChain[pi].anchor <= hi) {
            pushPreamble(preambleChain[pi], pi === lastPreambleIdx);
            pi += 1;
        }
        if (hi < history.length) {
            const m = history[hi];
            messages.push({
                role: m.isUser ? 'user' : 'assistant',
                content: m.markdownContent || m.content,
                ...(m.attachments?.length ? { attachments: m.attachments } : {})
            });
        }
    }

    // 当前轮 user 消息：
    // - 整页模式：pageContent 已在 preamble 里，这里只发原始问题
    // - 纯聊模式：直接发问题
    const promptContent = question;

    messages.push({
        role: 'user',
        content: promptContent || (turn.attachments?.length ? '请分析这张图片。' : ''),
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {})
    });

    return {
        promptContent,
        requestMessages: messages
    };
}

// 返回当前会话的完整上下文（system + preamble + history + 当前问题），
// 供前端"查看上下文"按钮展示。
async function getContextDump(tabId) {
    const session = getSession(tabId);
    if (!session) {
        return { status: 'error', error: '当前无活跃会话' };
    }
    const settings = await loadSettings();
    const history = session.history || [];
    const lastUser = [...history].reverse().find((h) => h.isUser);
    const lastQuestion = lastUser?.text || '';

    // 如果没有 turn 信息（还没提过问），构造一个最小 turn
    const lastTurn = session.turns?.[session.turns.length - 1];
    const chatMode = session.sessionMeta?.currentChatMode
        || lastTurn?.chatMode
        || 'web_ephemeral';
    const mockTurn = {
        chatMode,
        usesPageContext: modeUsesPageContext(chatMode),
    };

    const pageContent = ''; // 正文已存在 preambleChain 里，不需要再传
    const { requestMessages } = buildMessagesForRequest(
        session, settings, lastQuestion, pageContent, mockTurn
    );

    return {
        status: 'ok',
        messages: requestMessages.map((m) => ({
            role: m.role,
            content: `${m.content || ''}${m.attachments?.length ? `\n\n[图片附件：${m.attachments.length} 张]` : ''}`
        })),
        meta: {
            sessionId: session.sessionMeta?.sessionId || '',
            chatMode,
            mentorFlavor: session.sessionMeta?.mentorFlavor || 'off',
            historyCount: history.length,
            preambleCount: (session.sessionMeta?.preambleChain || []).length
        }
    };
}

function getApiSetting(settings, field) {
    const apiType = normalizeApiType(settings.apiType);
    const value = settings[`${apiType}_${field}`];
    if (value) return value;
    if (apiType === 'openai_chat') return settings[`custom_${field}`] || DEFAULT_SETTINGS[`openai_chat_${field}`] || '';
    if (apiType === 'claude') return settings[`anthropic_${field}`] || DEFAULT_SETTINGS[`claude_${field}`] || '';
    return DEFAULT_SETTINGS[`${apiType}_${field}`] || '';
}

function apiRequiresKey(apiType) {
    return normalizeApiType(apiType) !== 'ollama';
}

function buildRequestBody(settings, model, messages) {
    const apiType = normalizeApiType(settings.apiType);
    if (apiType === 'ollama') {
        // Ollama 格式：过滤内部字段 _cacheable
        return {
            model,
            messages: messages.map(buildOllamaMessage),
            stream: true,
            options: {
                temperature: settings.temperature,
                num_predict: settings.maxTokens
            }
        };
    }

    if (apiType === 'claude') {
        return buildAnthropicBody(settings, model, messages, true);
    }

    if (apiType === 'responses') {
        return buildResponsesBody(settings, model, messages, true);
    }

    if (apiType === 'gemini') {
        return buildGeminiBody(settings, messages);
    }

    // OpenAI 兼容格式
    return {
        model,
        messages: messages.map(buildOpenAIMessage),
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        stream: true
    };
}

function stripInternalFields(m) {
    const { _cacheable, attachments, ...rest } = m;
    return rest;
}

function buildOpenAIMessage(message) {
    const base = stripInternalFields(message);
    const attachments = normalizeImageAttachments(message.attachments);
    if (!attachments.length) return base;

    return {
        role: base.role,
        content: [
            { type: 'text', text: base.content || '请分析这张图片。' },
            ...attachments.map((attachment) => ({
                type: 'image_url',
                image_url: { url: attachment.dataUrl }
            }))
        ]
    };
}

function buildOllamaMessage(message) {
    const base = stripInternalFields(message);
    const attachments = normalizeImageAttachments(message.attachments);
    if (!attachments.length) return base;

    return {
        ...base,
        content: base.content || '请分析这张图片。',
        images: attachments.map((attachment) => imageBase64FromDataUrl(attachment.dataUrl)).filter(Boolean)
    };
}

function buildResponsesBody(settings, model, messages, stream) {
    const input = [];
    let instructions = '';

    for (const message of messages) {
        if (message.role === 'system') {
            instructions = [instructions, message.content || ''].filter(Boolean).join('\n\n');
            continue;
        }

        const attachments = normalizeImageAttachments(message.attachments);
        if (!attachments.length) {
            input.push({
                role: message.role,
                content: message.content || ''
            });
            continue;
        }

        input.push({
            role: message.role,
            content: [
                { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content || '请分析这张图片。' },
                ...attachments.map((attachment) => ({
                    type: 'input_image',
                    image_url: attachment.dataUrl
                }))
            ]
        });
    }

    const body = {
        model,
        input,
        max_output_tokens: settings.maxTokens,
        temperature: settings.temperature,
        stream: Boolean(stream),
        store: false
    };
    if (instructions) body.instructions = instructions;
    return body;
}

function buildGeminiBody(settings, messages) {
    const systemMsg = messages.find((m) => m.role === 'system');
    const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => {
            const attachments = normalizeImageAttachments(m.attachments);
            const parts = [{ text: m.content || '请分析这张图片。' }];
            for (const attachment of attachments) {
                parts.push({
                    inlineData: {
                        mimeType: attachment.mimeType || mimeTypeFromDataUrl(attachment.dataUrl) || 'image/jpeg',
                        data: imageBase64FromDataUrl(attachment.dataUrl)
                    }
                });
            }
            return {
                role: m.role === 'assistant' ? 'model' : 'user',
                parts
            };
        });

    const body = {
        contents,
        generationConfig: {
            maxOutputTokens: settings.maxTokens,
            temperature: settings.temperature
        }
    };
    if (systemMsg?.content) {
        body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }
    return body;
}

// Anthropic v1/messages 格式：system 单独字段；大块内容附 cache_control 开启 prompt caching（90% off）
function buildAnthropicBody(settings, model, messages, stream) {
    const systemMsg = messages.find((m) => m.role === 'system');
    const rest = messages.filter((m) => m.role !== 'system');

    const anthMessages = rest.map((m) => {
        const content = buildAnthropicContent(m);
        return { role: m.role, content };
    });

    const body = {
        model,
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        stream: Boolean(stream),
        messages: anthMessages
    };

    if (systemMsg && systemMsg.content) {
        // 也把 system 打上 cache_control，让带教提示词也能缓存
        body.system = [{ type: 'text', text: systemMsg.content, cache_control: { type: 'ephemeral' } }];
    }

    return body;
}

function buildAnthropicContent(message) {
    const attachments = normalizeImageAttachments(message.attachments);
    if (!attachments.length) {
        return message._cacheable
            ? [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }]
            : message.content;
    }

    const blocks = [
        { type: 'text', text: message.content || '请分析这张图片。' }
    ];

    for (const attachment of attachments) {
        blocks.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: attachment.mimeType || mimeTypeFromDataUrl(attachment.dataUrl) || 'image/jpeg',
                data: imageBase64FromDataUrl(attachment.dataUrl)
            }
        });
    }

    return blocks;
}

function buildRequestHeaders(settings, apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    const apiType = normalizeApiType(settings.apiType);

    if (apiType === 'claude') {
        if (apiKey) headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        // 浏览器直连 Anthropic 需要此头开启 CORS 场景
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if ((apiType === 'openai_chat' || apiType === 'responses') && apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    return headers;
}

function normalizeApiPath(apiType, apiPath) {
    const path = String(apiPath || '').trim();
    if (path) return path.startsWith('/') ? path : `/${path}`;
    if (apiType === 'openai_chat') return '/chat/completions';
    if (apiType === 'responses') return '/responses';
    if (apiType === 'claude') return '/messages';
    if (apiType === 'gemini') return '/models/{model}:generateContent';
    return '';
}

function stripKnownEndpointSuffix(basePath) {
    if (basePath.endsWith(':generateContent') && basePath.includes('/models/')) {
        return basePath.split('/models/', 1)[0].replace(/\/$/, '');
    }
    const suffixes = ['/chat/completions', '/responses', '/messages', ':generateContent', '/models'];
    for (const suffix of suffixes) {
        if (basePath.endsWith(suffix)) {
            return basePath.slice(0, -suffix.length).replace(/\/$/, '');
        }
    }
    return basePath;
}

function stripEndpointSuffix(basePath, apiPath) {
    const plainApiPath = apiPath.replace('{model}', '').replace(/\/$/, '');
    const candidates = [apiPath.replace(/\/$/, ''), plainApiPath, '/models']
        .filter((item) => item && item !== '/')
        .sort((a, b) => b.length - a.length);
    for (const suffix of candidates) {
        if (basePath.endsWith(suffix)) {
            return basePath.slice(0, -suffix.length).replace(/\/$/, '');
        }
    }
    return basePath;
}

function normalizeApiBaseUrl(apiType, rawUrl, apiPath) {
    let value = String(rawUrl || '').trim();
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) {
        value = `https://${value}`;
    }

    const parsed = new URL(value);
    let path = parsed.pathname.replace(/\/$/, '');
    path = stripKnownEndpointSuffix(path);
    path = stripEndpointSuffix(path, apiPath);

    if (['openai_chat', 'responses', 'claude'].includes(apiType) && (!path || path === '/')) {
        path = '/v1';
    }
    if (apiType === 'gemini' && (!path || path === '/')) {
        path = '/v1beta';
    }

    parsed.pathname = path;
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
}

function mergeUrlQuery(url, values) {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(values)) {
        parsed.searchParams.set(key, value);
    }
    return parsed.toString();
}

function buildEndpointUrl(apiType, apiBase, apiPath, model, apiKey = '') {
    if (apiType === 'ollama') return apiBase;
    const normalizedPath = normalizeApiPath(apiType, apiPath);
    const base = normalizeApiBaseUrl(apiType, apiBase, normalizedPath);
    if (!base) throw new Error('请求URL是必填项');

    const parsed = new URL(base);
    const basePath = parsed.pathname.replace(/\/$/, '');
    const path = normalizedPath.replace('{model}', encodeURIComponent(String(model || '').replace(/^models\//, '')));
    parsed.pathname = `${basePath}${path.startsWith('/') ? path : `/${path}`}`;
    parsed.hash = '';

    let finalUrl = parsed.toString();
    if (apiType === 'gemini') {
        finalUrl = mergeUrlQuery(finalUrl, { key: apiKey });
    }
    return finalUrl;
}

function buildModelsUrl(apiType, apiBase, apiKey = '') {
    if (apiType === 'ollama') {
        const parsed = new URL(apiBase || 'http://127.0.0.1:11434/api/chat');
        parsed.pathname = '/api/tags';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    }
    const base = normalizeApiBaseUrl(apiType, apiBase, '/models');
    if (!base) throw new Error('请求URL是必填项');
    const parsed = new URL(base);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/models`;
    parsed.hash = '';
    let finalUrl = parsed.toString();
    if (apiType === 'gemini') {
        finalUrl = mergeUrlQuery(finalUrl, { key: apiKey });
    }
    return finalUrl;
}

// 非流式一次性调用（用于 annotateConcepts 等需要完整 JSON 的场景）
async function callLLMOnce(settings, messages, { temperature = 0.2, maxTokens = 1500 } = {}) {
    const apiType = normalizeApiType(settings.apiType);
    const model = getApiSetting(settings, 'model');
    const apiKey = getApiSetting(settings, 'apiKey');
    const apiBase = getApiSetting(settings, 'apiBase');
    const apiPath = getApiSetting(settings, 'apiPath');

    if (!apiBase?.trim()) throw new Error('请先在设置页填写请求URL');
    if (!model?.trim()) throw new Error('请先在设置页填写AI模型');
    if (apiRequiresKey(apiType) && !apiKey?.trim()) {
        throw new Error('请先在设置页填写API密钥');
    }

    let body;
    const requestSettings = { ...settings, apiType, maxTokens, temperature };
    if (apiType === 'ollama') {
        body = { model, messages: messages.map(buildOllamaMessage), stream: false, options: { temperature, num_predict: maxTokens } };
    } else if (apiType === 'claude') {
        body = buildAnthropicBody(requestSettings, model, messages, false);
    } else if (apiType === 'responses') {
        body = buildResponsesBody(requestSettings, model, messages, false);
    } else if (apiType === 'gemini') {
        body = buildGeminiBody(requestSettings, messages);
    } else {
        body = { model, messages: messages.map(buildOpenAIMessage), max_tokens: maxTokens, temperature, stream: false };
    }

    const headers = buildRequestHeaders(requestSettings, apiKey);
    const finalUrl = buildEndpointUrl(apiType, apiBase, apiPath, model, apiKey);

    const response = await fetch(finalUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`LLM 请求失败: ${response.status} ${errText.slice(0, 200)}`);
    }
    const data = await response.json();
    return extractContentFromResponse(apiType, data);
}

async function annotateConcepts(pageContent, pageTitle) {
    try {
        const settings = await loadSettings();
        const text = (pageContent || '').trim();
        if (!text) {
            return { status: 'error', error: '页面没有可分析的正文' };
        }
        // 截断过长内容，避免超 token
        const truncated = text.slice(0, 8000);

        const systemPrompt = [
            '你是一个学习助手，专门从用户阅读的网页内容里找出"值得学习的关键概念/术语/要点"。',
            '请根据给定的网页正文，识别 8-15 个最值得关注的概念或术语（初学者最应该记住或理解的）。',
            '对每个概念，给出一条极简（<=45 字）的**中文**口语化解释，面向完全不了解此领域的人。',
            '仅返回一个 JSON 数组，不要任何说明、前言或 Markdown 代码围栏。',
            '每个元素形如：{"term": "原文中出现的准确术语", "explanation": "一句中文解释"}',
            '要求：(1) term 必须是原文中**出现过的确切字符串**（原文是什么语言就保留什么语言，绝不翻译或改写，否则无法在网页上匹配）；(2) explanation **必须用中文**，即使页面本身是英文/日文等；(3) 优先选名词/专有名词/公式名/函数名等；(4) 避免过于泛化的词（如"内容""方法""问题"）；(5) 按原文出现顺序排列。'
        ].join('\n');

        const userPrompt = `网页标题：${pageTitle || '（未知）'}\n\n网页正文：\n${truncated}`;

        const raw = await callLLMOnce(settings, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ], { temperature: 0.1, maxTokens: 1500 });

        // 容错解析：剥掉可能的 ```json``` 围栏
        let jsonText = (raw || '').trim();
        const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) jsonText = fence[1].trim();
        const bracketStart = jsonText.indexOf('[');
        const bracketEnd = jsonText.lastIndexOf(']');
        if (bracketStart >= 0 && bracketEnd > bracketStart) {
            jsonText = jsonText.slice(bracketStart, bracketEnd + 1);
        }

        let concepts;
        try {
            concepts = JSON.parse(jsonText);
        } catch (e) {
            return { status: 'error', error: `无法解析 LLM 返回的 JSON: ${e.message}`, raw: raw.slice(0, 500) };
        }

        if (!Array.isArray(concepts)) {
            return { status: 'error', error: 'LLM 返回格式不对，应为数组' };
        }
        // 规范化并去重
        const seen = new Set();
        const cleaned = [];
        for (const c of concepts) {
            if (!c || typeof c.term !== 'string') continue;
            const term = c.term.trim();
            const explanation = typeof c.explanation === 'string' ? c.explanation.trim() : '';
            if (!term || term.length > 60 || seen.has(term)) continue;
            seen.add(term);
            cleaned.push({ term, explanation });
            if (cleaned.length >= 20) break;
        }
        return { status: 'ok', concepts: cleaned };
    } catch (error) {
        console.error('annotateConcepts 失败:', error);
        return { status: 'error', error: error.message };
    }
}

async function fetchApiModels(config) {
    try {
        const apiType = normalizeApiType(config.apiType);
        const apiKey = String(config.apiKey || '').trim();
        const apiBase = String(config.apiBase || '').trim() || DEFAULT_SETTINGS[`${apiType}_apiBase`] || '';
        if (apiRequiresKey(apiType) && !apiKey) {
            throw new Error('API密钥是必填项');
        }
        const url = buildModelsUrl(apiType, apiBase, apiKey);
        const headers = buildRequestHeaders({ apiType }, apiKey);
        delete headers['Content-Type'];

        const response = await fetch(url, { method: 'GET', headers });
        const raw = await response.text();
        const data = parseJsonResponse(raw);
        if (!response.ok) {
            throw new Error(extractApiErrorMessage(data, raw) || `HTTP ${response.status}`);
        }

        const models = extractModelsFromResponse(apiType, data);
        return {
            status: 'ok',
            models,
            count: models.length,
            finalUrl: redactUrlKey(url)
        };
    } catch (error) {
        return { status: 'error', error: error.message };
    }
}

async function testApiConfigFromBackground(config) {
    try {
        const apiType = normalizeApiType(config.apiType);
        const apiKey = String(config.apiKey || '').trim();
        const apiBase = String(config.apiBase || '').trim() || DEFAULT_SETTINGS[`${apiType}_apiBase`] || '';
        const apiPath = String(config.apiPath || '').trim() || DEFAULT_SETTINGS[`${apiType}_apiPath`] || '';
        const model = String(config.model || '').trim();
        if (!apiBase) throw new Error('请求URL是必填项');
        if (!model) throw new Error('AI模型是必填项');
        if (apiRequiresKey(apiType) && !apiKey) throw new Error('API密钥是必填项');

        const settings = {
            apiType,
            maxTokens: 64,
            temperature: 0,
            [`${apiType}_apiKey`]: apiKey,
            [`${apiType}_apiBase`]: apiBase,
            [`${apiType}_apiPath`]: apiPath,
            [`${apiType}_model`]: model
        };
        const messages = [{ role: 'user', content: 'Reply exactly: OK' }];
        const body = buildRequestBody(settings, model, messages);
        if (apiType !== 'ollama' && apiType !== 'gemini') {
            body.stream = false;
        }
        const url = buildEndpointUrl(apiType, apiBase, apiPath, model, apiKey);
        const headers = buildRequestHeaders(settings, apiKey);
        const started = Date.now();
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        const elapsedMs = Date.now() - started;
        const raw = await response.text();
        const data = parseJsonResponse(raw);

        if (!response.ok) {
            throw new Error(extractApiErrorMessage(data, raw) || `HTTP ${response.status}`);
        }

        const text = extractContentFromResponse(apiType, data);
        if (!text.trim()) {
            throw new Error('响应成功，但没有返回文本内容');
        }

        return {
            status: 'ok',
            httpStatus: response.status,
            elapsedMs,
            finalUrl: redactUrlKey(url),
            returnedModel: data.model || data.modelVersion || ''
        };
    } catch (error) {
        return { status: 'error', error: error.message };
    }
}

function parseJsonResponse(raw) {
    try {
        return JSON.parse(raw);
    } catch (error) {
        return { raw };
    }
}

function extractApiErrorMessage(data, raw) {
    const error = data?.error || data;
    if (error && typeof error === 'object') {
        return error.message || error.code || JSON.stringify(error).slice(0, 300);
    }
    if (typeof error === 'string') return error.slice(0, 300);
    return String(raw || '').slice(0, 300);
}

function extractModelsFromResponse(apiType, data) {
    if (!data || typeof data !== 'object') return [];
    if (apiType === 'ollama' && Array.isArray(data.models)) {
        return data.models
            .map((item) => item?.name || item?.model)
            .filter((name) => typeof name === 'string' && name);
    }
    if (Array.isArray(data.data)) {
        const ids = data.data
            .map((item) => item?.id)
            .filter((id) => typeof id === 'string' && id);
        if (ids.length) return ids.sort();
    }
    if (Array.isArray(data.models)) {
        return data.models
            .map((item) => item?.name || item?.id)
            .filter((name) => typeof name === 'string' && name)
            .map((name) => name.replace(/^models\//, ''))
            .sort();
    }
    return [];
}

function redactUrlKey(url) {
    try {
        const parsed = new URL(url);
        if (parsed.searchParams.has('key')) {
            parsed.searchParams.set('key', '***');
        }
        return parsed.toString();
    } catch (error) {
        return url;
    }
}

function buildHistoryResponse(session) {
    if (!session) {
        return {
            history: [],
            isGenerating: false,
            pendingQuestion: '',
            currentAnswer: '',
            chatMode: DEFAULT_CHAT_MODE,
            mentorFlavor: DEFAULT_MENTOR_FLAVOR
        };
    }

    return {
        history: session.history,
        isGenerating: session.generatingState.isGenerating,
        pendingQuestion: session.generatingState.pendingQuestion,
        currentAnswer: session.currentAnswer || '',
        sessionId: session.sessionMeta.sessionId,
        chatMode: session.sessionMeta.currentChatMode,
        mentorFlavor: session.sessionMeta.mentorFlavor || DEFAULT_MENTOR_FLAVOR
    };
}

async function getTabSnapshot(tabId, pageContent = '') {
    let tab = null;

    try {
        tab = await chrome.tabs.get(tabId);
    } catch (error) {
        console.warn('读取标签页信息失败:', error);
    }

    const pageUrl = tab?.url || `tab://${tabId}`;
    return {
        pageUrl,
        pageTitle: tab?.title || '未命名页面',
        pageDomain: extractHostname(pageUrl),
        pageContentExcerpt: buildPageContentExcerpt(pageContent),
        pageContentLength: pageContent.length
    };
}

// ==================== 对话归档（按 URL 索引） ====================
//
// 设计目标：用户下次打开同一网页时，能看到过去在这个页面聊过的会话列表，
// 并可选择任意一条"真·恢复"到当前 tab 继续聊。
//
// 存储分两层：
//   - archiveIndex: chrome.storage.local 里的一张大 Map，key = 归一化 URL，
//     value = 轻量 entry 数组（只含 metadata + preview），抽屉列表一次读完。
//   - archiveBlob: 每条会话一个单独 key（webchat_archive_blob_v1:<sessionId>），
//     存完整 history/turns/preambleChain。只有用户点某条"恢复"时才按需读取。
//
// URL 归一化：只取 origin + pathname，忽略 query/hash，避免同一页因追踪参数
// 或锚点被拆成多条。chrome:// / file:// / 扩展页不存档。

const ARCHIVE_BLOB_PREFIX = 'webchat_archive_blob_v1:';
const ARCHIVE_MAX_PER_URL = 20;             // 每个 URL 最多保留 N 条
const ARCHIVE_PREVIEW_LEN = 140;            // preview 截断长度

function normalizeArchiveUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
        const u = new URL(rawUrl);
        // 跳过特殊协议
        if (!/^https?:$/.test(u.protocol)) return '';
        // origin + pathname，忽略 query / hash
        return (u.origin + u.pathname).replace(/\/$/, '');
    } catch (_) {
        return '';
    }
}

function buildArchivePreview(session) {
    const firstUserTurn = (session.turns || []).find((t) => t.question);
    const firstAssistantTurn = (session.turns || []).find((t) => t.answer);
    const q = firstUserTurn?.question || '';
    const a = firstAssistantTurn?.answer || '';
    const part = (s) => s.replace(/\s+/g, ' ').slice(0, 60);
    const parts = [];
    if (q) parts.push('Q: ' + part(q));
    if (a) parts.push('A: ' + part(a));
    return parts.join(' / ').slice(0, ARCHIVE_PREVIEW_LEN);
}

function buildArchiveIndexEntry(session, mode /* 'persisted' | 'ephemeral' */) {
    const meta = session.sessionMeta || {};
    return {
        sessionId: meta.sessionId,
        pageUrl: meta.pageUrl || '',
        pageTitle: meta.pageTitle || '未命名页面',
        createdAt: meta.startedAt || new Date().toISOString(),
        lastTurnAt: meta.lastActivityAt || meta.updatedAt || new Date().toISOString(),
        turnCount: (session.turns || []).length,
        chatMode: meta.currentChatMode,
        mentorFlavor: meta.mentorFlavor,
        mode: mode || (modeShouldPersist(meta.currentChatMode) ? 'persisted' : 'ephemeral'),
        preview: buildArchivePreview(session)
    };
}

async function loadArchiveIndex() {
    const got = await chrome.storage.local.get({ [STORAGE_KEYS.archiveIndex]: {} });
    const raw = got[STORAGE_KEYS.archiveIndex];
    return raw && typeof raw === 'object' ? raw : {};
}

async function saveArchiveIndex(index) {
    await chrome.storage.local.set({ [STORAGE_KEYS.archiveIndex]: index });
}

// upsert：同 sessionId 的 entry 会被整条替换；按 lastTurnAt 倒序；超出 cap 的淘汰。
// 被淘汰的 entry 同步把它的 blob 也删了，避免孤儿。
async function upsertArchiveIndexEntry(urlKey, entry) {
    if (!urlKey || !entry || !entry.sessionId) return;
    const index = await loadArchiveIndex();
    const list = Array.isArray(index[urlKey]) ? index[urlKey].slice() : [];
    const existingIdx = list.findIndex((e) => e && e.sessionId === entry.sessionId);
    if (existingIdx >= 0) {
        list[existingIdx] = entry;
    } else {
        list.push(entry);
    }
    // 按最近活动时间倒序
    list.sort((a, b) => String(b.lastTurnAt).localeCompare(String(a.lastTurnAt)));
    // LRU：超出上限的丢弃，并删掉对应 blob
    const toDrop = list.splice(ARCHIVE_MAX_PER_URL);
    if (toDrop.length) {
        const dropKeys = toDrop.map((e) => ARCHIVE_BLOB_PREFIX + e.sessionId);
        try { await chrome.storage.local.remove(dropKeys); } catch (_) { /* ignore */ }
    }
    index[urlKey] = list;
    await saveArchiveIndex(index);
}

async function removeArchiveIndexEntry(urlKey, sessionId) {
    if (!urlKey || !sessionId) return;
    const index = await loadArchiveIndex();
    const list = Array.isArray(index[urlKey]) ? index[urlKey] : [];
    const next = list.filter((e) => e && e.sessionId !== sessionId);
    if (next.length === 0) {
        delete index[urlKey];
    } else {
        index[urlKey] = next;
    }
    await saveArchiveIndex(index);
}

async function writeArchiveBlob(session) {
    const sessionId = session?.sessionMeta?.sessionId;
    if (!sessionId) return;
    const blob = {
        sessionId,
        savedAt: new Date().toISOString(),
        sessionMeta: session.sessionMeta,
        history: session.history || [],
        turns: session.turns || []
    };
    await chrome.storage.local.set({ [ARCHIVE_BLOB_PREFIX + sessionId]: blob });
}

async function readArchiveBlob(sessionId) {
    if (!sessionId) return null;
    const key = ARCHIVE_BLOB_PREFIX + sessionId;
    const got = await chrome.storage.local.get({ [key]: null });
    return got[key] || null;
}

async function deleteArchiveBlob(sessionId) {
    if (!sessionId) return;
    try {
        await chrome.storage.local.remove(ARCHIVE_BLOB_PREFIX + sessionId);
    } catch (_) { /* ignore */ }
}

// 增量更新：只改 index，不写 blob（省 IO）。用在每轮 answer-complete 后。
async function touchArchiveIndexFromSession(session) {
    const urlKey = normalizeArchiveUrl(session?.sessionMeta?.pageUrl);
    if (!urlKey) return;
    if (!session.turns || session.turns.length === 0) return;
    const mode = modeShouldPersist(session.sessionMeta.currentChatMode) ? 'persisted' : 'ephemeral';
    const entry = buildArchiveIndexEntry(session, mode);
    await upsertArchiveIndexEntry(urlKey, entry);
}

// 全量写入：index + blob。用在 finalize / manual persist 时。
async function commitArchiveFromSession(session, mode) {
    const urlKey = normalizeArchiveUrl(session?.sessionMeta?.pageUrl);
    if (!urlKey) return;
    if (!session.turns || session.turns.length === 0) return;
    const resolvedMode = mode || (modeShouldPersist(session.sessionMeta.currentChatMode) ? 'persisted' : 'ephemeral');
    const entry = buildArchiveIndexEntry(session, resolvedMode);
    await upsertArchiveIndexEntry(urlKey, entry);
    await writeArchiveBlob(session);
}

async function listArchivesForUrl(rawUrl) {
    const urlKey = normalizeArchiveUrl(rawUrl);
    if (!urlKey) return [];
    const index = await loadArchiveIndex();
    const list = Array.isArray(index[urlKey]) ? index[urlKey] : [];
    // 已经是倒序的，这里再保险一次
    return list.slice().sort((a, b) => String(b.lastTurnAt).localeCompare(String(a.lastTurnAt)));
}

async function deleteArchiveEntry(sessionId, rawUrlHint) {
    if (!sessionId) return { status: 'error', error: 'missing sessionId' };
    let urlKey = normalizeArchiveUrl(rawUrlHint);
    if (!urlKey) {
        // 兜底扫一遍索引，找到属于哪个 URL
        const index = await loadArchiveIndex();
        for (const [k, list] of Object.entries(index)) {
            if (Array.isArray(list) && list.some((e) => e?.sessionId === sessionId)) {
                urlKey = k;
                break;
            }
        }
    }
    if (urlKey) {
        await removeArchiveIndexEntry(urlKey, sessionId);
    }
    await deleteArchiveBlob(sessionId);
    return { status: 'ok' };
}

// 把归档的会话恢复到指定 tab 作为当前 session。
// 真·恢复：history / turns / preambleChain / mentorFlavor / chatMode 全部接回去；
// 为避免 sessionId 冲突，这里会新发一个 sessionId（原 archive 那条保留不动）。
async function restoreArchiveToTab(tabId, sessionId) {
    if (!tabId || !sessionId) {
        return { status: 'error', error: '缺少 tabId 或 sessionId' };
    }
    const blob = await readArchiveBlob(sessionId);
    if (!blob) {
        return { status: 'error', error: '找不到该归档（可能已被删除）' };
    }

    // 先把当前 tab 的会话收尾（会自动写一遍 archive，下次还能找到）
    const existing = getSession(tabId);
    if (existing) {
        await finalizeAndClearSession(tabId, 'restore-from-archive');
    }

    const tabInfo = await getTabSnapshot(tabId);
    const now = new Date().toISOString();

    // 新 session 以 blob 内容为骨架，但 sessionId 重新生成避免和原归档冲突
    const restored = normalizeSession({
        sessionMeta: {
            ...blob.sessionMeta,
            sessionId: createSessionId(blob.sessionMeta?.pageTitle || tabInfo.pageTitle),
            startedAt: blob.sessionMeta?.startedAt || now,
            updatedAt: now,
            lastActivityAt: now,
            // 页面信息用当前 tab 的（因为用户现在就在这一页，URL 可能带不同 query/hash）
            pageUrl: tabInfo.pageUrl,
            pageTitle: tabInfo.pageTitle,
            pageDomain: tabInfo.pageDomain,
            // pageContentExcerpt 保留 blob 的，让 preambleChain 的"锚"语义不乱；
            // 下一轮提问时若页面正文有变，maybeAppendPreamble 会自然追加新章节
            isFinalizing: false,
            lastRotationReason: '',
            lastRecoveryReason: 'restored-from-archive'
        },
        history: blob.history || [],
        turns: (blob.turns || []).map((t) => ({ ...t }))
    });

    await saveSession(tabId, restored, true);

    // 通知该 tab 的 content script 把 UI 重绘成恢复后的 history
    if (typeof tabId === 'number') {
        chrome.tabs.sendMessage(tabId, {
            action: 'sessionReset',
            reason: 'restored-from-archive'
        }).catch(() => { /* 标签页可能已关闭 */ });
    }

    return {
        status: 'ok',
        sessionId: restored.sessionMeta.sessionId,
        chatMode: restored.sessionMeta.currentChatMode,
        mentorFlavor: restored.sessionMeta.mentorFlavor,
        turnCount: restored.turns.length
    };
}

function createSession(tabInfo, chatMode = DEFAULT_CHAT_MODE) {
    const now = new Date().toISOString();
    return normalizeSession({
        sessionMeta: {
            sessionId: createSessionId(tabInfo.pageTitle),
            startedAt: now,
            updatedAt: now,
            lastActivityAt: now,
            pageUrl: tabInfo.pageUrl,
            pageTitle: tabInfo.pageTitle,
            pageDomain: tabInfo.pageDomain,
            pageContentExcerpt: tabInfo.pageContentExcerpt,
            pageContentLength: tabInfo.pageContentLength,
            currentChatMode: normalizeChatMode(chatMode),
            isFinalizing: false
        },
        history: [],
        turns: [],
        generatingState: createIdleGeneratingState(),
        currentAnswer: '',
        completedAnswer: '',
        reservation: {
            requestId: '',
            createdAt: ''
        }
    });
}

function updateSessionPageInfo(session, tabInfo) {
    session.sessionMeta.pageUrl = tabInfo.pageUrl;
    session.sessionMeta.pageTitle = tabInfo.pageTitle;
    session.sessionMeta.pageDomain = tabInfo.pageDomain;

    if (tabInfo.pageContentExcerpt) {
        session.sessionMeta.pageContentExcerpt = tabInfo.pageContentExcerpt;
        session.sessionMeta.pageContentLength = tabInfo.pageContentLength;
    }
}

function createPageSnapshot(tabInfo) {
    return {
        title: tabInfo.pageTitle,
        url: tabInfo.pageUrl,
        domain: tabInfo.pageDomain,
        excerpt: tabInfo.pageContentExcerpt,
        contentLength: tabInfo.pageContentLength
    };
}

function touchSession(session) {
    const now = new Date().toISOString();
    session.sessionMeta.updatedAt = now;
    session.sessionMeta.lastActivityAt = now;
}

function createIdleGeneratingState() {
    return {
        isGenerating: false,
        pendingQuestion: '',
        requestId: '',
        turnId: '',
        clientId: '',
        startedAt: '',
        chatMode: DEFAULT_CHAT_MODE
    };
}

function createMessage(content, isUser, turnId = '', attachments = []) {
    return {
        turnId,
        content,
        markdownContent: content,
        attachments: normalizeImageAttachments(attachments),
        isUser,
        createdAt: new Date().toISOString()
    };
}

function normalizeImageAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];
    const out = [];

    for (const attachment of attachments) {
        if (!attachment || typeof attachment.dataUrl !== 'string') continue;
        if (attachment.dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) continue;

        const mimeType = attachment.mimeType || mimeTypeFromDataUrl(attachment.dataUrl);
        if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mimeType)) continue;
        if (!attachment.dataUrl.startsWith(`data:${mimeType};base64,`)) continue;

        out.push({
            id: String(attachment.id || `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
            name: String(attachment.name || 'image'),
            mimeType,
            dataUrl: attachment.dataUrl,
            size: Number(attachment.size) || 0
        });

        if (out.length >= MAX_IMAGE_ATTACHMENTS) break;
    }

    return out;
}

function mimeTypeFromDataUrl(dataUrl) {
    const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
    return match ? match[1] : '';
}

function imageBase64FromDataUrl(dataUrl) {
    const index = String(dataUrl || '').indexOf(',');
    return index >= 0 ? dataUrl.slice(index + 1) : '';
}

function getTurnById(session, turnId) {
    return session.turns.find((turn) => turn.turnId === turnId) || null;
}

function finalizeTurn(session, turnId, answer, status, errorMessage) {
    const turn = getTurnById(session, turnId);
    if (!turn) {
        return;
    }

    turn.answer = answer || '';
    turn.status = status;
    turn.errorMessage = errorMessage || '';
}

function materializeCurrentAnswer(session) {
    if (!session?.currentAnswer?.trim()) {
        return;
    }

    const turnId = session.generatingState.turnId;
    const lastMessage = session.history[session.history.length - 1];

    if (lastMessage && !lastMessage.isUser && lastMessage.content === session.currentAnswer && lastMessage.turnId === turnId) {
        return;
    }

    session.history.push(createMessage(session.currentAnswer, false, turnId));
}

function processStreamLine(apiType, rawLine) {
    const line = rawLine.trim();
    if (!line) {
        return '';
    }

    // SSE 的 event: 行、注释行 (: ...)、以及非 data: 开头的元信息：跳过
    if (!line.startsWith('data:')) {
        if (line.startsWith('event:') || line.startsWith(':')) return '';
        // 对于 Ollama 这类直接发 JSON 而非标准 SSE 的路径，保持兼容
        if (apiType !== 'ollama') return '';
    }

    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!payload || payload === '[DONE]') {
        return '';
    }

    try {
        return extractContentFromChunk(apiType, JSON.parse(payload));
    } catch (parseError) {
        console.warn('解析响应块失败:', parseError, payload);
        return '';
    }
}

function extractContentFromChunk(apiType, parsed) {
    apiType = normalizeApiType(apiType);
    if (apiType === 'ollama') {
        return parsed.message?.content || '';
    }
    if (apiType === 'claude') {
        // 只关心 content_block_delta 里的 text_delta
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            return parsed.delta.text || '';
        }
        return '';
    }
    if (apiType === 'responses') {
        if (parsed.type === 'response.output_text.delta') return parsed.delta || '';
        if (parsed.type === 'response.output_text.done') return '';
        return '';
    }
    return parsed.choices?.[0]?.delta?.content || '';
}

function extractContentFromResponse(apiType, parsed) {
    apiType = normalizeApiType(apiType);
    if (!parsed || typeof parsed !== 'object') return '';
    if (apiType === 'ollama') {
        return parsed.message?.content || '';
    }
    if (apiType === 'claude') {
        return (parsed.content || [])
            .filter((block) => block && block.type === 'text')
            .map((block) => block.text || '')
            .join('');
    }
    if (apiType === 'responses') {
        if (typeof parsed.output_text === 'string') return parsed.output_text;
        const chunks = [];
        for (const item of parsed.output || []) {
            if (!item || typeof item !== 'object') continue;
            for (const part of item.content || []) {
                if (part && typeof part.text === 'string') chunks.push(part.text);
            }
        }
        return chunks.join('');
    }
    if (apiType === 'gemini') {
        const chunks = [];
        for (const candidate of parsed.candidates || []) {
            const parts = candidate?.content?.parts || [];
            for (const part of parts) {
                if (typeof part?.text === 'string') chunks.push(part.text);
            }
        }
        return chunks.join('');
    }
    return parsed.choices?.[0]?.message?.content || '';
}

function extractHostname(rawUrl) {
    try {
        return new URL(rawUrl).hostname || 'unknown';
    } catch (error) {
        return 'unknown';
    }
}

function buildPageContentExcerpt(pageContent = '') {
    return pageContent.replace(/\s+/g, ' ').trim().slice(0, 1500);
}

function buildVideoContextKey(rawUrl = '', pageContent = '') {
    const contentUrl = String(pageContent || '').match(/^- URL:\s*(.+)$/m)?.[1]?.trim() || '';
    const sourceUrl = contentUrl || rawUrl;
    try {
        const url = new URL(sourceUrl);
        const path = url.pathname || '';
        const bvid = path.match(/\/video\/([Bb][Vv][0-9A-Za-z]+)/)?.[1] || '';
        const epId = path.match(/\/bangumi\/play\/(ep\d+)/i)?.[1] || '';
        const page = url.searchParams.get('p') || '';
        if (bvid) return `bilibili:${bvid}${page ? `:p${page}` : ''}`;
        if (epId) return `bilibili:${epId}`;
        return `video:${url.origin}${path}`;
    } catch (_) {
        const title = String(pageContent || '').match(/^- 标题:\s*(.+)$/m)?.[1]?.trim() || '';
        return title ? `video-title:${title}` : '';
    }
}

function createSessionId(pageTitle) {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const titlePart = slugify(pageTitle).slice(0, 24) || 'webchat';
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `lingsi-${timestamp}-${titlePart}-${randomPart}`;
}

function createRequestId() {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTurnId() {
    return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(text = '') {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function isReservationExpired(reservation) {
    if (!reservation?.requestId || !reservation?.createdAt) {
        return true;
    }
    return Date.now() - new Date(reservation.createdAt).getTime() > 60 * 1000;
}

function modeUsesPageContext(chatMode) {
    return chatMode === CHAT_MODES.WEB_PERSISTED
        || chatMode === CHAT_MODES.WEB_EPHEMERAL
        || chatMode === CHAT_MODES.VIDEO_PERSISTED
        || chatMode === CHAT_MODES.VIDEO_EPHEMERAL;
}

function modeIsVideoContext(chatMode) {
    return chatMode === CHAT_MODES.VIDEO_PERSISTED || chatMode === CHAT_MODES.VIDEO_EPHEMERAL;
}

function modeShouldPersist(chatMode) {
    return chatMode === CHAT_MODES.WEB_PERSISTED
        || chatMode === CHAT_MODES.VIDEO_PERSISTED
        || chatMode === CHAT_MODES.CHAT_PERSISTED;
}

function getRotationReason(session, tabInfo, settings, forQuestion) {
    // 策略：只要标签页一直在，就保持同一会话。
    // 同一 tab 内"目录式 SPA 换章"不再切会话，而是通过 preambleChain 把新章节正文
    // 作为新的 cache 前缀追加进上下文（见 maybeAppendPreamble / buildMessagesForRequest）。
    // 会话切分只由 tab 生命周期事件触发（关闭 / 刷新 / URL 导航）。
    return '';
}

async function rotateSessionIfNeeded(tabId, forQuestion) {
    const session = getSession(tabId);
    if (!session) {
        return null;
    }

    const settings = await loadSettings();
    const tabInfo = await getTabSnapshot(tabId);
    const rotationReason = getRotationReason(session, tabInfo, settings, forQuestion);

    if (!rotationReason) {
        return session;
    }

    const nextChatMode = session.sessionMeta.currentChatMode;
    await finalizeAndClearSession(tabId, rotationReason);
    const nextSession = createSession(tabInfo, nextChatMode);
    await saveSession(tabId, nextSession, true);
    return nextSession;
}

function registerPort(tabId, port) {
    const key = String(tabId);
    if (!runtimePorts[key]) {
        runtimePorts[key] = new Set();
    }
    runtimePorts[key].add(port);
    port.__tabId = key;
}

function unregisterPort(port) {
    const tabId = port.__tabId;
    if (!tabId || !runtimePorts[tabId]) {
        return;
    }

    runtimePorts[tabId].delete(port);
    if (runtimePorts[tabId].size === 0) {
        delete runtimePorts[tabId];
    }
}

function sendDirectMessage(port, message) {
    try {
        port.postMessage(message);
    } catch (error) {
        unregisterPort(port);
    }
}

function broadcastToTab(tabId, message) {
    const ports = runtimePorts[String(tabId)];
    if (!ports) {
        return;
    }

    for (const port of [...ports]) {
        sendDirectMessage(port, message);
    }
}

function broadcastChatModeUpdate(tabId, chatMode, reason) {
    const message = {
        action: 'chatModeUpdated',
        tabId,
        chatMode,
        reason
    };
    // 扩展内部页面（popup / options）通过 runtime 接收
    chrome.runtime.sendMessage(message).catch(() => { /* 没监听者就忽略 */ });
    // 内容脚本必须通过 tabs.sendMessage，否则侧边面板收不到模式变更广播
    if (typeof tabId === 'number') {
        chrome.tabs.sendMessage(tabId, message).catch(() => { /* 标签页可能已关闭 */ });
    }
}

async function finalizeAndClearSession(tabId, reason) {
    const session = getSession(tabId);
    if (!session) {
        return;
    }

    const settings = await loadSettings();
    session.sessionMeta.isFinalizing = true;

    if (session.generatingState.isGenerating) {
        const controller = runtimeControllers[session.sessionMeta.sessionId];
        if (controller) {
            controller.abort(reason);
        }
        materializeCurrentAnswer(session);
        finalizeTurn(session, session.generatingState.turnId, session.currentAnswer, 'stopped', '');
        session.generatingState = createIdleGeneratingState();
        session.completedAnswer = session.currentAnswer;
    }

    session.sessionMeta.lastRotationReason = reason;
    touchSession(session);
    await saveSession(tabId, session, true);
    await persistSessionLog(tabId, reason, settings);

    // 会话即将被清掉：把完整 blob 落到 archive，方便用户下次在同一页恢复。
    // 空会话（没 turn）不写，避免 "每次关标签都产一条空归档"。
    try {
        if ((session.turns || []).length > 0) {
            await commitArchiveFromSession(session);
        }
    } catch (e) {
        console.warn('archive 归档失败:', e);
    }

    await deleteSession(tabId, true);

    // 通知该 tab 里的 content script：会话已被后端清空，UI 该刷新了。
    // broadcastToTab 走的是 runtime port（只在流式中存在）—— 空闲对话框收不到，
    // 所以这里用 chrome.tabs.sendMessage 主动广播，覆盖 SPA 换页等场景。
    if (typeof tabId === 'number') {
        chrome.tabs.sendMessage(tabId, {
            action: 'sessionReset',
            reason
        }).catch(() => { /* 标签页可能已关闭或 content script 未加载 */ });
    }
}

async function persistSessionLog(tabId, reason, providedSettings = null) {
    const session = getSession(tabId);
    if (!session || session.turns.length === 0) {
        return;
    }

    const settings = providedSettings || await loadSettings();
    if (!settings.enableSessionLogging) {
        return;
    }

    const exportPayload = buildLogPayload(session, reason, settings);
    if (!exportPayload) {
        return;
    }

    await flushPendingLogs(settings);

    try {
        const result = await postSessionLog(settings, exportPayload);
        if (result?.filePath) {
            session.sessionMeta.outputFilePath = result.filePath;
            await saveSession(tabId, session, true);
        }
    } catch (error) {
        console.warn('同步会话日志失败，已加入待重试队列:', error);
        pendingLogsState[session.sessionMeta.sessionId] = exportPayload;
        await flushPersistentState();
    }
}

function buildLogPayload(session, reason, settings) {
    const persistedTurns = session.turns.filter((turn) => turn.shouldPersist);
    if (persistedTurns.length === 0) {
        return null;
    }

    const messages = [];
    const exportedTurns = [];
    let skippedGapPending = false;

    for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex += 1) {
        const turn = session.turns[turnIndex];
        if (!turn.shouldPersist) {
            if (messages.length > 0) {
                skippedGapPending = true;
            }
            continue;
        }

        if (skippedGapPending) {
            const gapMessage = {
                index: messages.length + 1,
                role: 'assistant',
                content: '【日志说明】中间存在未入库回合，已省略。',
                createdAt: turn.createdAt
            };
            messages.push(gapMessage);
            exportedTurns.push({
                type: 'gap',
                createdAt: turn.createdAt,
                note: gapMessage.content
            });
            skippedGapPending = false;
        }

        if (turn.usesPageContext && turn.pageSnapshot) {
            const snapshotContent = buildPageSnapshotNote(turn.pageSnapshot);
            const snapshotMessage = {
                index: messages.length + 1,
                role: 'assistant',
                content: snapshotContent,
                createdAt: turn.createdAt
            };
            messages.push(snapshotMessage);
        }

        const userMessage = {
            index: messages.length + 1,
            role: 'user',
            content: turn.question,
            createdAt: turn.createdAt
        };
        messages.push(userMessage);

        if (turn.answer) {
            messages.push({
                index: messages.length + 1,
                role: 'assistant',
                content: turn.answer,
                createdAt: turn.createdAt
            });
        } else if (turn.errorMessage) {
            messages.push({
                index: messages.length + 1,
                role: 'assistant',
                content: `发生错误：${turn.errorMessage}`,
                createdAt: turn.createdAt
            });
        }

        exportedTurns.push({
            type: 'turn',
            turnId: turn.turnId,
            turnIndex, // 0-based 位置，用于 Python 侧按 preamble.anchor 映射到章节
            createdAt: turn.createdAt,
            chatMode: turn.chatMode,
            usesPageContext: turn.usesPageContext,
            shouldPersist: turn.shouldPersist,
            pageSnapshot: turn.pageSnapshot,
            status: turn.status,
            messages: [
                { role: 'user', content: turn.question, createdAt: turn.createdAt },
                ...(turn.answer ? [{ role: 'assistant', content: turn.answer, createdAt: turn.createdAt }] : []),
                ...(turn.errorMessage ? [{ role: 'assistant', content: `发生错误：${turn.errorMessage}`, createdAt: turn.createdAt }] : [])
            ]
        });
    }

    const sessionPage = buildSessionPageForExport(persistedTurns);

    // 学习轨迹：每段 preamble 是一个"章节"，按 anchor 顺序出现
    const preambleChain = (session.sessionMeta.preambleChain || []).map((pre, idx) => ({
        index: idx,
        anchor: pre.anchor,
        pageTitle: pre.pageTitle || '',
        pageUrl: pre.pageUrl || '',
        excerpt: pre.excerpt || '',
        content: pre.content || '',
        createdAt: pre.createdAt || ''
    }));

    return {
        version: chrome.runtime.getManifest().version,
        savedAt: new Date().toISOString(),
        reason,
        outputDir: settings.sessionLogOutputDir,
        workspaceRoot: settings.sessionLogWorkspaceRoot,
        session: {
            sessionId: session.sessionMeta.sessionId,
            startedAt: session.sessionMeta.startedAt,
            updatedAt: session.sessionMeta.updatedAt,
            status: session.generatingState.isGenerating ? 'generating' : 'completed',
            page: sessionPage,
            preambleChain,
            assistant: {
                apiType: settings.apiType,
                model: getApiSetting(settings, 'model'),
                temperature: settings.temperature,
                maxTokens: settings.maxTokens,
                enableContext: settings.enableContext,
                maxContextRounds: settings.maxContextRounds,
                chatMode: session.sessionMeta.currentChatMode
            },
            messages,
            turns: exportedTurns,
            messageCount: messages.length,
            turnCount: persistedTurns.length
        }
    };
}

function buildPageSnapshotNote(pageSnapshot) {
    const lines = ['【页面上下文】'];

    if (pageSnapshot.title) {
        lines.push(`- 标题: ${pageSnapshot.title}`);
    }
    if (pageSnapshot.url) {
        lines.push(`- 地址: ${pageSnapshot.url}`);
    }
    if (pageSnapshot.domain) {
        lines.push(`- 域名: ${pageSnapshot.domain}`);
    }
    if (pageSnapshot.excerpt) {
        lines.push('', '```text', pageSnapshot.excerpt, '```');
    }

    return lines.join('\n');
}

function buildSessionPageForExport(persistedTurns) {
    const webTurns = persistedTurns.filter((turn) => turn.usesPageContext && turn.pageSnapshot);
    if (webTurns.length === 0) {
        return {
            title: '',
            url: '',
            domain: '',
            excerpt: '',
            contentLength: 0
        };
    }

    const firstSnapshot = webTurns[0].pageSnapshot;
    const samePage = webTurns.every((turn) => turn.pageSnapshot?.url === firstSnapshot.url);

    if (samePage) {
        return {
            title: firstSnapshot.title,
            url: firstSnapshot.url,
            domain: firstSnapshot.domain,
            excerpt: firstSnapshot.excerpt,
            contentLength: firstSnapshot.contentLength
        };
    }

    return {
        title: '混合网页会话',
        url: '',
        domain: '',
        excerpt: '',
        contentLength: 0
    };
}

async function postSessionLog(settings, payload) {
    const response = await fetch(settings.sessionLogEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(errorText || `HTTP ${response.status}`);
    }

    return await response.json().catch(() => null);
}

async function flushPendingLogs(settings) {
    const entries = Object.entries(pendingLogsState);
    if (entries.length === 0 || !settings.enableSessionLogging) {
        return;
    }

    let changed = false;

    for (const [sessionId, payload] of entries) {
        try {
            await postSessionLog(settings, payload);
            delete pendingLogsState[sessionId];
            changed = true;
        } catch (error) {
            console.warn('重试待写日志失败:', error);
            break;
        }
    }

    if (changed) {
        await flushPersistentState();
    }
}
