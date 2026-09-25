/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_FACTORY?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_DEFAULT_KEEPER?: string;
  readonly VITE_FROM_BLOCK?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
