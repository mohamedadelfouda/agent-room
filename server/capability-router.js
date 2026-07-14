const RULES = [
  {
    intent: "publish",
    capability: "publish",
    patterns: [/\b(?:push|publish|open|create)\s+(?:a\s+)?(?:pr|pull request)\b/i, /\b(?:send|email)\s+(?:it|this|them|the)\b/i, /(?:اعمل|افتح|انشر|ارفع)\s*(?:pr|pull request|بي آر)/i, /(?:ابعت|ارسل)\s*(?:الإيميل|الايميل|البريد)/i],
  },
  {
    intent: "execute",
    capability: "execute",
    patterns: [/\b(?:run|execute)\s+(?:the\s+)?tests?\b/i, /\b(?:implement|fix|refactor|edit|change)\s+(?:the\s+)?(?:code|project|repo|files?|bug|feature)/i, /(?:شغ[ّ]?ل|نفذ|طب[ّ]?ق)\s*(?:الاختبارات|التستات|الخطة|التعديل|الكود)/i, /(?:اصلح|عد[ّ]?ل|غي[ّ]?ر)\s*(?:المشكلة|الكود|المشروع|الملفات)/i],
  },
  {
    intent: "project_read",
    capability: "projectRead",
    patterns: [/\b(?:review|audit|inspect|analy[sz]e)\s+(?:the\s+)?(?:project|repo|repository|codebase|code)\b/i, /(?:راجع|حلل|افحص)\s*(?:المشروع|الريبو|الكود)/i],
  },
];

export function routeRequest(text) {
  const source = String(text || "").trim();
  const informational = /^(?:how|what|why|where|when|can you explain|ازاي|إزاي|كيف|ليه|لماذا|فين)(?=\s|[؟?]|$)/i.test(source);
  for (const rule of RULES) {
    if (informational && (rule.intent === "execute" || rule.intent === "publish")) continue;
    if (rule.patterns.some((pattern) => pattern.test(source))) {
      return { intent: rule.intent, requiredCapability: rule.capability, confidence: "high" };
    }
  }
  return { intent: "discussion", requiredCapability: "discussion", confidence: "default" };
}

export function preflightRoute(text, { projectTrusted = false } = {}) {
  const route = routeRequest(text);
  if (route.intent === "execute" || route.intent === "publish") {
    return {
      ...route,
      allowed: false,
      action: "open_execution",
      reasonCode: "state_change_requires_execution",
      reason: "This request changes state and needs the Execute → Review → Decide flow.",
    };
  }
  if (route.intent === "project_read" && !projectTrusted) {
    return {
      ...route,
      allowed: false,
      action: "attach_project",
      reasonCode: "project_trust_required",
      reason: "Attach and trust the project before a read-only review.",
    };
  }
  return { ...route, allowed: true, action: null, reasonCode: null, reason: "" };
}
