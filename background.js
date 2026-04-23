const DEFAULT_SETTINGS = {
    apiType: 'custom',
    maxTokens: 2048,
    temperature: 0.7,
    enableContext: true,
    maxContextRounds: 3,
    systemPrompt: '你是一个帮助理解网页内容的AI助手。请使用Markdown格式回复。',
    custom_apiKey: '',
    custom_apiBase: '',
    custom_model: '',
    ollama_apiKey: '',
    ollama_apiBase: 'http://127.0.0.1:11434/api/chat',
    ollama_model: 'qwen2.5',
    enableSessionLogging: true,
    sessionLogEndpoint: 'http://127.0.0.1:8765/log-session',
    sessionLogOutputDir: '~/webchat-session-logs',
    sessionLogWorkspaceRoot: '~/webchat-workspace',
    sessionIdleMinutes: 30
};

const STORAGE_KEYS = {
    sessions: 'webchat_sessions_v5',
    pendingLogs: 'webchat_pending_logs_v2',
    domainModePrefs: 'webchat_domain_mode_prefs_v1'
};

// 按域名记忆的默认会话模式：{ [domain]: chatMode }
let domainModePrefs = {};

// 加载共享的会话模式定义（供 importScripts 引入）
try {
    importScripts('shared/chatModes.js');
} catch (e) {
    console.error('加载 shared/chatModes.js 失败:', e);
}

const {
    CHAT_MODES,
    DEFAULT_CHAT_MODE,
    CHAT_MODE_META: SHARED_CHAT_MODE_META
} = self.WebChatModes;

