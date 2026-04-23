let markedInstance;

// 从 shared/chatModes.js 读取统一定义
const { CHAT_MODE_META, CHAT_MODES, DEFAULT_CHAT_MODE, normalizeChatMode } = self.WebChatModes;

async function initMarked() {
    try {
        await new Promise((resolve) => {
            if (typeof marked !== 'undefined') {
                resolve();
            } else {
                const script = document.createElement('script');
                script.src = '../lib/marked.min.js';
                script.onload = resolve;
                document.head.appendChild(script);
            }
        });

        marked.setOptions({
            breaks: true,
            gfm: true,
            headerIds: false,
            mangle: false
        });

        markedInstance = marked.parse;
    } catch (error) {
        console.error('Marked初始化失败:', error);
        markedInstance = (text) => text;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await initMarked();

    const userInput = document.getElementById('userInput');
    const askButton = document.getElementById('askButton');
    const messagesContainer = document.getElementById('messages');
    const toggleBall = document.getElementById('toggleBall');
    const chatModeGroup = document.getElementById('chatModeGroup');
    const chatModeButtons = chatModeGroup ? Array.from(chatModeGroup.querySelectorAll('.chat-mode-btn')) : [];
    const chatModeHint = document.getElementById('chatModeHint');
    const clientId = `popup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let isGenerating = false;
    let currentChatMode = 'web_persisted';
    let suppressModeSelect = false;
    let activePort = null;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab.id;

    const { showFloatingBall = true } = await chrome.storage.sync.get('showFloatingBall');
    toggleBall.checked = showFloatingBall;

    toggleBall.addEventListener('change', async () => {
        await chrome.storage.sync.set({ showFloatingBall: toggleBall.checked });
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (currentTab) {
            chrome.tabs.sendMessage(currentTab.id, { action: 'toggleFloatingBall' });
        }
    });

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'chatModeUpdated' && request.tabId === tabId) {
            updateChatModeUI(request.chatMode);
            sendResponse({ status: 'ok' });
        }
        return true;
    });

    chatModeButtons.forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (suppressModeSelect) {
                return;
            }

            const targetMode = btn.dataset.mode;
            if (!targetMode || targetMode === currentChatMode) {
                return;
            }

            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'setChatMode',
                    tabId,
                    chatMode: targetMode
                });

                if (!response || response.status !== 'ok') {
                    throw new Error(response?.error || '切换会话模式失败');
                }

                updateChatModeUI(response.chatMode);
            } catch (error) {
                console.error('切换会话模式失败:', error);
                updateChatModeUI(currentChatMode);
                addMessage('发生错误：' + error.message, false);
            }
        });
    });

    function renderWelcomeMessage() {
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'welcome-message';
        welcomeDiv.innerHTML = '<p>👋 你好！我是AI助手，可以帮你理解和分析当前网页的内容。</p>';
        messagesContainer.appendChild(welcomeDiv);
    }

    function resetMessagesUI(showWelcome = true) {
        messagesContainer.innerHTML = '';
        if (showWelcome) {
            renderWelcomeMessage();
        }
    }

    function updateChatModeUI(chatMode) {
        currentChatMode = CHAT_MODE_META[chatMode] ? chatMode : 'web_persisted';
        suppressModeSelect = true;
        chatModeButtons.forEach((btn) => {
            const active = btn.dataset.mode === currentChatMode;
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            btn.classList.toggle('active', active);
        });
        suppressModeSelect = false;

        const meta = CHAT_MODE_META[currentChatMode];
        chatModeHint.textContent = meta.hint;
        chatModeHint.className = `chat-mode-hint ${meta.hintClass}`;
    }

    async function ensureContentScriptLoaded(targetTabId) {
        try {
            await chrome.tabs.sendMessage(targetTabId, { action: 'ping' });
            return true;
        } catch (error) {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    files: ['content.js']
                });
                await new Promise((resolve) => setTimeout(resolve, 100));
                return true;
            } catch (injectError) {
                console.error('Failed to inject content script:', injectError);
                return false;
            }
        }
    }

    async function getPageContent(currentTab, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i += 1) {
            try {
                await ensureContentScriptLoaded(currentTab.id);
                const response = await chrome.tabs.sendMessage(currentTab.id, { action: 'getPageContent' });
                return response.content;
            } catch (error) {
                if (i === maxRetries - 1) {
                    throw new Error('无法获取页面内容，请刷新页面后重试');
                }
                await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
            }
        }
        return '';
    }

    function addMessage(content, isUser = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isUser ? 'user-message' : 'assistant-message'}`;

        if (!isUser && content === '') {
            messageDiv.setAttribute('data-pending', 'true');
        } else if (isUser) {
            messageDiv.textContent = content;
        } else {
            try {
                messageDiv.innerHTML = markedInstance(content);
            } catch (error) {
                console.error('Markdown渲染失败:', error);
                messageDiv.textContent = content;
            }
        }

        messagesContainer.appendChild(messageDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        return messageDiv;
    }

    function addTypingIndicator() {
        const indicatorDiv = document.createElement('div');
        indicatorDiv.className = 'message assistant-message typing-indicator';
        indicatorDiv.innerHTML = '<span></span><span></span><span></span>';
        messagesContainer.appendChild(indicatorDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        return indicatorDiv;
    }

    function closeActivePort() {
        if (!activePort) {
            return;
        }

        try {
            activePort.disconnect();
        } catch (error) {
            console.debug('关闭端口失败:', error);
        }

        activePort = null;
    }

    function attachStreamPort(port, messageDiv, typingIndicator, initialAnswer = '') {
        activePort = port;
        let answer = initialAnswer;

        if (answer) {
            try {
                messageDiv.innerHTML = markedInstance(answer);
            } catch (error) {
                messageDiv.textContent = answer;
            }
        }

        port.onMessage.addListener(async (msg) => {
            if (msg.type === 'answer-chunk') {
                answer += msg.content;
                try {
                    messageDiv.innerHTML = markedInstance(answer);
                } catch (error) {
                    console.error('Markdown渲染失败:', error);
                    messageDiv.textContent = answer;
                }
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
                return;
            }

            if (msg.type === 'session-reset') {
                closeActivePort();
                updateChatModeUI(msg.chatMode || currentChatMode);
                resetMessagesUI(true);
                await loadHistory();
                return;
            }

            if (msg.type === 'answer-end' || msg.type === 'answer-stopped') {
                if (msg.type === 'answer-stopped' && answer.trim()) {
                    addMessage('已停止回复', false);
                }
                messageDiv.removeAttribute('data-pending');
                isGenerating = false;
                userInput.disabled = false;
                askButton.disabled = false;
                userInput.focus();
                typingIndicator.remove();
                closeActivePort();
                return;
            }

            if (msg.type === 'error') {
                messageDiv.remove();
                addMessage('发生错误：' + msg.error, false);
                isGenerating = false;
                userInput.disabled = false;
                askButton.disabled = false;
                userInput.focus();
                typingIndicator.remove();
                closeActivePort();
            }
        });
    }

    async function loadHistory() {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getHistory',
                tabId
            });

            updateChatModeUI(response?.chatMode || 'web_persisted');
            messagesContainer.innerHTML = '';

            if (!response || !response.history || response.history.length === 0) {
                renderWelcomeMessage();
            } else {
                response.history.forEach((msg) => {
                    const messageDiv = document.createElement('div');
                    messageDiv.className = `message ${msg.isUser ? 'user-message' : 'assistant-message'}`;
                    if (msg.isUser) {
                        messageDiv.textContent = msg.content;
                    } else {
                        try {
                            messageDiv.innerHTML = markedInstance(msg.markdownContent || msg.content);
                        } catch (error) {
                            console.error('Markdown渲染失败:', error);
                            messageDiv.textContent = msg.content;
                        }
                    }
                    messagesContainer.appendChild(messageDiv);
                });
            }

            if (response?.isGenerating) {
                isGenerating = true;
                userInput.disabled = true;
                askButton.disabled = true;
                const messageDiv = addMessage('', false);
                const typingIndicator = addTypingIndicator();
                const port = chrome.runtime.connect({ name: 'answerStream' });
                attachStreamPort(port, messageDiv, typingIndicator, response.currentAnswer || '');
                port.postMessage({
                    action: 'reconnectStream',
                    tabId,
                    clientId
                });
            }

            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        } catch (error) {
            console.error('加载历史记录失败:', error);
            resetMessagesUI(true);
        }
    }

    async function handleUserInput() {
        if (isGenerating) {
            return;
        }

        const question = userInput.value.trim();
        if (!question) {
            return;
        }

        isGenerating = true;
        userInput.disabled = true;
        askButton.disabled = true;
        userInput.value = '';

        try {
            const meta = CHAT_MODE_META[currentChatMode] || {};
            let pageContent = '';
            if (meta.contextSource === 'full') {
                pageContent = await getPageContent(tab);
            } else if (meta.contextSource === 'selection') {
                await ensureContentScriptLoaded(tab.id);
                const res = await chrome.tabs.sendMessage(tab.id, { action: 'getSelection' }).catch(() => null);
                const sel = (res?.selection || '').trim();
                if (!sel) {
                    addMessage('当前是"选中+临时"模式，请先在页面上选中一段文字再提问。', false);
                    isGenerating = false;
                    userInput.disabled = false;
                    askButton.disabled = false;
                    userInput.value = question;
                    userInput.focus();
                    return;
                }
                pageContent = sel;
            }
            const prepare = await chrome.runtime.sendMessage({
                action: 'prepareGeneration',
                tabId,
                pageContent,
                question
            });

            if (!prepare || prepare.status !== 'ok') {
                throw new Error(prepare?.error || '当前无法开始新对话');
            }

            updateChatModeUI(prepare.chatMode || currentChatMode);

            if (prepare.sessionReset) {
                resetMessagesUI(true);
            }

            addMessage(question, true);
            const messageDiv = addMessage('', false);
            const typingIndicator = addTypingIndicator();
            const port = chrome.runtime.connect({ name: 'answerStream' });
            attachStreamPort(port, messageDiv, typingIndicator);
            port.postMessage({
                action: 'generateAnswer',
                tabId,
                pageContent,
                question,
                requestId: prepare.requestId,
                clientId,
                sessionReset: prepare.sessionReset
            });
        } catch (error) {
            addMessage('发生错误：' + error.message, false);
            isGenerating = false;
            userInput.disabled = false;
            askButton.disabled = false;
            userInput.focus();
        }
    }

    askButton.addEventListener('click', handleUserInput);
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleUserInput();
        }
    });

    userInput.addEventListener('input', () => {
        userInput.style.height = 'auto';
        userInput.style.height = `${Math.min(userInput.scrollHeight, 100)}px`;
    });

    await loadHistory();
});
