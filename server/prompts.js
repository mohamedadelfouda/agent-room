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

export function collaborationPrompt({ session, agentLabel, role, round, totalRounds, userTask }) {
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

Answer in the same language as the user's latest message. Do not claim you directly share a provider-side session with another model; the local orchestrator is supplying the shared transcript. Do not use tools, modify files, or run commands.

Latest user task:
${clean(userTask)}

Shared session transcript:
${transcriptFor(session)}`;
}

export function debatePrompt({ session, agentLabel, role, opponentLabel, round, totalRounds, userTask, independent }) {
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

Answer in the same language as the user's latest message. Do not use tools, modify files, or run commands.

Debate question:
${clean(userTask)}

Shared session transcript:
${transcriptFor(session)}`;
}

export function synthesisPrompt({ session, agentLabel, role, userTask, mode }) {
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

Use the language of the user's latest message. Do not use tools or change files.

Original/current user task:
${clean(userTask)}

Shared session transcript:
${transcriptFor(session, 30000)}`;
}
