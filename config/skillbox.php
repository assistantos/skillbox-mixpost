<?php

return [
    /*
    |--------------------------------------------------------------------------
    | Skillbox API URL
    |--------------------------------------------------------------------------
    |
    | The base URL of the Skillbox backend API. Used for SSO token validation
    | and communication between Mixpost and Skillbox.
    |
    */
    'api_url' => env('SKILLBOX_API_URL', 'http://localhost:3001'),

    /*
    |--------------------------------------------------------------------------
    | Skillbox Tenant
    |--------------------------------------------------------------------------
    |
    | Default tenant identifier for this Mixpost instance.
    | Used by the Bridge-Script to identify the Skillbox tenant.
    |
    */
    'tenant' => env('SKILLBOX_TENANT', 'dev'),
];
