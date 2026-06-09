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
}
export declare const env: EnvConfig;
export {};
//# sourceMappingURL=env.d.ts.map