import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "antd/dist/reset.css";
import "@canvas/styles/globals.css";
import "@canvas/i18n";
import { useConfigStore } from "@canvas/stores/use-config-store";
import CanvasPage from "@canvas/pages/canvas";
import CanvasProjectPage from "@canvas/pages/canvas/project";

type DesktopBridge = { phantomTowerServer?: { getToken?: () => Promise<string> } };

class CanvasErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
    state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("Canvas render failed", error, info.componentStack);
    }

    render() {
        if (!this.state.error) return this.props.children;
        return (
            <main style={{ padding: 24, color: "#b42318", fontFamily: "sans-serif" }}>
                <h2>无限画布加载失败</h2>
                <pre style={{ whiteSpace: "pre-wrap" }}>{this.state.error.message}</pre>
            </main>
        );
    }
}

async function syncPhantomTowerConfig() {
    try {
        const bridge = window as Window & DesktopBridge;
        const token = await bridge.phantomTowerServer?.getToken?.().catch(() => "");
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const [settingsResponse, modelsResponse] = await Promise.all([
            fetch("http://127.0.0.1:4317/api/settings", { headers }),
            fetch("http://127.0.0.1:4317/api/models", { headers }),
        ]);
        if (!settingsResponse.ok || !modelsResponse.ok) return;
        const settings = await settingsResponse.json();
        const canvasPreferences = settings.preferences?.canvas || {};
        const modelPayload = await modelsResponse.json();
        const active = (settings.apis || []).find((item: { id: string }) => item.id === settings.activeApiId) || settings.apis?.[0];
        if (!active) return;
        const names = (modelPayload.data || modelPayload.models || []).map((item: string | { id?: string; name?: string }) => typeof item === "string" ? item : item.id || item.name).filter(Boolean);
        const capability = (name: string) => /video|sora|veo|kling|wan|hailuo/i.test(name) ? "video" : /audio|tts|speech|voice|music|sound/i.test(name) ? "audio" : /image|dall|flux|sdxl|stable|imagen|seedream|midjourney/i.test(name) ? "image" : "text";
        const channelId = active.id || "phantom-tower";
        const models = names.map((name: string) => `${channelId}::${name}`);
        // Update the live Zustand store as well as its persisted state.  Writing
        // localStorage alone leaves an already-mounted canvas on stale models.
        useConfigStore.setState((current) => ({
            ...current,
            config: {
                ...current.config,
                channelMode: "local",
                channels: [{ id: channelId, name: active.name || "PhantomTower", baseUrl: active.endpoint || active.baseUrl || "", apiKey: "", apiFormat: active.provider === "gemini" ? "gemini" : "openai", models: names.map((name: string) => ({ name, capability: capability(name) })) }],
                models,
                model: models[0] || current.config.model || "",
                imageModel: models.find((name: string) => capability(name) === "image") || models[0] || "",
                videoModel: models.find((name: string) => capability(name) === "video") || "",
                audioModel: models.find((name: string) => capability(name) === "audio") || "",
                textModel: models.find((name: string) => capability(name) === "text") || "",
                canvasImageCount: String(canvasPreferences.imageCount || current.config.canvasImageCount || "3"),
                size: String(canvasPreferences.size || current.config.size || "1:1"),
                quality: String(canvasPreferences.quality || current.config.quality || "auto"),
            },
        }));
        localStorage.setItem("phantom-tower:canvas_preferences", JSON.stringify(canvasPreferences));
    } catch {
        // Canvas rendering must not depend on the optional local configuration service.
    }
}

function CanvasModule() {
    return (
        <ConfigProvider>
            <App>
                {/* Do not redirect on mount. The host has its own router and a
                    mount-time redirect can race persisted project hydration,
                    producing the repeated blank/reload cycle. */}
                <MemoryRouter initialEntries={["/canvas"]}>
                    <Routes>
                        <Route path="/canvas" element={<CanvasPage />} />
                        <Route path="/canvas/:id" element={<CanvasProjectPage />} />
                    </Routes>
                </MemoryRouter>
            </App>
        </ConfigProvider>
    );
}

export async function mountCanvasReact(element: HTMLElement): Promise<Root> {
    const root = createRoot(element);
    root.render(<CanvasErrorBoundary><CanvasModule /></CanvasErrorBoundary>);
    // Configuration sync is optional and must never block the canvas from mounting.
    void syncPhantomTowerConfig();
    const resync = () => void syncPhantomTowerConfig();
    window.addEventListener("sample-factory-active-api-changed", resync);
    window.addEventListener("sample-factory-canvas-settings-changed", resync);
    const unmount = root.unmount.bind(root);
    root.unmount = () => {
        window.removeEventListener("sample-factory-active-api-changed", resync);
        window.removeEventListener("sample-factory-canvas-settings-changed", resync);
        unmount();
    };
    return root;
}
