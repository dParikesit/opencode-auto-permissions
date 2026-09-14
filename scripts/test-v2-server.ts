import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Real V2 host + packed plugin + local model endpoint. No TUI, credentials,
// production database, external model calls, or executable dangerous commands.
const root = resolve(import.meta.dir, "..")
const path = (process.env.PATH ?? "").split(":").filter((entry) => resolve(entry) !== join(root, "node_modules/.bin")).join(":")
const binary = process.env.AUTO_PERMISSIONS_V2_BINARY ?? Bun.which("opencode", { PATH: path })
assert(binary, "Set AUTO_PERMISSIONS_V2_BINARY to a released OpenCode V2 executable")
const version = Bun.spawnSync([binary, "--version"]).stdout.toString().trim()
assert(/\bv2\./.test(version) || /^2\./.test(version), `Expected released OpenCode V2, got ${version}`)

await mkdir(join(tmpdir(), "opencode"), { recursive: true })
const testRoot = await mkdtemp(join(tmpdir(), "opencode/auto-permissions-v2-"))
console.log(`Isolated headless test: ${testRoot}`)
const packed = Bun.spawnSync(["npm", "pack", "--ignore-scripts", "--pack-destination", testRoot], { cwd: root })
assert.equal(packed.exitCode, 0, packed.stderr.toString())
const archive = packed.stdout.toString().trim().split("\n").at(-1)!
const extracted = Bun.spawnSync(["tar", "-xzf", join(testRoot, archive), "-C", testRoot])
assert.equal(extracted.exitCode, 0, extracted.stderr.toString())
const installed = join(testRoot, "package")
const entrypoint = installed

const requests: Array<Record<string, any>> = []
let responseText = JSON.stringify({ decision: "allow", reasonCode: "smoke_allowed", reason: "The user authorized this test." })
let delay = 0
const model = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (!request.url.endsWith("/chat/completions")) return new Response("Not found", { status: 404 })
    const body = await request.json() as Record<string, any>
    requests.push(body)
    const content = responseText
    if (delay) await Bun.sleep(delay)
    const base = { id: "chatcmpl_smoke", object: "chat.completion.chunk", created: 1, model: "reviewer" }
    if (!body.stream) return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    const chunks = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  },
})

const configDirectory = join(testRoot, "config/opencode")
const workspace = join(testRoot, "project")
const shadowWorkspace = join(testRoot, "shadow")
await Promise.all([configDirectory, workspace, shadowWorkspace, join(testRoot, "home")].map((directory) => mkdir(directory, { recursive: true })))
await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  plugins: [{ package: entrypoint, options: { timeoutMs: 1_000, debug: join(testRoot, "decisions.jsonl") } }],
  model: "smoke/reviewer",
  providers: {
    smoke: {
      name: "Local smoke model", env: ["AUTO_PERMISSIONS_SMOKE_KEY"],
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${model.port}/v1` },
      models: { reviewer: { name: "Reviewer" } },
    },
  },
  permissions: [
    { action: "shell", resource: "*", effect: "ask" },
    { action: "shell", resource: "configured-allow", effect: "allow" },
    { action: "shell", resource: "configured-deny", effect: "deny" },
  ],
}, null, 2))
await writeFile(join(shadowWorkspace, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  plugins: [{ package: entrypoint, options: { shadow: true, timeoutMs: 1_000 } }],
}))

const address = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = address.port!
await address.stop(true)
const url = `http://127.0.0.1:${port}`
const server = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: workspace,
  env: {
    PATH: path, HOME: join(testRoot, "home"),
    XDG_CONFIG_HOME: join(testRoot, "config"), XDG_DATA_HOME: join(testRoot, "data"),
    XDG_CACHE_HOME: join(testRoot, "cache"), XDG_STATE_HOME: join(testRoot, "state"),
    AUTO_PERMISSIONS_SMOKE_KEY: "local-test-only",
    OPENCODE_LOG_LEVEL: "DEBUG",
  },
  stdin: "ignore", stdout: Bun.file(join(testRoot, "server.log")), stderr: Bun.file(join(testRoot, "server-error.log")),
})

