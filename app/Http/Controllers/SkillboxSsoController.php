<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use App\Models\User;

/**
 * SkillboxSsoController
 *
 * Handles SSO authentication from Skillbox into Mixpost.
 * Validates a Skillbox JWT token, auto-provisions the user
 * and logs the user in.
 *
 * Supports both Community (single workspace) and Enterprise (multi-workspace).
 * - Community: Creates user, logs in, redirects to /mixpost
 * - Enterprise: Additionally creates/assigns workspace per Skillbox tenant
 *
 * Usage: GET /auth/skillbox?token={skillbox-jwt-token}
 */
class SkillboxSsoController extends Controller
{
    /**
     * Handle SSO login from Skillbox.
     */
    public function login(Request $request)
    {
        $token = $request->query('token');

        if (!$token) {
            abort(400, 'Missing Skillbox token');
        }

        // 1. Validate token against Skillbox API
        $skillboxApiUrl = config('skillbox.api_url');

        try {
            $response = Http::withToken($token)
                ->timeout(10)
                ->get("{$skillboxApiUrl}/api/social/validate");
        } catch (\Exception $e) {
            \Log::error('Skillbox SSO: Failed to connect to Skillbox API', [
                'url' => "{$skillboxApiUrl}/api/social/validate",
                'error' => $e->getMessage(),
            ]);
            abort(502, 'Cannot reach Skillbox API: ' . $e->getMessage());
        }

        if (!$response->ok()) {
            \Log::warning('Skillbox SSO: Token validation failed', [
                'status' => $response->status(),
                'body' => $response->body(),
            ]);
            abort(401, 'Invalid or expired Skillbox token (status: ' . $response->status() . ')');
        }

        $skillboxUser = $response->json();

        // Expected response:
        // {
        //   "id": "uuid",
        //   "email": "user@example.com",
        //   "name": "Max Mustermann",
        //   "tenantId": "uuid",
        //   "tenantSlug": "firma-abc",
        //   "tenantName": "Firma ABC",
        //   "role": "admin"
        // }

        \Log::info('Skillbox SSO: Token validated', [
            'email' => $skillboxUser['email'],
            'tenant' => $skillboxUser['tenantSlug'] ?? 'unknown',
        ]);

        // 2. Find or create Mixpost user
        $user = User::firstOrCreate(
            ['email' => $skillboxUser['email']],
            [
                'name' => $skillboxUser['name'] ?? $skillboxUser['email'],
                'password' => Hash::make(Str::random(32)),
            ]
        );

        // Update name if changed
        if ($user->name !== ($skillboxUser['name'] ?? $skillboxUser['email'])) {
            $user->update(['name' => $skillboxUser['name']]);
        }

        // 3. Handle workspace assignment (Enterprise only)
        $redirectPath = $this->handleWorkspace($user, $skillboxUser);

        // 4. Log the user in via Laravel Auth
        Auth::login($user);

        // 5. Regenerate session for security
        $request->session()->regenerate();

        \Log::info('Skillbox SSO: User logged in', [
            'userId' => $user->id,
            'email' => $user->email,
            'redirect' => $redirectPath,
        ]);

        // 6. Return an intermediate page that stores the token in localStorage
        //    and then redirects to the dashboard.
        //    This avoids cookie size limits (JWT tokens are too large for nginx).
        return response()->view('skillbox-sso-redirect', [
            'token' => $token,
            'redirectPath' => $redirectPath,
            'storageKey' => 'skillbox_social_token',
        ]);
    }

    /**
     * Handle workspace creation/assignment.
     * Returns the redirect path.
     *
     * Community Edition: No workspace model, redirect to /mixpost
     * Enterprise Edition: Create workspace per tenant, redirect to /mixpost/{uuid}
     */
    private function handleWorkspace(User $user, array $skillboxUser): string
    {
        $corePath = config('mixpost.core_path', 'mixpost');

        // Check if Enterprise Workspace model is available
        $enterpriseWorkspaceClass = 'Inovector\\MixpostEnterprise\\Models\\Workspace';

        if (!class_exists($enterpriseWorkspaceClass)) {
            // Community Edition: No workspaces, just redirect to main dashboard
            \Log::info('Skillbox SSO: Community Edition detected, skipping workspace setup');
            return "/{$corePath}";
        }

        // Enterprise Edition: Create/assign workspace per Skillbox tenant
        \Log::info('Skillbox SSO: Enterprise Edition detected, setting up workspace', [
            'tenantId' => $skillboxUser['tenantId'] ?? 'unknown',
        ]);

        try {
            // Find workspace by Skillbox tenant ID (stored in hex_color as identifier)
            $workspace = $enterpriseWorkspaceClass::where('hex_color', $skillboxUser['tenantId'])->first();

            if (!$workspace) {
                $workspace = $enterpriseWorkspaceClass::create([
                    'name' => $skillboxUser['tenantName'] ?? $skillboxUser['tenantSlug'],
                    'hex_color' => $skillboxUser['tenantId'],
                ]);

                \Log::info('Skillbox SSO: Created new workspace', [
                    'workspaceId' => $workspace->id,
                    'name' => $workspace->name,
                ]);
            }

            // Attach user to workspace if not already
            if (!$workspace->users()->where('user_id', $user->id)->exists()) {
                $workspace->users()->attach($user->id, [
                    'role' => $this->mapRole($skillboxUser['role'] ?? 'user'),
                    'joined' => true,
                ]);
            }

            // Set current workspace in session
            session(['current_workspace_id' => $workspace->id]);

            return "/{$corePath}/{$workspace->uuid}";
        } catch (\Exception $e) {
            \Log::warning('Skillbox SSO: Enterprise workspace setup failed, falling back to main dashboard', [
                'error' => $e->getMessage(),
            ]);
            return "/{$corePath}";
        }
    }

    /**
     * Map Skillbox role to Mixpost role.
     */
    private function mapRole(string $skillboxRole): string
    {
        return match ($skillboxRole) {
            'owner', 'admin' => 'admin',
            'user' => 'editor',
            'viewer' => 'viewer',
            default => 'editor',
        };
    }
}
