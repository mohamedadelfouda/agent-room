function clean(text) {
  return String(text ?? "").trim();
}

export function transcriptFor(session, maxChars = 24000) {
  const lines = [];
  for (const message of session.messages ?? []) {
    const speaker = message.author === "user"
      ? "USER"
      : message.author === "system"
        ? "SYSTEM"
        : `${String(message.agent || "AGENT").toUpperCase()}${message.role ? ` (${message.role})` : ""}`;
    lines.push(`[${speaker} | ${message.phase || "message"}${message.round ? ` | round ${message.round}` : ""}]\n${clean(message.content)}`);
  }
  let joined = lines.join("\n\n---\n\n");
  if (joined.length > maxChars) {
    joined = `[Older context was trimmed by the local orchestrator.]\n\n${joined.slice(-maxChars)}`;
  }
  return joined;
}

export function collaborationPrompt({ session, agentLabel, role, round, totalRounds, userTask, projectSnapshot = "" }) {
  const tools = projectSnapshot
    ? `You may READ the attached project's files (Read/Grep/Glob) to ground your answer in the real code — read only, never modify files or run commands.`
    : `Do not use tools, modify files, or run commands.`;
  return `You are ${agentLabel}, participating in one persistent multi-agent session controlled by the user.
Current mode: COLLABORATION.
Your assigned role: ${role || "Collaborator"}.
Current collaboration round: ${round} of ${totalRounds}.

Goal:
Work with the other agent toward one stronger shared answer. Do not merely repeat earlier text. Identify what is already useful, correct weak points, add missing reasoning, and move the shared solution forward.

Required response structure:
1. What I accept from the shared work
2. What I would change or add
3. Updated shared proposal
4. Remaining uncertainty, if any

After the structured response above, output on its own final line exactly one of:
CONVERGENCE: converged
CONVERGENCE: open — <the specific point(s) you still disagree on with the other agent>
Use "converged" only if you genuinely agree with the other agent's latest position and have nothing substantive left to add or dispute. This line is a control signal for the local orchestrator, not part of your answer.

Answer in the same language as the user's latest message. Do not claim you directly share a provider-side session with another model; the local orchestrator is supplying the shared transcript. ${tools}
${projectSnapshot ? `\n${projectSnapshot}\n` : ""}
Latest user task:
${clean(userTask)}

Shared session transcript:
${transcriptFor(session)}`;
}

export function chatPrompt({ session, agentLabel, role, userTask }) {
  return `You are ${agentLabel}, answering the user directly in one persistent multi-agent session.
Current mode: CHAT.
Your assigned role: ${role || "Assistant"}.

This is a normal chat, exactly like chatting with you directly: answer any question the user asks — about code, a repo, or anything else. Answer the user's latest message directly and helpfully in your own voice. You have web search available (WebSearch/WebFetch). If the user asks about anything specific you do not already know for certain — a product, company, person, website, or recent event — search the web immediately and answer from what you find, citing your sources. Do NOT ask the user for permission to search, and do NOT reply that you simply don't know: look it up first, then answer. Another agent is answering the same message separately — do not coordinate with, imitate, or wait for the other agent's answer.

Answer in the same language as the user's latest message. Do not claim you directly share a provider-side session with another model; the local orchestrator is supplying the shared transcript. Do not modify files or run shell commands.

Latest user message:
${clean(userTask)}

Shared session transcript (for context only):
${transcriptFor(session)}`;
}

export function debatePrompt({ session, agentLabel, role, opponentLabel, round, totalRounds, userTask, independent, projectSnapshot = "" }) {
  const tools = projectSnapshot
    ? `You may READ the attached project's files (Read/Grep/Glob) to ground your argument in the real code — read only, never modify files or run commands.`
    : `Do not use tools, modify files, or run commands.`;
  return `You are ${agentLabel}, participating in one persistent multi-agent session controlled by the user.
Current mode: DEBATE.
Your assigned position/role: ${role || "Critical debater"}.
Opponent: ${opponentLabel}.
Current debate round: ${round} of ${totalRounds}.

${independent
    ? "This is the independent opening round. Form your position from the user's task and earlier session context without imitating an opponent's current-round answer."
    : "This is a rebuttal round. Address the strongest opposing claims already present in the shared transcript. Concede valid points and challenge weak ones with specific reasoning."}

Required response structure:
1. My position
2. Strongest supporting arguments
3. What I concede
4. Rebuttal to the opposing position
5. What evidence or test would change my mind
6. Recommended decision
7. Confidence from 0 to 100

After the structured response above, output on its own final line exactly one of:
CONVERGENCE: converged
CONVERGENCE: open — <the specific point(s) still in dispute with the opponent>
Use "converged" only if the debate is genuinely resolved for you — you now agree or fully concede and have nothing substantive left to dispute. This line is a control signal for the local orchestrator, not part of your answer.

Answer in the same language as the user's latest message. ${tools}
${projectSnapshot ? `\n${projectSnapshot}\n` : ""}
Debate question:
${clean(userTask)}

Shared session transcript:
${transcriptFor(session)}`;
}

export function synthesisPrompt({ session, agentLabel, role, userTask, mode, projectSnapshot = "" }) {
  const tools = projectSnapshot
    ? `You may READ the attached project's files (Read/Grep/Glob) to verify claims against the real code — read only, never modify files or run commands.`
    : `Do not use tools or change files.`;
  return `You are ${agentLabel}, acting as the final synthesizer/judge in a persistent multi-agent session.
Mode completed: ${String(mode).toUpperCase()}.
Your role: ${role || "Judge and synthesizer"}.

Produce one useful final outcome from the full transcript. Do not decide by majority or by model reputation. Judge arguments by correctness, evidence, feasibility, risk, and fit with the user's goal.

Required response structure:
1. نقاط الاتفاق
2. نقاط الخلاف الحقيقية
3. أقوى حجة من كل طرف
4. القرار المقترح وأسبابه
5. المخاطر أو الشروط
6. الخطوة العملية التالية
7. درجة الثقة

Use the language of the user's latest message. ${tools}
${projectSnapshot ? `\n${projectSnapshot}\n` : ""}
Original/current user task:
${clean(userTask)}

Shared session transcript:
${transcriptFor(session, 30000)}`;
}
