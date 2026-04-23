function parseWebContent() {
    // 克隆当前文档以供解析，不影响原始页面
    const docClone = document.cloneNode(true);

    // 在克隆的文档中移除不需要的元素
    const scripts = docClone.querySelectorAll('script');
    const styles = docClone.querySelectorAll('style, link[rel="stylesheet"]');
    const headers = docClone.querySelectorAll('header, nav');
    const footers = docClone.querySelectorAll('footer');

    // 从克隆的文档中移除元素
    [...scripts, ...styles, ...headers, ...footers].forEach(element => {
        if (element.parentNode) {
            element.parentNode.removeChild(element);
        }
    });

    // 获取主要内容（从body中提取）
    const mainContent = docClone.querySelector('body');

    // 如果找到了body元素，获取其文本内容
    const textContent = mainContent ? mainContent.innerText : '';

    // 清理文本
    return textContent
        .replace(/\s+/g, ' ')  // 将多个空白字符替换为单个空格
        .trim();               // 移除首尾空白
}

let activeDialogSyncController = null;
// 从 shared/chatModes.js 读取统一定义
const { CHAT_MODE_META, CHAT_MODES, DEFAULT_CHAT_MODE, normalizeChatMode } = self.WebChatModes;

// 创建对话框
function createDialog() {
    // 先移除可能存在的旧对话框
    const existingDialog = document.getElementById('ai-assistant-dialog');
    if (existingDialog) {
        existingDialog.remove();
    }

    const dialog = document.createElement('div');
    dialog.id = 'ai-assistant-dialog';

    // 侧边栏模式：面板停靠到屏幕一侧，整页高度，挤压页面内容
    dialog.dataset.panelSide = 'right';
    dialog.innerHTML = `
        <div class="container">
            <div class="header">
                <div class="header-main">
                    <div class="tokens-counter">Tokens: 0</div>
                    <div class="chat-mode-control">
                        <span class="chat-mode-label">会话模式</span>
                        <div class="chat-mode-group" id="chatModeGroup" role="radiogroup" aria-label="会话模式">
                            <button type="button" class="chat-mode-btn" data-mode="web_persisted" aria-pressed="false" title="基于整页内容回答，写入知识库">网页+入库</button>
                            <button type="button" class="chat-mode-btn" data-mode="web_ephemeral" aria-pressed="false" title="基于整页内容回答，不入库">网页+临时</button>
                            <button type="button" class="chat-mode-btn" data-mode="web_selection" aria-pressed="false" title="只用页面选中文本作为上下文">选中+临时</button>
                            <button type="button" class="chat-mode-btn" data-mode="chat_persisted" aria-pressed="false" title="纯聊天，写入知识库">纯聊+入库</button>
                            <button type="button" class="chat-mode-btn" data-mode="chat_ephemeral" aria-pressed="false" title="纯聊天，不入库">纯聊+临时</button>
                        </div>
                    </div>
                    <div class="panel-actions">
                        <button type="button" class="panel-clear" title="清空当前会话">🧹</button>
                        <button type="button" class="panel-width-cycle" title="切换预设宽度">⤢</button>
                        <button type="button" class="panel-side-switch" title="切换左右停靠">⇄</button>
                        <button type="button" class="panel-close" title="关闭面板 (Esc 也可关)">×</button>
                    </div>
                </div>
                <div id="chatModeHint" class="storage-mode-hint">基于网页内容回答，且会写入知识库。</div>
            </div>
            <div id="chat-container" class="chat-container">
                <div id="messages" class="messages"></div>
            </div>
            <div class="input-container">
                <div class="slash-menu" id="slashMenu" hidden role="listbox" aria-label="提示词模板"></div>
                <div class="selection-chip" id="selectionChip" hidden>
                    <span class="sel-icon">“</span>
                    <span class="sel-text">引用选中内容</span>
                    <span class="sel-len">0</span>
                    <span class="sel-dismiss" title="取消引用">×</span>
                </div>
                <textarea id="userInput" placeholder="请输入您的问题... (Enter 发送 / Shift+Enter 换行 / Esc 关闭)" rows="2"></textarea>
                <button id="askButton" class="send-button">
                </button>
            </div>
        </div>
        <div class="resize-handle resize-handle-panel" data-resize-dir="w"></div>
    `;

    // 创建遮罩层（仅在拉伸时用来阻挡下层鼠标事件，不挡视线）
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    document.body.appendChild(overlay);

    // 侧边栏参数
    const MIN_W = 320;
    const EDGE_RESERVE = 80; // 至少给原页面留下 80px
    const DEFAULT_W = 420;

    function effectiveMaxWidth() {
        return Math.max(MIN_W, window.innerWidth - EDGE_RESERVE);
    }

    function clampWidth(width) {
        return Math.max(MIN_W, Math.min(Math.round(width), effectiveMaxWidth()));
    }

    // 把挤压效果应用到 <html>；用 margin 方式，兼容绝大多数站点
    function applyBodyOffset(side, width) {
        const html = document.documentElement;
        html.classList.add('ai-assistant-panel-open');
        html.style.setProperty('transition', 'margin 0.2s ease', 'important');
        if (side === 'left') {
            html.style.setProperty('margin-left', `${width}px`, 'important');
            html.style.removeProperty('margin-right');
        } else {
            html.style.setProperty('margin-right', `${width}px`, 'important');
            html.style.removeProperty('margin-left');
        }
    }

    function clearBodyOffset() {
        const html = document.documentElement;
        html.classList.remove('ai-assistant-panel-open');
        html.style.removeProperty('margin-right');
        html.style.removeProperty('margin-left');
        html.style.removeProperty('transition');
    }

    function applyPanelSide(side) {
        const s = side === 'left' ? 'left' : 'right';
        dialog.dataset.panelSide = s;
        const handle = dialog.querySelector('.resize-handle-panel');
        if (handle) {
            handle.dataset.resizeDir = s === 'right' ? 'w' : 'e';
        }
        if (dialog.classList.contains('show')) {
            applyBodyOffset(s, dialog.offsetWidth);
        }
    }

    function applyPanelWidth(width) {
        const w = clampWidth(width);
        dialog.style.width = `${w}px`;
        if (dialog.classList.contains('show')) {
            applyBodyOffset(dialog.dataset.panelSide || 'right', w);
        }
        return w;
    }

    // 监听 .show 的增减，自动同步/清除 body margin
    const showObserver = new MutationObserver(() => {
        if (dialog.classList.contains('show')) {
            applyBodyOffset(dialog.dataset.panelSide || 'right', dialog.offsetWidth || DEFAULT_W);
        } else {
            clearBodyOffset();
        }
    });
    showObserver.observe(dialog, { attributes: true, attributeFilter: ['class'] });

    // 头部按钮：切换停靠方向 + 关闭
    const sideSwitchBtn = dialog.querySelector('.panel-side-switch');
    if (sideSwitchBtn) {
        sideSwitchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const next = (dialog.dataset.panelSide || 'right') === 'right' ? 'left' : 'right';
            applyPanelSide(next);
            chrome.storage.sync.set({ panelSide: next });
        });
    }
    const closeBtn = dialog.querySelector('.panel-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dialog.classList.remove('show');
        });
    }

    // 一键清空当前会话
    const clearBtn = dialog.querySelector('.panel-clear');
    if (clearBtn) {
        clearBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm('确定要清空当前会话吗？历史消息将被归档。')) return;
            try {
                const res = await sendMessageWithRetry({ action: 'getCurrentTab' });
                const targetTabId = res?.tabId;
                await sendMessageWithRetry({
                    action: 'clearHistory',
                    tabId: targetTabId,
                    reason: 'user-cleared'
                });
                // 让当前 initializeDialog 内的消息 UI 重置
                if (activeDialogSyncController && activeDialogSyncController.resetMessagesUI) {
                    activeDialogSyncController.resetMessagesUI();
                }
            } catch (err) {
                console.error('清空会话失败:', err);
            }
        });
    }

    // 宽度预设循环：360 -> 420 -> 560 -> 越宽越窄
    const WIDTH_PRESETS = [360, 420, 560, 760];
    const widthCycleBtn = dialog.querySelector('.panel-width-cycle');
    if (widthCycleBtn) {
        widthCycleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const current = dialog.offsetWidth;
            // 找下一个严格大于当前宽度的预设；循环
            const next = WIDTH_PRESETS.find((w) => w > current + 4) ?? WIDTH_PRESETS[0];
            const applied = applyPanelWidth(next);
            chrome.storage.sync.set({ panelWidth: applied });
        });
    }

    // 单轴拖拽改宽度
    let isResizing = false;
    let resizeStart = null;
    let resizeAnimationFrame;
    const resizeHandle = dialog.querySelector('.resize-handle-panel');
    if (resizeHandle) {
        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            dialog.style.transition = 'none';
            resizeStart = {
                x: e.clientX,
                width: dialog.offsetWidth,
                side: dialog.dataset.panelSide || 'right'
            };
            document.addEventListener('mousemove', handleResize);
            document.addEventListener('mouseup', stopResize);
            overlay.classList.add('dragging');
            e.preventDefault();
            e.stopPropagation();
        });
    }

    function handleResize(e) {
        if (!isResizing || !resizeStart) return;
        if (resizeAnimationFrame) cancelAnimationFrame(resizeAnimationFrame);

        resizeAnimationFrame = requestAnimationFrame(() => {
            const delta = e.clientX - resizeStart.x;
            // 右停靠时拖向左侧（delta 负）放大；左停靠时拖向右侧（delta 正）放大
            const raw = resizeStart.side === 'right'
                ? resizeStart.width - delta
                : resizeStart.width + delta;
            const applied = applyPanelWidth(raw);
            chrome.storage.sync.set({ panelWidth: applied });
        });
    }

    function stopResize() {
        if (!isResizing) return;
        isResizing = false;
        resizeStart = null;
        dialog.style.transition = '';
        document.removeEventListener('mousemove', handleResize);
        document.removeEventListener('mouseup', stopResize);
        overlay.classList.remove('dragging');
        if (resizeAnimationFrame) cancelAnimationFrame(resizeAnimationFrame);
    }

    // 初始化：从存储读取停靠方向和宽度
    chrome.storage.sync.get({
        panelWidth: DEFAULT_W,
        panelSide: 'right'
    }, (items) => {
        applyPanelSide(items.panelSide);
        applyPanelWidth(items.panelWidth);
    });

    // 窗口缩放时重新收敛宽度并同步 body offset
    window.addEventListener('resize', () => {
        applyPanelWidth(dialog.offsetWidth || DEFAULT_W);
    });

    document.body.appendChild(dialog);

    // 修改点击外部关闭功能
    document.addEventListener('mousedown', async (e) => {
        const ball = document.getElementById('ai-assistant-ball');
        const contextMenu = document.querySelector('.context-menu');

        // 获取自动隐藏设置（侧边栏模式下默认关闭，避免误触关掉面板）
        const settings = await chrome.storage.sync.get({
            autoHideDialog: false
        });

        if (settings.autoHideDialog && // 检查设置
            dialog.classList.contains('show') &&
            !dialog.contains(e.target) &&
            (!ball || !ball.contains(e.target)) &&
            (!contextMenu || !contextMenu.contains(e.target))) {
            dialog.classList.remove('show');
        }
    });

    return dialog;
}

