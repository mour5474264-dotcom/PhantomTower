import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
//#region server/index.js
var dataDir = process.env.PHANTOMTOWER_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "../data");
var generatedDir = path.join(dataDir, "generated");
var exportDir = process.env.PHANTOMTOWER_EXPORT_DIR || path.join(dataDir, "export");
var files = {
	settings: path.join(dataDir, "settings.json"),
	records: path.join(dataDir, "generation-records.json"),
	presets: path.join(dataDir, "presets.json"),
	builtInPresets: path.join(dataDir, "builtin-presets.json"),
	promptTemplates: path.join(dataDir, "prompt-templates.json"),
	defaultPromptTemplates: path.join(dataDir, "prompt-templates.defaults.json"),
	builtInPromptTemplates: path.join(dataDir, "builtin-prompt-templates.json"),
	defaultBuiltInPromptTemplates: path.join(dataDir, "builtin-prompt-templates.defaults.json"),
	promptTemplateHistory: path.join(dataDir, "prompt-template-history.json"),
	imageCache: path.join(dataDir, "image-cache.json")
};
var activeGenerations = /* @__PURE__ */ new Map();
var recordsWriteQueue = Promise.resolve();
var imageGenerationTimeoutMs = 9e4;
function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
async function read(file, fallback) {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return fallback;
	}
}
async function write(file, data) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
		for (let attempt = 0; attempt < 6; attempt += 1) try {
			await fs.rename(temporary, file);
			return;
		} catch (error) {
			if (![
				"EPERM",
				"EACCES",
				"EBUSY"
			].includes(error.code) || attempt === 5) throw error;
			await wait(40 * (attempt + 1));
		}
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => null);
		throw error;
	}
}
function normalizePromptTemplate(template, previous = {}) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const contentChanged = [
		"name",
		"mode",
		"operation",
		"systemPrompt",
		"defaultNegativePrompt"
	].some((key) => String(template?.[key] || "") !== String(previous?.[key] || ""));
	return {
		id: String(template?.id || previous.id || crypto.randomUUID()),
		name: String(template?.name || "").trim(),
		mode: [
			"text",
			"image",
			"all"
		].includes(template?.mode) ? template.mode : previous.mode || "all",
		operation: [
			"all",
			"text",
			"batch",
			"three-view",
			"fusion",
			"background",
			"prop",
			"edit"
		].includes(template?.operation) ? template.operation : previous.operation || "all",
		systemPrompt: String(template?.systemPrompt || ""),
		defaultNegativePrompt: String(template?.defaultNegativePrompt || ""),
		updatedAt: contentChanged || !previous.id ? now : previous.updatedAt,
		version: contentChanged || !previous.id ? Math.max(1, Number(previous.version || 0) + 1) : previous.version
	};
}
function promptTemplateMatches(template, mode, operation) {
	const normalizedOperation = {
		"local-edit": "edit",
		reference: "batch",
		"prop-replace": "prop"
	}[operation] || operation;
	return template && (template.mode === "all" || template.mode === mode) && (!template.operation || template.operation === "all" || template.operation === normalizedOperation);
}
async function savePromptTemplates(value, targetFile = files.promptTemplates) {
	if (!Array.isArray(value)) throw new Error("prompt templates must be an array");
	const current = await read(targetFile, []);
	const existing = new Map(current.map((item) => [item.id, item]));
	const templates = value.map((item) => normalizePromptTemplate(item, existing.get(item?.id))).filter((item) => {
		if (!item.name || !item.systemPrompt) throw new Error("template name and system prompt are required");
		return true;
	});
	const nextById = new Map(templates.map((item) => [item.id, item]));
	const history = await read(files.promptTemplateHistory, []);
	for (const previous of current) {
		const next = nextById.get(previous.id);
		if (!next || [
			"name",
			"mode",
			"operation",
			"systemPrompt",
			"defaultNegativePrompt"
		].some((key) => next[key] !== previous[key])) history.unshift({
			...previous,
			archivedAt: (/* @__PURE__ */ new Date()).toISOString(),
			action: next ? "updated" : "deleted"
		});
	}
	await write(files.promptTemplateHistory, history.slice(0, 200));
	await write(targetFile, templates);
	return templates;
}
function send(res, status, data) {
	if (res.destroyed) return;
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Access-Control-Allow-Origin": "*"
	});
	res.end(JSON.stringify(data));
}
async function json(req) {
	let value = "";
	for await (const chunk of req) value += chunk;
	return value ? JSON.parse(value) : {};
}
function apiUrl(endpoint, route) {
	return `${String(endpoint || "").trim().replace(/\/+$/, "")}/v1/${String(route).replace(/^\/+/, "")}`;
}
function dataUrlFile(dataUrl, filename = "reference.png") {
	const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/s);
	if (!match) throw new Error("invalid reference image data");
	return new Blob([Buffer.from(match[2], "base64")], { type: match[1] || "image/png" });
}
function referenceFilename(dataUrl, index) {
	const contentType = String(dataUrl || "").match(/^data:([^;]+);base64,/i)?.[1] || "image/png";
	return `reference-${index + 1}.${imageExtension(contentType)}`;
}
async function upstreamJson(response, context = "上游 API") {
	const text = await response.text();
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		if (response.status === 524) throw new Error(`${context}响应超时（HTTP 524）。上游中转站未能在规定时间内完成图片生成，请稍后重试；如果持续出现，请确认该平台支持 Gemini 图生图和多张参考图。`);
		if (response.status === 502 || response.status === 503 || response.status === 504) throw new Error(`${context}暂时不可用（HTTP ${response.status}）。请稍后重试，或检查中转站服务状态。`);
		if (response.status === 401 || response.status === 403) throw new Error(`${context}鉴权失败（HTTP ${response.status}）。请检查 API Key 和账号权限。`);
		if (response.status === 404) throw new Error(`${context}地址不存在（HTTP 404）。请检查 API 地址和协议配置。`);
		throw new Error(`${context}返回了无法识别的响应（HTTP ${response.status}）。请检查 API 地址、协议和模型是否匹配。`);
	}
}
function apiProvider(api, model = "") {
	const explicit = String(api?.provider || "").trim().toLowerCase();
	if (explicit) return explicit;
	const endpoint = String(api?.endpoint || "").toLowerCase();
	if (endpoint.includes("generativelanguage.googleapis.com") || endpoint.includes("aiplatform.googleapis.com")) return "gemini";
	return "openai";
}
function geminiUrl(api, model) {
	return `${String(api.endpoint || "").trim().replace(/\/+$/, "").replace(/\/v1beta$|\/v1$|\/v1alpha$/i, "")}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(api.key)}`;
}
function dataUrlParts(value) {
	const match = String(value || "").match(/^data:([^;]+);base64,(.+)$/s);
	return match ? {
		mimeType: match[1],
		data: match[2]
	} : null;
}
function geminiPayload(input, prompt, images) {
	const parts = [{ text: prompt }];
	for (const image of images) {
		const inline = dataUrlParts(image);
		if (inline) parts.push({ inlineData: inline });
	}
	return {
		contents: [{
			role: "user",
			parts
		}],
		generationConfig: { responseModalities: ["IMAGE"] }
	};
}
function geminiImages(result) {
	return (result?.candidates?.flatMap((candidate) => candidate?.content?.parts || []) || []).filter((part) => part?.inlineData?.data).map((part) => ({
		b64_json: part.inlineData.data,
		mime_type: part.inlineData.mimeType || "image/png"
	}));
}
function friendlyProviderError(result, status, referenceRequest = false) {
	const raw = typeof result === "string" ? result : result?.error?.message || result?.error || result?.message || "";
	const text = String(raw);
	if (status === 400 && /(?:invalid|unsupported|not supported).{0,80}(?:size|dimension|resolution|width|height)|(?:size|dimension|resolution|width|height).{0,80}(?:invalid|unsupported|not supported)/i.test(text)) return "当前模型或中转站不支持所选图片尺寸。请改用 1024x1080，或在 API 管理中确认该模型支持 2160x3240。";
	if (status === 413) return "图片请求过大，当前模型或中转站无法处理该尺寸或参考图。请改用 1024x1080，或减少参考图数量后重试。";
	if (/images api.*not supported|image api.*not supported|not supported.*images api/i.test(text)) return referenceRequest ? "当前中转站不支持图片编辑/图生图接口，请确认该平台提供图生图能力，或更换支持参考图的模型。" : "当前中转站不支持图片生成接口，请更换支持图片生成的模型或 API。";
	if (/invalid.*key|api.?key|unauthorized|forbidden/i.test(text) && (status === 401 || status === 403)) return "API Key 无效或没有权限，请检查密钥和账号套餐。";
	return text || `图片接口调用失败（HTTP ${status}）。请检查 API 地址、协议和模型配置。`;
}
function upstreamFetchError(error, context, size = "") {
	const code = String(error?.cause?.code || error?.code || "");
	const sizeText = size ? `（请求尺寸 ${size}）` : "";
	if (error?.generationTimedOut || error?.name === "AbortError") return `${context}超时${sizeText}。图片生成耗时过长，请稍后重试；也可改用 1024x1080。`;
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `无法解析图片服务地址${sizeText}。请检查网络、DNS 或 API 地址后重试。`;
	if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return `无法连接图片服务${sizeText}。请检查网络、代理或中转站状态后重试。`;
	return `${context}网络连接失败${sizeText}。请检查网络、代理和中转站状态后重试。`;
}
async function fetchImageGeneration(url, options) {
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => timeoutController.abort(), imageGenerationTimeoutMs);
	try {
		return await fetch(url, {
			...options,
			signal: AbortSignal.any([options.signal, timeoutController.signal])
		});
	} catch (error) {
		if (timeoutController.signal.aborted) error.generationTimedOut = true;
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}
function appendGenerationRecord(record) {
	recordsWriteQueue = recordsWriteQueue.catch(() => null).then(async () => {
		const records = await read(files.records, []);
		records.unshift(record);
		await write(files.records, records.slice(0, 500));
	});
	return recordsWriteQueue;
}
function appendGenerationOptions(form, payload, input) {
	form.append("model", String(payload.model));
	form.append("prompt", String(payload.prompt));
	form.append("n", "1");
	form.append("quality", String(payload.quality));
	if (input.size && input.size !== "auto") form.append("size", input.size);
	if (input.resolution) form.append("resolution", input.resolution);
	if (input.format) form.append("output_format", input.format);
}
function promptTemplateOperation(operation, mode) {
	return {
		reference: "batch",
		"prop-replace": "prop",
		"local-edit": "edit"
	}[operation] || operation || (mode === "text" ? "text" : "all");
}
async function activeApi() {
	const settings = await read(files.settings, {
		apis: [],
		activeApiId: ""
	});
	return settings.apis.find((item) => item.id === settings.activeApiId);
}
async function fetchModels(api) {
	if (!api?.endpoint || !api?.key) throw new Error("请填写 API 地址和 API Key");
	const provider = apiProvider(api);
	const response = provider === "gemini" ? await fetch(`${String(api.endpoint).replace(/\/+$/, "").replace(/\/v1beta$|\/v1$|\/v1alpha$/i, "")}/v1beta/models?key=${encodeURIComponent(api.key)}`) : await fetch(apiUrl(api.endpoint, "models"), { headers: { Authorization: `Bearer ${api.key}` } });
	const payload = await upstreamJson(response, "模型接口");
	if (provider === "gemini" && response.ok) return {
		status: 200,
		payload: { data: (payload.models || []).filter((item) => (item.supportedGenerationMethods || []).includes("generateContent")).map((item) => ({
			id: String(item.name || "").replace(/^models\//, ""),
			name: item.displayName || item.name
		})) }
	};
	return {
		status: response.status,
		payload
	};
}
function cacheKey(url) {
	return crypto.createHash("sha256").update(url).digest("hex");
}
function exportStamp() {
	return `${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}
function imageExtension(contentType) {
	if (/jpe?g/i.test(contentType)) return "jpg";
	if (/webp/i.test(contentType)) return "webp";
	if (/gif/i.test(contentType)) return "gif";
	return "png";
}
function imageContentType(filename) {
	const extension = path.extname(String(filename || "")).toLowerCase();
	if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
	if (extension === ".webp") return "image/webp";
	if (extension === ".gif") return "image/gif";
	return "image/png";
}
function detectedImageContentType(buffer, fallback = "image/png") {
	if (buffer.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
	if (buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
	if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
	return fallback;
}
function filenameWithImageExtension(filename, contentType) {
	const safeName = String(filename || "atelier-image").replace(/[^a-zA-Z0-9._-]/g, "_");
	return `${path.basename(safeName, path.extname(safeName)) || "atelier-image"}.${imageExtension(contentType)}`;
}
async function repairStoredImageExtensions() {
	let names;
	try {
		names = await fs.readdir(generatedDir);
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	const renamed = /* @__PURE__ */ new Map();
	for (const name of names) {
		const source = path.join(generatedDir, name);
		let buffer;
		try {
			buffer = await fs.readFile(source);
		} catch {
			continue;
		}
		const contentType = detectedImageContentType(buffer, imageContentType(name));
		const expected = filenameWithImageExtension(name, contentType);
		if (expected === name) continue;
		const target = path.join(generatedDir, expected);
		try {
			await fs.access(target);
			await fs.rm(source);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			await fs.rename(source, target);
		}
		renamed.set(name, {
			filename: expected,
			contentType
		});
	}
	if (!renamed.size) return;
	const cache = await read(files.imageCache, {});
	for (const entry of Object.values(cache)) {
		const replacement = renamed.get(entry?.filename);
		if (replacement) Object.assign(entry, replacement);
	}
	await write(files.imageCache, cache);
	const records = await read(files.records, []);
	for (const record of records) for (const image of record?.images || []) {
		const replacement = renamed.get(String(image?.url || "").split("/").pop());
		if (replacement) image.url = generatedUrl(replacement.filename);
	}
	await write(files.records, records);
}
function generatedUrl(filename) {
	return `http://127.0.0.1:4317/api/generated/${encodeURIComponent(filename)}`;
}
async function writeGeneratedImage(filename, buffer) {
	await fs.mkdir(generatedDir, { recursive: true });
	const file = path.join(generatedDir, filename);
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await fs.writeFile(temporary, buffer);
	if (!(await fs.stat(temporary)).size) throw new Error("generated image is empty");
	await fs.rename(temporary, file);
	return file;
}
async function cachedImage(url) {
	const entry = (await read(files.imageCache, {}))[cacheKey(url)];
	if (!entry?.filename) return null;
	try {
		const file = path.join(generatedDir, entry.filename);
		await fs.access(file);
		return {
			...entry,
			file
		};
	} catch {
		return null;
	}
}
async function cacheImage(url) {
	const existing = await cachedImage(url);
	if (existing) return existing;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2e4);
	let response;
	try {
		response = await fetch(url, { signal: controller.signal });
	} catch (error) {
		if (error.name === "AbortError") throw new Error("image cache request timed out");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
	if (!response.ok) throw new Error(`image request failed: ${response.status}`);
	const headerContentType = response.headers.get("content-type") || "image/png";
	const buffer = Buffer.from(await response.arrayBuffer());
	const contentType = detectedImageContentType(buffer, headerContentType);
	const entry = {
		filename: `${cacheKey(url)}.${imageExtension(contentType)}`,
		contentType
	};
	const file = await writeGeneratedImage(entry.filename, buffer);
	const cache = await read(files.imageCache, {});
	cache[cacheKey(url)] = entry;
	await write(files.imageCache, cache);
	return {
		...entry,
		file
	};
}
async function persistImage(url) {
	if (/^data:image\//i.test(url)) {
		const match = url.match(/^data:([^;]+);base64,(.+)$/s);
		if (!match) throw new Error("invalid image data");
		const buffer = Buffer.from(match[2], "base64");
		const contentType = detectedImageContentType(buffer, match[1]);
		const filename = `${cacheKey(url)}.${imageExtension(contentType)}`;
		const file = path.join(generatedDir, filename);
		await fs.mkdir(generatedDir, { recursive: true });
		try {
			await fs.access(file);
		} catch {
			await writeGeneratedImage(filename, buffer);
		}
		return {
			filename,
			contentType,
			file
		};
	}
	if (url.startsWith("http://127.0.0.1:4317/api/generated/")) {
		const filename = decodeURIComponent(new URL(url).pathname.slice(15));
		const file = path.join(generatedDir, filename);
		await fs.access(file);
		return {
			filename,
			contentType: imageContentType(filename),
			file
		};
	}
	return cacheImage(url);
}
async function getDownloadImage(url) {
	if (/^data:image\//i.test(url)) {
		const match = url.match(/^data:([^;]+);base64,(.+)$/s);
		if (!match) throw new Error("invalid image data");
		const buffer = Buffer.from(match[2], "base64");
		return {
			buffer,
			contentType: detectedImageContentType(buffer, match[1])
		};
	}
	if (/^https?:/i.test(url) && !url.startsWith("http://127.0.0.1:4317/api/generated/")) {
		const local = await cachedImage(url);
		if (local) return {
			buffer: await fs.readFile(local.file),
			contentType: local.contentType
		};
	}
	const local = await persistImage(url);
	return {
		buffer: await fs.readFile(local.file),
		contentType: local.contentType
	};
}
await repairStoredImageExtensions();
http.createServer(async (req, res) => {
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "Content-Type"
		});
		return res.end();
	}
	try {
		if (req.url === "/api/health" && req.method === "GET") return send(res, 200, {
			ok: true,
			dataDir,
			exportDir
		});
		if (req.url.startsWith("/api/generate/cancel") && req.method === "POST") {
			const taskId = new URL(req.url, "http://127.0.0.1").searchParams.get("taskId");
			const controller = taskId && activeGenerations.get(taskId);
			if (controller) controller.abort();
			return send(res, 200, {
				ok: true,
				cancelled: Boolean(controller)
			});
		}
		if (req.url === "/api/settings" && req.method === "GET") {
			const { adminPassword, ...safeSettings } = await read(files.settings, {
				apis: [],
				activeApiId: ""
			});
			if (adminPassword !== void 0) await write(files.settings, safeSettings);
			return send(res, 200, safeSettings);
		}
		if (req.url === "/api/settings" && req.method === "POST") {
			const { adminPassword, ...next } = await json(req);
			await write(files.settings, next);
			return send(res, 200, { ok: true });
		}
		if (req.url === "/api/presets" && req.method === "GET") {
			const presets = await read(files.presets, []);
			const builtIns = await read(files.builtInPresets, []);
			return send(res, 200, [...presets, ...builtIns.filter((item) => !presets.some((saved) => saved.id === item.id))]);
		}
		if (req.url === "/api/presets" && req.method === "POST") {
			await write(files.presets, await json(req));
			return send(res, 200, { ok: true });
		}
		if (req.url === "/api/prompt-templates" && req.method === "GET") return send(res, 200, await read(files.promptTemplates, []));
		if (req.url === "/api/prompt-templates" && req.method === "POST") return send(res, 200, await savePromptTemplates(await json(req)));
		if (req.url.startsWith("/api/prompt-templates/history") && req.method === "GET") {
			const id = new URL(req.url, "http://127.0.0.1").searchParams.get("templateId");
			const history = await read(files.promptTemplateHistory, []);
			return send(res, 200, id ? history.filter((item) => item.id === id) : history);
		}
		if (req.url === "/api/prompt-templates/restore-defaults" && req.method === "POST") return send(res, 200, await savePromptTemplates((await read(files.defaultPromptTemplates, [])).map((item) => ({
			...item,
			version: 0
		}))));
		if (req.url === "/api/builtin-prompt-templates" && req.method === "GET") return send(res, 200, await read(files.builtInPromptTemplates, []));
		if (req.url === "/api/builtin-prompt-templates" && req.method === "POST") return send(res, 200, await savePromptTemplates(await json(req), files.builtInPromptTemplates));
		if (req.url === "/api/builtin-prompt-templates/restore-defaults" && req.method === "POST") return send(res, 200, await savePromptTemplates((await read(files.defaultBuiltInPromptTemplates, [])).map((item) => ({
			...item,
			version: 0
		})), files.builtInPromptTemplates));
		if (req.url === "/api/records" && req.method === "GET") {
			const records = await read(files.records, []);
			return send(res, 200, Array.isArray(records) ? records : []);
		}
		if (req.url.startsWith("/api/generated/") && req.method === "GET") {
			const name = decodeURIComponent(req.url.slice(15)).replace(/[^a-zA-Z0-9._-]/g, "");
			if (!name || name.includes("..")) return send(res, 400, { error: "invalid generated file" });
			try {
				const file = path.join(generatedDir, name);
				const buffer = await fs.readFile(file);
				const type = imageContentType(name);
				res.writeHead(200, {
					"Content-Type": type,
					"Cache-Control": "public, max-age=31536000",
					"Access-Control-Allow-Origin": "*"
				});
				return res.end(buffer);
			} catch {
				return send(res, 404, { error: "generated file not found" });
			}
		}
		if (req.url.startsWith("/api/download") && req.method === "GET") {
			const params = new URL(req.url, "http://127.0.0.1").searchParams;
			const target = params.get("url");
			const filename = (params.get("filename") || "atelier-image.png").replace(/[^a-zA-Z0-9._-]/g, "_");
			if (!target || !/^https?:/.test(target)) return send(res, 400, { error: "invalid url" });
			const image = await getDownloadImage(target);
			res.writeHead(200, {
				"Content-Type": image.contentType || "application/octet-stream",
				"Content-Disposition": `attachment; filename="${filename}"`,
				"Access-Control-Allow-Origin": "*"
			});
			return res.end(image.buffer);
		}
		if (req.url === "/api/save-image" && req.method === "POST") {
			const { url, filename = "atelier-image.png" } = await json(req);
			if (!url || typeof url !== "string") return send(res, 400, { error: "invalid image url" });
			const image = await getDownloadImage(url);
			const safeName = filenameWithImageExtension(filename, image.contentType);
			await fs.mkdir(exportDir, { recursive: true });
			const target = path.join(exportDir, safeName);
			await fs.writeFile(target, image.buffer);
			return send(res, 200, {
				ok: true,
				path: target,
				filename: safeName,
				exportDir
			});
		}
		if (req.url === "/api/prepare-edit" && req.method === "POST") {
			const { url } = await json(req);
			if (!url || typeof url !== "string") return send(res, 400, { error: "invalid image url" });
			const image = await persistImage(url);
			return send(res, 200, {
				ok: true,
				url: generatedUrl(image.filename),
				filename: image.filename,
				contentType: image.contentType
			});
		}
		if (req.url === "/api/export" && req.method === "POST") {
			const { urls = [] } = await json(req);
			if (!urls.length) return send(res, 400, { error: "请选择图片" });
			const batch = exportStamp();
			await fs.mkdir(exportDir, { recursive: true });
			const saved = await Promise.all(urls.map(async (url, index) => {
				const image = await getDownloadImage(url);
				const filename = filenameWithImageExtension(`phantom-tower-${batch}-${index + 1}`, image.contentType);
				const target = path.join(exportDir, filename);
				await fs.writeFile(target, image.buffer);
				return {
					filename,
					path: target
				};
			}));
			return send(res, 200, {
				ok: true,
				count: saved.length,
				files: saved,
				exportDir
			});
		}
		if (req.url === "/api/models" && req.method === "GET") {
			const api = await activeApi();
			if (!api) return send(res, 400, { error: "请先配置并启用 API" });
			const result = await fetchModels(api);
			return send(res, result.status, result.payload);
		}
		if (req.url === "/api/models/test" && req.method === "POST") {
			const result = await fetchModels(await json(req));
			return send(res, result.status, result.payload);
		}
		if (req.url === "/api/generate" && req.method === "POST") {
			const input = await json(req);
			const api = await activeApi();
			const requestedImages = Array.isArray(input.images) ? input.images.filter((image) => typeof image === "string" && image.trim()) : [];
			const mode = input.mode === "image" ? "image" : "text";
			const operation = promptTemplateOperation(input.operation, mode);
			const builtIn = (await read(files.builtInPromptTemplates, [])).find((item) => promptTemplateMatches(item, mode, operation));
			const templates = await read(files.promptTemplates, []);
			const userTemplate = input.presetId ? templates.find((item) => item.id === input.presetId) : null;
			if (input.presetId && !userTemplate) return send(res, 400, { error: "所选提示词预设不存在" });
			const finalPrompt = [
				builtIn?.systemPrompt,
				builtIn?.defaultNegativePrompt && `负向提示词：${builtIn.defaultNegativePrompt}`,
				input.prompt,
				userTemplate?.systemPrompt,
				userTemplate?.defaultNegativePrompt && `负向提示词：${userTemplate.defaultNegativePrompt}`,
				input.extraPrompt
			].filter((value) => typeof value === "string" && value.trim()).join("\n\n");
			if (!api) return send(res, 400, { error: "请先配置并启用 API" });
			const controller = new AbortController();
			req.on("aborted", () => controller.abort());
			const images = [];
			const responses = [];
			for (let index = 0; index < Math.max(1, Number(input.n || 1)); index += 1) {
				if (controller.signal.aborted) break;
				const provider = apiProvider(api, input.model);
				const payload = {
					model: input.model,
					prompt: finalPrompt,
					n: 1,
					quality: input.quality || "medium",
					response_format: "url"
				};
				if (input.size && input.size !== "auto") payload.size = input.size;
				if (input.resolution) payload.resolution = input.resolution;
				if (input.format) payload.output_format = input.format;
				if (input.mask) payload.mask = input.mask;
				const referenceImages = requestedImages;
				if (Array.isArray(input.materials) && input.materials.length) payload.materials = input.materials.map(({ data, ...material }) => material);
				const isReferenceRequest = referenceImages.length > 0;
				const imagePath = isReferenceRequest ? "/images/edits" : "/images/generations";
				let body = JSON.stringify(payload);
				let headers = {
					"Content-Type": "application/json",
					Authorization: `Bearer ${api.key}`
				};
				if (isReferenceRequest) {
					const form = new FormData();
					appendGenerationOptions(form, payload, input);
					for (const [imageIndex, image] of referenceImages.entries()) form.append("image[]", dataUrlFile(image), referenceFilename(image, imageIndex));
					form.append("input_fidelity", "high");
					body = form;
					headers = { Authorization: `Bearer ${api.key}` };
				}
				if (provider === "gemini") {
					if (isReferenceRequest) body = JSON.stringify(geminiPayload(input, finalPrompt, referenceImages));
					else body = JSON.stringify(geminiPayload(input, finalPrompt, []));
					headers = { "Content-Type": "application/json" };
				}
				const activeTaskId = String(input.taskId || crypto.randomUUID());
				activeGenerations.set(activeTaskId, controller);
				let response;
				let responseProvider = provider;
				try {
					response = await fetchImageGeneration(provider === "gemini" ? geminiUrl(api, input.model) : apiUrl(api.endpoint, imagePath), {
						method: "POST",
						headers,
						body,
						signal: controller.signal
					});
				} catch (error) {
					return send(res, 504, {
						error: upstreamFetchError(error, "图片生成接口", input.size),
						provider,
						hint: `本次请求尺寸为 ${input.size || "默认尺寸"}；2160x3240 仅在当前模型和中转站支持时可用。`
					});
				} finally {
					activeGenerations.delete(activeTaskId);
				}
				let result;
				try {
					result = await upstreamJson(response, `${provider} 图片接口`);
				} catch (error) {
					return send(res, response.ok ? 502 : response.status, {
						error: error.message,
						provider,
						endpoint: provider === "gemini" ? geminiUrl(api, input.model) : apiUrl(api.endpoint, imagePath),
						hint: isReferenceRequest ? "当前请求包含参考图，请确认该平台支持图生图接口或 Gemini 图片输入。" : "请确认接口地址是 API 根地址，而不是网站首页。"
					});
				}
				const errorText = JSON.stringify(result).toLowerCase();
				const canRetryGemini = provider === "openai" && /gemini/i.test(String(input.model || "")) && /images api.*not supported|not supported.*images api|image api.*not supported/.test(errorText);
				if (!response.ok && canRetryGemini) {
					responseProvider = "gemini";
					try {
						response = await fetchImageGeneration(geminiUrl(api, input.model), {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(geminiPayload(input, finalPrompt, referenceImages)),
							signal: controller.signal
						});
					} catch (error) {
						return send(res, 504, {
							error: upstreamFetchError(error, "Gemini 回退接口", input.size),
							provider: "gemini",
							hint: `本次请求尺寸为 ${input.size || "默认尺寸"}；请确认 Gemini 接口地址、网络和中转站状态。`
						});
					}
					try {
						result = await upstreamJson(response, "Gemini 回退接口");
					} catch (error) {
						return send(res, response.ok ? 502 : response.status, {
							error: error.message,
							provider: "gemini",
							endpoint: geminiUrl(api, input.model),
							hint: "中转站不支持 OpenAI Images API，且 Gemini 原生接口也未返回 JSON，请核对该中转站的 Gemini 接口地址。"
						});
					}
				}
				if (!response.ok) return send(res, response.status, {
					error: friendlyProviderError(result, response.status, isReferenceRequest),
					provider: responseProvider
				});
				const normalizedData = responseProvider === "gemini" ? geminiImages(result) : result.data || [];
				responses.push({
					usage: result.usage || null,
					revisedPrompts: normalizedData.map((item) => item.revised_prompt).filter(Boolean)
				});
				images.push(...normalizedData);
			}
			if (controller.signal.aborted) return;
			let persistedImages;
			try {
				persistedImages = await Promise.all(images.map(async (image) => {
					const contentType = image?.mime_type || image?.content_type || "image/png";
					const source = image?.url || (image?.b64_json ? `data:${contentType};base64,${image.b64_json}` : "");
					if (!source) return image;
					const local = await persistImage(source);
					return {
						...image,
						url: generatedUrl(local.filename),
						sourceUrl: image.url || source
					};
				}));
			} catch (error) {
				return send(res, 502, {
					error: upstreamFetchError(error, "生成结果下载", input.size),
					provider: responseProvider,
					hint: "图片接口可能已经生成成功，但应用无法从上游下载图片保存到本地。请稍后重试。"
				});
			}
			await appendGenerationRecord({
				id: Date.now().toString(),
				createdAt: (/* @__PURE__ */ new Date()).toISOString(),
				model: input.model,
				prompt: input.extraPrompt || "",
				request: {
					taskId: input.taskId || crypto.randomUUID(),
					parentResultId: input.parentResultId || null,
					version: Math.max(1, Number(input.version || 1)),
					operation,
					effectivePrompt: finalPrompt,
					presetId: userTemplate?.id || null,
					builtinPresetId: builtIn?.id || null,
					imageCount: input.images?.length || 0,
					materials: (input.materials || []).map((item, index) => ({
						index: index + 1,
						role: item.role || "reference",
						type: item.type
					}))
				},
				responses,
				images: persistedImages.map((image) => ({
					...image,
					id: crypto.randomUUID(),
					taskId: input.taskId || null,
					parentResultId: input.parentResultId || null,
					version: Math.max(1, Number(input.version || 1))
				}))
			});
			return send(res, 200, {
				created: Date.now(),
				data: persistedImages
			});
		}
		send(res, 404, { error: "Not found" });
	} catch (error) {
		if (error.name !== "AbortError") send(res, 500, { error: error.message });
	}
}).listen(4317, "127.0.0.1", () => console.log("PhantomTower local server: http://127.0.0.1:4317"));
//#endregion
export {};
