const ERROR_MESSAGE_KEYS = Object.freeze({
  unauthorized: "errorUnauthorized",
  forbidden_origin: "errorForbiddenOrigin",
  server_shutting_down: "errorServerShuttingDown",
  session_busy: "errorSessionBusy",
  title_required: "errorTitleRequired",
  state_change_requires_execution: "routeStateChangeRequiresExecution",
  project_trust_required: "routeProjectTrustRequired",
  project_path_required: "errorProjectPathRequired",
  project_path_not_found: "errorProjectPathNotFound",
  project_path_not_directory: "errorProjectPathNotDirectory",
  pending_execution_decisions: "errorPendingExecutionDecisions",
  project_not_attached: "errorProjectNotAttached",
  project_identity_changed: "errorProjectIdentityChanged",
  project_changed_before_trust: "errorProjectChangedBeforeTrust",
  startup_recovery_pending: "errorStartupRecoveryPending",
  execution_accept_failed: "errorExecutionAcceptFailed",
  execution_reject_failed: "errorExecutionRejectFailed",
  connector_catalog_failed: "errorConnectorCatalogFailed",
  connector_toggle_failed: "errorConnectorToggleFailed",
  connector_action_request_failed: "errorConnectorActionRequestFailed",
  connector_action_decision_failed: "errorConnectorActionDecisionFailed",
  connector_configuration_failed: "errorConnectorConfigurationFailed",
  provider_update_failed: "errorProviderUpdateFailed",
  provider_check_failed: "errorProviderCheckFailed",
  provider_model_discovery_failed: "errorProviderModelDiscoveryFailed",
  github_repositories_unavailable: "errorGithubRepositoriesUnavailable",
  github_clone_failed: "errorGithubCloneFailed",
  filesystem_list_failed: "errorFilesystemListFailed",
  not_found: "errorNotFound",
  internal_error: "errorInternal",
});

const CONNECTOR_LABEL_KEYS = Object.freeze({
  github: "connectorGithub",
  gmail: "connectorGmail",
  supabase: "connectorSupabase",
});

const CONNECTOR_ACTION_KEYS = Object.freeze({
  "github:list_repositories": { label: "actionGithubListRepositories", description: "actionGithubListRepositoriesDescription" },
  "github:create_issue": { label: "actionGithubCreateIssue", description: "actionGithubCreateIssueDescription" },
  "gmail:list_messages": { label: "actionGmailListMessages", description: "actionGmailListMessagesDescription" },
  "gmail:get_message": { label: "actionGmailGetMessage", description: "actionGmailGetMessageDescription" },
  "gmail:send_message": { label: "actionGmailSendMessage", description: "actionGmailSendMessageDescription" },
  "supabase:select_rows": { label: "actionSupabaseSelectRows", description: "actionSupabaseSelectRowsDescription" },
  "supabase:insert_row": { label: "actionSupabaseInsertRow", description: "actionSupabaseInsertRowDescription" },
});

const CONNECTOR_STATUS_KEYS = Object.freeze({
  pending: "actionPending",
  executing_unknown: "actionUnknown",
  completed: "actionCompleted",
  failed_after_approval: "actionFailed",
  rejected: "actionRejected",
});

const DECISION_TYPE_KEYS = Object.freeze({
  project_trust: "decisionTypeProjectTrust",
  execution: "decisionTypeExecution",
  connector: "decisionTypeConnector",
  connector_action: "decisionTypeConnectorAction",
  decision: "decisionTypeDecision",
});

const DECISION_OUTCOME_KEYS = Object.freeze({
  trusted: "decisionOutcomeTrusted",
  accepted: "decisionOutcomeAccepted",
  blocked_secret: "decisionOutcomeBlockedSecret",
  rejected: "decisionOutcomeRejected",
  enabled: "decisionOutcomeEnabled",
  disabled: "decisionOutcomeDisabled",
  approved: "decisionOutcomeApproved",
});

const DECISION_ACTION_KEYS = Object.freeze({
  merge: "decisionActionMerge",
  pr: "decisionActionPr",
});

export function localeId(language) {
  return language === "en" ? "en-GB" : "ar-EG";
}

export function formatLocaleNumber(language, value) {
  return new Intl.NumberFormat(localeId(language)).format(Number(value));
}

export function formatMessageCount(language, value) {
  const count = Math.max(0, Number(value) || 0);
  const locale = localeId(language);
  const category = new Intl.PluralRules(locale).select(count);
  if (language === "en") return `${formatLocaleNumber(language, count)} ${category === "one" ? "message" : "messages"}`;
  if (category === "zero") return "لا رسائل";
  if (category === "one") return "رسالة واحدة";
  if (category === "two") return "رسالتان";
  return `${formatLocaleNumber(language, count)} ${category === "few" ? "رسائل" : "رسالة"}`;
}

export function formatLocaleDuration(language, milliseconds) {
  const numeric = Number(milliseconds);
  if (!Number.isFinite(numeric)) return "";
  const totalSeconds = Math.max(0, Math.round(numeric / 1000));
  const locale = localeId(language);
  const secondsFormatter = new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "short" });
  if (totalSeconds < 60) return secondsFormatter.format(totalSeconds);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const minutesFormatter = new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "short" });
  return new Intl.ListFormat(locale, { style: "narrow", type: "unit" }).format([
    minutesFormatter.format(minutes),
    secondsFormatter.format(seconds),
  ]);
}

export function errorMessageKey(failure = {}) {
  const code = failure.code || failure.reasonCode || failure.route?.reasonCode;
  return ERROR_MESSAGE_KEYS[code] || "errorUnexpected";
}

export function connectorLabelKey(connectorId) {
  return CONNECTOR_LABEL_KEYS[connectorId] || null;
}

export function connectorActionKeys(connectorId, actionId) {
  return CONNECTOR_ACTION_KEYS[`${connectorId}:${actionId}`] || null;
}

export function connectorStatusKey(status) {
  return CONNECTOR_STATUS_KEYS[status] || null;
}

export function decisionTypeKey(type) {
  return DECISION_TYPE_KEYS[type] || null;
}

export function decisionOutcomeKey(outcome) {
  return DECISION_OUTCOME_KEYS[outcome] || null;
}

export function decisionActionKey(action) {
  return DECISION_ACTION_KEYS[action] || null;
}
