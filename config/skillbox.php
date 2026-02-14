<?php

return [
    /*
    |--------------------------------------------------------------------------
    | Skillbox API URL (Server-to-Server)
    |--------------------------------------------------------------------------
    |
    | The base URL of the Skillbox backend API for server-side communication.
    | Used by SkillboxSsoController for token validation (container-to-container).
    | Must be set via SKILLBOX_API_URL environment variable.
    |
    */
    'api_url' => env('SKILLBOX_API_URL'),

    /*
    |--------------------------------------------------------------------------
    | Skillbox Browser URL (Client-Side)
    |--------------------------------------------------------------------------
    |
    | The URL that the user's browser uses to reach Skillbox.
    | Used by the Bridge-Script (runs in user's browser, not in Docker).
    | Must be set via SKILLBOX_BROWSER_URL environment variable.
    |
    */
    'browser_url' => env('SKILLBOX_BROWSER_URL'),

    /*
    |--------------------------------------------------------------------------
    | Skillbox Tenant
    |--------------------------------------------------------------------------
    |
    | Default tenant identifier for this Mixpost instance.
    | Used by the Bridge-Script to identify the Skillbox tenant.
    |
    */
    'tenant' => env('SKILLBOX_TENANT', 'default'),
];
