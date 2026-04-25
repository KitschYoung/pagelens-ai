// API类型的默认配置
const API_CONFIGS = {
    custom: {
        apiBase: '',
        modelPlaceholder: '例如：gpt-4.1-mini',
        requiresKey: true,
        apiBasePlaceholder: '例如：https://your-openai-compatible-endpoint/v1/chat/completions',
        apiKeyPlaceholder: '请输入API密钥',
        modelHelp: '填写你所使用的模型标识，例如：gpt-4.1-mini'
    },
    ollama: {
        apiBase: 'http://127.0.0.1:11434/api/chat',
        modelPlaceholder: 'qwen2.5',
        requiresKey: false,
        apiBasePlaceholder: 'http://127.0.0.1:11434/api/chat',
        apiKeyPlaceholder: '本地模型无需API密钥',
        modelHelp: '常用模型：qwen2.5, llama2, mistral, gemma, codellama等。使用前请确保已安装模型：ollama pull qwen2.5'
    },
    anthropic: {
        apiBase: 'https://api.anthropic.com/v1/messages',
        modelPlaceholder: 'claude-sonnet-4-5',
        requiresKey: true,
        apiBasePlaceholder: 'https://api.anthropic.com/v1/messages',
        apiKeyPlaceholder: '请输入 Anthropic API Key (sk-ant-...)',
        modelHelp: '示例：claude-sonnet-4-5 / claude-opus-4-1 / claude-haiku-4-5。会自动在 page 内容上打 cache_control 命中 Anthropic prompt caching（90% off）。'
    }
};

const FLOATING_ICON_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_FLOATING_ICON_SVG = `
    <svg class="icon" width="24" height="24" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
        <path d="M200 935.744a39.517867 39.517867 0 0 1-14.122667-7.185067c-12.906667-10.295467-18.602667-27.2896-14.741333-43.4688a1295.863467 1295.863467 0 0 0 17.207467-520c-5.6448-33.216 0.418133-66.760533 17.5488-96.443733 17.156267-29.563733 43.498667-51.648 75.656533-60.497067h0.008533l417.591467-114.24c66.0352-19.434667 144.533333 49.792 162.602667 156.258134a1978.666667 1978.666667 0 0 1 27.144533 397.806933c-3.4432 107.592533-71.6928 186.248533-139.758933 176.008533l-64.823467-8.494933c-22.203733-3.042133-36.8768-29.952-33.8944-60.1984 3.008-30.2336 22.664533-53.713067 45.038933-52.343467 21.7472 1.463467 43.485867 2.922667 65.233067 4.3776 24.170667 1.783467 45.969067-26.0096 47.133867-62.007466a1897.941333 1897.941333 0 0 0-26.030934-381.499734c-6.062933-35.618133-31.466667-60.3136-55.168-55.2576l-424.0128 87.466667c-11.4176 2.363733-21.1584 9.570133-27.6096 20.078933-6.4512 10.530133-8.802133 22.993067-6.698666 35.345067a1377.0368 1377.0368 0 0 1 2.346666 449.117867 1341.696 1341.696 0 0 0 118.4512-104.448c8.251733-8.1792 18.862933-12.475733 29.602134-11.758934l293.009066 19.6736c22.340267 1.365333 38.839467 28.650667 35.639467 60.842667-3.1744 32.200533-24.704 55.765333-46.882133 52.7232l-274.5216-35.972267c-62.229333 57.1136-127.6544 106.965333-194.973867 149.384534-9.629867 6.071467-20.8 7.522133-30.976 4.731733z" fill="white"></path>
        <path d="M635.733333 488.533333m-59.733333 0a59.733333 59.733333 0 1 0 119.466667 0 59.733333 59.733333 0 1 0-119.466667 0Z" fill="white"></path>
        <path d="M460.864 507.733333m-50.133333 0a50.133333 50.133333 0 1 0 100.266666 0 50.133333 50.133333 0 1 0-100.266666 0Z" fill="white"></path>
    </svg>
`;

// 校验字符串是否全为可用作 HTTP header 的 ASCII（排除控制字符）
function assertHeaderSafe(value, fieldName) {
    if (!value) return;
    // 允许空格到 ~ (0x20..0x7E)
    if (!/^[\x20-\x7E]+$/.test(value)) {
        const bad = [...value].find((ch) => ch.charCodeAt(0) > 0x7E || ch.charCodeAt(0) < 0x20);
        throw new Error(
            `${fieldName} 里包含非 ASCII 字符（"${bad}"，码点 U+${bad.charCodeAt(0).toString(16).toUpperCase()}）。` +
            `常见原因：从微信/聊天工具复制时带入了"智能引号"或不可见字符。请清空重新粘贴。`
        );
    }
}

