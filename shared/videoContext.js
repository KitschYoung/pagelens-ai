/*
 * 视频页字幕上下文提取。
 * v1 覆盖 YouTube / B站：优先使用站点字幕，不做音频转写。
 */
(function (global) {
    const PLATFORM_LABELS = {
        youtube: 'YouTube',
        bilibili: 'B站'
    };

    function isSupportedVideoPage() {
        return Boolean(detectPlatform());
    }

    async function extractVideoContext() {
        const platform = detectPlatform();
        if (!platform) {
            return {
                ok: false,
                platform: '',
                title: document.title || '',
                url: location.href,
                currentTime: null,
                duration: null,
                transcript: [],
                markdown: '',
                error: '当前不是支持的视频页面'
            };
        }

        try {
            if (platform === 'youtube') {
                return await extractYouTubeContext();
            }
            return await extractBilibiliContext();
        } catch (error) {
            const video = getPrimaryVideo();
            const context = {
                ok: false,
                platform,
                title: cleanTitle(document.title || ''),
                url: location.href,
                currentTime: readFiniteNumber(video?.currentTime),
                duration: readFiniteNumber(video?.duration),
                transcript: [],
                error: `视频字幕提取失败：${error.message || String(error)}`
            };
            return {
                ...context,
                markdown: formatTranscriptMarkdown(context)
            };
        }
    }

    async function extractYouTubeContext() {
        const playerResponse = parseAssignedJson('ytInitialPlayerResponse') || {};
        const currentVideoId = parseYouTubeVideoId(location.href);
        const responseVideoId = playerResponse.videoDetails?.videoId || '';
        const tracks = playerResponse.captions
            ?.playerCaptionsTracklistRenderer
            ?.captionTracks || [];
        const video = getPrimaryVideo();
        const baseContext = {
            platform: 'youtube',
            title: playerResponse.videoDetails?.title || cleanTitle(document.title || ''),
            url: location.href,
            currentTime: readFiniteNumber(video?.currentTime),
            duration: readFiniteNumber(video?.duration)
                ?? readFiniteNumber(Number(playerResponse.videoDetails?.lengthSeconds)),
            transcript: []
        };

        if (currentVideoId && responseVideoId && currentVideoId !== responseVideoId) {
            return buildNoTranscriptContext(baseContext, '页面脚本中的字幕信息不是当前视频，请刷新页面后重试。');
        }

        if (!tracks.length) {
            return buildNoTranscriptContext(baseContext, '未找到可读取字幕。');
        }

        const track = selectPreferredTrack(tracks, (item) => ({
            languageCode: item.languageCode,
            label: textFromRuns(item.name),
            isAuto: item.kind === 'asr'
        }));

        if (!track?.baseUrl) {
            return buildNoTranscriptContext(baseContext, '字幕轨道缺少下载地址。');
        }

        try {
            const url = withSearchParam(track.baseUrl, 'fmt', 'json3');
            const text = await fetchTextViaBackground(url, 'include');
            const transcript = parseYouTubeJson3(text);
            if (!transcript.length) {
                return buildNoTranscriptContext(baseContext, '字幕文件为空或无法解析。');
            }
            const context = {
                ok: true,
                ...baseContext,
                transcript,
                subtitleLanguage: track.languageCode || '',
                subtitleLabel: textFromRuns(track.name) || track.languageCode || ''
            };
            return {
                ...context,
                markdown: formatTranscriptMarkdown(context)
            };
        } catch (error) {
            return buildNoTranscriptContext(baseContext, `字幕请求失败：${error.message || String(error)}`);
        }
    }

    async function extractBilibiliContext() {
        const state = parseAssignedJson('__INITIAL_STATE__') || {};
        const videoData = state.videoData || {};
        const epInfo = state.epInfo || state.episode || {};
        const urlBvid = parseBvidFromUrl(location.href);
        let stateBvid = state.bvid || videoData.bvid || epInfo.bvid || '';
        let bvid = urlBvid || stateBvid;
        let aid = state.aid || videoData.aid || epInfo.aid || '';
        let cid = state.cid || videoData.cid || epInfo.cid || findCurrentBiliCid(videoData);
        const video = getPrimaryVideo();
        let baseContext = {
            platform: 'bilibili',
            title: videoData.title || state.mediaInfo?.title || cleanTitle(document.title || ''),
            url: location.href,
            currentTime: readFiniteNumber(video?.currentTime),
            duration: readFiniteNumber(video?.duration) ?? readFiniteNumber(videoData.duration),
            transcript: []
        };

        if (urlBvid && stateBvid && urlBvid !== stateBvid) {
            return buildNoTranscriptContext(baseContext, '页面脚本中的 cid 不是当前视频，请刷新页面后重试。');
        }

        if (!cid || (!bvid && !aid)) {
            const detail = await fetchBilibiliVideoDetail({ bvid, aid });
            if (detail) {
                bvid = bvid || detail.bvid || '';
                stateBvid = stateBvid || detail.bvid || '';
                aid = aid || detail.aid || '';
                cid = cid || findCurrentBiliCid(detail) || detail.cid || '';
                baseContext = {
                    ...baseContext,
                    title: detail.title || baseContext.title,
                    duration: baseContext.duration ?? readFiniteNumber(detail.duration)
                };
            }
        }

        if (!cid || (!bvid && !aid)) {
            return buildNoTranscriptContext(baseContext, '未找到视频 cid/bvid，无法读取字幕列表。');
        }

        try {
            const subtitles = await fetchBilibiliSubtitleTracks({ bvid, aid, cid });
            if (!subtitles.length) {
                return buildNoTranscriptContext(baseContext, '未找到可读取字幕。');
            }

            const subtitle = selectPreferredTrack(subtitles, (item) => ({
                languageCode: item.lan,
                label: item.lan_doc || item.ai_type || item.lan,
                isAuto: Boolean(item.ai_type)
            }));
            const subtitleUrl = normalizeSubtitleUrl(subtitle?.subtitle_url);
            if (!subtitleUrl) {
                return buildNoTranscriptContext(baseContext, '字幕轨道缺少下载地址。');
            }

            const subtitleText = await fetchTextViaBackground(subtitleUrl, 'include');
            const transcript = parseBilibiliSubtitleJson(subtitleText);
            if (!transcript.length) {
                return buildNoTranscriptContext(baseContext, '字幕文件为空或无法解析。');
            }

            const context = {
                ok: true,
                ...baseContext,
                transcript,
                subtitleLanguage: subtitle.lan || '',
                subtitleLabel: subtitle.lan_doc || subtitle.lan || ''
            };
            return {
                ...context,
                markdown: formatTranscriptMarkdown(context)
            };
        } catch (error) {
            return buildNoTranscriptContext(baseContext, `字幕请求失败：${error.message || String(error)}`);
        }
    }

    async function fetchBilibiliSubtitleTracks({ bvid, aid, cid }) {
        const localTracks = findBilibiliSubtitleTracksFromPage();
        if (localTracks.length) return localTracks;

        try {
            const wbiPlayerUrl = buildBilibiliWbiPlayerUrl({ bvid, aid, cid });
            const wbiPlayerText = await fetchTextViaBackground(wbiPlayerUrl, 'include');
            const wbiPlayerJson = JSON.parse(wbiPlayerText);
            const wbiPlayerTracks = normalizeBilibiliSubtitleTracks(wbiPlayerJson.data?.subtitle);
            if (wbiPlayerTracks.length) return wbiPlayerTracks;
        } catch (_) {
            // 继续尝试旧播放器接口。
        }

        try {
            const playerUrl = buildBilibiliPlayerUrl({ bvid, aid, cid });
            const playerText = await fetchTextViaBackground(playerUrl, 'include');
            const playerJson = JSON.parse(playerText);
            const playerTracks = normalizeBilibiliSubtitleTracks(playerJson.data?.subtitle);
            if (playerTracks.length) return playerTracks;
        } catch (_) {
            // 继续尝试 ACG助手同款备用接口。
        }

        // ACG助手兼容路径：部分页面在 x/player/v2 没返回字幕时，
        // x/web-interface/view?aid=...&cid=... 仍会带 subtitle 数组。
        if (aid && cid) {
            try {
                const viewUrl = buildBilibiliViewUrl({ aid, cid });
                const viewText = await fetchTextViaBackground(viewUrl, 'include');
                const viewJson = JSON.parse(viewText);
                const viewTracks = normalizeBilibiliSubtitleTracks(viewJson.data?.subtitle);
                if (viewTracks.length) return viewTracks;
            } catch (_) {
                // 由调用方统一返回“未找到字幕”。
            }
        }

        if (aid || bvid) {
            try {
                const detailUrl = buildBilibiliWbiViewDetailUrl({ bvid, aid });
                const detailText = await fetchTextViaBackground(detailUrl, 'include');
                const detailJson = JSON.parse(detailText);
                const detailTracks = normalizeBilibiliSubtitleTracks([
                    detailJson.data?.View?.subtitle,
                    detailJson.data?.subtitle,
                    detailJson.result?.subtitle
                ]);
                if (detailTracks.length) return detailTracks;
            } catch (_) {
                // 由调用方统一返回“未找到字幕”。
            }
        }

        return [];
    }

    async function fetchBilibiliVideoDetail({ bvid, aid }) {
        const id = bvid || aid;
        if (!id) return null;

        try {
            const url = new URL('https://api.bilibili.com/x/web-interface/view');
            if (bvid) {
                url.searchParams.set('bvid', String(bvid));
            } else {
                url.searchParams.set('aid', String(aid));
            }
            const text = await fetchTextViaBackground(url.toString(), 'include');
            const json = JSON.parse(text);
            return json.code === 0 && json.data ? json.data : null;
        } catch (_) {
            return null;
        }
    }

    function findBilibiliSubtitleTracksFromPage() {
        const state = parseAssignedJson('__INITIAL_STATE__') || {};
        const playInfo = parseAssignedJson('__playinfo__') || parseAssignedJson('__PLAYINFO__') || {};
        return [
            ...normalizeBilibiliSubtitleTracks(state.subtitle),
            ...normalizeBilibiliSubtitleTracks(state.videoData?.subtitle),
            ...normalizeBilibiliSubtitleTracks(state.epInfo?.subtitle),
            ...normalizeBilibiliSubtitleTracks(playInfo.data?.subtitle),
            ...findBilibiliSubtitleTracksFromScripts()
        ];
    }

    function normalizeBilibiliSubtitleTracks(raw) {
        const list = collectBilibiliSubtitleTracks(raw);
        const seen = new Set();
        return list
            .filter((item) => item && item.subtitle_url)
            .filter((item) => {
                const key = normalizeSubtitleUrl(item.subtitle_url);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function collectBilibiliSubtitleTracks(raw) {
        if (!raw) return [];
        if (Array.isArray(raw)) {
            return raw.flatMap((item) => collectBilibiliSubtitleTracks(item));
        }
        if (typeof raw !== 'object') return [];
        if (raw.subtitle_url) return [raw];

        return [
            ...collectBilibiliSubtitleTracks(raw.subtitle),
            ...collectBilibiliSubtitleTracks(raw.subtitles),
            ...collectBilibiliSubtitleTracks(raw.list),
            ...collectBilibiliSubtitleTracks(raw.data?.subtitle),
            ...collectBilibiliSubtitleTracks(raw.View?.subtitle),
            ...collectBilibiliSubtitleTracks(raw.result?.subtitle)
        ];
    }

    function findBilibiliSubtitleTracksFromScripts() {
        const tracks = [];
        const scripts = Array.from(document.scripts || []);

        for (const script of scripts) {
            const text = script.textContent || '';
            let index = text.indexOf('subtitle_url');
            while (index >= 0) {
                const jsonText = extractJsonObjectAround(text, index);
                if (jsonText) {
                    try {
                        tracks.push(...normalizeBilibiliSubtitleTracks(JSON.parse(jsonText)));
                    } catch (_) {
                        // 继续查找下一个字幕对象。
                    }
                }
                index = text.indexOf('subtitle_url', index + 12);
            }
        }

        return tracks;
    }

    function detectPlatform() {
        const host = (location.hostname || '').toLowerCase();
        const path = location.pathname || '';

        if ((host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be')
            && (path === '/watch' || path.startsWith('/shorts/') || host === 'youtu.be')) {
            return 'youtube';
        }

        if ((host === 'bilibili.com' || host.endsWith('.bilibili.com'))
            && (path.includes('/video/') || path.includes('/bangumi/play/'))) {
            return 'bilibili';
        }

        return '';
    }

    function buildNoTranscriptContext(baseContext, error) {
        const context = {
            ok: true,
            ...baseContext,
            transcript: [],
            error
        };
        return {
            ...context,
            markdown: formatTranscriptMarkdown(context)
        };
    }

    function formatTranscriptMarkdown(context = {}) {
        const transcript = Array.isArray(context.transcript) ? context.transcript : [];
        const lines = [
            '# 视频字幕内容',
            '',
            `- 标题: ${oneLine(context.title || '未命名视频')}`,
            `- 平台: ${PLATFORM_LABELS[context.platform] || context.platform || '未知平台'}`,
            `- URL: ${context.url || location.href}`,
            `- 当前播放位置: ${formatTime(context.currentTime)}`,
            `- 总时长: ${formatTime(context.duration)}`,
            `- 字幕状态: ${transcript.length ? `已提取 ${transcript.length} 条` : '未找到可读取字幕'}`
        ];

        if (context.subtitleLabel || context.subtitleLanguage) {
            lines.push(`- 字幕语言: ${oneLine(context.subtitleLabel || context.subtitleLanguage)}`);
        }
        if (context.error) {
            lines.push(`- 提取说明: ${oneLine(context.error)}`);
        }

        lines.push('', '## 字幕正文', '');

        if (!transcript.length) {
            lines.push('（未找到可读取字幕；当前上下文只包含视频元信息，不包含评论、推荐或页面正文。）');
            return lines.join('\n');
        }

        for (const item of transcript) {
            lines.push(`[${formatTime(item.start)}] ${item.text}`);
        }
        return lines.join('\n');
    }

    function parseAssignedJson(name) {
        const scripts = Array.from(document.scripts || []);
        for (const script of scripts) {
            const text = script.textContent || '';
            let index = text.indexOf(name);

            while (index >= 0) {
                const jsonText = extractJsonObjectAfter(text, index + name.length);
                if (jsonText) {
                    try {
                        return JSON.parse(jsonText);
                    } catch (_) {
                        // 继续查找同一脚本里的下一个同名变量片段。
                    }
                }

                index = text.indexOf(name, index + name.length);
            }
        }
        return null;
    }

    function extractJsonObjectAfter(text, fromIndex) {
        const start = text.indexOf('{', fromIndex);
        if (start < 0) return '';

        let depth = 0;
        let inString = false;
        let quote = '';
        let escaped = false;

        for (let i = start; i < text.length; i += 1) {
            const ch = text[i];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (ch === '\\') {
                    escaped = true;
                } else if (ch === quote) {
                    inString = false;
                    quote = '';
                }
                continue;
            }

            if (ch === '"' || ch === "'") {
                inString = true;
                quote = ch;
            } else if (ch === '{') {
                depth += 1;
            } else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    return text.slice(start, i + 1);
                }
            }
        }

        return '';
    }

    function extractJsonObjectAround(text, index) {
        const start = text.lastIndexOf('{', index);
        if (start < 0) return '';

        let depth = 0;
        let inString = false;
        let quote = '';
        let escaped = false;

        for (let i = start; i < text.length; i += 1) {
            const ch = text[i];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (ch === '\\') {
                    escaped = true;
                } else if (ch === quote) {
                    inString = false;
                    quote = '';
                }
                continue;
            }

            if (ch === '"' || ch === "'") {
                inString = true;
                quote = ch;
            } else if (ch === '{') {
                depth += 1;
            } else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    return text.slice(start, i + 1);
                }
            }
        }

        return '';
    }

    function selectPreferredTrack(items, read) {
        const browserLang = (navigator.language || '').toLowerCase();
        const browserBase = browserLang.split('-')[0];

        return [...items].sort((a, b) => {
            const ar = read(a);
            const br = read(b);
            return trackScore(ar, browserLang, browserBase) - trackScore(br, browserLang, browserBase);
        })[0] || null;
    }

    function trackScore(track, browserLang, browserBase) {
        const lang = String(track.languageCode || '').toLowerCase();
        const label = String(track.label || '').toLowerCase();
        let score = 30;

        if (lang.startsWith('zh') || /中文|chinese|国语|普通话|简体|繁体/.test(label)) {
            score = 0;
        } else if (browserLang && (lang === browserLang || lang.startsWith(`${browserBase}-`) || lang === browserBase)) {
            score = 10;
        } else if (lang.startsWith('en') || /english|英语/.test(label)) {
            score = 20;
        }

        return score + (track.isAuto ? 1 : 0);
    }

    function parseYouTubeJson3(text) {
        const data = JSON.parse(text);
        const events = Array.isArray(data.events) ? data.events : [];
        const transcript = [];

        for (const event of events) {
            const raw = (event.segs || []).map((seg) => seg.utf8 || '').join('');
            const cleaned = normalizeCaptionText(raw);
            if (!cleaned) continue;
            transcript.push({
                start: readFiniteNumber(Number(event.tStartMs) / 1000) ?? 0,
                end: readFiniteNumber((Number(event.tStartMs) + Number(event.dDurationMs || 0)) / 1000),
                text: cleaned
            });
        }

        return transcript;
    }

    function parseBilibiliSubtitleJson(text) {
        const data = JSON.parse(text);
        const body = Array.isArray(data.body) ? data.body : [];
        return body
            .map((item) => ({
                start: readFiniteNumber(item.from) ?? 0,
                end: readFiniteNumber(item.to),
                text: normalizeCaptionText(item.content || '')
            }))
            .filter((item) => item.text);
    }

    function normalizeCaptionText(text) {
        return decodeEntities(String(text || ''))
            .replace(/\s+/g, ' ')
            .trim();
    }

    function decodeEntities(text) {
        try {
            const textarea = document.createElement('textarea');
            textarea.innerHTML = text;
            return textarea.value;
        } catch (_) {
            return text
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'");
        }
    }

    function textFromRuns(value) {
        if (!value) return '';
        if (typeof value === 'string') return value;
        if (value.simpleText) return value.simpleText;
        if (Array.isArray(value.runs)) {
            return value.runs.map((run) => run.text || '').join('');
        }
        return '';
    }

    function withSearchParam(rawUrl, key, value) {
        try {
            const url = new URL(rawUrl);
            url.searchParams.set(key, value);
            return url.toString();
        } catch (_) {
            const sep = rawUrl.includes('?') ? '&' : '?';
            return `${rawUrl}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        }
    }

    function fetchTextViaBackground(url, credentials = 'omit') {
        return new Promise((resolve, reject) => {
            try {
                if (shouldFetchFromPage(url, credentials)) {
                    fetch(url, { credentials: 'include' })
                        .then((resp) => {
                            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                            return resp.text();
                        })
                        .then(resolve)
                        .catch(() => {
                            fetchTextViaExtension(url, credentials).then(resolve).catch(reject);
                        });
                    return;
                }

                fetchTextViaExtension(url, credentials).then(resolve).catch(reject);
            } catch (error) {
                reject(error);
            }
        });
    }

    function fetchTextViaExtension(url, credentials = 'omit') {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage({ action: 'fetchText', url, credentials }, (resp) => {
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        reject(new Error(lastError.message));
                        return;
                    }
                    if (!resp || resp.status !== 'ok') {
                        reject(new Error(resp?.error || 'fetchText failed'));
                        return;
                    }
                    resolve(resp.text || '');
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    function shouldFetchFromPage(url, credentials) {
        try {
            const target = new URL(url);
            const host = (location.hostname || '').toLowerCase();
            return credentials === 'include'
                && (host === 'bilibili.com' || host.endsWith('.bilibili.com'))
                && target.hostname === 'api.bilibili.com';
        } catch (_) {
            return false;
        }
    }

    function findCurrentBiliCid(videoData) {
        const pages = Array.isArray(videoData.pages) ? videoData.pages : [];
        const pageParam = Number(new URLSearchParams(location.search).get('p') || '1');
        return pages[Math.max(0, pageParam - 1)]?.cid || pages[0]?.cid || '';
    }

    function buildBilibiliPlayerUrl({ bvid, aid, cid }) {
        const url = new URL('https://api.bilibili.com/x/player/v2');
        url.searchParams.set('cid', String(cid));
        if (bvid) {
            url.searchParams.set('bvid', String(bvid));
        } else {
            url.searchParams.set('aid', String(aid));
        }
        return url.toString();
    }

    function buildBilibiliWbiPlayerUrl({ bvid, aid, cid }) {
        const url = new URL('https://api.bilibili.com/x/player/wbi/v2');
        url.searchParams.set('cid', String(cid));
        if (bvid) {
            url.searchParams.set('bvid', String(bvid));
        }
        if (aid) {
            url.searchParams.set('aid', String(aid));
        }
        return url.toString();
    }

    function buildBilibiliViewUrl({ aid, cid }) {
        const url = new URL('https://api.bilibili.com/x/web-interface/view');
        url.searchParams.set('aid', String(aid));
        url.searchParams.set('cid', String(cid));
        return url.toString();
    }

    function buildBilibiliWbiViewDetailUrl({ bvid, aid }) {
        const url = new URL('https://api.bilibili.com/x/web-interface/wbi/view/detail');
        if (bvid) {
            url.searchParams.set('bvid', String(bvid));
        } else if (aid) {
            url.searchParams.set('aid', String(aid));
        }
        url.searchParams.set('p', String(Math.max(1, Number(new URLSearchParams(location.search).get('p') || '1'))));
        return url.toString();
    }

    function normalizeSubtitleUrl(rawUrl) {
        if (!rawUrl) return '';
        if (rawUrl.startsWith('//')) return `https:${rawUrl}`;
        if (rawUrl.startsWith('/')) return `https://www.bilibili.com${rawUrl}`;
        return rawUrl;
    }

    function parseBvidFromUrl(rawUrl) {
        const match = String(rawUrl || '').match(/\/video\/([Bb][Vv][0-9A-Za-z]+)/);
        return match ? match[1] : '';
    }

    function parseYouTubeVideoId(rawUrl) {
        try {
            const url = new URL(rawUrl);
            if (url.hostname === 'youtu.be') {
                return url.pathname.split('/').filter(Boolean)[0] || '';
            }
            if (url.pathname.startsWith('/shorts/')) {
                return url.pathname.split('/').filter(Boolean)[1] || '';
            }
            return url.searchParams.get('v') || '';
        } catch (_) {
            return '';
        }
    }

    function getPrimaryVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        return videos.find((video) => !video.paused) || videos[0] || null;
    }

    function readFiniteNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function formatTime(seconds) {
        const n = readFiniteNumber(seconds);
        if (n === null) return '未知';

        const total = Math.max(0, Math.floor(n));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (v) => String(v).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    function cleanTitle(title) {
        return String(title || '')
            .replace(/\s*-\s*YouTube\s*$/i, '')
            .replace(/\s*_\s*哔哩哔哩_bilibili\s*$/i, '')
            .trim();
    }

    function oneLine(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    global.WebChatVideo = {
        isSupportedVideoPage,
        extractVideoContext,
        formatTranscriptMarkdown
    };
})(typeof self !== 'undefined' ? self : this);
