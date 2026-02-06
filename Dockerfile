# Skillbox-Mixpost: Official Mixpost + Skillbox Assistant Integration
# Extends the official image with SSO, Bridge-Script, and Theming

FROM inovector/mixpost:latest

# Copy Skillbox SSO Controller
COPY app/Http/Controllers/SkillboxSsoController.php /var/www/html/app/Http/Controllers/

# Copy Skillbox config
COPY config/skillbox.php /var/www/html/config/

# Copy Bridge-Script and CSS to public assets
COPY resources/dist/vendor/mixpost/skillbox-assistant-bridge.js /var/www/html/public/vendor/mixpost/
COPY resources/dist/vendor/mixpost/skillbox-assistant.css /var/www/html/public/vendor/mixpost/
COPY resources/dist/vendor/mixpost/skillbox-logo.svg /var/www/html/public/vendor/mixpost/

# Copy modified source files
COPY resources/js/Services/emitter.js /var/www/html/resources/js/Services/
COPY resources/views/app.blade.php /var/www/html/resources/views/
COPY resources/css/skillbox-theme.css /var/www/html/resources/css/
COPY resources/css/app.css /var/www/html/resources/css/
COPY routes/web.php /var/www/html/routes/

# Ensure correct permissions
RUN chown -R www-data:www-data /var/www/html/app/Http/Controllers/SkillboxSsoController.php \
    /var/www/html/config/skillbox.php \
    /var/www/html/public/vendor/mixpost/skillbox-assistant-bridge.js \
    /var/www/html/public/vendor/mixpost/skillbox-assistant.css \
    /var/www/html/public/vendor/mixpost/skillbox-logo.svg