// 测试API配置
async function testApiConfig(settings) {
    try {
        // 预检：apiKey / apiBase / model 不能有非 ASCII 字符（HTTP header/URL 要求）
        assertHeaderSafe(settings.apiKey, 'API 密钥');
        assertHeaderSafe(settings.apiBase, '请求 URL');
        assertHeaderSafe(settings.model, '模型名');

        // 设置基础headers
        let headers = {
            'Content-Type': 'application/json'
        };

        // 按 API 类型配置认证头
        if (settings.apiType === 'custom') {
            if (!settings.apiKey) {
                throw new Error('API密钥是必填项');
            }
            headers['Authorization'] = `Bearer ${settings.apiKey}`;
        } else if (settings.apiType === 'anthropic') {
            if (!settings.apiKey) {
                throw new Error('Anthropic API Key 是必填项');
            }
            headers['x-api-key'] = settings.apiKey;
            headers['anthropic-version'] = '2023-06-01';
            headers['anthropic-dangerous-direct-browser-access'] = 'true';
        }

        let requestBody;
        if (settings.apiType === 'ollama') {
            requestBody = {
                model: settings.model,
                messages: [
                    { role: "system", content: "你是一个帮助理解网页内容的AI助手。" },
                    { role: "user", content: "这是一条测试消息，请回复：API配置测试成功" }
                ],
                stream: false,
                options: { temperature: settings.temperature || 0.7, num_predict: 50 }
            };
        } else if (settings.apiType === 'anthropic') {
            requestBody = {
                model: settings.model,
                max_tokens: 50,
                temperature: 0.7,
                stream: false,
                system: '你是一个帮助理解网页内容的AI助手。',
                messages: [
                    { role: 'user', content: '这是一条测试消息，请回复：API配置测试成功' }
                ]
            };
        } else {
            requestBody = {
                model: settings.model,
                messages: [
                    { role: "system", content: "你是一个帮助理解网页内容的AI助手。" },
                    { role: "user", content: "这是一条测试消息，请回复：API配置测试成功" }
                ],
                max_tokens: 50,
                temperature: 0.7,
                stream: false
            };
        }

        const response = await fetch(settings.apiBase, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            try {
                const errorJson = JSON.parse(errorText);
                throw new Error(errorJson.error?.message || '请求失败');
            } catch (e) {
                if (settings.apiType === 'ollama') {
                    throw new Error(
                        `无法连接到Ollama服务。请检查：\n` +
                        `1. Ollama是否已正确安装\n` +
                        `2. 服务是否已启动：\n` +
                        `   OLLAMA_ORIGINS=* ollama serve\n` +
                        `3. 服务地址是否正确(默认：http://127.0.0.1:11434)\n` +
                        `4. 是否允许跨域请求(OLLAMA_ORIGINS=*)\n` +
                        `5. 是否已安装所需的模型：ollama pull ${settings.model}\n` +
                        `6. 如果问题持续，可以尝试重启Ollama服务`
                    );
                }
                throw new Error(`请求失败: ${errorText}`);
            }
        }

        const data = await response.json();

        // 根据不同的API类型验证响应
        if (settings.apiType === 'ollama') {
            if (data.error) throw new Error(data.error);
            if (!data.message || !data.message.content) {
                throw new Error('无效的API响应格式');
            }
        } else if (settings.apiType === 'anthropic') {
            if (!data.content || !Array.isArray(data.content) || data.content.length === 0) {
                throw new Error('无效的 Anthropic 响应格式');
            }
        } else {
            if (!data.choices || !data.choices[0].message) {
                throw new Error('无效的API响应格式');
            }
        }

        return true;
    } catch (error) {
        if (error.message.includes('Failed to fetch') && settings.apiType === 'ollama') {
            throw new Error(
                `无法连接到Ollama服务。请检查：\n` +
                `1. Ollama是否已正确安装\n` +
                `2. 服务是否已启动：\n` +
                `   OLLAMA_ORIGINS=* ollama serve\n` +
                `3. 服务地址是否正确(默认：http://127.0.0.1:11434)\n` +
                `4. 是否允许跨域请求(OLLAMA_ORIGINS=*)\n` +
                `5. 是否已安装所需的模型：ollama pull ${settings.model}\n` +
                `6. 如果问题持续，可以尝试重启Ollama服务`
            );
        }
        throw new Error(`API测试失败: ${error.message}`);
    }
}

