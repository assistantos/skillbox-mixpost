/**
 * Skillbox Assistant Bridge for Mixpost
 *
 * This script runs inside the Mixpost browser tab and provides:
 * 1. Authentication with Skillbox via popup-based token exchange
 * 2. Button injection into Mixpost's post editor
 * 3. A floating Assistant chat panel
 * 4. Text insertion into TipTap editor via Mixpost's event emitter
 * 5. Media transfer from Skillbox S3 to Mixpost's media library
 *
 * Dependencies:
 *   - window.__mixpostEmitter (exposed by our fork's emitter.js change)
 *   - Skillbox API (for assistants, conversations, messages)
 */
(function () {
    'use strict';

    // ================================================================
    // Configuration
    // ================================================================
    const scriptTag = document.currentScript;
    const CONFIG = {
        skillboxApiUrl: scriptTag?.dataset?.api || 'http://localhost:3001',
        tenant: scriptTag?.dataset?.tenant || 'dev',
        tokenStorageKey: 'skillbox_social_token',
        panelId: 'skillbox-assistant-panel',
        buttonClass: 'skillbox-assistant-btn',
    };

    // ================================================================
    // Token Management
    // ================================================================
    class TokenManager {
        constructor() {
            this.token = localStorage.getItem(CONFIG.tokenStorageKey);
        }

        getToken() {
            if (this.token && !this.isExpired(this.token)) {
                return this.token;
            }
            return null;
        }

        setToken(token) {
            this.token = token;
            localStorage.setItem(CONFIG.tokenStorageKey, token);
        }

        clearToken() {
            this.token = null;
            localStorage.removeItem(CONFIG.tokenStorageKey);
        }

        isExpired(token) {
            try {
                const payload = JSON.parse(atob(token.split('.')[1]));
                return payload.exp * 1000 < Date.now();
            } catch {
                return true;
            }
        }

        /**
         * Authenticate via popup window.
         * Opens a Skillbox auth page that sends back a token via postMessage.
         */
        authenticate() {
            return new Promise((resolve, reject) => {
                const popup = window.open(
                    `${CONFIG.skillboxApiUrl}/auth/social-media-token`,
                    'skillbox-auth',
                    'width=450,height=400,menubar=no,toolbar=no'
                );

                if (!popup) {
                    reject(new Error('Popup blocked. Please allow popups for this site.'));
                    return;
                }

                const timeout = setTimeout(() => {
                    window.removeEventListener('message', handler);
                    reject(new Error('Authentication timeout'));
                }, 60000);

                const handler = (event) => {
                    // Only accept messages from Skillbox
                    if (!event.origin.includes(new URL(CONFIG.skillboxApiUrl).hostname)) return;
                    if (event.data?.type !== 'skillbox-token') return;

                    clearTimeout(timeout);
                    window.removeEventListener('message', handler);

                    this.setToken(event.data.token);
                    popup.close();
                    resolve(event.data.token);
                };

                window.addEventListener('message', handler);
            });
        }

        /**
         * Ensure we have a valid token, authenticating if needed.
         */
        async ensureAuthenticated() {
            const token = this.getToken();
            if (token) return token;
            return this.authenticate();
        }
    }

    // ================================================================
    // Skillbox API Client
    // ================================================================
    class SkillboxApiClient {
        constructor(tokenManager) {
            this.tokenManager = tokenManager;
        }

        async request(method, path, body = null) {
            const token = await this.tokenManager.ensureAuthenticated();
            const options = {
                method,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'x-social-media-request': 'true',
                },
            };
            if (body) {
                options.body = JSON.stringify(body);
            }

            const res = await fetch(`${CONFIG.skillboxApiUrl}${path}`, options);

            if (res.status === 401) {
                this.tokenManager.clearToken();
                throw new Error('Token expired. Please re-authenticate.');
            }

            if (!res.ok) {
                throw new Error(`API error: ${res.status} ${res.statusText}`);
            }

            return res.json();
        }

        async getAssistants() {
            return this.request('GET', `/api/social/assistants`);
        }

        async createConversation(assistantId) {
            return this.request('POST', `/api/social/conversations`, { assistantId });
        }

        async getMessages(conversationId) {
            return this.request('GET', `/api/conversations/${conversationId}/messages`);
        }

        async sendMessage(conversationId, content) {
            return this.request('POST', `/api/conversations/${conversationId}/messages`, {
                content,
            });
        }

        /**
         * Fetch a media blob from Skillbox S3 (for transfer to Mixpost).
         */
        async fetchMediaBlob(url) {
            const token = await this.tokenManager.ensureAuthenticated();
            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(`Failed to fetch media: ${res.status}`);
            return res.blob();
        }
    }

    // ================================================================
    // Mixpost Integration
    // ================================================================
    class MixpostIntegration {
        /**
         * Insert text into the active TipTap editor via Mixpost's event emitter.
         */
        static insertText(text) {
            const emitter = window.__mixpostEmitter;
            if (!emitter) {
                console.warn('[Skillbox Bridge] Mixpost emitter not found. Text copied to clipboard instead.');
                navigator.clipboard.writeText(text);
                return false;
            }

            // Find the active editor ID from the DOM
            const editorEl = document.querySelector('.ProseMirror');
            const editorWrapper = editorEl?.closest('[id]');
            const editorId = editorWrapper?.id;

            if (!editorId) {
                console.warn('[Skillbox Bridge] No active editor found. Text copied to clipboard.');
                navigator.clipboard.writeText(text);
                return false;
            }

            emitter.emit('insertContent', { editorId, text });
            return true;
        }

        /**
         * Upload a media blob to Mixpost's media library.
         */
        static async uploadMedia(blob, filename) {
            const formData = new FormData();
            formData.append('file', blob, filename);

            // Uses Mixpost's session cookie (we're in the same browser tab)
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

            const res = await fetch('/mixpost/api/media/upload', {
                method: 'POST',
                headers: {
                    'X-CSRF-TOKEN': csrfToken || '',
                },
                body: formData,
            });

            if (!res.ok) {
                throw new Error(`Media upload failed: ${res.status}`);
            }

            return res.json();
        }
    }

    // ================================================================
    // Assistant Panel UI
    // ================================================================
    class AssistantPanel {
        constructor(apiClient) {
            this.apiClient = apiClient;
            this.assistants = [];
            this.selectedAssistant = null;
            this.conversationId = null;
            this.messages = [];
            this.isOpen = false;
            this.isLoading = false;
            this.element = null;
        }

        async initialize() {
            try {
                const data = await this.apiClient.getAssistants();
                this.assistants = data.assistants || data || [];
            } catch (err) {
                console.error('[Skillbox Bridge] Failed to load assistants:', err);
                this.assistants = [];
            }
        }

        createPanelHTML() {
            const assistantOptions = this.assistants
                .map((a) => `<option value="${a.id}">${a.name}</option>`)
                .join('');

            return `
                <div id="${CONFIG.panelId}" class="skillbox-panel" style="display:none;">
                    <div class="skillbox-panel-header">
                        <span class="skillbox-panel-title">Skillbox Assistant</span>
                        <button class="skillbox-panel-close" onclick="window.__skillboxBridge.togglePanel()">&times;</button>
                    </div>
                    <div class="skillbox-panel-body">
                        <div class="skillbox-assistant-select">
                            <label for="skillbox-assistant-dropdown">Assistant:</label>
                            <select id="skillbox-assistant-dropdown" onchange="window.__skillboxBridge.selectAssistant(this.value)">
                                <option value="">-- Wählen --</option>
                                ${assistantOptions}
                            </select>
                        </div>
                        <div id="skillbox-messages" class="skillbox-messages"></div>
                        <div class="skillbox-input-area">
                            <textarea id="skillbox-prompt" placeholder="Beschreibe, was du brauchst..." rows="3"></textarea>
                            <div class="skillbox-actions">
                                <div class="skillbox-quick-actions">
                                    <button class="skillbox-quick-btn" onclick="window.__skillboxBridge.quickAction('kürzer')">Kürzer</button>
                                    <button class="skillbox-quick-btn" onclick="window.__skillboxBridge.quickAction('formeller')">Formeller</button>
                                    <button class="skillbox-quick-btn" onclick="window.__skillboxBridge.quickAction('hashtags')">+ Hashtags</button>
                                    <button class="skillbox-quick-btn" onclick="window.__skillboxBridge.quickAction('emoji')">+ Emojis</button>
                                </div>
                                <button id="skillbox-send-btn" class="skillbox-send-btn" onclick="window.__skillboxBridge.sendMessage()">
                                    Senden
                                </button>
                            </div>
                        </div>
                    </div>
                    <div id="skillbox-loading" class="skillbox-loading" style="display:none;">
                        <div class="skillbox-spinner"></div>
                        <span>Assistant denkt nach...</span>
                    </div>
                </div>
            `;
        }

        render() {
            // Remove existing panel if any
            const existing = document.getElementById(CONFIG.panelId);
            if (existing) existing.remove();

            // Insert panel HTML
            const container = document.createElement('div');
            container.innerHTML = this.createPanelHTML();
            document.body.appendChild(container.firstElementChild);

            this.element = document.getElementById(CONFIG.panelId);

            // Enter key to send
            const textarea = document.getElementById('skillbox-prompt');
            if (textarea) {
                textarea.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        window.__skillboxBridge.sendMessage();
                    }
                });
            }
        }

        toggle() {
            if (!this.element) {
                this.render();
            }
            this.isOpen = !this.isOpen;
            this.element.style.display = this.isOpen ? 'flex' : 'none';
        }

        addMessage(role, content, mediaItems = []) {
            this.messages.push({ role, content, mediaItems });
            this.renderMessages();
        }

        renderMessages() {
            const container = document.getElementById('skillbox-messages');
            if (!container) return;

            container.innerHTML = this.messages
                .map((msg) => {
                    const roleLabel = msg.role === 'user' ? 'Du' : 'Assistant';
                    const roleClass = msg.role === 'user' ? 'user' : 'assistant';

                    let mediaHTML = '';
                    if (msg.mediaItems && msg.mediaItems.length > 0) {
                        mediaHTML = msg.mediaItems
                            .map((item) => {
                                if (item.type === 'image') {
                                    return `
                                        <div class="skillbox-media-item">
                                            <img src="${item.url}" alt="Generated image" style="max-width:200px;border-radius:8px;">
                                            <button class="skillbox-transfer-btn" onclick="window.__skillboxBridge.transferMedia('${item.url}', '${item.filename || 'image.png'}')">
                                                📷 Bild übernehmen
                                            </button>
                                        </div>
                                    `;
                                }
                                if (item.type === 'audio') {
                                    return `
                                        <div class="skillbox-media-item">
                                            <audio controls src="${item.url}" style="max-width:100%;"></audio>
                                            <button class="skillbox-transfer-btn" onclick="window.__skillboxBridge.transferMedia('${item.url}', '${item.filename || 'audio.mp3'}')">
                                                🔊 Audio übernehmen
                                            </button>
                                        </div>
                                    `;
                                }
                                return '';
                            })
                            .join('');
                    }

                    const insertBtn =
                        msg.role === 'assistant' && msg.content
                            ? `<button class="skillbox-insert-btn" onclick="window.__skillboxBridge.insertText(\`${msg.content.replace(/`/g, '\\`').replace(/\\/g, '\\\\')}\`)">
                                    ✏️ In Editor übernehmen
                               </button>`
                            : '';

                    return `
                        <div class="skillbox-message skillbox-message-${roleClass}">
                            <div class="skillbox-message-role">${roleLabel}</div>
                            <div class="skillbox-message-content">${msg.content || ''}</div>
                            ${mediaHTML}
                            ${insertBtn}
                        </div>
                    `;
                })
                .join('');

            container.scrollTop = container.scrollHeight;
        }

        setLoading(loading) {
            this.isLoading = loading;
            const el = document.getElementById('skillbox-loading');
            const btn = document.getElementById('skillbox-send-btn');
            if (el) el.style.display = loading ? 'flex' : 'none';
            if (btn) btn.disabled = loading;
        }
    }

    // ================================================================
    // Bridge Controller (Main)
    // ================================================================
    class SkillboxBridge {
        constructor() {
            this.tokenManager = new TokenManager();
            this.apiClient = new SkillboxApiClient(this.tokenManager);
            this.panel = new AssistantPanel(this.apiClient);
            this.observer = null;
        }

        async init() {
            console.log('[Skillbox Bridge] Initializing...');

            // Load CSS
            this.loadStyles();

            // Watch for DOM changes (Mixpost is SPA with Inertia.js)
            this.observeDOM();

            console.log('[Skillbox Bridge] Ready.');
        }

        loadStyles() {
            if (document.getElementById('skillbox-assistant-styles')) return;

            const link = document.createElement('link');
            link.id = 'skillbox-assistant-styles';
            link.rel = 'stylesheet';
            link.href = '/skillbox-assistant.css';
            document.head.appendChild(link);
        }

        /**
         * Watch for DOM changes and inject the Assistant button
         * when the post editor is detected.
         */
        observeDOM() {
            // Initial check
            this.tryInjectButton();

            // Observe for SPA navigation
            this.observer = new MutationObserver(() => {
                this.tryInjectButton();
            });

            this.observer.observe(document.body, {
                childList: true,
                subtree: true,
            });
        }

        /**
         * Detect the post editor and inject our button if not already present.
         */
        tryInjectButton() {
            // Check if we're on a post editor page
            const editorToolbar = document.querySelector('.ProseMirror')?.closest('.relative')?.parentElement;

            if (!editorToolbar) return;
            if (editorToolbar.querySelector(`.${CONFIG.buttonClass}`)) return;

            // Find a suitable location to insert the button
            // Look for the editor actions area (where emoji, media buttons are)
            const actionsArea =
                editorToolbar.querySelector('[class*="flex"][class*="items-center"][class*="gap"]') ||
                editorToolbar.querySelector('.flex.items-center') ||
                editorToolbar;

            if (!actionsArea) return;

            const btn = document.createElement('button');
            btn.className = CONFIG.buttonClass;
            btn.innerHTML = `
                <span class="icon">🤖</span>
                <span>Skillbox Assistant</span>
            `;
            btn.onclick = () => this.togglePanel();
            btn.title = 'Content mit Skillbox Assistant erstellen';

            actionsArea.appendChild(btn);
            console.log('[Skillbox Bridge] Assistant button injected.');
        }

        /**
         * Toggle the Assistant panel.
         */
        async togglePanel() {
            if (!this.panel.assistants.length) {
                try {
                    await this.panel.initialize();
                } catch (err) {
                    console.error('[Skillbox Bridge] Panel init failed:', err);
                    alert('Verbindung zu Skillbox fehlgeschlagen. Bitte erneut versuchen.');
                    return;
                }
            }
            this.panel.toggle();
        }

        /**
         * Select an assistant and create a conversation.
         */
        async selectAssistant(assistantId) {
            if (!assistantId) {
                this.panel.selectedAssistant = null;
                this.panel.conversationId = null;
                return;
            }

            this.panel.selectedAssistant = assistantId;

            try {
                const conv = await this.apiClient.createConversation(assistantId);
                this.panel.conversationId = conv.id || conv.conversationId;
                this.panel.messages = [];
                this.panel.renderMessages();
            } catch (err) {
                console.error('[Skillbox Bridge] Failed to create conversation:', err);
            }
        }

        /**
         * Send a message to the selected assistant.
         */
        async sendMessage() {
            const textarea = document.getElementById('skillbox-prompt');
            const content = textarea?.value?.trim();

            if (!content || !this.panel.conversationId) return;

            // Add user message
            this.panel.addMessage('user', content);
            textarea.value = '';
            this.panel.setLoading(true);

            try {
                const response = await this.apiClient.sendMessage(
                    this.panel.conversationId,
                    content
                );

                // Extract text content
                const text = response.content || response.message?.content || response.text || '';

                // Extract media items from plugin results
                const mediaItems = this.extractMediaItems(response);

                this.panel.addMessage('assistant', text, mediaItems);
            } catch (err) {
                console.error('[Skillbox Bridge] Send message failed:', err);
                this.panel.addMessage('assistant', `Fehler: ${err.message}`);
            } finally {
                this.panel.setLoading(false);
            }
        }

        /**
         * Handle quick action buttons.
         */
        async quickAction(action) {
            const prompts = {
                'kürzer': 'Mache den letzten Text deutlich kürzer und prägnanter.',
                'formeller': 'Schreibe den letzten Text in einem formelleren, professionelleren Ton um.',
                'hashtags': 'Füge passende Hashtags zum letzten Text hinzu.',
                'emoji': 'Füge passende Emojis zum letzten Text hinzu, ohne den Inhalt zu ändern.',
            };

            const prompt = prompts[action];
            if (!prompt || !this.panel.conversationId) return;

            const textarea = document.getElementById('skillbox-prompt');
            if (textarea) textarea.value = prompt;

            await this.sendMessage();
        }

        /**
         * Extract media items (images, audio, video) from assistant response.
         */
        extractMediaItems(response) {
            const items = [];

            // Check for plugin results
            const pluginResults = response.pluginResults || response.plugin_results || [];

            for (const result of pluginResults) {
                if (result.type === 'image' || result.mimeType?.startsWith('image/')) {
                    items.push({
                        type: 'image',
                        url: result.url || result.data?.url,
                        filename: result.filename || 'generated-image.png',
                    });
                }
                if (result.type === 'audio' || result.mimeType?.startsWith('audio/')) {
                    items.push({
                        type: 'audio',
                        url: result.url || result.data?.url,
                        filename: result.filename || 'generated-audio.mp3',
                    });
                }
                if (result.type === 'video' || result.mimeType?.startsWith('video/')) {
                    items.push({
                        type: 'video',
                        url: result.url || result.data?.url,
                        filename: result.filename || 'generated-video.mp4',
                    });
                }
            }

            return items;
        }

        /**
         * Insert text into the Mixpost editor.
         */
        insertText(text) {
            const success = MixpostIntegration.insertText(text);
            if (success) {
                this.showToast('Text in Editor eingefügt');
            } else {
                this.showToast('Text in Zwischenablage kopiert');
            }
        }

        /**
         * Transfer media from Skillbox to Mixpost's media library.
         */
        async transferMedia(url, filename) {
            try {
                this.showToast('Lade Medium herunter...');

                const blob = await this.apiClient.fetchMediaBlob(url);
                const mediaItem = await MixpostIntegration.uploadMedia(blob, filename);

                this.showToast('Medium erfolgreich übernommen!');
                console.log('[Skillbox Bridge] Media transferred:', mediaItem);
            } catch (err) {
                console.error('[Skillbox Bridge] Media transfer failed:', err);
                this.showToast(`Fehler: ${err.message}`);
            }
        }

        /**
         * Show a temporary toast notification.
         */
        showToast(message) {
            const existing = document.getElementById('skillbox-toast');
            if (existing) existing.remove();

            const toast = document.createElement('div');
            toast.id = 'skillbox-toast';
            toast.className = 'skillbox-toast';
            toast.textContent = message;
            document.body.appendChild(toast);

            setTimeout(() => {
                toast.classList.add('skillbox-toast-hide');
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }
    }

    // ================================================================
    // Bootstrap
    // ================================================================
    const bridge = new SkillboxBridge();
    window.__skillboxBridge = bridge;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => bridge.init());
    } else {
        bridge.init();
    }
})();
