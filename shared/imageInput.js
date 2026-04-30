/*
 * 对话输入框图片附件控制器：支持粘贴图片、选择图片、预览与移除。
 */
(function (global) {
    const MAX_IMAGES = 4;
    const MAX_SIDE = 1600;
    const MAX_DATA_URL_LENGTH = 1400000;

    function createImageInputController({ container, input, onError } = {}) {
        if (!container || !input) {
            return null;
        }

        const attachments = [];
        const strip = document.createElement('div');
        strip.className = 'image-attachment-strip';
        strip.hidden = true;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'image-attachment-button';
        button.title = '添加图片（也可直接粘贴截图）';
        button.setAttribute('aria-label', '添加图片');
        button.textContent = '🖼';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.multiple = true;
        fileInput.className = 'image-attachment-file';
        fileInput.hidden = true;

        container.classList.add('has-image-input');
        container.insertBefore(strip, input);
        container.insertBefore(button, input);
        container.appendChild(fileInput);

        button.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', async () => {
            await addFiles(Array.from(fileInput.files || []));
            fileInput.value = '';
        });

        input.addEventListener('paste', async (event) => {
            const files = imageFilesFromClipboard(event.clipboardData);
            if (!files.length) return;

            event.preventDefault();
            await addFiles(files);
        });

        async function addFiles(files) {
            const imageFiles = files.filter((file) => file && file.type && file.type.startsWith('image/'));
            if (!imageFiles.length) return;

            for (const file of imageFiles) {
                if (attachments.length >= MAX_IMAGES) {
                    reportError(`最多支持 ${MAX_IMAGES} 张图片。`);
                    break;
                }

                try {
                    const attachment = await fileToAttachment(file);
                    attachments.push(attachment);
                } catch (error) {
                    reportError(error.message || String(error));
                }
            }

            render();
        }

        function render() {
            strip.innerHTML = '';
            strip.hidden = attachments.length === 0;

            for (const attachment of attachments) {
                const item = document.createElement('div');
                item.className = 'image-attachment-preview';
                item.dataset.id = attachment.id;

                const img = document.createElement('img');
                img.src = attachment.dataUrl;
                img.alt = attachment.name || '图片附件';

                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'image-attachment-remove';
                remove.title = '移除图片';
                remove.setAttribute('aria-label', '移除图片');
                remove.textContent = '×';
                remove.addEventListener('click', () => {
                    const index = attachments.findIndex((a) => a.id === attachment.id);
                    if (index >= 0) {
                        attachments.splice(index, 1);
                        render();
                    }
                });

                item.appendChild(img);
                item.appendChild(remove);
                strip.appendChild(item);
            }
        }

        function getAttachments() {
            return attachments.map((attachment) => ({ ...attachment }));
        }

        function clear() {
            attachments.splice(0, attachments.length);
            render();
        }

        function restore(nextAttachments) {
            attachments.splice(0, attachments.length, ...normalizeAttachments(nextAttachments));
            render();
        }

        function consumeAttachments() {
            const copied = getAttachments();
            clear();
            return copied;
        }

        function reportError(message) {
            if (typeof onError === 'function') {
                onError(message);
            } else {
                console.warn('[PageLens AI] 图片附件处理失败:', message);
            }
        }

        return {
            getAttachments,
            consumeAttachments,
            restore,
            clear,
            hasAttachments: () => attachments.length > 0
        };
    }

    function imageFilesFromClipboard(clipboardData) {
        if (!clipboardData) return [];
        const files = [];

        for (const item of Array.from(clipboardData.items || [])) {
            if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }

        if (files.length) return files;
        return Array.from(clipboardData.files || []).filter((file) => file.type?.startsWith('image/'));
    }

    async function fileToAttachment(file) {
        const bitmap = await loadImageFromFile(file);
        const canvas = document.createElement('canvas');
        const { width, height } = fitSize(bitmap.width, bitmap.height, MAX_SIDE);
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0, width, height);

        let dataUrl = '';
        for (const quality of [0.86, 0.76, 0.66]) {
            dataUrl = canvas.toDataURL('image/jpeg', quality);
            if (dataUrl.length <= MAX_DATA_URL_LENGTH) break;
        }

        if (dataUrl.length > MAX_DATA_URL_LENGTH) {
            throw new Error('图片过大，请先裁剪或压缩后再粘贴。');
        }

        return {
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || 'pasted-image.jpg',
            mimeType: 'image/jpeg',
            dataUrl,
            size: Math.ceil(dataUrl.length * 0.75)
        };
    }

    function loadImageFromFile(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('无法读取图片。'));
            };
            img.src = url;
        });
    }

    function fitSize(width, height, maxSide) {
        if (!width || !height) {
            return { width: maxSide, height: maxSide };
        }
        const scale = Math.min(1, maxSide / Math.max(width, height));
        return {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale))
        };
    }

    function normalizeAttachments(list) {
        if (!Array.isArray(list)) return [];
        return list
            .filter((item) => item && typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:image/'))
            .slice(0, MAX_IMAGES)
            .map((item) => ({
                id: item.id || `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: item.name || 'image.jpg',
                mimeType: item.mimeType || mimeTypeFromDataUrl(item.dataUrl) || 'image/jpeg',
                dataUrl: item.dataUrl,
                size: Number(item.size) || 0
            }));
    }

    function renderMessageAttachments(container, attachments) {
        const normalized = normalizeAttachments(attachments);
        if (!container || !normalized.length) return;

        const wrap = document.createElement('div');
        wrap.className = 'message-attachments';
        for (const attachment of normalized) {
            const img = document.createElement('img');
            img.src = attachment.dataUrl;
            img.alt = attachment.name || '图片附件';
            wrap.appendChild(img);
        }
        container.appendChild(wrap);
    }

    function mimeTypeFromDataUrl(dataUrl) {
        const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
        return match ? match[1] : '';
    }

    global.WebChatImageInput = {
        createImageInputController,
        renderMessageAttachments,
        normalizeAttachments,
        MAX_IMAGES
    };
})(typeof self !== 'undefined' ? self : this);