let authorization = ""
async function api(route: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> {
  if (!authorization) {
    const output = await readFile(join(testRoot, "server.log"), "utf8").catch(() => "")
    const password = /^server password (\S+)$/m.exec(output)?.[1]
    if (password) authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  }
  const response = await fetch(url + route, {
    method, headers: { "content-type": "application/json", authorization },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  assert(response.ok, `${method} ${route}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : undefined
}

try {
  const deadline = Date.now() + 30_000
  while (true) {
    try { await api("/api/health"); break } catch {
      assert(Date.now() < deadline && server.exitCode === null, `Server failed to start; inspect ${testRoot}`)
      await Bun.sleep(100)
    }
  }
  await api(`/api/plugin/await-activation?location[directory]=${encodeURIComponent(workspace)}`, undefined, "POST")
  const plugins = await api(`/api/plugin?location[directory]=${encodeURIComponent(workspace)}`)
  assert(plugins.data.some((plugin: any) => plugin.id === "opencode.auto-permissions.server" && plugin.state.status === "active"), JSON.stringify({
    plugins: plugins.data.filter((plugin: any) => plugin.source.type !== "builtin"),
    config: await api(`/api/config?location[directory]=${encodeURIComponent(workspace)}`),
  }))
  const created = await api("/api/session", { title: "Server-side permission smoke", model: { providerID: "smoke", id: "reviewer" }, location: { directory: workspace } })
  const sessionID = created.data.id
  const permission = async (command: string) => (await api(`/api/session/${sessionID}/permission`, { action: "shell", resources: [command] })).data.effect

  assert.equal(await permission("configured-allow"), "allow")
  assert.equal(await permission("configured-deny"), "deny")
  assert.equal(requests.length, 0)
  assert.equal(await permission("git status --short"), "allow")
  // Evaluate only a permission string: this never executes a shell command.
  assert.equal(await permission("sudo rm -rf /"), "deny")
  assert.equal(requests.length, 0)

  assert.equal(await permission("git tag smoke-test"), "allow")
  assert.equal(requests.length, 1, "Expected the real host to call the local reviewer endpoint")
  assert(!requests[0]!.tools?.length, "Reviewer must have no tools")
  assert(JSON.stringify(requests[0]).includes("You are an automatic permission reviewer"))

  responseText = JSON.stringify({ decision: "deny", reasonCode: "smoke_denied", reason: "Use a narrower target." })
  assert.equal(await permission("git tag denied-test"), "deny")
  responseText = "invalid output"
  assert.equal(await permission("git tag invalid-test"), "deny")
  delay = 2_000
  assert.equal(await permission("git tag timeout-test"), "deny")
  delay = 0
  const pending = await api(`/api/session/${sessionID}/permission`)
  assert.equal(pending.data.length, 0, "Automatic reviews must not leave pending UI requests")

  responseText = JSON.stringify({ decision: "allow", reasonCode: "smoke_allowed", reason: "Authorized test." })
  await api(`/api/plugin/await-activation?location[directory]=${encodeURIComponent(shadowWorkspace)}`, undefined, "POST")
  const shadow = await api("/api/session", { title: "Shadow smoke", model: { providerID: "smoke", id: "reviewer" }, location: { directory: shadowWorkspace } })
  const shadowResult = await api(`/api/session/${shadow.data.id}/permission`, { action: "shell", resources: ["git tag shadow-test"] })
  assert.equal(shadowResult.data.effect, "ask")
  const shadowPending = await api(`/api/session/${shadow.data.id}/permission`)
  assert.equal(shadowPending.data.length, 1, "Shadow mode must leave manual approval available")

  // Reload through the public location eviction API, then exercise the hook.
  await api(`/api/debug/location?location[directory]=${encodeURIComponent(workspace)}`, undefined, "DELETE")
  await api(`/api/plugin/await-activation?location[directory]=${encodeURIComponent(workspace)}`, undefined, "POST")
  assert.equal(await permission("git tag reloaded-test"), "allow")
  const sessions = await api("/api/session")
  assert.equal(sessions.data.length, 2, "Stateless review must not create reviewer sessions")
  await Bun.sleep(50)
  const diagnostics = await readFile(join(testRoot, "decisions.jsonl"), "utf8")
  assert(!diagnostics.includes("git tag"), "Diagnostics must not contain commands")
  assert(diagnostics.includes('"failureCategory":"timeout"'))
  console.log(`${version}: packed-plugin headless checks passed (policies, model approval/denial, malformed output, timeout, shadow mode, reload, no orphan sessions).`)
} finally {
  server.kill()
  await Promise.race([server.exited, Bun.sleep(3_000)])
  if (server.exitCode === null) { server.kill(9); await server.exited }
  await model.stop(true)
}
