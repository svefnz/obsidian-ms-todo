import { build } from "esbuild";
import assert from "node:assert";
import { createRequire } from "node:module";
import http from "node:http";

// 每次都用新连接，避免连接池命中上一次已关闭的服务器
const get = (path) =>
	new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: mod.exports.LOOPBACK_PORT, path, agent: false }, (res) => {
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
const { buildAuthorizeUrl, waitForCallback, REDIRECT_URI, LOOPBACK_PORT, pkce } = mod.exports;

// 1) authorize URL must not duplicate the path segment
const url = new URL(buildAuthorizeUrl("test-client-id", "CHALLENGE"));
assert.strictEqual(url.origin + url.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "authorize endpoint");
assert.ok(!url.pathname.includes("/oauth2/v2.0/oauth2/v2.0"), "no duplicated path");
assert.strictEqual(url.searchParams.get("redirect_uri"), REDIRECT_URI);
assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256");
assert.strictEqual(url.searchParams.get("scope"), "Tasks.ReadWrite offline_access User.Read");

// 2) loopback callback receives the code
assert.strictEqual(REDIRECT_URI, `http://localhost:${LOOPBACK_PORT}/ms-todo-auth`);
const pending = waitForCallback(5000);
await new Promise((r) => setTimeout(r, 300));
const res = await get("/ms-todo-auth?code=AUTH_CODE_123");
assert.strictEqual(res.status, 200);
assert.ok(res.body.includes("授权成功"), "success page");
const got = await pending;
assert.deepStrictEqual(got, { code: "AUTH_CODE_123", error: undefined }, "callback result");

// 3) error path
const pendingErr = waitForCallback(5000);
await new Promise((r) => setTimeout(r, 300));
const errRes = await get("/ms-todo-auth?error=access_denied&error_description=denied");
assert.ok(errRes.body.includes("授权失败"), "error page");
assert.strictEqual((await pendingErr).error, "access_denied");

// 4) PKCE shape
const { verifier, challenge } = await pkce();
assert.ok(/^[A-Za-z0-9_-]{43}$/.test(verifier), "verifier is 43-char base64url");
assert.ok(/^[A-Za-z0-9_-]{43}$/.test(challenge), "challenge is 43-char base64url");
assert.notStrictEqual(verifier, challenge);

console.log("all auth tests passed");
