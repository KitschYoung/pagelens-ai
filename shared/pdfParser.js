/*
 * PDF 内容抽取
 * 在 Chrome 原生 PDF 阅读器（<embed>）以及任何 Content-Type 为 application/pdf 的页面里，
 * content script 拿不到文本——这里直接 fetch(location.href) 拿二进制，再用 pdf.js 抽文本。
 *
 * 暴露：self.WebChatPdf = { isPdfPage(), parsePdfContent() }
 *   - parsePdfContent() 返回 Markdown 字符串；非 PDF / 解析失败时返回 ''
 *   - 同 URL 缓存解析结果，避免每次提问都重新下载 / 解析
 */
(function (global) {
    const CACHE = new Map(); // url -> { markdown, parsedAt }
    const CACHE_TTL_MS = 30 * 60 * 1000;

    function isPdfPage() {
        try {
            if (document.contentType === 'application/pdf') return true;
        } catch (_) { /* 某些上下文没有 contentType */ }

        const url = (location && location.href) || '';
        if (/\.pdf(\?|#|$)/i.test(url)) return true;

        // Chrome 原生 PDF viewer 会把 body 里塞一个 <embed type="application/pdf">
        const embed = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
        if (embed) return true;

        return false;
    }

    function ensurePdfJsReady() {
        const lib = global.pdfjsLib;
        if (!lib) {
            throw new Error('pdf.js 未加载');
        }
        if (!lib.GlobalWorkerOptions.workerSrc) {
            // chrome.runtime.getURL 在 content script 上下文可用
            try {
                lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
            } catch (e) {
                // 极少数环境拿不到 worker，退化到主线程模式
                lib.GlobalWorkerOptions.workerSrc = '';
            }
        }
        return lib;
    }

    function base64ToArrayBuffer(b64) {
        const binary = atob(b64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    async function fetchPdfBytesViaBackground(url) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage({ action: 'fetchPdfBytes', url }, (resp) => {
                    const err = chrome.runtime.lastError;
                    if (err) { reject(new Error(err.message)); return; }
                    if (!resp || resp.status !== 'ok') {
                        reject(new Error((resp && resp.error) || '后台下载 PDF 失败'));
                        return;
                    }
                    try {
                        resolve(base64ToArrayBuffer(resp.base64));
                    } catch (e) {
                        reject(e);
                    }
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    async function fetchPdfBytes(url) {
        // 1) 优先用 content script 自身的 fetch（http/https 一般直接成功）
        // 2) 失败再走 background service worker（Chrome 原生 PDF 阅读器、file:// 多数情况只能这条路）
        //    - 本地 file:// 需要用户在 chrome://extensions 里给扩展打开"允许访问文件网址"
        try {
            const resp = await fetch(url, { credentials: 'include' });
            if (resp.ok) return await resp.arrayBuffer();
            throw new Error(`HTTP ${resp.status}`);
        } catch (directErr) {
            try {
                return await fetchPdfBytesViaBackground(url);
            } catch (bgErr) {
                throw new Error(`下载 PDF 失败：${directErr.message || directErr} / 后台回退：${bgErr.message || bgErr}`);
            }
        }
    }

    async function extractMarkdown(pdfDoc) {
        const numPages = pdfDoc.numPages;
        const pages = [];
        for (let p = 1; p <= numPages; p += 1) {
            const page = await pdfDoc.getPage(p);
            const tc = await page.getTextContent();
            // 尽量按行重组：pdf.js 的 item 顺序基本是阅读顺序，按 transform 的 y 坐标判断换行
            let lastY = null;
            const lineParts = [];
            for (const item of tc.items) {
                if (!item || !item.str) continue;
                const y = Array.isArray(item.transform) ? item.transform[5] : null;
                if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
                    lineParts.push('\n');
                }
                lineParts.push(item.str);
                if (item.hasEOL) lineParts.push('\n');
                lastY = y;
            }
            const pageText = lineParts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
            if (pageText) {
                pages.push(`## Page ${p}\n\n${pageText}`);
            }
            // 主动释放 pdf.js 内部缓存
            page.cleanup();
        }
        return pages.join('\n\n');
    }

    async function parsePdfContent() {
        if (!isPdfPage()) return '';

        const url = location.href;
        const cached = CACHE.get(url);
        if (cached && (Date.now() - cached.parsedAt) < CACHE_TTL_MS) {
            return cached.markdown;
        }

        try {
            const lib = ensurePdfJsReady();
            const bytes = await fetchPdfBytes(url);
            const loadingTask = lib.getDocument({
                data: bytes,
                // 关闭可执行字体，避免 worker 在严格 CSP 下报错
                disableFontFace: true,
                isEvalSupported: false
            });
            const pdfDoc = await loadingTask.promise;

            let header = '';
            try {
                const meta = await pdfDoc.getMetadata();
                const title = meta?.info?.Title || document.title || '';
                if (title) header = `# ${title}\n\n`;
            } catch (_) { /* 元数据可选 */ }
            header += `_PDF · 共 ${pdfDoc.numPages} 页 · ${url}_\n\n`;

            const body = await extractMarkdown(pdfDoc);
            const markdown = body ? (header + body) : '';

            try { await pdfDoc.cleanup(); } catch (_) { /* noop */ }
            try { await pdfDoc.destroy(); } catch (_) { /* noop */ }

            CACHE.set(url, { markdown, parsedAt: Date.now() });
            return markdown;
        } catch (error) {
            console.warn('[PageLens AI] PDF 解析失败:', error);
            const isFile = url.startsWith('file://');
            const hint = isFile
                ? '\n\n> 提示：本地 PDF 需要在 `chrome://extensions` 里给本扩展打开"允许访问文件网址"。'
                : '';
            return `# PDF 解析失败\n\n无法从当前 PDF 中抽取文本：${error.message || error}${hint}`;
        }
    }

    global.WebChatPdf = { isPdfPage, parsePdfContent };
})(typeof self !== 'undefined' ? self : this);
