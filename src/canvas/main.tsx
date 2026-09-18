import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@canvas/components/layout/app-providers";
import "@canvas/i18n";
import { initAnalytics } from "@canvas/lib/analytics";
import { router } from "@canvas/router";
import { useConfigStore } from "@canvas/stores/use-config-store";

type DesktopBridge = { phantomTowerServer?: { getToken?: () => Promise<string> } };

// The canvas has its own document to keep its UI lifecycle isolated, but it
// still reads the active Sample Factory workspace when it starts.
async function syncSampleFactoryConfig() {
    // Clear the imported canvas's persisted/default models first. From this
    // point on the only source of truth is Sample Factory's /api/models.
    useConfigStore.setState((current) => ({
        ...current,
        config: {
            ...current.config,
            channelMode: "local",
            channels: [],
            models: [],
            model: "",
            imageModel: "",
            videoModel: "",
            textModel: "",
            audioModel: "",
        },
    }));
    try {
        const ownWindow = window as Window & DesktopBridge;
        const parentWindow = window.parent as Window & DesktopBridge;
        const bridge = ownWindow.phantomTowerServer || (parentWindow !== window ? parentWindow.phantomTowerServer : undefined);
        const token = await bridge?.getToken?.().catch(() => "") || "";
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const [settingsResponse, modelsResponse] = await Promise.all([
            fetch("http://127.0.0.1:4317/api/settings", { headers }),
            fetch("http://127.0.0.1:4317/api/models", { headers }),
        ]);
        if (!settingsResponse.ok || !modelsResponse.ok) return;
        const settings = await settingsResponse.json();
        const canvas = settings.preferences?.canvas || {};
        const modelPayload = await modelsResponse.json();
        const active = (settings.apis || []).find((item: { id: string }) => item.id === settings.activeApiId) || settings.apis?.[0];
        if (!active) return;
        const upstreamModels = (modelPayload.data || modelPayload.models || []) as Array<string | { id?: string; name?: string; modelName?: string; protocol?: string; provider?: string }>;
        // `id` is Sample Factory's stable route ID; `name` is what a person
        // selected in API management. Keep both instead of showing UUIDs.
        const mappedModels = upstreamModels.map((item) => {
            if (typeof item === "string") return { id: item, label: item, apiFormat: active.provider === "gemini" ? "gemini" as const : "openai" as const };
            return { id: String(item.id || item.modelName || item.name || "").trim(), label: String(item.name || item.modelName || item.id || "").trim(), apiFormat: item.protocol?.startsWith("gemini") || item.provider === "gemini" ? "gemini" as const : "openai" as const };
        }).filter((item) => item.id);
        const names = mappedModels.map((item) => item.id);
        const channelId = active.id || "phantom-tower";
        const models = names.map((name) => `${channelId}::${name}`);
        useConfigStore.setState((current) => ({
            ...current,
            config: {
                ...current.config,
                channelMode: "local",
                // Do not infer capability from model names. Every picker uses
                // this exact API-management list, just like the workbench.
                channels: [{ id: channelId, name: active.name || "样片工厂", baseUrl: active.endpoint || active.baseUrl || "", apiKey: "", apiFormat: active.provider === "gemini" ? "gemini" : "openai", models: mappedModels.map(({ id, label, apiFormat }) => ({ name: id, label, apiFormat, capability: "image" })) }],
                models,
                model: models[0] || "",
                imageModel: models[0] || "",
                videoModel: models[0] || "",
                textModel: models[0] || "",
                audioModel: models[0] || "",
                canvasImageCount: String(canvas.imageCount || current.config.canvasImageCount || "3"),
                size: String(canvas.size || current.config.size || "1:1"),
                quality: String(canvas.quality || current.config.quality || "auto"),
            },
        }));
    } catch {
        // A missing optional local service must never prevent the canvas UI from opening.
    }
}

async function startCanvas() {
    // Do not briefly render the imported project's persisted defaults (such
    // as gpt-5.5) before the active Sample Factory workspace is available.
    await syncSampleFactoryConfig();
    initAnalytics();
    document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';
    createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
            </AppProviders>
        </React.StrictMode>,
    );
}

void startCanvas();
