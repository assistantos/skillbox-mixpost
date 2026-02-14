<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Anmeldung...</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: #f8fafc;
            color: #4f46e5;
        }
        .loader {
            text-align: center;
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid #e0e7ff;
            border-top-color: #4f46e5;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 0 auto 16px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="loader">
        <div class="spinner"></div>
        <p>Verbindung zu Skillbox wird hergestellt...</p>
    </div>
    <script>
        try {
            localStorage.setItem('{{ $storageKey }}', '{{ $token }}');
            console.log('[Skillbox SSO] Token stored in localStorage');
        } catch (e) {
            console.error('[Skillbox SSO] Failed to store token:', e);
        }
        window.location.href = '{{ $redirectPath }}';
    </script>
</body>
</html>
