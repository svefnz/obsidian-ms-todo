import { Notice, requestUrl } from "obsidian";

export interface TokenResult {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

export interface AuthSettings {
	clientId: string;
	tenant?: string;
	refreshToken?: string;
	accessToken?: string;
	tokenExpiry?: number;
}

/**
 * 权威终结点随租户变化：
 *  - common：工作/学校 + 个人账号（要求应用注册支持这两种账户类型）
 *  - consumers：仅个人 Microsoft 账户
 *  - <租户ID或域名>：仅该组织
 */
export function authority(tenant: string): string {
	const t = tenant || "common";
	return `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0`;
}
const SCOPES = "Tasks.ReadWrite offline_access User.Read";

/**
 * 把 AAD 的英文错误翻译成用户能照做的中文提示。
 * 只覆盖实际踩到的几类，其余原样返回。
 */
export function explainAuthError(text: string): string {
	const code = /"error"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? "";
	const detail = /"error_description"\s*:\s*"([^"]*)"/.exec(text)?.[1] ?? text;
	const clean = detail.split("\r\n")[0].split("Trace ID")[0].trim();
	if (code === "unauthorized_client" || code === "invalid_client") {
		return (
			"应用注册的「支持的账户类型」与登录账号不匹配。" +
			"请到 Azure 应用 → 身份验证，把账户类型改为「任何组织目录中的账户和个人 Microsoft 账户」；" +
			"若只想用个人账号，也可把本插件设置的租户改成 consumers。" +
			`（原始信息：${clean}）`
		);
	}
	if (/AADSTS50011|redirect_uri/i.test(text)) {
		return (
			"Azure 应用里没有登记本插件的重定向 URI。" +
			"请在 Azure 应用 → 身份验证 → 添加平台「移动和桌面应用程序」，重定向 URI 填 " +
			`http://localhost:${LOOPBACK_PORT}/ms-todo-auth。（原始信息：${clean}）`
		);
	}
	return `授权码兑换失败：${clean}`;
}

/** 本地回环端口：Azure 对 http://localhost 的重定向 URI 会忽略端口差异 */
const LOOPBACK_PORT = 42813;
const REDIRECT_URI = `http://localhost:${LOOPBACK_PORT}/ms-todo-auth`;

/**
 * OAuth 2.0 授权码 + PKCE 流程。
 * Obsidian 桌面端使用本地回环 HTTP 服务接收授权码（RFC 8252 推荐方式）。
 */
export class AuthManager {
	constructor(private settings: AuthSettings) {}

	get settings_(): AuthSettings {
		return this.settings;
	}

	updateSettings(s: AuthSettings) {
		this.settings = s;
	}

	async getToken(): Promise<string> {
		const s = this.settings;
		if (s.accessToken && s.tokenExpiry && Date.now() < s.tokenExpiry - 60000) {
			return s.accessToken;
		}
		if (!s.refreshToken) throw new Error("尚未登录：没有刷新令牌，请先执行「登录 Microsoft To Do」命令。");
		const tok = await this.refresh(s.refreshToken);
		s.accessToken = tok.access_token;
		s.tokenExpiry = Date.now() + tok.expires_in * 1000;
		if (tok.refresh_token) s.refreshToken = tok.refresh_token;
		return s.accessToken;
	}

	private async refresh(refreshToken: string): Promise<TokenResult> {
		const body = new URLSearchParams({
			client_id: this.settings.clientId,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			scope: SCOPES,
		});
		const res = await requestUrl({
			url: `${authority(this.settings.tenant ?? "common")}/token`,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: body.toString(),
		});
		if (res.status >= 400) throw new Error(`令牌刷新失败：${res.status} ${res.text}`);
		return res.json as TokenResult;
	}
}

// --- PKCE helpers (browser crypto) ---

