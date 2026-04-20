declare global {
  interface Window {
    agentory?: {
      loadState: (key: string) => Promise<string | null>;
      saveState: (key: string, value: string) => Promise<void>;
    };
  }
}

export {};
