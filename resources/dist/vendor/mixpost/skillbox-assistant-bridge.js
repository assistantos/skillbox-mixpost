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
            // Token is stored in localStorage by the SSO redirect page
            this.token = localStorage.getItem(CONFIG.tokenStorageKey);
            if (this.token) {
                const expired = this.isExpired(this.token);
                console.log('[Skillbox Bridge] Token found in localStorage', { expired });
                if (expired) {
                    this.clearToken();
                }
            } else {
                console.log('[Skillbox Bridge] No token in localStorage');
            }
        }

        getToken() {
            // Re-read from localStorage (may have been updated by new SSO login)
            const stored = localStorage.getItem(CONFIG.tokenStorageKey);
            if (stored && !this.isExpired(stored)) {
                this.token = stored;
                return this.token;
            }

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
         * Ensure we have a valid token.
         * Token comes from SSO cookie (set during Mixpost login).
         * No popup needed since user always enters via Skillbox SSO.
         */
        async ensureAuthenticated() {
            const token = this.getToken();
            if (token) return token;

            // No valid token available - user needs to re-login via Skillbox
            console.warn('[Skillbox Bridge] No valid token. Please re-login from Skillbox.');
            throw new Error('Nicht authentifiziert. Bitte über Skillbox erneut einloggen.');
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
            return this.request('GET', `/api/t/${CONFIG.tenant}/conversations/${conversationId}/messages`);
        }

        async sendMessage(conversationId, content) {
            return this.request('POST', `/api/t/${CONFIG.tenant}/conversations/${conversationId}/messages`, {
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
         * Insert text directly into the TipTap/ProseMirror editor.
         * Uses multiple strategies for maximum reliability:
         * 1. Direct ProseMirror transaction (cleanest)
         * 2. execCommand insertText (works with contenteditable)
         * 3. Clipboard fallback
         */
        static insertText(text) {
            const pmEl = document.querySelector('.ProseMirror');

            if (!pmEl) {
                console.warn('[Skillbox Bridge] No editor found. Copying to clipboard.');
                navigator.clipboard.writeText(text);
                return false;
            }

            // Strategy 1: Direct ProseMirror view access
            // TipTap/ProseMirror stores the view descriptor on the DOM element
            try {
                const view = pmEl.pmViewDesc?.view;
                if (view) {
                    const { state } = view;
                    const { tr } = state;
                    // Insert at current cursor position, or at end if no selection
                    const pos = state.selection.to || state.doc.content.size;
                    const textNode = state.schema.text(text);
                    view.dispatch(tr.insert(pos, textNode));
                    view.focus();
                    console.log('[Skillbox Bridge] Text inserted via ProseMirror transaction.');
                    return true;
                }
            } catch (e) {
                console.log('[Skillbox Bridge] ProseMirror direct insert failed, trying fallback:', e.message);
            }

            // Strategy 2: Focus + execCommand (works with contenteditable)
            try {
                pmEl.focus();
                // Move cursor to end
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(pmEl);
                range.collapse(false); // Collapse to end
                selection.removeAllRanges();
                selection.addRange(range);

                // Insert text
                const success = document.execCommand('insertText', false, text);
                if (success) {
                    console.log('[Skillbox Bridge] Text inserted via execCommand.');
                    return true;
                }
            } catch (e) {
                console.log('[Skillbox Bridge] execCommand insert failed:', e.message);
            }

            // Strategy 3: Simulate paste event
            try {
                pmEl.focus();
                const dt = new DataTransfer();
                dt.setData('text/plain', text);
                const pasteEvent = new ClipboardEvent('paste', {
                    bubbles: true,
                    cancelable: true,
                    clipboardData: dt,
                });
                pmEl.dispatchEvent(pasteEvent);
                console.log('[Skillbox Bridge] Text inserted via paste event.');
                return true;
            } catch (e) {
                console.log('[Skillbox Bridge] Paste event failed:', e.message);
            }

            // Strategy 4: Clipboard fallback
            console.warn('[Skillbox Bridge] All insert methods failed. Copying to clipboard.');
            navigator.clipboard.writeText(text);
            return false;
        }

        /**
         * Detect Mixpost's core path from the current page URL.
         * Mixpost URLs are structured as /{core_path}/posts/... (default: "mixpost").
         */
        static getCorePath() {
            const path = window.location.pathname;
            // Match /{corePath}/... – first path segment
            const match = path.match(/^\/([^/]+)\//);
            return match ? match[1] : 'mixpost';
        }

        /**
         * Upload a media blob to Mixpost's media library.
         * Tries multiple known API paths for compatibility.
         */
        static async uploadMedia(blob, filename) {
            const formData = new FormData();
            formData.append('file', blob, filename);

            // Uses Mixpost's session cookie (we're in the same browser tab)
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

            if (!csrfToken) {
                console.warn('[Skillbox Bridge] No CSRF token found – upload may fail.');
            }

            const corePath = MixpostIntegration.getCorePath();
            const uploadPaths = [
                `/${corePath}/media/upload`,
                `/${corePath}/api/media/upload`,
            ];

            let lastError = null;
            for (const uploadPath of uploadPaths) {
                try {
                    console.log(`[Skillbox Bridge] Trying media upload to: ${uploadPath}`);
                    const res = await fetch(uploadPath, {
                        method: 'POST',
                        headers: {
                            'X-CSRF-TOKEN': csrfToken || '',
                            'Accept': 'application/json',
                        },
                        body: formData,
                    });

                    if (res.ok) {
                        const result = await res.json();
                        console.log(`[Skillbox Bridge] Media upload succeeded via ${uploadPath}`);
                        return result;
                    }

                    // 419 = CSRF expired, 404 = wrong path, 422 = validation error
                    lastError = new Error(`${uploadPath}: ${res.status} ${res.statusText}`);
                    console.log(`[Skillbox Bridge] Upload to ${uploadPath} failed: ${res.status}`);

                    // Don't try other paths for auth/CSRF errors
                    if (res.status === 419 || res.status === 401) {
                        throw new Error('CSRF-Token abgelaufen. Bitte Seite neu laden.');
                    }
                } catch (err) {
                    lastError = err;
                    if (err.message.includes('CSRF')) throw err;
                }
            }

            throw lastError || new Error('Media upload fehlgeschlagen – alle Pfade versucht.');
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

        /**
         * Simple Markdown-to-HTML formatting for message display.
         */
        _formatText(text) {
            if (!text) return '';
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')   // **bold**
                .replace(/\*(.+?)\*/g, '<em>$1</em>')               // *italic*
                .replace(/\n/g, '<br>');                              // newlines
        }

        renderMessages() {
            const container = document.getElementById('skillbox-messages');
            if (!container) return;

            // Ensure storage maps exist on bridge for ID-based onclick handlers
            const bridge = window.__skillboxBridge;
            if (bridge) {
                bridge._mediaItems = bridge._mediaItems || {};
                bridge._texts = bridge._texts || {};
            }

            container.innerHTML = this.messages
                .map((msg, msgIdx) => {
                    const roleLabel = msg.role === 'user' ? 'Du' : 'Assistant';
                    const roleClass = msg.role === 'user' ? 'user' : 'assistant';

                    // Render media items (images, audio, video)
                    let mediaHTML = '';
                    if (msg.mediaItems && msg.mediaItems.length > 0) {
                        mediaHTML = msg.mediaItems
                            .map((item, itemIdx) => {
                                // Store item by ID for safe onclick (avoids URL escaping issues)
                                const mediaId = `media_${msgIdx}_${itemIdx}`;
                                if (bridge) bridge._mediaItems[mediaId] = item;

                                if (item.type === 'image') {
                                    return `
                                        <div class="skillbox-media-item">
                                            <img src="${item.url}" alt="Generiertes Bild"
                                                 class="skillbox-media-preview"
                                                 onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                                            <div class="skillbox-media-error" style="display:none;">
                                                ⚠️ Bild-Vorschau nicht verfügbar
                                            </div>
                                            <div class="skillbox-media-actions">
                                                <button class="skillbox-transfer-btn"
                                                        onclick="window.__skillboxBridge.transferMediaById('${mediaId}')">
                                                    📷 In Mixpost übernehmen
                                                </button>
                                                <button class="skillbox-download-btn"
                                                        onclick="window.__skillboxBridge.downloadMediaById('${mediaId}')">
                                                    ⬇️ Herunterladen
                                                </button>
                                            </div>
                                        </div>
                                    `;
                                }
                                if (item.type === 'video') {
                                    return `
                                        <div class="skillbox-media-item">
                                            <video controls src="${item.url}"
                                                   class="skillbox-media-preview"
                                                   style="max-height:200px;"
                                                   onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                                            </video>
                                            <div class="skillbox-media-error" style="display:none;">
                                                ⚠️ Video-Vorschau nicht verfügbar
                                            </div>
                                            <div class="skillbox-media-actions">
                                                <button class="skillbox-transfer-btn"
                                                        onclick="window.__skillboxBridge.transferMediaById('${mediaId}')">
                                                    🎬 In Mixpost übernehmen
                                                </button>
                                                <button class="skillbox-download-btn"
                                                        onclick="window.__skillboxBridge.downloadMediaById('${mediaId}')">
                                                    ⬇️ Herunterladen
                                                </button>
                                            </div>
                                        </div>
                                    `;
                                }
                                if (item.type === 'audio') {
                                    return `
                                        <div class="skillbox-media-item">
                                            <audio controls src="${item.url}" style="max-width:100%;"></audio>
                                            <div class="skillbox-media-actions">
                                                <button class="skillbox-transfer-btn"
                                                        onclick="window.__skillboxBridge.transferMediaById('${mediaId}')">
                                                    🔊 In Mixpost übernehmen
                                                </button>
                                                <button class="skillbox-download-btn"
                                                        onclick="window.__skillboxBridge.downloadMediaById('${mediaId}')">
                                                    ⬇️ Herunterladen
                                                </button>
                                            </div>
                                        </div>
                                    `;
                                }
                                return '';
                            })
                            .join('');
                    }

                    // "In Editor übernehmen" button for text content
                    // Uses ID-based reference to avoid escaping issues with special characters
                    let insertBtn = '';
                    if (msg.role === 'assistant' && msg.content) {
                        const textId = `text_${msgIdx}`;
                        if (bridge) bridge._texts[textId] = msg.content;
                        insertBtn = `
                            <button class="skillbox-insert-btn"
                                    onclick="window.__skillboxBridge.insertTextById('${textId}')">
                                ✏️ In Editor übernehmen
                            </button>`;
                    }

                    return `
                        <div class="skillbox-message skillbox-message-${roleClass}">
                            <div class="skillbox-message-role">${roleLabel}</div>
                            <div class="skillbox-message-content">${this._formatText(msg.content || '')}</div>
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
            console.log('[Skillbox Bridge] Initializing...', {
                api: CONFIG.skillboxApiUrl,
                tenant: CONFIG.tenant,
            });

            // Load CSS
            this.loadStyles();

            // Inject floating button immediately (always visible when editor exists)
            this.injectFloatingButton();

            // Watch for DOM changes (Mixpost is SPA with Inertia.js)
            this.observeDOM();

            console.log('[Skillbox Bridge] Ready.');
        }

        /**
         * Inject a floating Skillbox button that appears on any page with an editor.
         * This is the primary, reliable method (doesn't depend on toolbar DOM structure).
         */
        injectFloatingButton() {
            if (document.getElementById('skillbox-floating-btn')) return;

            const btn = document.createElement('button');
            btn.id = 'skillbox-floating-btn';
            btn.type = 'button';
            btn.title = 'Skillbox Assistant – Content mit KI erstellen';
            btn.innerHTML = `<span style="font-size:20px;line-height:1">🤖</span>`;
            btn.style.cssText = `
                position: fixed;
                bottom: 80px;
                right: 24px;
                width: 52px;
                height: 52px;
                border-radius: 50%;
                border: 2px solid #c7d2fe;
                background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%);
                color: #4f46e5;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);
                z-index: 9999;
                transition: all 0.2s ease;
                opacity: 0;
                pointer-events: none;
            `;
            btn.onmouseenter = () => {
                btn.style.transform = 'scale(1.1)';
                btn.style.boxShadow = '0 6px 20px rgba(79, 70, 229, 0.4)';
            };
            btn.onmouseleave = () => {
                btn.style.transform = 'scale(1)';
                btn.style.boxShadow = '0 4px 12px rgba(79, 70, 229, 0.3)';
            };
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.togglePanel();
            };

            document.body.appendChild(btn);
            console.log('[Skillbox Bridge] Floating button created (hidden until editor detected).');
        }

        /**
         * Show/hide the floating button based on editor presence.
         */
        updateFloatingButtonVisibility() {
            const btn = document.getElementById('skillbox-floating-btn');
            if (!btn) return;

            const hasEditor = !!document.querySelector('.ProseMirror, [contenteditable="true"]');
            btn.style.opacity = hasEditor ? '1' : '0';
            btn.style.pointerEvents = hasEditor ? 'auto' : 'none';
        }

        loadStyles() {
            if (document.getElementById('skillbox-assistant-styles')) return;

            const link = document.createElement('link');
            link.id = 'skillbox-assistant-styles';
            link.rel = 'stylesheet';
            link.href = '/vendor/mixpost/skillbox-assistant.css';
            document.head.appendChild(link);
        }

        /**
         * Watch for DOM changes and inject the Assistant button
         * when the post editor is detected.
         */
        observeDOM() {
            // Initial check
            this.tryInjectButton();
            this.updateFloatingButtonVisibility();

            // Observe for SPA navigation (debounced)
            let debounceTimer = null;
            this.observer = new MutationObserver(() => {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    this.tryInjectButton();
                    this.updateFloatingButtonVisibility();
                }, 200);
            });

            this.observer.observe(document.body, {
                childList: true,
                subtree: true,
            });
        }

        /**
         * Detect the post editor and inject our button if not already present.
         *
         * Mixpost DOM structure (Vue/Inertia SPA):
         *   <div id="postEditor" class="border border-gray-200 rounded-md...">
         *     <div> <!-- EditorContent wrapper -->
         *       <div class="ProseMirror...">  ← TipTap Editor
         *     </div>
         *     <!-- slot: PostMedia, Toolbar -->
         *     <div class="flex ... border-t ...">  ← Toolbar row
         *       <div class="flex ...">  ← Left buttons (emoji, media, etc.)
         *       <div class="flex ...">  ← Right buttons (charcount, plus)
         *     </div>
         *   </div>
         *
         * Uses multiple strategies to find the right injection point.
         */
        tryInjectButton() {
            // Already injected?
            if (document.querySelector(`.${CONFIG.buttonClass}`)) return;

            // Strategy 1: Find by editor ID (most reliable)
            let editorContainer = document.getElementById('postEditor');

            // Strategy 2: Find by ProseMirror class
            if (!editorContainer) {
                const proseMirror = document.querySelector('.ProseMirror');
                if (!proseMirror) return;

                // Walk up: ProseMirror → EditorContent wrapper → Editor container
                editorContainer = proseMirror.closest('[id="postEditor"]') ||
                                  proseMirror.closest('[class*="border"][class*="rounded"]') ||
                                  proseMirror.parentElement?.parentElement;
            }

            if (!editorContainer) {
                return;
            }

            // Find the toolbar: walk through children to find the one with border-t
            let toolbarRow = null;
            const allChildren = editorContainer.querySelectorAll('*');
            for (const child of allChildren) {
                const cl = child.className;
                if (typeof cl === 'string' && cl.includes('border-t') && cl.includes('flex')) {
                    toolbarRow = child;
                    break;
                }
            }

            // Fallback: find div containing the emoji/media buttons
            if (!toolbarRow) {
                // Look for SVG icons that indicate the toolbar
                const svgs = editorContainer.querySelectorAll('svg');
                for (const svg of svgs) {
                    const parent = svg.closest('[class*="flex"]');
                    if (parent && parent !== editorContainer) {
                        // Go up one more to get the toolbar row
                        const row = parent.parentElement;
                        if (row && row.parentElement === editorContainer) {
                            toolbarRow = row;
                            break;
                        }
                    }
                }
            }

            if (!toolbarRow) {
                console.log('[Skillbox Bridge] Toolbar row not found. Editor children:', 
                    Array.from(editorContainer.children).map(c => ({
                        tag: c.tagName,
                        class: c.className?.substring?.(0, 80),
                        children: c.children?.length
                    }))
                );
                return;
            }

            // Find the left-side button group (first child that is a flex container)
            let buttonGroup = null;
            for (const child of toolbarRow.children) {
                const cl = child.className;
                if (typeof cl === 'string' && cl.includes('flex')) {
                    buttonGroup = child;
                    break;
                }
            }

            if (!buttonGroup) {
                buttonGroup = toolbarRow.children[0] || toolbarRow;
            }

            // Create and inject the Skillbox button
            const btn = document.createElement('button');
            btn.className = CONFIG.buttonClass;
            btn.type = 'button';
            btn.title = 'Content mit Skillbox Assistant erstellen';
            btn.innerHTML = `<span style="font-size:16px">🤖</span><span>Skillbox</span>`;
            btn.style.cssText = `
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 4px 8px;
                border-radius: 6px;
                border: none;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
                color: #4f46e5;
                background: #eef2ff;
                transition: all 0.15s ease;
                white-space: nowrap;
            `;
            btn.onmouseenter = () => {
                btn.style.background = '#c7d2fe';
                btn.style.color = '#3730a3';
            };
            btn.onmouseleave = () => {
                btn.style.background = '#eef2ff';
                btn.style.color = '#4f46e5';
            };
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.togglePanel();
            };

            buttonGroup.appendChild(btn);
            console.log('[Skillbox Bridge] ✅ Assistant button injected into editor toolbar.');
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

                console.log('[Skillbox Bridge] Response:', JSON.stringify(response).substring(0, 300));

                // Extract text content from Skillbox API response format:
                // { success: true, data: { message: { content: "...", role: "assistant" } } }
                const msg = response?.data?.message || response?.message || response;
                const rawText = msg?.content || response?.content || response?.text || '';

                // Extract media items from structured plugin results
                let mediaItems = this.extractMediaItems(response?.data || response);

                // Also extract media URLs embedded in the text content
                // (e.g. <!-- IMAGE_URL: https://... --> from image generation plugins)
                const textMedia = this.extractMediaFromText(rawText);
                mediaItems = [...mediaItems, ...textMedia.items];

                // Use cleaned text for display (without URL markers)
                const displayText = textMedia.cleanText;

                if (mediaItems.length > 0) {
                    console.log(`[Skillbox Bridge] Found ${mediaItems.length} media item(s) in response.`);
                }

                this.panel.addMessage('assistant', displayText, mediaItems);
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
                        presigned: (result.url || '').includes('X-Amz-'),
                    });
                }
                if (result.type === 'audio' || result.mimeType?.startsWith('audio/')) {
                    items.push({
                        type: 'audio',
                        url: result.url || result.data?.url,
                        filename: result.filename || 'generated-audio.mp3',
                        presigned: (result.url || '').includes('X-Amz-'),
                    });
                }
                if (result.type === 'video' || result.mimeType?.startsWith('video/')) {
                    items.push({
                        type: 'video',
                        url: result.url || result.data?.url,
                        filename: result.filename || 'generated-video.mp4',
                        presigned: (result.url || '').includes('X-Amz-'),
                    });
                }
            }

            return items;
        }

        /**
         * Extract media URLs embedded in the assistant's text content.
         * Handles patterns like:
         *   - <!-- IMAGE_URL: https://... -->
         *   - ![alt](https://...image.jpg)
         *   - Plain image URLs (https://...image.jpg?...)
         *
         * Returns { cleanText, items[] }
         */
        extractMediaFromText(text) {
            if (!text) return { cleanText: '', items: [] };

            const items = [];
            let cleanText = text;
            const seenUrls = new Set();

            // Pattern 1: <!-- IMAGE_URL: https://... -->
            const commentRegex = /<!--\s*IMAGE_URL:\s*(https?:\/\/[^\s>]+?)\s*-->/gi;
            let match;
            while ((match = commentRegex.exec(text)) !== null) {
                const url = match[1];
                if (!seenUrls.has(url)) {
                    seenUrls.add(url);
                    items.push({
                        type: 'image',
                        url: url,
                        filename: this._extractFilename(url) || 'generated-image.jpg',
                        presigned: url.includes('X-Amz-'),
                    });
                }
                cleanText = cleanText.replace(match[0], '');
            }

            // Pattern 2: Markdown images ![alt](url)
            const mdImageRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi;
            while ((match = mdImageRegex.exec(text)) !== null) {
                const url = match[2];
                if (!seenUrls.has(url)) {
                    seenUrls.add(url);
                    const mediaType = this._detectMediaType(url);
                    items.push({
                        type: mediaType,
                        url: url,
                        filename: this._extractFilename(url) || match[1] || 'image.png',
                        presigned: url.includes('X-Amz-'),
                    });
                }
                cleanText = cleanText.replace(match[0], '');
            }

            // Pattern 3: Markdown links with media URLs [label](url)
            // (e.g. [Video ansehen](https://...mp4))
            const mdLinkRegex = /\[([^\]]*)\]\((https?:\/\/[^\s)]+?\.(mp4|webm|mov|avi|mp3|wav|ogg|jpg|jpeg|png|gif|webp|svg)(\?[^\s)]*)?)\)/gi;
            while ((match = mdLinkRegex.exec(text)) !== null) {
                const url = match[2];
                if (!seenUrls.has(url)) {
                    seenUrls.add(url);
                    const mediaType = this._detectMediaType(url);
                    items.push({
                        type: mediaType,
                        url: url,
                        filename: this._extractFilename(url) || match[1] || 'media.' + match[3],
                        presigned: url.includes('X-Amz-'),
                    });
                }
                cleanText = cleanText.replace(match[0], '');
            }

            // Pattern 4: Plain media URLs ending in known extensions
            const plainRegex = /(https?:\/\/[^\s]+?\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg)(\?[^\s]*)?)/gi;
            while ((match = plainRegex.exec(text)) !== null) {
                const url = match[1];
                if (!seenUrls.has(url)) {
                    seenUrls.add(url);
                    const mediaType = this._detectMediaType(url);
                    items.push({
                        type: mediaType,
                        url: url,
                        filename: this._extractFilename(url) || 'media.' + match[2],
                        presigned: url.includes('X-Amz-'),
                    });
                }
                cleanText = cleanText.replace(match[0], '');
            }

            // Clean up excess whitespace and trailing labels
            cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();
            cleanText = cleanText.replace(/Details:\s*$/i, '').trim();

            return { cleanText, items };
        }

        /**
         * Extract filename from a URL path.
         */
        _extractFilename(url) {
            try {
                const path = new URL(url).pathname;
                const parts = path.split('/');
                return parts[parts.length - 1] || null;
            } catch {
                return null;
            }
        }

        /**
         * Detect media type from URL extension.
         */
        _detectMediaType(url) {
            const lower = url.toLowerCase();
            if (/\.(mp4|webm|mov|avi)(\?|$)/.test(lower)) return 'video';
            if (/\.(mp3|wav|ogg|m4a|flac)(\?|$)/.test(lower)) return 'audio';
            return 'image';
        }

        /**
         * Insert text into the Mixpost editor (direct call).
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
         * Insert text by stored ID (used by onclick handlers to avoid escaping issues).
         */
        insertTextById(textId) {
            const text = this._texts?.[textId];
            if (!text) {
                console.warn('[Skillbox Bridge] No text found for ID:', textId);
                return;
            }
            this.insertText(text);
        }

        /**
         * Transfer media by stored ID (used by onclick handlers).
         */
        async transferMediaById(mediaId) {
            const item = this._mediaItems?.[mediaId];
            if (!item) {
                console.warn('[Skillbox Bridge] No media item found for ID:', mediaId);
                return;
            }
            await this.transferMedia(item.url, item.filename, item.presigned);
        }

        /**
         * Download media by stored ID (fallback: save to disk).
         */
        downloadMediaById(mediaId) {
            const item = this._mediaItems?.[mediaId];
            if (!item) return;
            this._downloadFile(item.url, item.filename);
        }

        /**
         * Transfer media from Skillbox/S3 to Mixpost's media library.
         *
         * Flow:
         * 1. Download the image via Skillbox backend proxy (avoids CORS issues with S3)
         * 2. Upload the blob to Mixpost's media library (uses Mixpost session cookie)
         *
         * The proxy is needed because browsers block cross-origin fetch() to S3
         * from the Mixpost domain, even for presigned URLs.
         */
        async transferMedia(url, filename, presigned = false) {
            try {
                this.showToast('Lade Bild herunter...');

                let blob;
                try {
                    // Use Skillbox backend proxy to avoid CORS issues
                    const token = await this.tokenManager.ensureAuthenticated();
                    const proxyUrl = `${CONFIG.skillboxApiUrl}/api/social/media-proxy?url=${encodeURIComponent(url)}`;
                    console.log('[Skillbox Bridge] Fetching media via proxy...');

                    const res = await fetch(proxyUrl, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'x-social-media-request': 'true',
                        },
                    });

                    if (!res.ok) throw new Error(`Proxy download fehlgeschlagen: ${res.status}`);
                    blob = await res.blob();
                } catch (proxyErr) {
                    console.warn('[Skillbox Bridge] Proxy fetch failed, trying direct:', proxyErr.message);
                    // Fallback: try direct fetch (might work if CORS is configured on S3)
                    const res = await fetch(url);
                    if (!res.ok) throw new Error(`Download fehlgeschlagen: ${res.status}`);
                    blob = await res.blob();
                }

                console.log(`[Skillbox Bridge] Downloaded blob: ${blob.size} bytes, type: ${blob.type}`);
                this.showToast('Lade in Mixpost Medien-Bibliothek...');

                const mediaResult = await MixpostIntegration.uploadMedia(blob, filename);
                this.showToast('Bild in Medien-Bibliothek gespeichert! ✅');
                console.log('[Skillbox Bridge] Media uploaded to Mixpost:', mediaResult);

            } catch (err) {
                console.error('[Skillbox Bridge] Media transfer failed:', err);
                this.showToast(`Fehler beim Übernehmen: ${err.message}`);
            }
        }

        /**
         * Trigger a file download in the browser.
         */
        _downloadFile(url, filename) {
            const a = document.createElement('a');
            a.href = url;
            a.download = filename || 'download';
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            this.showToast('Download gestartet');
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
