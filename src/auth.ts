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

const REDIRECT_URI = "https://localhost/ms-todo-auth";

/**
 * OAuth 2.0 authorization code + PKCE flow for Microsoft Graph.
 * Because Obsidian is a desktop app, we use the loopback-style redirect trick
 * via Obsidian's `registerObsidianProtocolHandler` with the "ms-todo-auth"
 * protocol. The code is exchanged against the v2.0 token endpoint.
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
		if (!s.refreshToken) throw new Error("Not authenticated: no refresh token. Run 'Sign in to Microsoft To Do'.");
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
			url: `${AUTHORITY}/oauth2/v2.0/token`,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: body.toString(),
		});
		if (res.status >= 400) throw new Error(`Token refresh failed: ${res.status} ${res.text}`);
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
	return `${AUTHORITY}/oauth2/v2.0/authorize?${p.toString()}`;
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
		url: `${AUTHORITY}/oauth2/v2.0/token`,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: body.toString(),
	});
	if (res.status >= 400) {
		new Notice(`Microsoft To Do auth failed: ${res.text}`, 10000);
		throw new Error(`Auth code exchange failed: ${res.status} ${res.text}`);
	}
	return res.json as TokenResult;
}

export { REDIRECT_URI };
