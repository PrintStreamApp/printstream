/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
	readonly VITE_API_BASE_URL?: string
	readonly VITE_DOMAIN_MIGRATION_TARGET?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
