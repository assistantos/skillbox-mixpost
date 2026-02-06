<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use App\Models\User;
use Inovector\Mixpost\Models\Workspace;

/**
 * SkillboxSsoController
 *
 * Handles SSO authentication from Skillbox into Mixpost.
 * Validates a Skillbox JWT token, auto-provisions the user
 * and workspace if needed, and logs the user in.
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

        $response = Http::withToken($token)
            ->timeout(10)
            ->get("{$skillboxApiUrl}/api/auth/validate");

        if (!$response->ok()) {
            abort(401, 'Invalid or expired Skillbox token');
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

        // 3. Find or create workspace (maps to Skillbox tenant)
        $workspace = Workspace::where('hex_color', $skillboxUser['tenantId'])->first();

        if (!$workspace) {
            $workspace = Workspace::create([
                'name' => $skillboxUser['tenantName'] ?? $skillboxUser['tenantSlug'],
                'hex_color' => $skillboxUser['tenantId'], // Store Skillbox tenant ID in hex_color field
            ]);
        }

        // 4. Attach user to workspace if not already
        if (!$workspace->users()->where('user_id', $user->id)->exists()) {
            $workspace->users()->attach($user->id, [
                'role' => $this->mapRole($skillboxUser['role'] ?? 'user'),
                'joined' => true,
            ]);
        }

        // 5. Log the user in via Laravel Auth
        Auth::login($user);

        // 6. Set current workspace in session
        session(['current_workspace_id' => $workspace->id]);

        // 7. Redirect to Mixpost workspace dashboard
        $corePath = config('mixpost.core_path', 'mixpost');

        return redirect("/{$corePath}/{$workspace->uuid}");
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
