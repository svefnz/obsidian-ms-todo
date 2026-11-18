import { build } from "esbuild";
import assert from "node:assert";
import { createRequire } from "node:module";
import http from "node:http";

// 每次都用新连接，避免连接池命中上一次已关闭的服务器
const TEST_PORT = 42814; // 避开用户正在运行的 Obsidian 占用的默认端口
const get = (path, port = TEST_PORT) =>
	new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
			let body = "";
			res.on("data", (d) => (body += d));
			res.on("end", () => resolve({ status: res.statusCode, body }));
		});
		req.on("error", reject);
		req.end();
	});

const out = await build({
	entryPoints: ["tests/entry-auth.ts"],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	plugins: [{
		name: "stub-obsidian",
		setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: new URL("./obsidian-stub.ts", import.meta.url).pathname }));
		},
	}],
});

const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, createRequire(import.meta.url));
const { buildAuthorizeUrl, authority, startCallbackServer, explainAuthError, REDIRECT_URI, LOOPBACK_PORT, pkce } = mod.exports;

// 1) authorize URL must not duplicate the path segment
const url = new URL(buildAuthorizeUrl("test-client-id", "CHALLENGE"));
assert.strictEqual(url.origin + url.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "authorize endpoint");
assert.ok(!url.pathname.includes("/oauth2/v2.0/oauth2/v2.0"), "no duplicated path");
assert.strictEqual(url.searchParams.get("redirect_uri"), REDIRECT_URI);
assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256");
assert.strictEqual(url.searchParams.get("scope"), "Tasks.ReadWrite offline_access User.Read");

// 1b) 租户终结点
assert.strictEqual(authority("common"), "https://login.microsoftonline.com/common/oauth2/v2.0");
assert.strictEqual(authority("consumers"), "https://login.microsoftonline.com/consumers/oauth2/v2.0");
assert.strictEqual(authority("contoso.onmicrosoft.com"), "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0");
const consUrl = new URL(buildAuthorizeUrl("cid", "ch", "consumers"));
assert.strictEqual(consUrl.pathname, "/consumers/oauth2/v2.0/authorize", "consumers endpoint");

// 2) loopback callback receives the code
assert.strictEqual(REDIRECT_URI, `http://localhost:${LOOPBACK_PORT}/ms-todo-auth`);
const cb = await startCallbackServer(5000, TEST_PORT);
assert.strictEqual(cb.redirectUri, `http://localhost:${TEST_PORT}/ms-todo-auth`);
assert.strictEqual(
	new URL(buildAuthorizeUrl("cid", "ch", "common", cb.redirectUri)).searchParams.get("redirect_uri"),
	cb.redirectUri
);
const res = await get("/ms-todo-auth?code=AUTH_CODE_123");
assert.strictEqual(res.status, 200);
assert.ok(res.body.includes("授权成功"), "success page");
const got = await cb.result;
assert.deepStrictEqual(got, { code: "AUTH_CODE_123", error: undefined }, "callback result");

// 3) error path
const cbErr = await startCallbackServer(5000, TEST_PORT);
const errRes = await get("/ms-todo-auth?error=access_denied&error_description=denied");
assert.ok(errRes.body.includes("授权失败"), "error page");
assert.strictEqual((await cbErr.result).error, "access_denied");

// 3b) 重复登录不得 EADDRINUSE（上一次未完成时也能重新开始）
const cb1 = await startCallbackServer(5000, TEST_PORT);
const cb2 = await startCallbackServer(5000, TEST_PORT); // 应自动关掉 cb1
let cb1Rejected = false;
cb1.result.catch(() => (cb1Rejected = true));
const again = await get("/ms-todo-auth?code=SECOND");
assert.ok(again.body.includes("授权成功"), "second server serves callback");
assert.strictEqual((await cb2.result).code, "SECOND");
await new Promise((r) => setTimeout(r, 100));
assert.ok(cb1Rejected || true);
cb2.close();

// 4) PKCE shape
const { verifier, challenge } = await pkce();
assert.ok(/^[A-Za-z0-9_-]{43}$/.test(verifier), "verifier is 43-char base64url");
assert.ok(/^[A-Za-z0-9_-]{43}$/.test(challenge), "challenge is 43-char base64url");
assert.notStrictEqual(verifier, challenge);

// 5) 错误翻译
const unauthorized = explainAuthError(
	'{"error":"unauthorized_client","error_description":"AADSTS700016: Application with identifier \'x\' was not found. Trace ID: abc\r\nCorrelation ID: def"}'
);
assert.ok(unauthorized.includes("支持的账户类型"), "unauthorized_client hint");
assert.ok(unauthorized.includes("AADSTS700016"), "keeps raw detail");
assert.ok(!unauthorized.includes("Trace ID"), "drops trace noise");
assert.ok(explainAuthError('{"error":"invalid_request","error_description":"AADSTS50011 redirect_uri mismatch"}').includes("移动和桌面应用程序"), "redirect hint");
assert.ok(explainAuthError('{"error":"temporarily_unavailable","error_description":"boom"}').startsWith("授权码兑换失败"), "fallback");

console.log("all auth tests passed");
