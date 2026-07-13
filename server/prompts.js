function clean(text) {
  return String(text ?? "").trim();
}

export function transcriptFor(session, maxChars = 24000) {
  const msgs = session.messages ?? [];
  const render = (message) => {
    const speaker = message.author === "user"
      ? "USER"
      : message.author === "system"
        ? "SYSTEM"
        : `${String(message.agent || "AGENT").toUpperCase()}${message.role ? ` (${message.role})` : ""}`;
    return `[${speaker} | ${message.phase || "message"}${message.round ? ` | round ${message.round}` : ""}]\n${clean(message.content)}`;
  };
  const SEP = "\n\n---\n\n";
  const TRIM = "[Older context was trimmed by the local orchestrator.]";
  const blocks = msgs.map(render);
  const joined = blocks.join(SEP);
  // Clamp to a small floor so the trim marker itself always fits — this keeps the ≤ cap
  // ceiling below real even if a caller passes a tiny budget (no current caller does).
  const cap = Math.max(maxChars, TRIM.length + SEP.length + 40);
  if (joined.length <= cap) return joined;

  // Under delta-only middle rounds the full plan/position lives ONLY in the round-1 agent
  // turns, and a blind tail-slice would drop them (they sit at the head). So keep them as
  // verbatim "anchors" and fill the rest from the most recent tail.
  //
  // But sessions are PERSISTENT and multi-run: each new task appends another `user` turn and
  // a fresh round-1 opener to the same message list. Matching every round===1 would pin
  // stale proposals from earlier, unrelated tasks — wasting the budget on exactly the
  // full-rewrite bloat this change removes, and potentially dropping the current task. So
  // scope the anchors to the CURRENT run only: the latest `user` turn and the round-1 agent
  // turns after it.
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) { if (msgs[i].author === "user") { lastUserIdx = i; break; } }
  const anchorIdx = [];
  if (lastUserIdx >= 0) anchorIdx.push(lastUserIdx);
  for (let i = lastUserIdx + 1; i < msgs.length; i += 1) {
    if (msgs[i].author === "agent" && msgs[i].round === 1) anchorIdx.push(i);
  }
  let anchorText = anchorIdx.map((i) => blocks[i]).join(SEP);
  // Hard ceiling: even one run's own round-1 proposals could be huge. Cap the anchors so
  // anchorText + SEP + TRIM never exceeds the budget (the ≤ cap guarantee must hold). The
  // clamp above ensures anchorBudget > SUFFIX, so the else branch always applies.
  const SUFFIX = "\n…[anchor truncated]";
  const anchorBudget = Math.max(0, cap - TRIM.length - SEP.length);
  if (anchorText.length > anchorBudget) {
    anchorText = anchorBudget <= SUFFIX.length
      ? SUFFIX.slice(0, anchorBudget)
      : anchorText.slice(0, anchorBudget - SUFFIX.length) + SUFFIX;
  }

  // Fill from the most recent tail, strictly AFTER the anchors so the output stays in
  // chronological order and earlier runs are dropped entirely.
  const lastAnchor = anchorIdx.length ? anchorIdx[anchorIdx.length - 1] : lastUserIdx;
  const tail = [];
  let used = anchorText.length + TRIM.length + SEP.length * 2;
  for (let i = msgs.length - 1; i > lastAnchor; i -= 1) {
    const cost = blocks[i].length + SEP.length;
    if (used + cost > cap) break;
    tail.unshift(blocks[i]);
    used += cost;
  }
  return [anchorText, TRIM, tail.join(SEP)].filter(Boolean).join(SEP);
}