// 修改createFloatingBall函
function createFloatingBall() {
    // 创建容器
    const container = document.createElement('div');
    container.className = 'ball-container';

    // 创建悬浮球
    const ball = document.createElement('div');
    ball.id = 'ai-assistant-ball';
    ball.innerHTML = `<svg t="1731757557572" class="icon" width="32" height="32" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1317" width="128" height="128">
        <path d="M200 935.744a39.517867 39.517867 0 0 1-14.122667-7.185067c-12.906667-10.295467-18.602667-27.2896-14.741333-43.4688a1295.863467 1295.863467 0 0 0 17.207467-520c-5.6448-33.216 0.418133-66.760533 17.5488-96.443733 17.156267-29.563733 43.498667-51.648 75.656533-60.497067h0.008533l417.591467-114.24c66.0352-19.434667 144.533333 49.792 162.602667 156.258134a1978.666667 1978.666667 0 0 1 27.144533 397.806933c-3.4432 107.592533-71.6928 186.248533-139.758933 176.008533l-64.823467-8.494933c-22.203733-3.042133-36.8768-29.952-33.8944-60.1984 3.008-30.2336 22.664533-53.713067 45.038933-52.343467 21.7472 1.463467 43.485867 2.922667 65.233067 4.3776 24.170667 1.783467 45.969067-26.0096 47.133867-62.007466a1897.941333 1897.941333 0 0 0-26.030934-381.499734c-6.062933-35.618133-31.466667-60.3136-55.168-55.2576l-424.0128 87.466667c-11.4176 2.363733-21.1584 9.570133-27.6096 20.078933-6.4512 10.530133-8.802133 22.993067-6.698666 35.345067a1377.0368 1377.0368 0 0 1 2.346666 449.117867 1341.696 1341.696 0 0 0 118.4512-104.448c8.251733-8.1792 18.862933-12.475733 29.602134-11.758934l293.009066 19.6736c22.340267 1.365333 38.839467 28.650667 35.639467 60.842667-3.1744 32.200533-24.704 55.765333-46.882133 52.7232l-274.5216-35.972267c-62.229333 57.1136-127.6544 106.965333-194.973867 149.384534-9.629867 6.071467-20.8 7.522133-30.976 4.731733z" p-id="1318" fill="white"></path>
        <path d="M635.733333 488.533333m-59.733333 0a59.733333 59.733333 0 1 0 119.466667 0 59.733333 59.733333 0 1 0-119.466667 0Z" p-id="1319" fill="white"></path>
        <path d="M460.864 507.733333m-50.133333 0a50.133333 50.133333 0 1 0 100.266666 0 50.133333 50.133333 0 1 0-100.266666 0Z" p-id="1320" fill="white"></path>
    </svg>`;

    // 创建设置按钮
    const settingsButton = document.createElement('div');
    settingsButton.className = 'settings-button';
    settingsButton.innerHTML = '<svg t="1731757768104" class="icon" width="24" height="24" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1612" width="128" height="128"><path d="M550.4 924.404h-49.1c-57.7 0-104.6-46.9-104.6-104.6-0.1-7.2-2.1-14.5-5.9-20.9-6.6-11.2-16.3-18.6-27.9-21.7-11.6-3.1-23.7-1.5-34.1 4.6-51.6 28.6-115.3 10.1-143.2-40.4l-24.5-42.2c-0.1-0.1-0.1-0.2-0.2-0.3v-0.1c-28.5-49.8-11.2-113.5 38.5-142 14-8.1 22.8-23.3 22.8-39.5s-8.7-31.4-22.9-39.6c-49.8-28.8-67-92.8-38.3-142.6l26.6-43.8c28.5-49.3 92.5-66.3 142.3-37.7 6.7 4 14.1 6 21.6 6.1h0.1c24.6 0 45.1-20.2 45.4-45.1 0-57.5 46.7-104.2 104-104.2h49.3c61 1.9 106.4 50.3 104.6 107.9 0.1 6.3 2.1 13.6 5.9 20 6.4 10.8 16.2 18.2 27.9 21.2s23.8 1.2 34.2-4.9c50-28.8 114.1-11.7 143 38l24.5 42.5 1.5 3c26.2 49.3 8.8 111.3-39.7 139.6-7.1 4-12.8 9.7-16.7 16.7-6.4 11.1-7.9 23.3-4.7 34.9 3.2 11.6 10.7 21.3 21.2 27.3 25 14.6 42.1 37.1 49.2 64 7.1 26.9 3.2 54.9-10.8 78.9l-26 43.5c-28.7 49.3-92.6 66.5-142.6 37.8-6.6-3.8-14.3-6-22.1-6.2-12 0.1-23.4 4.9-31.8 13.5-8.5 8.6-13.1 20-13 32-0.4 57.7-47.3 104.3-104.5 104.3z m-199.2-207.6c8.9 0 17.9 1.2 26.7 3.5 26.8 7.1 49.3 24.2 63.2 48.2 9.3 15.7 14.2 33.2 14.4 51 0 25.5 20.5 46 45.7 46h49.1c25 0 45.5-20.4 45.7-45.4-0.2-27.4 10.4-53.6 30-73.4 19.5-19.8 45.6-30.8 73.4-31 19.4 0.5 36.6 5.3 51.7 14 21.9 12.5 49.8 5 62.4-16.7l26.1-43.6c5.9-10.1 7.6-22.3 4.5-34-3.1-11.7-10.5-21.4-20.9-27.5-24.6-14-42-36.4-49.3-63.2-7.3-26.8-3.8-54.9 10-79 9.6-16.8 22.9-30.1 38.9-39.2 21.3-12.4 28.8-40.3 16.5-62-0.5-0.8-0.8-1.6-1.2-2.4l-23.2-40.2c-12.5-21.6-40.5-29.2-62.2-16.7-23.6 14-51.6 17.9-78.5 11.1-26.9-6.9-49.5-23.9-63.7-47.8-9.3-15.7-14.2-33.2-14.4-51.1 0.8-26.4-19-47.5-44.2-48.3h-50.8c-24.9 0-45.1 20.3-45.1 45.2-0.8 57.8-47.7 104.1-104.6 104.1h-0.2c-18.1-0.2-35.5-5.1-50.9-14.2-21.5-12.4-49.4-4.8-62 16.9l-26.6 43.7c-12.1 21.1-4.6 49.1 17.1 61.7 32.2 18.6 52.3 53.3 52.3 90.6s-20.1 72-52.3 90.6c-21.7 12.4-29.2 40.1-16.8 61.7 0 0.1 0.1 0.1 0.1 0.2l24.8 42.8c12.5 22.6 40.3 30.6 62.4 18.5 16-9.3 33.8-14.1 51.9-14.1zM525.9 650.204c-73.3 0-133-59.7-133-133s59.7-133 133-133 133 59.7 133 133c0 73.4-59.7 133-133 133z m0-207c-40.8 0-74.1 33.2-74.1 74.1s33.2 74.1 74.1 74.1 74.1-33.2 74.1-74.1-33.3-74.1-74.1-74.1z" p-id="1613" fill="#ffffff"></path></svg>';
    settingsButton.title = '设置';

    // 创建对话框（如果不存在）
    let dialog = document.getElementById('ai-assistant-dialog');
    if (!dialog) {
        dialog = createDialog();
        // 初始化对话框内容（只初始化一次）
        initializeDialog(dialog);
    }

    // 设置按钮点击事件
    settingsButton.addEventListener('click', (e) => {
        e.stopPropagation(); // 防止触发悬浮球的点击事件
        chrome.runtime.sendMessage({ action: 'openOptions' });
    });

    // 悬浮球点击事件：侧边栏模式下只做 show/hide 切换
    ball.addEventListener('click', () => {
        dialog.classList.toggle('show');
    });

    // 将悬浮球和设置按钮添加到容器中
    container.appendChild(ball);
    container.appendChild(settingsButton);

    // 修改拖拽功能
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;

    ball.addEventListener('mousedown', (e) => {
        isDragging = true;
        const rect = container.getBoundingClientRect();
        initialX = e.clientX - rect.left;
        initialY = e.clientY - rect.top;
    });

    // 拖动期间：自由跟随鼠标，不做任何吸附，保证拖拽手感丝滑
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;

        const maxX = window.innerWidth - container.offsetWidth;
        const maxY = window.innerHeight - container.offsetHeight;

        currentX = Math.max(0, Math.min(currentX, maxX));
        currentY = Math.max(0, Math.min(currentY, maxY));

        // 拖动中先清掉 edge-* 类，避免半吸附抖动
        ball.classList.remove('edge-left', 'edge-right', 'edge-top', 'edge-bottom');
        container.style.transition = 'none';
        Object.assign(container.style, {
            left: `${currentX}px`,
            top: `${currentY}px`,
            right: 'auto',
            bottom: 'auto'
        });
    });

    // 松开时：计算到四条边的距离，始终吸附到最近的一条边
    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;

        const containerW = container.offsetWidth;
        const containerH = container.offsetHeight;
        const winW = window.innerWidth;
        const winH = window.innerHeight;

        const x = typeof currentX === 'number'
            ? currentX
            : container.getBoundingClientRect().left;
        const y = typeof currentY === 'number'
            ? currentY
            : container.getBoundingClientRect().top;

        const distLeft = x;
        const distRight = winW - (x + containerW);
        const distTop = y;
        const distBottom = winH - (y + containerH);

        const minDist = Math.min(distLeft, distRight, distTop, distBottom);

        let edge;
        let position;
        if (minDist === distLeft) {
            edge = 'left';
            position = {
                left: '0px',
                top: `${Math.max(0, Math.min(y, winH - containerH))}px`,
                right: 'auto',
                bottom: 'auto',
                edge
            };
        } else if (minDist === distRight) {
            edge = 'right';
            position = {
                right: '0px',
                top: `${Math.max(0, Math.min(y, winH - containerH))}px`,
                left: 'auto',
                bottom: 'auto',
                edge
            };
        } else if (minDist === distTop) {
            edge = 'top';
            position = {
                top: '0px',
                left: `${Math.max(0, Math.min(x, winW - containerW))}px`,
                right: 'auto',
                bottom: 'auto',
                edge
            };
        } else {
            edge = 'bottom';
            position = {
                bottom: '0px',
                left: `${Math.max(0, Math.min(x, winW - containerW))}px`,
                right: 'auto',
                top: 'auto',
                edge
            };
        }

        ball.classList.remove('edge-left', 'edge-right', 'edge-top', 'edge-bottom');
        ball.classList.add(`edge-${edge}`);
        // 用过渡动画让吸附过程更平滑
        container.style.transition = 'left 0.2s ease, top 0.2s ease, right 0.2s ease, bottom 0.2s ease';
        Object.assign(container.style, position);

        chrome.storage.sync.set({ ballPosition: position });
    });

    // 从存储中加载位置，并确保位置在可视区域内
    chrome.storage.sync.get({
        ballPosition: { right: '0px', bottom: '20px', left: 'auto', top: 'auto', edge: 'right' }
    }, (items) => {
        // 获取容器和窗口尺寸
        const containerRect = container.getBoundingClientRect();
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        // 解析保存的位置值
        let position = items.ballPosition;
        let left = position.left !== 'auto' ? parseInt(position.left) : null;
        let right = position.right !== 'auto' ? parseInt(position.right) : null;
        let top = position.top !== 'auto' ? parseInt(position.top) : null;
        let bottom = position.bottom !== 'auto' ? parseInt(position.bottom) : null;

        // 确保位置在可视区域内
        if (left !== null) {
            // 如果使用left定位
            left = Math.min(Math.max(0, left), windowWidth - containerRect.width);
            position = {
                left: `${left}px`,
                top: position.top,
                right: 'auto',
                bottom: position.bottom,
                edge: position.edge
            };
        } else if (right !== null) {
            // 如果使用right定位
            right = Math.min(Math.max(0, right), windowWidth - containerRect.width);
            position = {
                right: `${right}px`,
                top: position.top,
                left: 'auto',
                bottom: position.bottom,
                edge: position.edge
            };
        }

        if (top !== null) {
            // 如果使用top定
            top = Math.min(Math.max(0, top), windowHeight - containerRect.height);
            position = {
                ...position,
                top: `${top}px`,
                bottom: 'auto'
            };
        } else if (bottom !== null) {
            // 如果使用bottom定位
            bottom = Math.min(Math.max(0, bottom), windowHeight - containerRect.height);
            position = {
                ...position,
                bottom: `${bottom}px`,
                top: 'auto'
            };
        }

        // 应用位置
        Object.assign(container.style, position);

        // 如果有边缘状态，添加相应的类
        if (position.edge) {
            ball.classList.add(`edge-${position.edge}`);
        }

        // 保存调整后的位置
        chrome.storage.sync.set({ ballPosition: position });
    });

    // 添加窗口大小变化监听器
    window.addEventListener('resize', () => {
        // 获取当前位置
        const rect = container.getBoundingClientRect();
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        // 确保位置在可视区内
        let left = rect.left;
        let top = rect.top;

        // 调整位置
        if (left + rect.width > windowWidth) {
            left = windowWidth - rect.width;
        }
        if (top + rect.height > windowHeight) {
            top = windowHeight - rect.height;
        }

        // 确保不会小于0
        left = Math.max(0, left);
        top = Math.max(0, top);

        // 应用新位置
        const position = {
            left: `${left}px`,
            top: `${top}px`,
            right: 'auto',
            bottom: 'auto',
            edge: null // 重置边缘状态
        };

        Object.assign(container.style, position);

        // 保存新位置
        chrome.storage.sync.set({ ballPosition: position });

        // 检查是否需要添加边缘类
        const edgeThreshold = ball.offsetWidth / 2;
        ball.classList.remove('edge-left', 'edge-right', 'edge-top', 'edge-bottom');

        if (left <= edgeThreshold) {
            ball.classList.add('edge-left');
            position.edge = 'left';
        } else if (left >= windowWidth - rect.width - edgeThreshold) {
            ball.classList.add('edge-right');
            position.edge = 'right';
        }

        if (top <= edgeThreshold) {
            ball.classList.add('edge-top');
            position.edge = 'top';
        } else if (top >= windowHeight - rect.height - edgeThreshold) {
            ball.classList.add('edge-bottom');
            position.edge = 'bottom';
        }

        // 保存更新后的位置和边缘状态
        chrome.storage.sync.set({ ballPosition: position });
    });

    document.body.appendChild(container);
    return ball;
}

