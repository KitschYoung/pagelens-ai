/*
 * 会话模式共享定义
 * 被 background.js (importScripts)、content.js (content_scripts 注入)、popup.html (script 标签) 共用
 * 避免三处重复维护导致漂移
 */
(function (global) {
    const CHAT_MODES = {
        WEB_PERSISTED: 'web_persisted',
        WEB_EPHEMERAL: 'web_ephemeral',
        VIDEO_PERSISTED: 'video_persisted',
        VIDEO_EPHEMERAL: 'video_ephemeral',
        CHAT_PERSISTED: 'chat_persisted',
        CHAT_EPHEMERAL: 'chat_ephemeral'
    };

    const DEFAULT_CHAT_MODE = CHAT_MODES.WEB_PERSISTED;

    const CHAT_MODE_META = {
        web_persisted: {
            label: '网页 + 入库',
            hint: '基于整页内容回答，且会写入知识库。',
            hintClass: 'persisted',
            usesPageContext: true,
            shouldPersist: true,
            contextSource: 'full'
        },
        web_ephemeral: {
            label: '网页 + 临时',
            hint: '基于整页内容回答，但不会写入知识库。',
            hintClass: 'ephemeral',
            usesPageContext: true,
            shouldPersist: false,
            contextSource: 'full'
        },
        video_persisted: {
            label: '视频 + 入库',
            hint: '基于视频字幕和网页文本回答，且会写入知识库。',
            hintClass: 'persisted',
            usesPageContext: true,
            shouldPersist: true,
            contextSource: 'video'
        },
        video_ephemeral: {
            label: '视频 + 临时',
            hint: '基于视频字幕和网页文本回答，但不会写入知识库。',
            hintClass: 'ephemeral',
            usesPageContext: true,
            shouldPersist: false,
            contextSource: 'video'
        },
        chat_persisted: {
            label: '纯聊 + 入库',
            hint: '纯聊天模式，不注入网页内容，会写入知识库。',
            hintClass: 'persisted',
            usesPageContext: false,
            shouldPersist: true,
            contextSource: 'none'
        },
        chat_ephemeral: {
            label: '纯聊 + 临时',
            hint: '纯聊天模式，不注入网页内容，也不会写入知识库。',
            hintClass: 'ephemeral',
            usesPageContext: false,
            shouldPersist: false,
            contextSource: 'none'
        }
    };

    function normalizeChatMode(chatMode) {
        const all = Object.values(CHAT_MODES);
        return all.includes(chatMode) ? chatMode : DEFAULT_CHAT_MODE;
    }

    function getChatModeMeta(chatMode) {
        return CHAT_MODE_META[normalizeChatMode(chatMode)];
    }

    const api = {
        CHAT_MODES,
        DEFAULT_CHAT_MODE,
        CHAT_MODE_META,
        normalizeChatMode,
        getChatModeMeta
    };

    global.WebChatModes = api;
})(typeof self !== 'undefined' ? self : this);
