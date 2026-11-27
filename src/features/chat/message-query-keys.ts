const messageQueryRoot = ['unified-messages'] as const;

export const messageQueryKeys = {
  all: messageQueryRoot,
  device: (deviceId: string) => [...messageQueryRoot, deviceId] as const,
  chat: (deviceId: string, chatJid: string) =>
    [...messageQueryRoot, deviceId, chatJid] as const,
  history: (deviceId: string, chatJid: string, search = '', mediaOnly = false) =>
    [...messageQueryRoot, deviceId, chatJid, search, mediaOnly] as const,
};

const chatLifecycleQueryRoot = ['chat-lifecycle'] as const;

export const chatLifecycleQueryKeys = {
  all: chatLifecycleQueryRoot,
  chat: (deviceId: string, chatJid: string) =>
    [...chatLifecycleQueryRoot, deviceId, chatJid] as const,
};