const runtimePorts = {};
const runtimeControllers = {};
let sessionsState = {};
let pendingLogsState = {};
let stateLoadedPromise = null;
let saveStateTimer = null;

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
    if (namespace !== 'sync') {
        return;
    }

    if (changes.systemPrompt) {
        console.log('系统提示词已更新');
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

    if (action === 'saveHistory') {
        return { status: 'ignored' };
    }

    return { status: 'unknown-action' };
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
            outputFilePath: session.sessionMeta?.outputFilePath || '',
            lastRotationReason: session.sessionMeta?.lastRotationReason || '',
            lastRecoveryReason: session.sessionMeta?.lastRecoveryReason || '',
            currentChatMode: normalizeChatMode(session.sessionMeta?.currentChatMode),
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
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    await flushPendingLogs(settings);

    let sessionReset = false;
    let session = getSession(tabId);
    const tabInfo = await getTabSnapshot(tabId, pageContent);

    if (session) {
        const rotationReason = getRotationReason(session, tabInfo, settings, true);
        if (rotationReason) {
            const nextChatMode = session.sessionMeta.currentChatMode;
            await finalizeAndClearSession(tabId, rotationReason);
            session = createSession(tabInfo, nextChatMode);
            sessionReset = true;
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

async function startGenerationFromPort(port, request) {
    const tabId = request.tabId;
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
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
    if (!question) {
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

    session.turns.push({
        turnId,
        requestId: request.requestId,
        createdAt: new Date().toISOString(),
        chatMode,
        usesPageContext,
        shouldPersist,
        pageSnapshot,
        question,
        answer: '',
        status: 'generating',
        errorMessage: ''
    });
    session.history.push(createMessage(question, true, turnId));
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
            reason: 'new-session',
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
        const model = settings[`${settings.apiType}_model`];
        const apiKey = settings[`${settings.apiType}_apiKey`];
        const apiBase = settings[`${settings.apiType}_apiBase`];

        if (!apiBase?.trim()) {
            throw new Error('请先在设置页填写请求URL');
        }

        if (!model?.trim()) {
            throw new Error('请先在设置页填写AI模型');
        }

        if (settings.apiType === 'custom' && !apiKey?.trim()) {
            throw new Error('请先在设置页填写API密钥');
        }

        const requestBody = buildRequestBody(settings, model, requestMessages);
        const headers = {
            'Content-Type': 'application/json'
        };

        if (settings.apiType === 'custom' && apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
        }

        const response = await fetch(apiBase, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: abortController.signal
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(errorText || 'API请求失败');
        }

        const inputTokens = Math.ceil((settings.systemPrompt.length + promptContent.length) / 4);
        broadcastToTab(tabId, {
            type: 'input-tokens',
            tokens: inputTokens
        });

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('响应流不可用');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let accumulatedResponse = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n');
            buffer = parts.pop() || '';

            for (const rawLine of parts) {
                const content = processStreamLine(settings.apiType, rawLine);
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

        const remainingContent = processStreamLine(settings.apiType, buffer);
        if (remainingContent) {
            accumulatedResponse += remainingContent;
            session.currentAnswer = accumulatedResponse;
            touchSession(session);
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

function buildMessagesForRequest(session, settings, question, pageContent, turn) {
    const history = settings.enableContext
        ? session.history.slice(-(Math.max(1, settings.maxContextRounds) * 2))
        : [];

    const promptContent = turn.usesPageContext
        ? (modeIsSelectionOnly(turn.chatMode)
            ? `基于以下用户在网页上选中的内容回答问题：\n\n${pageContent}\n\n问题：${question}`
            : `基于以下网页内容回答问题：\n\n${pageContent}\n\n问题：${question}`)
        : question;

    return {
        promptContent,
        requestMessages: [
            {
                role: 'system',
                content: settings.systemPrompt
            },
            ...history.map((message) => ({
                role: message.isUser ? 'user' : 'assistant',
                content: message.markdownContent || message.content
            })),
            {
                role: 'user',
                content: promptContent
            }
        ]
    };
}

function buildRequestBody(settings, model, messages) {
    if (settings.apiType === 'ollama') {
        return {
            model,
            messages,
            stream: true,
            options: {
                temperature: settings.temperature,
                num_predict: settings.maxTokens
            }
        };
    }

    return {
        model,
        messages,
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        stream: true
    };
}

function buildHistoryResponse(session) {
    if (!session) {
        return {
            history: [],
            isGenerating: false,
            pendingQuestion: '',
            currentAnswer: '',
            chatMode: DEFAULT_CHAT_MODE
        };
    }

    return {
        history: session.history,
        isGenerating: session.generatingState.isGenerating,
        pendingQuestion: session.generatingState.pendingQuestion,
        currentAnswer: session.currentAnswer || '',
        sessionId: session.sessionMeta.sessionId,
        chatMode: session.sessionMeta.currentChatMode
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

function createMessage(content, isUser, turnId = '') {
    return {
        turnId,
        content,
        markdownContent: content,
        isUser,
        createdAt: new Date().toISOString()
    };
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
    if (apiType === 'ollama') {
        return parsed.message?.content || '';
    }
    return parsed.choices?.[0]?.delta?.content || '';
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
        || chatMode === CHAT_MODES.WEB_SELECTION;
}

function modeIsSelectionOnly(chatMode) {
    return chatMode === CHAT_MODES.WEB_SELECTION;
}

function modeShouldPersist(chatMode) {
    return chatMode === CHAT_MODES.WEB_PERSISTED || chatMode === CHAT_MODES.CHAT_PERSISTED;
}

function getRotationReason(session, tabInfo, settings, forQuestion) {
    if (session.sessionMeta.pageUrl && tabInfo.pageUrl && session.sessionMeta.pageUrl !== tabInfo.pageUrl) {
        return 'page-changed';
    }

    if (!forQuestion) {
        return '';
    }

    const lastActivityAt = new Date(session.sessionMeta.lastActivityAt).getTime();
    const idleMs = Math.max(1, settings.sessionIdleMinutes) * 60 * 1000;

    if (session.history.length > 0 && Date.now() - lastActivityAt >= idleMs) {
        return 'idle-timeout';
    }

    return '';
}

async function rotateSessionIfNeeded(tabId, forQuestion) {
    const session = getSession(tabId);
    if (!session) {
        return null;
    }

    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
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

    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
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
    await deleteSession(tabId, true);
}

async function persistSessionLog(tabId, reason, providedSettings = null) {
    const session = getSession(tabId);
    if (!session || session.turns.length === 0) {
        return;
    }

    const settings = providedSettings || await chrome.storage.sync.get(DEFAULT_SETTINGS);
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

    for (const turn of session.turns) {
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
            assistant: {
                apiType: settings.apiType,
                model: settings[`${settings.apiType}_model`],
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
