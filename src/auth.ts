import { Notice, requestUrl } from "obsidian";

export interface TokenResult {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

export interface AuthSettings {
	clientId: string;
	refreshToken?: string;
	accessToken?: string;
	tokenExpiry?: number;
}

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPES = "Tasks.ReadWrite offline_access User.Read";

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
			url: `${AUTHORITY}/token`,
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

export function buildAuthorizeUrl(clientId: string, challenge: string): string {
	const p = new URLSearchParams({
		client_id: clientId,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		response_mode: "query",
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		prompt: "select_account",
	});
	return `${AUTHORITY}/authorize?${p.toString()}`;
}

export async function exchangeCode(clientId: string, code: string, verifier: string): Promise<TokenResult> {
	const body = new URLSearchParams({
		client_id: clientId,
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier,
		scope: SCOPES,
	});
	const res = await requestUrl({
		url: `${AUTHORITY}/token`,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: body.toString(),
	});
	if (res.status >= 400) {
		new Notice(`Microsoft To Do 登录失败：${res.text}`, 10000);
		throw new Error(`授权码兑换失败：${res.status} ${res.text}`);
	}
	return res.json as TokenResult;
}

/**
 * 启动一次性本地回调服务，等待 Microsoft 重定向带回授权码。
 * 收到后立即关闭服务器。
 */
export function waitForCallback(timeoutMs = 5 * 60 * 1000): Promise<{ code?: string; error?: string }> {
	// obsidian 桌面端可用 Node 内置模块
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const http = require("http") as typeof import("http");
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://localhost:${LOOPBACK_PORT}`);
			if (url.pathname !== "/ms-todo-auth") {
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
			resolve({ code, error: code ? undefined : error ?? "unknown" });
		});
		const timer = setTimeout(() => {
			finish();
			reject(new Error("登录超时（5 分钟）。"));
		}, timeoutMs);
		let closed = false;
		const finish = () => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			server.close();
		};
		server.on("error", (e) => {
			finish();
			reject(new Error(`本地回调服务启动失败：${(e as Error).message}`));
		});
		server.listen(LOOPBACK_PORT, "127.0.0.1");
	});
}

export { REDIRECT_URI, LOOPBACK_PORT };