function buildHealthUrl(endpoint) {
    try {
        const url = new URL(endpoint);
        url.pathname = '/health';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch (error) {
        throw new Error('日志服务地址格式无效');
    }
}

async function testSessionLogConfig(settings) {
    if (!settings.enableSessionLogging) {
        return true;
    }

    if (!settings.sessionLogEndpoint.trim()) {
        throw new Error('日志服务地址是必填项');
    }

    if (!settings.sessionLogOutputDir.trim()) {
        throw new Error('日志输出目录是必填项');
    }

    const response = await fetch(buildHealthUrl(settings.sessionLogEndpoint), {
        method: 'GET'
    });

    if (!response.ok) {
        throw new Error(`日志服务不可用: HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.ok) {
        throw new Error(data.error || '日志服务状态异常');
    }

    return true;
}

// 更新界面显示
function updateApiTypeUI(apiType) {
    const config = API_CONFIGS[apiType];
    const apiKeyGroup = document.querySelector('.api-key-group');
    const apiBaseInput = document.getElementById('apiBase');
    const modelInput = document.getElementById('model');
    const apiKeyInput = document.getElementById('apiKey');

    // 从存储中加载当前API类型的配置
    chrome.storage.sync.get({
        [`${apiType}_apiKey`]: '',
        [`${apiType}_apiBase`]: apiType === 'custom' ? DEFAULT_SETTINGS.custom_apiBase : config.apiBase,
        [`${apiType}_model`]: apiType === 'custom' ? DEFAULT_SETTINGS.custom_model : config.modelPlaceholder,
    }, (items) => {
        // 更新API密钥输入框
        apiKeyGroup.style.display = config.requiresKey ? 'block' : 'none';
        apiKeyInput.placeholder = config.apiKeyPlaceholder;
        apiKeyInput.value = items[`${apiType}_apiKey`];

        // 更新API请求URL输入框
        apiBaseInput.value = items[`${apiType}_apiBase`];
        apiBaseInput.placeholder = config.apiBasePlaceholder;
        const baseHelp = apiType === 'ollama'
            ? '本地 API 接口地址'
            : apiType === 'anthropic'
                ? 'Anthropic v1/messages 端点（官方：https://api.anthropic.com/v1/messages）；浏览器直连会带 anthropic-dangerous-direct-browser-access 头'
                : 'API 接口地址';
        document.getElementById('apiBaseHelp').textContent = baseHelp;

        // 更新模型输入框
        modelInput.value = items[`${apiType}_model`];
        modelInput.placeholder = config.modelPlaceholder;
        document.getElementById('modelHelp').textContent = config.modelHelp;
    });
}

// 显示状态消息
function showStatus(message, type = 'success') {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = `status ${type}`; // type可以是 'success', 'error', 或 'warning'
    status.style.display = 'block';

    // 只有在显示"正在测试API配置..."的临时消息时才自动隐藏
    if (message === '正在测试API配置...') {
        setTimeout(() => {
            // 确保还是显示的同一条消息时才隐藏
            if (status.textContent === message) {
                status.style.display = 'none';
            }
        }, 2000);
    }
}

function setFloatingIconPreview(dataUrl) {
    const preview = document.getElementById('floatingIconPreview');
    if (!preview) return;
    preview.innerHTML = dataUrl
        ? `<img src="${dataUrl}" alt="">`
        : DEFAULT_FLOATING_ICON_SVG;
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
    });
}

// 验证设置
function validateSettings(settings) {
    const config = API_CONFIGS[settings.apiType];

    if (!settings.apiBase.trim()) {
        throw new Error('请求URL是必填项');
    }
    if (!settings.model.trim()) {
        throw new Error('AI模型是必填项');
    }
    if (config.requiresKey && !settings.apiKey.trim()) {
        throw new Error('API密钥是必填项');
    }
}

// 验证数值范围（添加对小数的支持）
function validateNumberInput(input, min, max, isFloat = false) {
    // 对于浮点数，先检查是否是有效的数字格式
    if (isFloat) {
        // 允许输入中包含小数点
        if (input.value === '.' || input.value === '') {
            return true; // 允许继续输入
        }
        const value = parseFloat(input.value);
        if (isNaN(value)) {
            input.classList.add('invalid');
            showStatus(`请输入有效的数字`, true);
            return false;
        }
        if (value < min || value > max) {
            input.classList.add('invalid');
            showStatus(`请输入${min}~${max}之间的数值`, true);
            return false;
        }
    } else {
        const value = parseInt(input.value);
        if (isNaN(value) || value < min || value > max) {
            input.classList.add('invalid');
            showStatus(`请输入${min}~${max}之间的数值`, true);
            return false;
        }
    }

    // 验证通过，移除错误状态和提示
    input.classList.remove('invalid');
    const status = document.getElementById('status');
    if (status.classList.contains('error')) {
        status.style.display = 'none';
    }
    return true;
}

// 更新温度显示
function updateTemperatureDisplay(value) {
    document.getElementById('temperatureRange').value = value;
    document.getElementById('temperatureInput').value = value;
}

// 更新最大回复长度显示
function updateMaxTokensDisplay(value) {
    document.getElementById('maxTokensRange').value = value;
    document.getElementById('maxTokensInput').value = value;
}

// 保存而不测试：验证必填项后直接写入存储
async function saveOptionsWithoutTest() {
    const apiType = document.getElementById('apiType').value;
    const settings = buildSettingsFromForm(apiType);
    try {
        validateSettings({
            apiType,
            apiKey: settings[`${apiType}_apiKey`],
            apiBase: settings[`${apiType}_apiBase`],
            model: settings[`${apiType}_model`]
        });
        await chrome.storage.sync.set(settings);
        showStatus('✅ 已保存（未测试）。若后续对话报错再回来排查');
    } catch (error) {
        showStatus(error.message, 'error');
    }
}

// 把表单字段打包成 settings 对象（saveOptions 与 saveOptionsWithoutTest 共用）
function buildSettingsFromForm(apiType) {
    const settings = {
        apiType,
        maxTokens: parseInt(document.getElementById('maxTokensInput').value),
        temperature: parseFloat(document.getElementById('temperatureInput').value),
        enableSessionLogging: document.getElementById('enableSessionLogging').checked,
        sessionLogEndpoint: document.getElementById('sessionLogEndpoint').value.trim() || DEFAULT_SETTINGS.sessionLogEndpoint,
        sessionLogOutputDir: document.getElementById('sessionLogOutputDir').value.trim() || DEFAULT_SETTINGS.sessionLogOutputDir,
        sessionLogWorkspaceRoot: document.getElementById('sessionLogWorkspaceRoot').value.trim() || DEFAULT_SETTINGS.sessionLogWorkspaceRoot,
        sessionIdleMinutes: parseInt(document.getElementById('sessionIdleMinutes').value, 10) || DEFAULT_SETTINGS.sessionIdleMinutes,
        [`${apiType}_apiKey`]: document.getElementById('apiKey').value.trim(),
        [`${apiType}_apiBase`]: apiType === 'custom'
            ? document.getElementById('apiBase').value.trim()
            : (document.getElementById('apiBase').value.trim() || API_CONFIGS[apiType].apiBase),
        [`${apiType}_model`]: document.getElementById('model').value.trim()
    };
    settings.activeConfig = {
        apiKey: settings[`${apiType}_apiKey`],
        apiBase: settings[`${apiType}_apiBase`],
        model: settings[`${apiType}_model`]
    };
    return settings;
}

// 保存设置到Chrome存储
async function saveOptions() {
    const apiType = document.getElementById('apiType').value;
    const settings = {
        apiType,
        maxTokens: parseInt(document.getElementById('maxTokensInput').value),
        temperature: parseFloat(document.getElementById('temperatureInput').value),
        enableSessionLogging: document.getElementById('enableSessionLogging').checked,
        sessionLogEndpoint: document.getElementById('sessionLogEndpoint').value.trim() || DEFAULT_SETTINGS.sessionLogEndpoint,
        sessionLogOutputDir: document.getElementById('sessionLogOutputDir').value.trim() || DEFAULT_SETTINGS.sessionLogOutputDir,
        sessionLogWorkspaceRoot: document.getElementById('sessionLogWorkspaceRoot').value.trim() || DEFAULT_SETTINGS.sessionLogWorkspaceRoot,
        sessionIdleMinutes: parseInt(document.getElementById('sessionIdleMinutes').value, 10) || DEFAULT_SETTINGS.sessionIdleMinutes,
        // 存储当前API类型的配置
        [`${apiType}_apiKey`]: document.getElementById('apiKey').value.trim(),
        [`${apiType}_apiBase`]: apiType === 'custom'
            ? document.getElementById('apiBase').value.trim()
            : (document.getElementById('apiBase').value.trim() || API_CONFIGS[apiType].apiBase),
        [`${apiType}_model`]: document.getElementById('model').value.trim()
    };

    // 添加当前活动的配置到settings中
    settings.activeConfig = {
        apiKey: settings[`${apiType}_apiKey`],
        apiBase: settings[`${apiType}_apiBase`],
        model: settings[`${apiType}_model`]
    };

    try {
        // 验证必填项
        validateSettings({
            apiType,
            apiKey: settings[`${apiType}_apiKey`],
            apiBase: settings[`${apiType}_apiBase`],
            model: settings[`${apiType}_model`]
        });

        // 先保存（保证即使测试失败也有持久化，避免白填）
        await chrome.storage.sync.set(settings);
        showStatus('设置已保存，正在测试...');

        // 测试 API（options 页的 fetch 受 CORS 约束，而实际对话走 service worker；
        // 所以 options 页测试失败不代表扩展不能用）
        const testResults = [];
        try {
            await testApiConfig({
                apiType,
                apiKey: settings[`${apiType}_apiKey`],
                apiBase: settings[`${apiType}_apiBase`],
                model: settings[`${apiType}_model`]
            });
            testResults.push('✅ API 配置测试通过');
        } catch (e) {
            testResults.push(
                `⚠️ API 测试未通过（${e.message}）\n` +
                `注意：设置页的测试受浏览器 CORS 限制，实际对话走扩展后台（不受限），` +
                `所以这里失败不代表真的用不了。回到网页直接试一下对话即可。`
            );
        }

        try {
            await testSessionLogConfig(settings);
            testResults.push('✅ 日志服务测试通过');
        } catch (e) {
            if (settings.enableSessionLogging) {
                testResults.push(`⚠️ 日志服务不可用（${e.message}），会先进队列待补写`);
            }
        }

        const allOk = testResults.every((r) => r.startsWith('✅'));
        showStatus(testResults.join('\n\n'), allOk ? 'success' : 'warning');
    } catch (error) {
        // 验证失败（必填项缺失）不保存
        showStatus(error.message, 'error');
    }
}

// 从Chrome存储加载设置
function loadOptions() {
    chrome.storage.sync.get({
        apiType: 'custom',
        maxTokens: 2048,
        temperature: 0.7,
        // 自定义API的默认配置
        custom_apiKey: '',
        custom_apiBase: '',
        custom_model: '',
        // ollama的默认配置
        ollama_apiKey: '',
        ollama_apiBase: API_CONFIGS.ollama.apiBase,
        ollama_model: API_CONFIGS.ollama.modelPlaceholder,
        enableSessionLogging: true,
        sessionLogEndpoint: 'http://127.0.0.1:8765/log-session',
        sessionLogOutputDir: '~/pagelens-session-logs',
        sessionLogWorkspaceRoot: '~/pagelens-workspace',
        sessionIdleMinutes: 30
    }, (items) => {
        document.getElementById('apiType').value = items.apiType;
        document.getElementById('enableSessionLogging').checked = items.enableSessionLogging;
        document.getElementById('sessionLogEndpoint').value = items.sessionLogEndpoint;
        document.getElementById('sessionLogOutputDir').value = items.sessionLogOutputDir;
        document.getElementById('sessionLogWorkspaceRoot').value = items.sessionLogWorkspaceRoot;
        document.getElementById('sessionIdleMinutes').value = items.sessionIdleMinutes;
        document.getElementById('sessionLogSettings').style.display = items.enableSessionLogging ? 'block' : 'none';

        // 确保正确更新maxTokens显示
        const maxTokensRange = document.getElementById('maxTokensRange');
        const maxTokensInput = document.getElementById('maxTokensInput');
        maxTokensRange.value = items.maxTokens;
        maxTokensInput.value = items.maxTokens;

        // 更新温度显示
        updateTemperatureDisplay(items.temperature);

        updateApiTypeUI(items.apiType);
    });
}

// 在现有代码中添加默认设置常量
const DEFAULT_SETTINGS = {
    apiType: 'custom',
    maxTokens: 2048,
    temperature: 0.7,
    // 请在扩展设置页填写密钥与端点；此处默认值保持为空，避免泄露。
    custom_apiKey: '',
    custom_apiBase: '',
    custom_model: '',
    ollama_apiKey: 'ollama',
    ollama_apiBase: 'http://127.0.0.1:11434/api/chat',
    ollama_model: 'llama2',
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

// 修改还原设置函数
async function resetOptions() {
    try {
        // 直接保存默认设置到存储
        await chrome.storage.sync.set({
            ...DEFAULT_SETTINGS,
            // 添加activeConfig
            activeConfig: {
                apiKey: DEFAULT_SETTINGS.custom_apiKey,
                apiBase: DEFAULT_SETTINGS.custom_apiBase,
                model: DEFAULT_SETTINGS.custom_model
            }
        });

        // 更新UI显示
        document.getElementById('apiType').value = DEFAULT_SETTINGS.apiType;
        document.getElementById('apiKey').value = DEFAULT_SETTINGS.custom_apiKey;
        document.getElementById('apiBase').value = DEFAULT_SETTINGS.custom_apiBase;
        document.getElementById('model').value = DEFAULT_SETTINGS.custom_model;
        document.getElementById('enableSessionLogging').checked = DEFAULT_SETTINGS.enableSessionLogging;
        document.getElementById('sessionLogEndpoint').value = DEFAULT_SETTINGS.sessionLogEndpoint;
        document.getElementById('sessionLogOutputDir').value = DEFAULT_SETTINGS.sessionLogOutputDir;
        document.getElementById('sessionLogWorkspaceRoot').value = DEFAULT_SETTINGS.sessionLogWorkspaceRoot;
        document.getElementById('sessionIdleMinutes').value = DEFAULT_SETTINGS.sessionIdleMinutes;
        document.getElementById('sessionLogSettings').style.display = 'block';
        await chrome.storage.local.remove('floatingIconDataUrl');
        setFloatingIconPreview('');
        updateMaxTokensDisplay(DEFAULT_SETTINGS.maxTokens);
        updateTemperatureDisplay(DEFAULT_SETTINGS.temperature);

        // 强制更新输入框显示
        const apiKeyInput = document.getElementById('apiKey');
        const apiBaseInput = document.getElementById('apiBase');
        const modelInput = document.getElementById('model');

        // 设置输入框的值和占位符
        apiKeyInput.value = DEFAULT_SETTINGS.custom_apiKey;
        apiKeyInput.placeholder = API_CONFIGS.custom.apiKeyPlaceholder;

        apiBaseInput.value = DEFAULT_SETTINGS.custom_apiBase;
        apiBaseInput.placeholder = API_CONFIGS.custom.apiBasePlaceholder;

        modelInput.value = DEFAULT_SETTINGS.custom_model;
        modelInput.placeholder = API_CONFIGS.custom.modelPlaceholder;

        // 更新帮助文本
        document.getElementById('apiBaseHelp').textContent = 'API接口地址';
        document.getElementById('modelHelp').textContent = API_CONFIGS.custom.modelHelp;

        // 确保API密钥输入组可见（因为默认是custom类型）
        document.querySelector('.api-key-group').style.display = 'block';

        // 清空带教提示词编辑器并重新渲染（所有覆盖已清）
        const mpContainer = document.getElementById('mentorPromptsContainer');
        if (mpContainer) {
            mpContainer.innerHTML = '';
            initMentorPromptsEditor();
        }

        // 示成功提示
        showStatus('已还原并保存默认设置。注意：使用前请先配置必要的API信息并测试。', 'warning');
    } catch (error) {
        showStatus('还原设置失败：' + error.message, 'error');
    }
}

// 事件监听器
document.addEventListener('DOMContentLoaded', async () => {
    loadOptions();

    const apiType = document.getElementById('apiType');
    const maxTokensRange = document.getElementById('maxTokensRange');
    const maxTokensInput = document.getElementById('maxTokensInput');
    const temperatureRange = document.getElementById('temperatureRange');
    const temperatureInput = document.getElementById('temperatureInput');
    const saveButton = document.getElementById('save');
    const resetButton = document.getElementById('reset');
    const toggleApiKeyBtn = document.getElementById('toggleApiKey');
    const apiKeyInput = document.getElementById('apiKey');
    const autoHideDialog = document.getElementById('autoHideDialog');
    const enableContext = document.getElementById('enableContext');
    const maxContextRounds = document.getElementById('maxContextRounds');
    const systemPrompt = document.getElementById('systemPrompt');
    const contextSettings = document.getElementById('contextSettings');
    const enableSessionLogging = document.getElementById('enableSessionLogging');
    const sessionLogSettings = document.getElementById('sessionLogSettings');
    const testSessionLogButton = document.getElementById('testSessionLog');
    const sessionLogEndpoint = document.getElementById('sessionLogEndpoint');
    const sessionLogOutputDir = document.getElementById('sessionLogOutputDir');
    const sessionLogWorkspaceRoot = document.getElementById('sessionLogWorkspaceRoot');
    const sessionIdleMinutes = document.getElementById('sessionIdleMinutes');
    const floatingIconUpload = document.getElementById('floatingIconUpload');
    const clearFloatingIcon = document.getElementById('clearFloatingIcon');

    apiType.addEventListener('change', (e) => {
        updateApiTypeUI(e.target.value);
    });

    maxTokensRange.addEventListener('input', (e) => {
        updateMaxTokensDisplay(e.target.value);
    });

    maxTokensInput.addEventListener('input', (e) => {
        if (validateNumberInput(e.target, 128, 4096)) {
            updateMaxTokensDisplay(e.target.value);
        }
    });

    temperatureRange.addEventListener('input', (e) => {
        updateTemperatureDisplay(e.target.value);
    });

    temperatureInput.addEventListener('input', (e) => {
        if (!/^[0-9.]*$/.test(e.target.value)) {
            e.target.value = e.target.value.replace(/[^0-9.]/g, '');
        }

        const dots = e.target.value.match(/\./g);

        if (dots && dots.length > 1) {
            e.target.value = e.target.value.replace(/\.+/g, '.');
        }

        if (validateNumberInput(e.target, 0, 1, true) && !isNaN(parseFloat(e.target.value))) {
            updateTemperatureDisplay(e.target.value);
        }
    });

    temperatureInput.addEventListener('blur', (e) => {
        const value = parseFloat(e.target.value);

        if (isNaN(value) || value < 0 || value > 1) {
            updateTemperatureDisplay(temperatureRange.value);
            return;
        }

        updateTemperatureDisplay(Math.round(value * 10) / 10);
    });

    const saveNoTestButton = document.getElementById('saveNoTest');
    if (saveNoTestButton) {
        saveNoTestButton.addEventListener('click', async () => {
            if (!validateNumberInput(maxTokensInput, 128, 4096) ||
                !validateNumberInput(temperatureInput, 0, 1, true)) {
                return;
            }
            await saveOptionsWithoutTest();
        });
    }

    saveButton.addEventListener('click', async () => {
        if (!validateNumberInput(maxTokensInput, 128, 4096) ||
            !validateNumberInput(temperatureInput, 0, 1, true)) {
            return;
        }

        await saveOptions();
    });

    let isVisible = false;
    apiKeyInput.type = 'password';
    toggleApiKeyBtn.title = '点击显示';

    toggleApiKeyBtn.addEventListener('click', () => {
        isVisible = !isVisible;
        apiKeyInput.type = isVisible ? 'text' : 'password';

        toggleApiKeyBtn.innerHTML = `
            <span class="eye-icon">
                ${isVisible ? `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                    </svg>
                ` : `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
                    </svg>
                `}
            </span>
        `;
    });

    resetButton.addEventListener('click', () => {
        if (confirm('确定要还原所有设置到默认值吗？\n注意：\n1. 所有设置将被立即还原并保存\n2. 使用前请先配置必要的API信息\n3. 请记得测试API配置是否正确')) {
            resetOptions();
        }
    });

    chrome.storage.sync.get({
        autoHideDialog: true,
        enableContext: true,
        maxContextRounds: 5,
        systemPrompt: '你是一个帮助理解网页内容的AI助手。请使用Markdown格式回复。'
    }, (items) => {
        autoHideDialog.checked = items.autoHideDialog;
        enableContext.checked = items.enableContext;
        maxContextRounds.value = items.maxContextRounds;
        systemPrompt.value = items.systemPrompt;
        contextSettings.style.display = items.enableContext ? 'block' : 'none';
    });

    chrome.storage.local.get({ floatingIconDataUrl: '' }, ({ floatingIconDataUrl }) => {
        setFloatingIconPreview(floatingIconDataUrl);
    });

    enableContext.addEventListener('change', () => {
        const isEnabled = enableContext.checked;
        contextSettings.style.display = isEnabled ? 'block' : 'none';
        chrome.storage.sync.set({ enableContext: isEnabled });
    });

    maxContextRounds.addEventListener('change', () => {
        let value = parseInt(maxContextRounds.value, 10);
        value = Math.max(1, Math.min(20, value));
        maxContextRounds.value = value;
        chrome.storage.sync.set({ maxContextRounds: value });
    });

    enableSessionLogging.addEventListener('change', () => {
        const isEnabled = enableSessionLogging.checked;
        sessionLogSettings.style.display = isEnabled ? 'block' : 'none';
        chrome.storage.sync.set({ enableSessionLogging: isEnabled });
    });

    testSessionLogButton.addEventListener('click', async () => {
        try {
            showStatus('正在测试日志服务...');
            await testSessionLogConfig({
                enableSessionLogging: enableSessionLogging.checked,
                sessionLogEndpoint: sessionLogEndpoint.value.trim() || DEFAULT_SETTINGS.sessionLogEndpoint,
                sessionLogOutputDir: sessionLogOutputDir.value.trim() || DEFAULT_SETTINGS.sessionLogOutputDir,
                sessionLogWorkspaceRoot: sessionLogWorkspaceRoot.value.trim() || DEFAULT_SETTINGS.sessionLogWorkspaceRoot
            });
            showStatus('✅ 日志服务可用，后续会话会写入本地 Markdown');
        } catch (error) {
            showStatus(error.message, 'error');
        }
    });

    sessionIdleMinutes.addEventListener('change', () => {
        let value = parseInt(sessionIdleMinutes.value, 10);
        value = Math.max(1, Math.min(720, value || DEFAULT_SETTINGS.sessionIdleMinutes));
        sessionIdleMinutes.value = value;
        chrome.storage.sync.set({ sessionIdleMinutes: value });
    });

    let promptTimeout;
    systemPrompt.addEventListener('input', () => {
        if (promptTimeout) {
            clearTimeout(promptTimeout);
        }

        promptTimeout = setTimeout(() => {
            chrome.storage.sync.set({
                systemPrompt: systemPrompt.value || '你是一个帮助理解网页内容的AI助手。请使用Markdown格式回复。'
            });
        }, 1000);
    });

    let saveTimeout;
    const debounceSave = (value) => {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }

        saveTimeout = setTimeout(() => {
            chrome.storage.sync.set({ autoHideDialog: value });
        }, 1000);
    };

    autoHideDialog.addEventListener('change', () => {
        debounceSave(autoHideDialog.checked);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.floatingIconDataUrl) {
            setFloatingIconPreview(changes.floatingIconDataUrl.newValue || '');
        }
    });

    floatingIconUpload.addEventListener('change', async () => {
        const file = floatingIconUpload.files && floatingIconUpload.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            showStatus('请选择图片文件', 'error');
            floatingIconUpload.value = '';
            return;
        }
        if (file.size > FLOATING_ICON_MAX_BYTES) {
            showStatus('图片文件不能超过 5 MB', 'error');
            floatingIconUpload.value = '';
            return;
        }
        try {
            const dataUrl = await fileToDataUrl(file);
            await chrome.storage.local.set({ floatingIconDataUrl: dataUrl });
            setFloatingIconPreview(dataUrl);
            showStatus('悬浮球图案已更新');
        } catch (error) {
            showStatus(error.message, 'error');
        } finally {
            floatingIconUpload.value = '';
        }
    });

    clearFloatingIcon.addEventListener('click', async () => {
        await chrome.storage.local.remove('floatingIconDataUrl');
        setFloatingIconPreview('');
        showStatus('已恢复默认悬浮球图案');
    });

    // ===== 学习带教模式提示词编辑器 =====
    initMentorPromptsEditor();

    // ===== Slash 指令编辑器 =====
    initSlashCommandsEditor();
});

function initMentorPromptsEditor() {
    const container = document.getElementById('mentorPromptsContainer');
    if (!container) return;
    const MentorAPI = self.WebChatMentor;
    if (!MentorAPI) {
        container.textContent = '⚠️ 带教模块未加载';
        return;
    }

    // 只展示非 OFF 的几种
    const flavors = Object.values(MentorAPI.MENTOR_FLAVORS).filter(
        (f) => f !== MentorAPI.MENTOR_FLAVORS.OFF
    );

    chrome.storage.sync.get({ mentorPrompts: {}, mentorLabels: {} }, ({ mentorPrompts, mentorLabels }) => {
        const overrides = mentorPrompts || {};
        const labelOverrides = mentorLabels || {};
        const saveTimers = {};
        const labelSaveTimers = {};

        flavors.forEach((flavor) => {
            const meta = MentorAPI.MENTOR_META[flavor];
            const defaultPrompt = MentorAPI.getDefaultMentorPrompt(flavor);
            const currentValue = typeof overrides[flavor] === 'string' ? overrides[flavor] : '';
            const isOverridden = Boolean(currentValue && currentValue.trim());
            const isCustom = MentorAPI.isCustomMentorSlot && MentorAPI.isCustomMentorSlot(flavor);
            const currentLabel = typeof labelOverrides[flavor] === 'string' ? labelOverrides[flavor] : '';
            const effectiveLabel = currentLabel.trim() || meta.label;

            const wrap = document.createElement('details');
            wrap.className = 'mentor-prompt-item';
            // 已自定义 or 是空白自定义槽位的都默认展开，方便用户编辑
            wrap.open = isOverridden || isCustom;

            const summary = document.createElement('summary');
            summary.innerHTML = `
                <span class="mp-icon">${meta.icon}</span>
                <span class="mp-label">${effectiveLabel}</span>
                <span class="mp-state" data-state="${isOverridden ? 'custom' : 'default'}">${
                    isOverridden ? '已自定义' : (isCustom ? '空槽位' : '使用默认')
                }</span>
            `;
            wrap.appendChild(summary);

            const body = document.createElement('div');
            body.className = 'mp-body';

            const hint = document.createElement('div');
            hint.className = 'help-text';
            hint.textContent = meta.hint;
            body.appendChild(hint);

            // 仅自定义槽位显示"名称"编辑框（覆盖 meta.label 的显示名）
            let labelInput = null;
            if (isCustom) {
                const labelRow = document.createElement('div');
                labelRow.className = 'mp-label-row';
                labelRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0 8px;';
                const labelLbl = document.createElement('label');
                labelLbl.textContent = '显示名称：';
                labelLbl.style.cssText = 'font-size:12px;color:#555;flex-shrink:0;';
                labelInput = document.createElement('input');
                labelInput.type = 'text';
                labelInput.placeholder = meta.label;
                labelInput.value = currentLabel;
                labelInput.style.cssText = 'flex:1;padding:4px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;';
                labelRow.appendChild(labelLbl);
                labelRow.appendChild(labelInput);
                body.appendChild(labelRow);
            }

            const textarea = document.createElement('textarea');
            textarea.rows = 12;
            textarea.placeholder = defaultPrompt || '在这里填入你的自定义系统提示词...';
            textarea.value = currentValue;
            textarea.spellcheck = false;
            body.appendChild(textarea);

            const row = document.createElement('div');
            row.className = 'mp-actions';

            const loadDefaultBtn = document.createElement('button');
            loadDefaultBtn.type = 'button';
            loadDefaultBtn.className = 'secondary-button';
            loadDefaultBtn.textContent = '填入默认（以便修改）';
            loadDefaultBtn.addEventListener('click', () => {
                textarea.value = defaultPrompt;
                textarea.dispatchEvent(new Event('input'));
                textarea.focus();
            });
            row.appendChild(loadDefaultBtn);

            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'secondary-button';
            resetBtn.textContent = '恢复默认（清空覆盖）';
            resetBtn.addEventListener('click', () => {
                textarea.value = '';
                textarea.dispatchEvent(new Event('input'));
            });
            row.appendChild(resetBtn);

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'secondary-button';
            copyBtn.textContent = '复制默认到剪贴板';
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(defaultPrompt);
                    copyBtn.textContent = '✓ 已复制';
                    setTimeout(() => { copyBtn.textContent = '复制默认到剪贴板'; }, 1500);
                } catch (e) {
                    alert('复制失败：' + e.message);
                }
            });
            row.appendChild(copyBtn);

            body.appendChild(row);
            wrap.appendChild(body);
            container.appendChild(wrap);

            const stateBadge = summary.querySelector('.mp-state');
            const labelBadge = summary.querySelector('.mp-label');
            function refreshState() {
                const custom = Boolean(textarea.value && textarea.value.trim());
                stateBadge.dataset.state = custom ? 'custom' : 'default';
                stateBadge.textContent = custom
                    ? '已自定义'
                    : (isCustom ? '空槽位' : '使用默认');
            }

            // 提示词：1 秒防抖保存
            textarea.addEventListener('input', () => {
                refreshState();
                if (saveTimers[flavor]) clearTimeout(saveTimers[flavor]);
                saveTimers[flavor] = setTimeout(() => {
                    chrome.storage.sync.get({ mentorPrompts: {} }, ({ mentorPrompts }) => {
                        const next = { ...(mentorPrompts || {}) };
                        const v = (textarea.value || '').trim();
                        if (v) {
                            next[flavor] = v;
                        } else {
                            delete next[flavor];
                        }
                        chrome.storage.sync.set({ mentorPrompts: next });
                    });
                }, 800);
            });

            // 显示名称：同样 1 秒防抖保存到 mentorLabels
            if (labelInput) {
                labelInput.addEventListener('input', () => {
                    if (labelBadge) {
                        labelBadge.textContent = labelInput.value.trim() || meta.label;
                    }
                    if (labelSaveTimers[flavor]) clearTimeout(labelSaveTimers[flavor]);
                    labelSaveTimers[flavor] = setTimeout(() => {
                        chrome.storage.sync.get({ mentorLabels: {} }, ({ mentorLabels }) => {
                            const next = { ...(mentorLabels || {}) };
                            const v = (labelInput.value || '').trim();
                            if (v) {
                                next[flavor] = v;
                            } else {
                                delete next[flavor];
                            }
                            chrome.storage.sync.set({ mentorLabels: next });
                        });
                    }, 800);
                });
            }
        });
    });
}

// ===== Slash 指令编辑器 =====
function initSlashCommandsEditor() {
    const container = document.getElementById('slashCommandsContainer');
    const addBtn = document.getElementById('addSlashCmd');
    const resetBtn = document.getElementById('resetSlashCmd');
    if (!container || !addBtn || !resetBtn) return;

    const SlashAPI = self.WebChatSlash;
    if (!SlashAPI) {
        container.textContent = '⚠️ Slash 指令模块未加载';
        return;
    }

    const NAME_RE = /^[\w-]+$/;
    let saveTimer = null;
    // 内存中的工作副本（可以包含暂时不合法的条目，比如空 name）
    let items = [];

    function scheduleSave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            const normalized = SlashAPI.normalizeSlashCommands(items);
            chrome.storage.sync.set({ slashCommands: normalized });
        }, 500);
    }

    function validateItem(item) {
        const errs = [];
        const name = String(item.name || '').trim();
        const prompt = String(item.prompt || '');
        if (!name) errs.push('指令名为空');
        else if (!NAME_RE.test(name)) errs.push('指令名只能包含字母/数字/下划线/连字符');
        if (!prompt.trim()) errs.push('提示词为空');
        return errs;
    }

    function render() {
        container.innerHTML = '';
        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'help-text';
            empty.style.cssText = 'padding:14px;text-align:center;color:#9ca3af;';
            empty.textContent = '暂无指令。点击下方"新增指令"添加。';
            container.appendChild(empty);
            return;
        }
        // 重名集合
        const nameCount = {};
        items.forEach((it) => {
            const n = String(it.name || '').trim();
            if (n) nameCount[n] = (nameCount[n] || 0) + 1;
        });

        items.forEach((item, idx) => {
            const wrap = document.createElement('div');
            wrap.className = 'slash-cmd-item';

            const row1 = document.createElement('div');
            row1.className = 'sc-row1';

            const slash = document.createElement('span');
            slash.className = 'sc-slash';
            slash.textContent = '/';
            row1.appendChild(slash);

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'sc-name';
            nameInput.placeholder = 'summarize';
            nameInput.value = item.name || '';
            nameInput.addEventListener('input', () => {
                items[idx].name = nameInput.value;
                updateErr();
                scheduleSave();
            });
            row1.appendChild(nameInput);

            const titleInput = document.createElement('input');
            titleInput.type = 'text';
            titleInput.className = 'sc-title';
            titleInput.placeholder = '显示名称（可留空，默认用指令名）';
            titleInput.value = item.title || '';
            titleInput.addEventListener('input', () => {
                items[idx].title = titleInput.value;
                scheduleSave();
            });
            row1.appendChild(titleInput);

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'sc-del';
            del.textContent = '删除';
            del.addEventListener('click', () => {
                if (!confirm(`确认删除指令 /${item.name || '(未命名)'} 吗？`)) return;
                items.splice(idx, 1);
                render();
                scheduleSave();
            });
            row1.appendChild(del);

            wrap.appendChild(row1);

            const prompt = document.createElement('textarea');
            prompt.className = 'sc-prompt';
            prompt.rows = 3;
            prompt.placeholder = '选中指令后灌入输入框的提示词';
            prompt.value = item.prompt || '';
            prompt.addEventListener('input', () => {
                items[idx].prompt = prompt.value;
                updateErr();
                scheduleSave();
            });
            wrap.appendChild(prompt);

            const errBox = document.createElement('div');
            errBox.className = 'help-text';
            errBox.style.cssText = 'color:#b91c1c;margin-top:6px;min-height:16px;';
            wrap.appendChild(errBox);

            function updateErr() {
                const errs = validateItem(items[idx]);
                const nm = String(items[idx].name || '').trim();
                if (nm && nameCount[nm] > 1) {
                    errs.push(`指令名重复（与其他条目同名：/${nm}）`);
                }
                errBox.textContent = errs.length ? '⚠ ' + errs.join('；') : '';
            }
            updateErr();

            container.appendChild(wrap);
        });
    }

    addBtn.addEventListener('click', () => {
        items.push({ name: '', title: '', prompt: '' });
        render();
        // 聚焦到新加的 name 输入
        const last = container.querySelector('.slash-cmd-item:last-child .sc-name');
        if (last) last.focus();
    });

    resetBtn.addEventListener('click', () => {
        if (!confirm('确认还原到默认指令列表？当前自定义内容将被覆盖。')) return;
        items = SlashAPI.DEFAULT_SLASH_COMMANDS.map((c) => ({ ...c }));
        render();
        scheduleSave();
    });

    // 初次加载：如果没有存储，使用默认
    chrome.storage.sync.get({ slashCommands: null }, ({ slashCommands }) => {
        if (Array.isArray(slashCommands) && slashCommands.length > 0) {
            items = SlashAPI.normalizeSlashCommands(slashCommands).map((c) => ({ ...c }));
        } else {
            items = SlashAPI.DEFAULT_SLASH_COMMANDS.map((c) => ({ ...c }));
        }
        render();
    });
}
