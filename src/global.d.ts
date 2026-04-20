declare global {
  interface Window {
    agentory?: {
      loadState: (key: string) => Promise<string | null>;
      saveState: (key: string, value: string) => Promise<void>;
      getDataDir: () => Promise<string>;
      getVersion: () => Promise<string>;
      getApiKey: () => Promise<string>;
      setApiKey: (value: string) => Promise<boolean>;
      hasEncryption: () => Promise<boolean>;
    };
  }
}

export {};