export function collaborationPrompt({ session, agentLabel, role, round, totalRounds, userTask, projectSnapshot = "" }) {
  const tools = projectSnapshot
    ? `You can READ the attached project (Read/Grep/Glob) to ground what you say in the real code — read only, never edit or run anything. When you make a claim about the code, point to the file (and the line when you can), and be honest about what you actually checked versus what you're inferring.`
    : `Work from what's in front of you — don't reach for tools, edit files, or run commands.`;
  // Round 1 is where you lay the whole thing out. After that it's DELTA-ONLY: say what
  // changed, not the whole plan again (re-writing it every round burns context for nothing).
  // Only the final synthesis rebuilds the complete version.
  const guidance = round === 1
    ? `Lay out your take in full this round. Talk through what's already solid in the shared work, what you'd change or add and why, the proposal as you'd shape it now, and anything you're honestly still unsure about. Write it the way you'd talk it through with a colleague you respect — in your own voice, not as a stiff numbered form.`
    : `This is a later round, so keep it to what's actually new — don't rewrite the whole plan. In a few honest lines: what you now accept from the other agent's last turn, where they're off and why, the one or two things you're really adding this round, and whatever's still open between you. If you've got nothing substantive left to add, just say so — don't pad it out.`;
  const control = round >= 2
    ? `\nOne housekeeping line for the orchestrator (not for the reader): make the very last line of your message either\nCONVERGENCE: converged\nor\nCONVERGENCE: open — <the specific point(s) you two still don't agree on>\nSay "converged" only when you genuinely agree with the other agent's latest position and have nothing real left to add or dispute. Don't wrap it in quotes or a code block, don't translate it, and don't write anything after it.\n`
    : "";
  return `You're ${agentLabel}, one of two agents thinking this through together in a shared session that the user runs and ultimately decides on.
Your seat at the table: ${role || "Collaborator"}.
This is round ${round}, and there's room for up to ${totalRounds} — but you're not here to fill rounds. The moment you and the other agent genuinely land in the same place, the session stops early, and that's exactly the outcome we want.

You're not competing. You're building one answer that's better than either of you would reach alone: take what's good in the other agent's work, fix what's weak, add what's missing, and move the shared solution forward. Don't just echo what's already on the table.

${guidance}
${control}
Reply in the same language the user last used. You don't literally share a session with the other model — the local orchestrator is handing you the shared transcript, so don't pretend otherwise. ${tools}
${projectSnapshot ? `\n${projectSnapshot}\n` : ""}
What the user asked for:
${clean(userTask)}

The conversation so far:
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
    ? `You can READ the attached project (Read/Grep/Glob) to ground your argument in the real code — read only, never edit or run anything. When you cite the code, name the file (and the line when you can), and keep what you verified separate from what you're inferring.`
    : `Argue from what's in front of you — don't reach for tools, edit files, or run commands.`;
  const guidance = independent
    ? `This is your opening. Form your own position from the task and the earlier context — don't shadow how your opponent framed theirs. Make the real case: where you stand and why, your strongest arguments, what you'll honestly concede, where the other side falls short, what evidence or test would actually change your mind, the call you'd make, and how confident you are (0–100). Argue it like you mean it, in your own voice — not as a checklist.`
    : `This is a rebuttal, so go straight at the strongest opposing point on the table — don't re-argue your whole case. In a few sharp, honest lines: what you now concede from their last turn, your best specific challenge to it, anything genuinely new you're bringing this round, what's still unsettled between you, and your updated confidence (0–100).`;
  const control = !independent
    ? `\nOne housekeeping line for the orchestrator, not the reader: make the very last line of your message either\nCONVERGENCE: converged\nor\nCONVERGENCE: open — <what the two of you still dispute>\nSay "converged" only if this is genuinely settled for you — you now agree or fully concede and have nothing real left to contest. No quotes, no code block, no translation, and nothing written after it.\n`
    : "";
  return `You're ${agentLabel}, debating in a shared session that the user runs and ultimately decides on.
Your position: ${role || "Critical debater"}.
Across the table: ${opponentLabel}.
This is round ${round}, with room for up to ${totalRounds} — but the session can stop early the moment the disagreement is genuinely resolved, so don't stretch it just to fill rounds.

${guidance}
${control}
Reply in the same language the user last used. ${tools}
${projectSnapshot ? `\n${projectSnapshot}\n` : ""}
The question on the table:
${clean(userTask)}

The debate so far:
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