// 存储对话框和悬浮球的引用
let dialogInstance = null;
let ballInstance = null;

// 初始化marked
async function initMarked() {
    try {
        // 等待marked加载完成
        if (typeof marked === 'undefined') {
            // 如果marked还没有加载，等它加载完成
            await new Promise((resolve, reject) => {
                const checkMarked = () => {
                    if (typeof marked !== 'undefined') {
                        resolve();
                    } else {
                        setTimeout(checkMarked, 100);
                    }
                };
                checkMarked();
                // 设置超时
                setTimeout(() => reject(new Error('Marked加超时')), 5000);
            });
        }

        // 配置marked选项
        marked.setOptions({
            breaks: true,      // 将换行符转换为<br>
            gfm: true,         // 启用GitHub格的Markdown
            headerIds: false,  // 禁用标题ID以避免潜在的冲突
            mangle: false      // 禁用标题ID转义
        });

        return marked.parse;
    } catch (error) {
        console.error('Marked初化失败:', error);
        return text => text; // 提供一个后备方案
    }
}

// 修改错误处理和通知显示函数
function showNotification(message) {
    // 移除可能存在的旧通知
    const existingNotification = document.querySelector('.extension-notification');
    if (existingNotification) {
        existingNotification.remove();
    }

    const notification = document.createElement('div');
    notification.className = 'extension-notification';
    notification.style.cssText = `
        position: fixed;
        right: 20px;
        top: 20px;
        padding: 10px 20px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        border-radius: 4px;
        z-index: 10000;
        font-size: 14px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
        animation: fadeInOut 3s ease forwards;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    // 3秒后自动移除
    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// 修改sendMessageWithRetry函数
async function sendMessageWithRetry(message, maxRetries = 3) {
    let notificationShown = false; // 添加标记，避免重复显示通知

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await chrome.runtime.sendMessage(message);
        } catch (error) {
            if (error.message.includes('Extension context invalidated')) {
                if (!notificationShown) {
                    console.log('Extension context invalidated, reloading page...');
                    // 显示通知
                    const notification = document.createElement('div');
                    notification.style.cssText = `
                        position: fixed;
                        right: 20px;
                        top: 20px;
                        padding: 10px 20px;
                        background: rgba(0, 0, 0, 0.8);
                        color: white;
                        border-radius: 4px;
                        z-index: 10000;
                        font-size: 14px;
                        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
                    `;
                    notification.textContent = '扩展已更新，请刷新页面以继续使用';
                    document.body.appendChild(notification);

                    // 3秒后自动移除提示
                    setTimeout(() => {
                        notification.remove();
                    }, 3000);

                    notificationShown = true; // 标记通知已显示
                }
                return;
            }
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 100));
        }
    }
}

// 移除全局错误监听器中的通知显示
window.addEventListener('error', (event) => {
    if (event.error && event.error.message.includes('Extension context invalidated')) {
        event.preventDefault(); // 阻止错误继续传播
    }
});

// 移除未处理Promise错误监听器中的通知显示
window.addEventListener('unhandledrejection', (event) => {
    if (event.reason && event.reason.message &&
        event.reason.message.includes('Extension context invalidated')) {
        event.preventDefault(); // 阻止错误继续传播
    }
});

// 修改checkAndSetBallVisibility函数
async function checkAndSetBallVisibility() {
    try {
        if (!chrome.runtime) {
            showNotification('扩展已更新，请刷新页面以继续使用');
            return;
        }
        const existingBall = document.getElementById('ai-assistant-ball');
        const existingDialog = document.getElementById('ai-assistant-dialog');

        if (!existingBall) {
            createFloatingBall();
        } else if (!existingDialog) {
            const dialog = createDialog();
            initializeDialog(dialog);
        }
    } catch (error) {
        if (error.message.includes('Extension context invalidated')) {
            showNotification('扩展已更新，请刷新页面以继续使用');
        }
    }
}

// 监听来自popup的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        if (request.action === 'ping') {
            sendResponse({ status: 'ok' });
        } else if (request.action === 'getPageContent') {
            const content = parseWebContent();
            sendResponse({ content });
        } else if (request.action === 'getSelection') {
            const selection = window.getSelection ? window.getSelection().toString().trim() : '';
            sendResponse({ selection });
        } else if (request.action === 'toggleFloatingBall') {
            checkAndSetBallVisibility();
            sendResponse({ status: 'ok' });
        } else if (request.action === 'togglePanel') {
            const dialog = document.getElementById('ai-assistant-dialog');
            if (dialog) {
                dialog.classList.toggle('show');
                if (dialog.classList.contains('show')) {
                    const ta = dialog.querySelector('#userInput');
                    if (ta) setTimeout(() => ta.focus(), 150);
                }
            } else {
                // 面板还没构建，先让 ball 逻辑打开
                const ball = document.getElementById('ai-assistant-ball');
                if (ball) ball.click();
            }
            sendResponse({ status: 'ok' });
        } else if (request.action === 'chatModeUpdated') {
            if (activeDialogSyncController && activeDialogSyncController.tabId === request.tabId) {
                void activeDialogSyncController.applyChatModeUpdate(request.chatMode, true);
            }
            sendResponse({ status: 'ok' });
        }
    } catch (error) {
        console.error('处理消息时出错:', error);
        sendResponse({ error: error.message });
    }
    return true;
});

// 初始化时检查悬浮球状态
checkAndSetBallVisibility();

// 修改initializeDialog函数
async function initializeDialog(dialog) {
    try {
        const userInput = dialog.querySelector('#userInput');
        const askButton = dialog.querySelector('#askButton');
        const messagesContainer = dialog.querySelector('#messages');
        const chatContainer = dialog.querySelector('#chat-container');
        const chatModeGroup = dialog.querySelector('#chatModeGroup');
        const chatModeButtons = chatModeGroup ? Array.from(chatModeGroup.querySelectorAll('.chat-mode-btn')) : [];
        const chatModeHint = dialog.querySelector('#chatModeHint');
        let isGenerating = false;
        let currentPort = null;
        let currentAnswer = '';
        let userHasScrolled = false;
        const clientId = `dialog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let currentChatMode = 'web_persisted';
        let suppressModeSelect = false;

        // 创建并添加滚动按钮
        const scrollToBottomButton = createScrollToBottomButton(messagesContainer);
        chatContainer.appendChild(scrollToBottomButton);

        // 监听滚动事件
        messagesContainer.addEventListener('scroll', () => {
            // 计算是否滚动到底部（添加一个小的容差值）
            const isAtBottom = Math.abs(
                messagesContainer.scrollHeight -
                messagesContainer.clientHeight -
                messagesContainer.scrollTop
            ) < 30;

            // 更新按钮显示状态
            if (!isAtBottom) {
                userHasScrolled = true;
                scrollToBottomButton.style.display = 'block';
            } else {
                userHasScrolled = false;
                scrollToBottomButton.style.display = 'none';
            }
        });

        // 修改autoScroll函数
        function autoScroll(force = false) {
            const messagesContainer = document.querySelector('#ai-assistant-dialog .messages');
            if (!messagesContainer) return;

            // 如果强制滚动或者用户没有手动滚动
            if (force || !userHasScrolled) {
                // 使用requestAnimationFrame确保在DOM更新后滚动
                requestAnimationFrame(() => {
                    // 再次使用requestAnimationFrame以确保渲染完成
                    requestAnimationFrame(() => {
                        // 使用scrollIntoView来确保最新消息可见
                        const messages = messagesContainer.children;
                        if (messages.length > 0) {
                            const lastMessage = messages[messages.length - 1];
                            lastMessage.scrollIntoView({ behavior: 'smooth', block: 'end' });
                        }
                    });
                });
            }
        }

        // 修改监听滚动事件的逻辑
        messagesContainer.addEventListener('scroll', () => {
            // 只有在不生成答案时才检测用户滚动
            if (!isGenerating) {
                const isAtBottom = Math.abs(
                    messagesContainer.scrollHeight -
                    messagesContainer.clientHeight -
                    messagesContainer.scrollTop
                ) < 30;

                userHasScrolled = !isAtBottom;
            }
        });

        // 监听消息容器的容化
        const observer = new MutationObserver((mutations) => {
            let shouldScroll = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList' || mutation.type === 'characterData') {
                    shouldScroll = true;
                    break;
                }
            }
            if (shouldScroll) {
                autoScroll();
            }
        });

        observer.observe(messagesContainer, {
            childList: true,
            subtree: true,
            characterData: true
        });

        // 修改dialog的show类添加监听
        const dialogObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.target.classList.contains('show')) {
                    userHasScrolled = false;
                    autoScroll(true); // 强制滚动到底部
                }
            });
        });

        dialogObserver.observe(dialog, {
            attributes: true,
            attributeFilter: ['class']
        });

        // 获取当前标签页ID
        let tabId;
        try {
            const response = await sendMessageWithRetry({ action: 'getCurrentTab' });
            if (!response) {
                throw new Error('无法获取标签页ID');
            }
            tabId = response.tabId;
        } catch (error) {
            console.error('获取标签页ID失败:', error);
            return;
        }

        // 初化marked
        const markedInstance = await initMarked();

        function renderWelcomeMessage() {
            const welcomeDiv = document.createElement('div');
            welcomeDiv.className = 'welcome-message';
            welcomeDiv.innerHTML = '<p>👋 你好！我是AI助手，可以帮你理解和分析当前网页的内容。</p>';
            messagesContainer.appendChild(welcomeDiv);
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
            chatModeHint.className = `storage-mode-hint ${meta.hintClass}`;
        }

        async function applyChatModeUpdate(chatMode, reloadOnly) {
            updateChatModeUI(chatMode);

            if (!reloadOnly) {
                const label = CHAT_MODE_META[currentChatMode]?.label || currentChatMode;
                addMessage(`已切换会话模式：${label}`, false);
            }
        }

        activeDialogSyncController = {
            tabId,
            applyChatModeUpdate,
            resetMessagesUI: () => resetMessagesUI()
        };

        // 加载历史会话
        async function loadHistory() {
            try {
                const response = await sendMessageWithRetry({
                    action: 'getHistory',
                    tabId: tabId
                });

                updateChatModeUI(response?.chatMode || 'web_persisted');
                messagesContainer.innerHTML = '';

                if (!response || !response.history || response.history.length === 0) {
                    renderWelcomeMessage();
                } else {
                    response.history.forEach(msg => {
                        const messageDiv = document.createElement('div');
                        messageDiv.className = `message ${msg.isUser ? 'user-message' : 'assistant-message'}`;

                        // 保存原始的Markdown内容
                        messageDiv.dataset.markdownContent = msg.markdownContent || msg.content;

                        try {
                            // 对所有消息使用Markdown渲染
                            messageDiv.innerHTML = markedInstance(msg.markdownContent || msg.content);
                            // 添加右键菜单事件监听
                            messageDiv.addEventListener('contextmenu', (e) => {
                                const markdownContent = messageDiv.dataset.markdownContent;
                                handleContextMenu(e, messageDiv, markdownContent);
                            });
                        } catch (error) {
                            console.error('Markdown渲染失败:', error);
                            messageDiv.textContent = msg.content;
                        }

                        messagesContainer.appendChild(messageDiv);
                    });

                    if (response.isGenerating) {
                        isGenerating = true;
                        userInput.disabled = true;
                        askButton.classList.add('generating');

                        const messageDiv = addMessage('', false);
                        const typingIndicator = addTypingIndicator();
                        currentPort = chrome.runtime.connect({ name: "answerStream" });
                        let streamAnswer = response.currentAnswer || '';

                        if (streamAnswer) {
                            try {
                                messageDiv.dataset.markdownContent = streamAnswer;
                                messageDiv.innerHTML = markedInstance(streamAnswer);
                            } catch (error) {
                                messageDiv.textContent = streamAnswer;
                            }
                        }

                        currentPort.onMessage.addListener(async (msg) => {
                            try {
                                if (msg.type === 'answer-chunk') {
                                    streamAnswer += msg.content;
                                    messageDiv.dataset.markdownContent = msg.markdownContent || streamAnswer;
                                    messageDiv.innerHTML = markedInstance(streamAnswer);
                                    autoScroll();
                                } else if (msg.type === 'answer-end' || msg.type === 'answer-stopped') {
                                    if (msg.type === 'answer-stopped' && streamAnswer.trim()) {
                                        addMessage('已停止回复', false);
                                    }
                                messageDiv.removeAttribute('data-pending');
                                isGenerating = false;
                                userInput.disabled = false;
                                    askButton.disabled = false;
                                    askButton.classList.remove('generating');
                                    typingIndicator.remove();
                                    currentPort.disconnect();
                                    currentPort = null;
                                    autoScroll(true);
                                } else if (msg.type === 'session-reset') {
                                    if (currentPort) {
                                        try {
                                            currentPort.disconnect();
                                        } catch (error) {
                                            console.debug('关闭端口失败:', error);
                                        }
                                        currentPort = null;
                                    }
                                    isGenerating = false;
                                    userInput.disabled = false;
                                    askButton.disabled = false;
                                    askButton.classList.remove('generating');
                                    updateChatModeUI(msg.chatMode || currentChatMode);
                                    resetMessagesUI();
                                    await loadHistory();
                                } else if (msg.type === 'error') {
                                    messageDiv.remove();
                                    addMessage('发生错误：' + msg.error, false);
                                    isGenerating = false;
                                    userInput.disabled = false;
                                    askButton.disabled = false;
                                    askButton.classList.remove('generating');
                                    typingIndicator.remove();
                                    currentPort.disconnect();
                                    currentPort = null;
                                }
                            } catch (error) {
                                console.error('处理重连流消息失败:', error);
                            }
                        });

                        currentPort.postMessage({
                            action: 'reconnectStream',
                            tabId: tabId,
                            clientId: clientId
                        });
                    }
                }
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            } catch (error) {
                console.error('加载历史记录失败:', error);
                messagesContainer.innerHTML = '';
                renderWelcomeMessage();
            }
        }

        function resetMessagesUI() {
            messagesContainer.innerHTML = '';
            renderWelcomeMessage();
        }

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
                    const response = await sendMessageWithRetry({
                        action: 'setChatMode',
                        tabId: tabId,
                        chatMode: targetMode
                    });

                    if (!response || response.status !== 'ok') {
                        throw new Error(response?.error || '切换会话模式失败');
                    }

                    await applyChatModeUpdate(response.chatMode, false);
                } catch (error) {
                    console.error('切换会话模式失败:', error);
                    updateChatModeUI(currentChatMode);
                    addMessage('发生错误：' + error.message, false);
                }
            });
        });

        // 添加复制功能
        function createCopyButton() {
            const button = document.createElement('button');
            button.className = 'copy-button';
            button.innerHTML = '📋 复制';
            return button;
        }

        // 复制文本到剪贴板
        async function copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (err) {
                console.error('复制失败:', err);
                return false;
            }
        }

        // 修改handleContextMenu函数
        function handleContextMenu(e, messageDiv, content) {
            e.preventDefault();
            e.stopPropagation();

            // 移除可能存在的旧菜单
            const oldMenu = document.querySelector('.context-menu');
            if (oldMenu) {
                oldMenu.remove();
            }

            // 获取要复制的内容
            // 对于AI回复，优先使用保存的Markdown内容
            const textToCopy = messageDiv.classList.contains('assistant-message')
                ? messageDiv.dataset.markdownContent || content || messageDiv.textContent
                : content;

            console.log('Copy content:', textToCopy); // 调试日志

            // 创建右键菜单
            const menu = document.createElement('div');
            menu.className = 'context-menu';
            menu.style.position = 'fixed';
            menu.style.left = `${e.clientX}px`;
            menu.style.top = `${e.clientY}px`;

            // 添加复制选项
            const copyOption = document.createElement('div');
            copyOption.className = 'context-menu-item';
            copyOption.innerHTML = '📋 复制该消息';
            copyOption.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const success = await copyToClipboard(textToCopy);
                if (success) {
                    // 显示复制成功提示
                    const toast = document.createElement('div');
                    toast.className = 'copy-toast';
                    toast.textContent = '✓ 已复制';
                    toast.style.position = 'fixed';
                    toast.style.left = `${e.clientX}px`;
                    toast.style.top = `${e.clientY - 40}px`;
                    toast.style.transform = 'translate(-50%, -50%)';
                    document.body.appendChild(toast);

                    // 2秒后移除提示
                    setTimeout(() => {
                        toast.remove();
                    }, 2000);
                }
                menu.remove();
            };
            menu.appendChild(copyOption);

            // 添加菜单到页面
            document.body.appendChild(menu);

            // 点击其他地方时关闭菜单
            const closeMenu = (event) => {
                if (!menu.contains(event.target)) {
                    menu.remove();
                    document.removeEventListener('mousedown', closeMenu);
                }
            };
            document.addEventListener('mousedown', closeMenu);
        }

        // 修改addMessage函数
        function addMessage(content, isUser = false) {
            const messageDiv = document.createElement('div');
            messageDiv.className = `message ${isUser ? 'user-message' : 'assistant-message'}`;

            if (!isUser && content === '') {
                messageDiv.setAttribute('data-pending', 'true');
            } else {
                // 保存原始的Markdown内容
                messageDiv.dataset.markdownContent = content;

                try {
                    // 无论是用户消息还是AI回复，都使用Markdown渲染
                    messageDiv.innerHTML = markedInstance(content);
                    messageDiv.addEventListener('contextmenu', (e) => {
                        const markdownContent = messageDiv.dataset.markdownContent;
                        handleContextMenu(e, messageDiv, markdownContent);
                    });
                } catch (error) {
                    console.error('Markdown渲染失败:', error);
                    messageDiv.textContent = content;
                }
            }

            messagesContainer.appendChild(messageDiv);
            autoScroll();
            return messageDiv;
        }

        // 添加打字指示器
        function addTypingIndicator() {
            const indicatorDiv = document.createElement('div');
            indicatorDiv.className = 'message assistant-message typing-indicator';
            indicatorDiv.innerHTML = '<span></span><span></span><span></span>';
            messagesContainer.appendChild(indicatorDiv);
            autoScroll(); // 使用自动滚动函数
            return indicatorDiv;
        }

        // 修改handleUserInput函数
        async function handleUserInput() {
            if (isGenerating) {
                askButton.disabled = true;
                await sendMessageWithRetry({
                    action: 'stopGeneration',
                    tabId: tabId,
                    reason: 'manual-stop'
                });
                return;
            }

            const question = userInput.value.trim();
            if (!question) return;

            isGenerating = true;
            userInput.disabled = true;
            askButton.disabled = false;
            askButton.classList.add('generating');
            userInput.value = '';

            try {
                const meta = CHAT_MODE_META[currentChatMode] || {};
                let pageContent = '';
                if (meta.contextSource === 'full') {
                    pageContent = parseWebContent();
                } else if (meta.contextSource === 'selection') {
                    const sel = (window.getSelection ? window.getSelection().toString().trim() : '') || pendingSelection || '';
                    if (!sel) {
                        isGenerating = false;
                        userInput.disabled = false;
                        askButton.disabled = false;
                        askButton.classList.remove('generating');
                        userInput.value = question; // 恢复输入
                        addMessage('当前是"选中+临时"模式，请先在页面上选中一段文字再提问。', false);
                        return;
                    }
                    pageContent = sel;
                }

                const prepare = await sendMessageWithRetry({
                    action: 'prepareGeneration',
                    tabId: tabId,
                    pageContent: pageContent,
                    question: question
                });

                if (!prepare || prepare.status !== 'ok') {
                    throw new Error(prepare?.error || '当前无法开始新对话');
                }

                updateChatModeUI(prepare.chatMode || currentChatMode);

                if (prepare.sessionReset) {
                    resetMessagesUI();
                }

                addMessage(question, true);
                const messageDiv = addMessage('', false);
                const typingIndicator = addTypingIndicator();

                if (currentPort) {
                    currentPort.disconnect();
                }
                currentPort = chrome.runtime.connect({ name: "answerStream" });
                let currentAnswer = '';

                const tokensCounter = dialog.querySelector('.tokens-counter');
                let totalTokens = 0;

                // 修改消息监听器
                currentPort.onMessage.addListener(async (msg) => {
                    try {
                        if (msg.type === 'input-tokens') {
                            // 更新输入Tokens计数
                            totalTokens += msg.tokens;
                            tokensCounter.textContent = `Tokens: ${totalTokens}`;
                        } else if (msg.type === 'answer-chunk') {
                            currentAnswer += msg.content;
                            try {
                                messageDiv.dataset.markdownContent = msg.markdownContent || currentAnswer;
                                messageDiv.innerHTML = markedInstance(currentAnswer);
                            } catch (error) {
                                messageDiv.textContent = currentAnswer;
                            }
                            // 更新输出Tokens计数
                            if (msg.tokens) {
                                totalTokens += msg.tokens;
                                tokensCounter.textContent = `Tokens: ${totalTokens}`;
                            }
                            autoScroll();
                        } else if (msg.type === 'answer-end' || msg.type === 'answer-stopped') {
                            if (msg.type === 'answer-stopped' && currentAnswer.trim()) {
                                addMessage('已停止回复', false);
                            }
                            messageDiv.removeAttribute('data-pending');
                            messageDiv.dataset.markdownContent = msg.markdownContent || currentAnswer;
                            messageDiv.addEventListener('contextmenu', (e) => {
                                const markdownContent = messageDiv.dataset.markdownContent;
                                handleContextMenu(e, messageDiv, markdownContent);
                            });

                            isGenerating = false;
                            userInput.disabled = false;
                            askButton.disabled = false;
                            askButton.classList.remove('generating');
                            userInput.focus();
                            typingIndicator.remove();
                            currentPort.disconnect();
                            currentPort = null;
                            currentAnswer = '';
                            userHasScrolled = false;
                            autoScroll(true);

                            // 保存Tokens计数到存储
                            chrome.storage.sync.set({ totalTokens });
                        } else if (msg.type === 'session-reset') {
                            if (currentPort) {
                                try {
                                    currentPort.disconnect();
                                } catch (error) {
                                    console.debug('关闭端口失败:', error);
                                }
                                currentPort = null;
                            }
                            isGenerating = false;
                            userInput.disabled = false;
                            askButton.disabled = false;
                            askButton.classList.remove('generating');
                            updateChatModeUI(msg.chatMode || currentChatMode);
                            resetMessagesUI();
                            await loadHistory();
                        } else if (msg.type === 'error') {
                            messageDiv.remove();
                            addMessage('发生错误：' + msg.error, false);
                            isGenerating = false;
                            userInput.disabled = false;
                            askButton.disabled = false;
                            askButton.classList.remove('generating');
                            userInput.focus();
                            typingIndicator.remove();
                            currentPort.disconnect();
                            currentPort = null;
                            currentAnswer = '';
                            userHasScrolled = false;
                        }
                    } catch (error) {
                        console.error('处理消息时出错:', error);
                    }
                });

                try {
                    currentPort.postMessage({
                        action: 'generateAnswer',
                        tabId: tabId,
                        pageContent: pageContent,
                        question: question,
                        requestId: prepare.requestId,
                        clientId: clientId,
                        sessionReset: prepare.sessionReset
                    });
                } catch (error) {
                    console.error('发送消息失败:', error);
                    throw error;
                }

            } catch (error) {
                addMessage('发生错误：' + error.message, false);
                isGenerating = false;
                userInput.disabled = false;
                askButton.disabled = false;
                askButton.classList.remove('generating');
                userInput.focus();
            }
        }

        // 绑定事件
        askButton.addEventListener('click', handleUserInput);
        userInput.addEventListener('keydown', (e) => {
            // 斜杠菜单激活时，优先拦截导航键
            if (slashActive) {
                if (e.key === 'ArrowDown') { e.preventDefault(); moveSlashHighlight(1); return; }
                if (e.key === 'ArrowUp')   { e.preventDefault(); moveSlashHighlight(-1); return; }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
                    e.preventDefault();
                    if (slashItems[slashHighlight]) applySlash(slashItems[slashHighlight]);
                    return;
                }
                if (e.key === 'Escape') { e.preventDefault(); hideSlashMenu(); return; }
            }

            // Cmd/Ctrl + Enter 也发送（便于多行输入时确认）
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleUserInput();
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleUserInput();
                return;
            }
            if (e.key === 'Escape') {
                // 生成中 -> 停止生成；否则关闭面板
                e.preventDefault();
                if (isGenerating) {
                    void sendMessageWithRetry({
                        action: 'stopGeneration',
                        tabId,
                        reason: 'user-esc'
                    });
                } else {
                    dialog.classList.remove('show');
                }
            }
        });

        userInput.addEventListener('input', () => {
            userInput.style.height = 'auto';
            userInput.style.height = Math.min(userInput.scrollHeight, 100) + 'px';
            // 触发 @selection 识别：以 "@sel" 开头结尾空格或Tab时自动替换
            maybeExpandSelectionMacro();
            // 检查 /commands 菜单状态
            maybeToggleSlashMenu();
        });

        // ===== 选中文本引用 (selection chip) =====
        const selectionChip = dialog.querySelector('#selectionChip');
        const selectionChipText = selectionChip?.querySelector('.sel-text');
        const selectionChipLen = selectionChip?.querySelector('.sel-len');
        const selectionChipDismiss = selectionChip?.querySelector('.sel-dismiss');
        let pendingSelection = '';

        function updateSelectionChip() {
            if (!selectionChip) return;
            const sel = window.getSelection ? window.getSelection().toString().trim() : '';
            // 忽略面板内部的选中（避免自选自用）
            const anchor = window.getSelection?.().anchorNode;
            const insidePanel = anchor && dialog.contains(anchor.nodeType === 1 ? anchor : anchor.parentElement);
            if (!insidePanel && sel && sel.length >= 2) {
                pendingSelection = sel;
                selectionChipLen.textContent = `${sel.length} 字`;
                selectionChip.hidden = false;
            } else if (!pendingSelection) {
                selectionChip.hidden = true;
            }
        }

        document.addEventListener('selectionchange', updateSelectionChip);
        // 打开面板或输入聚焦时刷新一次
        userInput.addEventListener('focus', updateSelectionChip);

        if (selectionChipDismiss) {
            selectionChipDismiss.addEventListener('click', (e) => {
                e.stopPropagation();
                pendingSelection = '';
                selectionChip.hidden = true;
            });
        }

        // 点击 chip 主体把引文插到输入框
        if (selectionChip) {
            selectionChip.addEventListener('click', () => {
                if (!pendingSelection) return;
                insertQuoteIntoInput(pendingSelection);
            });
        }

        function insertQuoteIntoInput(text) {
            const quoted = text
                .split(/\r?\n/)
                .map((l) => `> ${l}`)
                .join('\n');
            const existing = userInput.value;
            const prefix = existing.trim() ? `${existing.replace(/\s+$/, '')}\n\n` : '';
            userInput.value = `${prefix}${quoted}\n\n`;
            userInput.dispatchEvent(new Event('input'));
            userInput.focus();
            // 插入后清掉 chip（一次性引用）
            pendingSelection = '';
            if (selectionChip) selectionChip.hidden = true;
            // 光标放到末尾
            userInput.setSelectionRange(userInput.value.length, userInput.value.length);
        }

        // ===== /commands 提示词模板菜单 =====
        const SLASH_TEMPLATES = [
            { name: 'summarize', title: '五条要点总结',   prompt: '请用 5 条要点总结这篇内容。' },
            { name: 'tldr',      title: 'TL;DR 一句话概括', prompt: '请用一句话概括核心观点（不超过 40 字）。' },
            { name: 'translate-zh', title: '翻译为中文', prompt: '请把上述内容完整翻译成中文，保留原有的 Markdown/列表结构。' },
            { name: 'translate-en', title: '翻译为英文', prompt: 'Please translate the above content into English, preserving the Markdown structure.' },
            { name: 'explain',   title: '通俗讲解',       prompt: '请用通俗易懂的语言（面向初学者）解释上述内容，适当举例。' },
            { name: 'outline',   title: '生成大纲',       prompt: '请为上述内容生成一个多层级的 Markdown 结构化大纲。' },
            { name: 'keypoints', title: '抽取核心要点',   prompt: '请列出上述内容中 5-8 个关键信息点，用项目符号呈现。' },
            { name: 'qa',        title: '出 5 道练习题', prompt: '基于上述内容出 5 道理解题，并在每题后给出参考答案。' },
            { name: 'rewrite',   title: '改写更清晰',     prompt: '请改写上述内容，让表达更清晰凝练，保留原意。' },
            { name: 'counter',   title: '反驳/质疑角度', prompt: '请从另一个角度反驳/质疑上述内容，列出 3-5 条潜在问题或反例。' }
        ];

        const slashMenu = dialog.querySelector('#slashMenu');
        let slashActive = false;
        let slashItems = [];
        let slashHighlight = -1;

        function maybeToggleSlashMenu() {
            const v = userInput.value;
            // 仅在整个输入形如 `/xxx`（没有空格/换行）时激活
            const m = v.match(/^\/([\w-]*)$/);
            if (m) {
                renderSlashMenu(m[1]);
            } else if (slashActive) {
                hideSlashMenu();
            }
        }

        function renderSlashMenu(filter) {
            if (!slashMenu) return;
            const f = (filter || '').toLowerCase();
            const list = !f
                ? SLASH_TEMPLATES.slice()
                : SLASH_TEMPLATES.filter(t => t.name.toLowerCase().startsWith(f) || t.title.toLowerCase().includes(f));
            if (!list.length) {
                hideSlashMenu();
                return;
            }
            slashMenu.innerHTML = '';
            list.forEach((t, i) => {
                const el = document.createElement('div');
                el.className = 'slash-item' + (i === 0 ? ' highlight' : '');
                el.dataset.idx = String(i);
                el.setAttribute('role', 'option');
                const cmd = document.createElement('span');
                cmd.className = 'slash-cmd';
                cmd.textContent = `/${t.name}`;
                const title = document.createElement('span');
                title.className = 'slash-title';
                title.textContent = t.title;
                el.appendChild(cmd);
                el.appendChild(title);
                // mousedown 而不是 click，避免 textarea 失焦后 selectionchange 改变状态
                el.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    applySlash(list[i]);
                });
                slashMenu.appendChild(el);
            });
            slashItems = list;
            slashHighlight = 0;
            slashActive = true;
            slashMenu.hidden = false;
        }

        function hideSlashMenu() {
            slashActive = false;
            slashHighlight = -1;
            slashItems = [];
            if (slashMenu) {
                slashMenu.hidden = true;
                slashMenu.innerHTML = '';
            }
        }

        function moveSlashHighlight(delta) {
            if (!slashActive || !slashItems.length) return;
            slashHighlight = (slashHighlight + delta + slashItems.length) % slashItems.length;
            Array.from(slashMenu.children).forEach((el, i) => {
                el.classList.toggle('highlight', i === slashHighlight);
            });
            const el = slashMenu.children[slashHighlight];
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
        }

        function applySlash(template) {
            if (!template) return;
            userInput.value = template.prompt;
            hideSlashMenu();
            // 触发 input 事件以刷新高度等
            userInput.dispatchEvent(new Event('input'));
            userInput.focus();
            userInput.setSelectionRange(userInput.value.length, userInput.value.length);
        }

        // 失焦关闭菜单
        userInput.addEventListener('blur', () => {
            // 延迟一点，让 mousedown 选中先执行
            setTimeout(() => hideSlashMenu(), 120);
        });

        // 支持 "@sel" / "@selection" 文本宏：结尾空格/Tab 触发展开
        function maybeExpandSelectionMacro() {
            const v = userInput.value;
            const m = v.match(/(^|\s)@(sel|selection)([\s\t])$/);
            if (!m) return;
            if (!pendingSelection) return;
            const quoted = pendingSelection
                .split(/\r?\n/)
                .map((l) => `> ${l}`)
                .join('\n');
            userInput.value = v.slice(0, m.index + m[1].length) + quoted + m[3];
            pendingSelection = '';
            if (selectionChip) selectionChip.hidden = true;
            userInput.setSelectionRange(userInput.value.length, userInput.value.length);
        }

        // 从存储中加载Tokens计数
        chrome.storage.sync.get({ totalTokens: 0 }, (items) => {
            totalTokens = items.totalTokens;
            tokensCounter.textContent = `Tokens: ${totalTokens}`;
        });

        // 加载初始历史记录
        await loadHistory();
    } catch (error) {
        console.error('初始化对话框失败:', error);
        // 显示友好的错误提示
        const errorDiv = document.createElement('div');
        errorDiv.className = 'welcome-message';
        errorDiv.innerHTML = '<p>⚠️ 初始化失败，请刷新页面后重试</p>';
        dialog.querySelector('.messages').appendChild(errorDiv);
    }
}

// 添加"回到当前消息"按钮
function createScrollToBottomButton(messagesContainer) {
    const button = document.createElement('button');
    button.className = 'scroll-to-bottom-button';
    button.innerHTML = '↓ 回到当前消息';
    button.style.display = 'none'; // 初始状态隐藏

    // 点击事件
    button.addEventListener('click', () => {
        messagesContainer.scrollTo({
            top: messagesContainer.scrollHeight,
            behavior: 'smooth'
        });
        userHasScrolled = false;
        button.style.display = 'none';
    });

    return button;
}

// 添加错误恢复机制
window.addEventListener('error', (event) => {
    if (event.error && event.error.message.includes('Extension context invalidated')) {
        // 显示友好的错误提示
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            right: 20px;
            top: 20px;
            padding: 10px 20px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            border-radius: 4px;
            z-index: 10000;
            font-size: 14px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
        `;
        notification.textContent = '扩展已更新，请刷新页面以继续使用';
        document.body.appendChild(notification);

        // 3秒后自动移除提示
        setTimeout(() => {
            notification.remove();
        }, 3000);
    }
}); 
