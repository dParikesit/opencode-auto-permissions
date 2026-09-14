import type { Context } from "@opencode/plugin/promise/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import { DECISION_SCHEMA, REVIEWER_SYSTEM_PROMPT } from "./agent.ts"
import { parseConfig, type Config } from "./config.ts"
import { AUTO_PERMISSIONS_MESSAGE_PREFIX } from "./context.ts"
import { failureCategory, writeDiagnostic } from "./diagnostics.ts"
import { applyDeterministicPolicy } from "./policy.ts"
import { buildReviewPrompt } from "./prompt.ts"
import type { Decision, ReviewInput } from "./types.ts"
import { parseDecision } from "./verdict.ts"

const MAX_PARENT_DEPTH = 32
const MAX_MESSAGE_CHARS = 4_000

/** Current V2 owns review on the server, before a pending prompt is published. */
export async function installServerReviewer(context: Context): Promise<() => Promise<void>> {
  const config = parseConfig(context.options)
  const controllers = new Set<AbortController>()
  const sharedReviews = new Map<string, Promise<Decision>>()
  let disposed = false
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(), event: "plugin_started", protocol: "v2",
    clientCapabilities: ["permission.hook.evaluate", "generate.text"],
  })

  const registration = await context.permission.hook("evaluate", async (event) => {
    // Configured allow/deny policies retain their meaning. Explicit denies are
    // normally already final in Core, but also guard this boundary ourselves.
    if (event.effect !== "ask") return
    const startedAt = performance.now()
    const controller = new AbortController()
    if (disposed) controller.abort(new DOMException("Permission reviewer was unloaded", "AbortError"))
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(new Error("Permission review timed out")), config.timeoutMs)
    const signal = controller.signal
    const diagnostic = {
      sessionID: event.sessionID,
      protocol: "v2" as const,
      action: event.action,
      resourceCount: event.resources.length,
    }
    writeDiagnostic(config.diagnosticsPath, {
      ...diagnostic, timestamp: new Date().toISOString(), event: "request_received",
    })

    try {
      const input = await abortable(collectInput(context, event, config, signal), signal)
      signal.throwIfAborted()
      const policy = applyDeterministicPolicy(input)
      const key = JSON.stringify([event.sessionID, input, config.model, config.variant])
      let review = sharedReviews.get(key)
      if (!policy && !review) {
        review = modelDecision(context, config, input, signal)
        sharedReviews.set(key, review)
        void review.finally(() => {
          if (sharedReviews.get(key) === review) sharedReviews.delete(key)
        }).catch(() => undefined)
      }
      const decision = policy ?? await abortable(review!, signal)
      signal.throwIfAborted()
      if (!config.shadow) {
        event.effect = decision.kind === "deny" ? "deny" : "allow"
        if (decision.kind === "deny") event.message = denialMessage(decision.reason)
      }
      writeDiagnostic(config.diagnosticsPath, {
        ...diagnostic, timestamp: new Date().toISOString(), event: "decision",
        elapsedMs: Math.round(performance.now() - startedAt), source: policy ? "policy" : "model",
        decision: decision.kind, reasonCode: decision.reasonCode, shadow: config.shadow,
        // This hook exposes no tool-proposed save patterns. Never turn a model
        // verdict into a durable permission rule or invent a reusable pattern.
        ...(decision.kind !== "deny" ? { approvalScope: "once" as const } : {}),
      })
    } catch (error) {
      const category = failureCategory(error)
      if (!config.shadow) {
        event.effect = "deny"
        event.message = denialMessage(category === "timeout" ? "Permission review timed out." : "Permission review failed.")
      }
      // Provider errors and model reasons can echo private prompts. Log only
      // classifications in this adapter, never the raw error or request body.
      writeDiagnostic(config.diagnosticsPath, {
        ...diagnostic, timestamp: new Date().toISOString(), event: "failure",
        elapsedMs: Math.round(performance.now() - startedAt), failureCategory: category, shadow: config.shadow,
      })
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
    }
  })

  return async () => {
    disposed = true
    for (const controller of controllers) controller.abort(new DOMException("Permission reviewer was unloaded", "AbortError"))
    controllers.clear()
    sharedReviews.clear()
    await registration.dispose()
  }
}

async function collectInput(
  context: Context,
  event: PermissionEvaluation,
  config: Config,
  signal: AbortSignal,
): Promise<ReviewInput> {
  const session = await context.session.get({ sessionID: event.sessionID }, { signal })
  let root = session
  const seen = new Set([session.id])
  while (root.parentID) {
    signal.throwIfAborted()
    if (seen.has(root.parentID) || seen.size >= MAX_PARENT_DEPTH) throw new Error("Invalid session ancestry")
    seen.add(root.parentID)
    root = await context.session.get({ sessionID: root.parentID }, { signal })
  }
  signal.throwIfAborted()
  const [messages, currentMessages] = await Promise.all([
    context.session.context({ sessionID: root.id }, { signal }),
    root.id === session.id ? Promise.resolve(undefined) : context.session.context({ sessionID: session.id }, { signal }),
  ])
  const current = currentMessages ?? messages
  const source = event.source
  const assistant = source ? current.find((message) => message.id === source.messageID && message.type === "assistant") : undefined
  const tool = assistant?.type === "assistant" ? assistant.content.find((item) => item.type === "tool" && item.id === source?.id) : undefined
  const toolInput = tool?.type === "tool" && "input" in tool.state ? tool.state.input : undefined
  const latestAssistant = current.findLast((message) => message.type === "assistant")
  const model = (assistant?.type === "assistant" ? assistant.model : undefined)
    ?? session.model ?? (latestAssistant?.type === "assistant" ? latestAssistant.model : undefined)

  return {
    request: {
      action: event.action, resources: [...event.resources], sessionPatterns: [],
      ...(toolInput !== undefined ? { toolInput } : {}),
    },
    context: {
      rootSessionID: root.id,
      directory: session.location.directory,
      // A subagent's user-role briefing is agent-authored, not human consent.
      userMessages: messages.flatMap((message) =>
        message.type === "user" && !message.text.trimStart().startsWith(AUTO_PERMISSIONS_MESSAGE_PREFIX)
          ? [message.text.slice(0, MAX_MESSAGE_CHARS)] : [],
      ).slice(-config.userMessageCount),
      ...(model ? { model } : {}),
    },
  }
}

async function modelDecision(context: Context, config: Config, input: ReviewInput, signal: AbortSignal): Promise<Decision> {
  const model = config.model ?? (input.context.model
    ? { ...input.context.model, ...(config.variant ? { variant: config.variant } : {}) } : undefined)
  if (!model) throw new Error("Could not determine the requesting session model")
  // The stateless API has no tools, session history, repository instructions,
  // or reviewer sessions to clean up, and cannot recursively ask permission.
  const result = await abortable(context.generate.text({
    model,
    prompt: `${REVIEWER_SYSTEM_PROMPT}\n\nReturn exactly one JSON object matching this schema, without Markdown fences:\n${JSON.stringify(DECISION_SCHEMA)}\n\n${buildReviewPrompt(input)}`,
  }, { signal }), signal)
  let parsed: unknown
  try { parsed = JSON.parse(result.text) } catch { throw new Error("Reviewer returned an invalid decision") }
  const decision = parseDecision(parsed)
  if (!decision) throw new Error("Reviewer returned an invalid decision")
  return decision
}

function denialMessage(reason: string): string {
  return `Auto Permissions blocked this action: ${reason} Continue with a narrower or lower-risk step; do not retry the exact blocked action without addressing the reason.`
}

/** Bound even a transport that ignores AbortSignal, without late side effects. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