export function base64UrlEncode(bytes: Uint8Array): string {
	let str = "";
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export function buildAuthorizeUrl(
	clientId: string,
	challenge: string,
	tenant = "common",
	redirectUri = REDIRECT_URI
): string {
	const p = new URLSearchParams({
		client_id: clientId,
		response_type: "code",
		redirect_uri: redirectUri,
		response_mode: "query",
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		prompt: "select_account",
	});
	return `${authority(tenant)}/authorize?${p.toString()}`;
}

export async function exchangeCode(
	clientId: string,
	code: string,
	verifier: string,
	tenant = "common",
	redirectUri = REDIRECT_URI
): Promise<TokenResult> {
	const body = new URLSearchParams({
		client_id: clientId,
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		code_verifier: verifier,
		scope: SCOPES,
	});
	const res = await requestUrl({
		url: `${authority(tenant)}/token`,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: body.toString(),
	});
	if (res.status >= 400) {
		const msg = explainAuthError(res.text);
		new Notice(`Microsoft To Do 登录失败：${msg}`, 15000);
		throw new Error(msg);
	}
	return res.json as TokenResult;
}

/** 当前活动的回调服务，重复登录时先关掉旧的，避免 EADDRINUSE */
let activeServer: import("http").Server | null = null;

export interface CallbackHandle {
	/** 本次登录实际使用的重定向 URI（需在 Azure 中注册） */
	redirectUri: string;
	/** 收到浏览器回调后兑现 */
	result: Promise<{ code?: string; error?: string }>;
	/** 放弃登录，立刻释放端口 */
	close: () => void;
}

/**
 * 启动一次性本地回调服务，等待 Microsoft 重定向带回授权码。
 * 收到后立即关闭服务器。
 */
export function startCallbackServer(
	timeoutMs = 5 * 60 * 1000,
	port = LOOPBACK_PORT
): Promise<CallbackHandle> {
	// obsidian 桌面端可用 Node 内置模块
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const http = require("http") as typeof import("http");
	const redirectUri = `http://localhost:${port}/ms-todo-auth`;
	const path = "/ms-todo-auth";

	if (activeServer) {
		try {
			activeServer.close();
		} catch {
			/* 忽略 */
		}
		activeServer = null;
	}

	return new Promise((resolve, reject) => {
		let settle: (v: { code?: string; error?: string }) => void = () => {};
		let fail: (e: Error) => void = () => {};
		const result = new Promise<{ code?: string; error?: string }>((res, rej) => {
			settle = res;
			fail = rej;
		});

		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", redirectUri);
			if (url.pathname !== path) {
				res.writeHead(404).end();
				return;
			}
			const code = url.searchParams.get("code") ?? undefined;
			const error = url.searchParams.get("error") ?? undefined;
			const desc = url.searchParams.get("error_description") ?? "";
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
				`<!doctype html><meta charset="utf-8"><title>Microsoft To Do 同步</title>
				 <body style="font-family:system-ui;padding:3rem;text-align:center">
				 <h2>${code ? "授权成功 ✅" : "授权失败 ❌"}</h2>
				 <p>${code ? "可以关闭此页面，回到 Obsidian 继续。" : `${error} ${desc}`}</p></body>`
			);
			finish();
			settle({ code, error: code ? undefined : error ?? "unknown" });
		});

		const timer = setTimeout(() => {
			finish();
			fail(new Error("登录超时（5 分钟）。"));
		}, timeoutMs);

		let closed = false;
		const finish = () => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			server.close();
			if (activeServer === server) activeServer = null;
		};

		server.on("error", (e) => {
			finish();
			const err = new Error(
				(e as NodeJS.ErrnoException).code === "EADDRINUSE"
					? `本地端口 ${port} 已被占用（可能是上次登录窗口未关闭）。请稍后重试，或重启 Obsidian。`
					: `本地回调服务启动失败：${(e as Error).message}`
			);
			reject(err);
			fail(err);
		});

		server.listen(port, "127.0.0.1", () => {
			activeServer = server;
			resolve({ redirectUri, result, close: finish });
		});
		result.catch(() => {
			/* 由调用方处理 */
		});
	});
}

export { REDIRECT_URI, LOOPBACK_PORT };
