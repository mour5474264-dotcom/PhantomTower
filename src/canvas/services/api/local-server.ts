import { modelOptionName } from '@canvas/stores/use-config-store';

export function localGenerationUrl(kind: 'text' | 'audio' | 'video', model: string, taskId?: string, content = false) {
    const task = taskId ? `/${encodeURIComponent(taskId)}${content ? '/content' : ''}` : '';
    const path = kind === 'video' ? 'videos' : `canvas/${kind}`;
    return `http://127.0.0.1:4317/api/${path}${task}?model=${encodeURIComponent(modelOptionName(model))}`;
}

export async function localServerHeaders(): Promise<Record<string, string>> {
    type BridgeWindow = Window & { phantomTowerServer?: { getToken?: () => Promise<string> } };
    const own = window as BridgeWindow;
    let bridge = own.phantomTowerServer;
    try { bridge ||= (window.parent as BridgeWindow).phantomTowerServer; } catch { /* Cross-origin standalone host. */ }
    const token = await bridge?.getToken?.().catch(() => '') || '';
    return token ? { Authorization: `Bearer ${token}` } : {};
}
