interface EnvConfig {
    PORT: number;
    NODE_ENV: string;
    MONGO_URI: string;
    REDIS_URL: string;
    JWT_SECRET: string;
    ROOM_CODE_LENGTH: number;
    DEFAULT_ROOM_EXP_HOURS: number;
    MAX_FILE_SIZE_BYTES: number;
    BASE_URL: string;
    BACKEND_URL: string;
    SITE_TITLE: string;
    SITE_DESCRIPTION: string;
    DEFAULT_OG_IMAGE: string;
    FRONTEND_URL?: string;
    GCS_BUCKET?: string;
    GCS_PROJECT_ID?: string;
    GCS_CLIENT_EMAIL?: string;
    GCS_PRIVATE_KEY?: string;
    GOOGLE_API_KEY?: string;
    ADMIN_SECRET?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    GOOGLE_OAUTH_REDIRECT_URI?: string;
    USER_JWT_SECRET?: string;
    MONGO_MAX_POOL_SIZE: number;
    MONGO_MIN_POOL_SIZE: number;
    /** Comma-separated emails always treated as admin (RBAC bootstrap — auto-promoted on first check). */
    PERMANENT_ADMIN_EMAILS?: string;
    /** Razorpay live/test key pair for the donation gateway. Donations report "disabled" when unset. */
    RAZORPAY_KEY_ID?: string;
    RAZORPAY_KEY_SECRET?: string;
    /** Secret configured on the Razorpay webhook (Dashboard → Webhooks) — HMAC-verifies /api/donations/webhook. */
    RAZORPAY_WEBHOOK_SECRET?: string;
    /** Comma-separated emails granted Super Admin Ghost Mode (invisible room monitoring). Verified server-side only. */
    GHOST_MODE_ADMIN_EMAILS: string;
    /**
     * When false, index.ts skips starting the in-process setInterval workers
     * (cleanup, auto-vanish, subscription-expiry) at boot. Use this once those
     * jobs are driven externally instead (e.g. Cloud Scheduler hitting
     * POST /api/admin/maintenance/run) so the instance no longer needs a
     * continuously-running timer to stay correct, and can be allowed to fully
     * scale to zero between requests. Defaults to true — existing deployments
     * and local/docker-compose dev are unaffected until this is set.
     */
    ENABLE_IN_PROCESS_TIMERS: boolean;
}
export declare const env: EnvConfig;
export {};
//# sourceMappingURL=env.d.ts.map