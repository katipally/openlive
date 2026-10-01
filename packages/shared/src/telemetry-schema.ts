// Everything OpenLive may report about its own use, in one place. The desktop
// main process is plain CJS and cannot import this, so
// `node apps/desktop/scripts/gen-telemetry-schema.cjs` writes it to
// `apps/desktop/telemetry/schema.json`, and a test fails when the two drift.
//
// Closed sets only: every value is an enum member, a boolean or a capped
// number. The one free-form string shape is a version number. A value that
// is not described here is never sent.

// ── prop kinds ────────────────────────────────────────────────────────────
const en = <const V extends readonly string[]>(values: V) => ({ k: "enum", values }) as const;
const bool = { k: "bool" } as const;
const int = (max: number, o: { step?: number; min?: number } = {}) => ({ k: "int", max, ...o }) as const;
const dec = (max: number, places: number) => ({ k: "dec", max, places }) as const;
const str = (pattern: string, max: number) => ({ k: "str", pattern, max }) as const;
const opt = <S extends object>(s: S) => ({ ...s, opt: true }) as const;
const many = <const K extends readonly string[], S>(keys: K, spec: S) =>
  Object.fromEntries(keys.map((k) => [k, spec])) as { [P in K[number]]: S };

// ── fold rules (facts only) ───────────────────────────────────────────────
const sum = <S extends object>(s: S) => ({ ...s, fold: "sum" }) as const;
const last = <S extends object>(s: S) => ({ ...s, fold: "last" }) as const;
const or = <S extends object>(s: S) => ({ ...s, fold: "or" }) as const;
const samples = <const I extends { p50: string; p95?: string }>(into: I) =>
  ({ k: "int", max: 600000, fold: "samples", into }) as const;

// ── closed sets ───────────────────────────────────────────────────────────
const PROVIDER_IDS = [
  "anthropic", "openai", "minimax", "ollama", "ollama-cloud", "groq", "openrouter", "deepseek",
  "mistral", "xai", "google", "together", "fireworks", "cerebras", "perplexity",
] as const;
const AGENT_IDS = ["claude-code", "codex", "cursor", "opencode", "hermes", "gemini", "copilot", "kiro", "pi"] as const;
const BRAIN_IDS = [...PROVIDER_IDS, ...AGENT_IDS] as const;
const LANGUAGES = ["en", "es", "fr", "de", "it", "pt", "hi", "zh", "ja", "ko"] as const;
const STT_FAMILIES = ["whisper", "nemotron", "nemotron-3.5", "parakeet", "moonshine", "canary"] as const;
const TTS_FAMILIES = ["kokoro", "supertonic", "clone", "pocket", "kitten", "piper", "kokoro-native", "matcha"] as const;
const ENGINE_FAMILIES = [
  "nemotron", "nemotron-3.5", "parakeet", "moonshine", "canary",
  "pocket", "kitten", "piper", "kokoro-native", "supertonic", "matcha", "voiceprint", "addressee",
] as const;
const ACCEL_PROVIDERS = ["cpu", "coreml", "cuda", "directml", "webgpu"] as const;
const FAILURE_CODES = [
  "no_provider", "no_accessibility", "secure_input", "offline", "models_missing", "hook_failed",
  "addon_missing", "mic_failed", "answer_lost", "brain_setup", "turn_failed",
] as const;
const QUIET_REASONS = ["none", "meeting", "mic_busy", "dnd", "output_muted", "off"] as const;
const LINUX_SESSIONS = ["x11", "wayland", "n/a"] as const;
const ON_OFF = ["on", "off"] as const;
const FEEDBACK_REASONS = ["wrong_answer", "too_slow", "misheard_me", "didnt_do_it", "other"] as const;
const VERSION = "^\\d+\\.\\d+\\.\\d+(-[A-Za-z0-9.]+)?$";

const WEB_STEPS = [
  "flow_onboarding_shown", "flow_onboarding_step2", "flow_onboarding_done", "flow_onboarding_skipped",
  "first_provider_key_saved", "first_agent_install_ok", "first_agent_ready", "voice_models_ready", "flow_consent_granted",
  "first_call_turn", "first_flow_turn",
  "tour_closed_home", "tour_closed_lobby", "tour_closed_call", "tour_closed_history", "tour_closed_settings",
  "first_settings_open", "first_settings_search", "first_palette_use", "first_history_open", "first_resume",
  "first_flow_history_open", "first_carry_on", "first_lobby_open", "first_camera_on", "first_screen_share", "first_typed_message",
  "first_ptt_on", "first_mode_switch", "first_shortcuts_sheet",
] as const;
const MAIN_STEPS = [
  "flow_hook_started", "flow_hook_failed", "first_flow_summon", "first_call", "first_device_action", "first_agent_start_ok",
  "first_flow_reply", "first_call_reply", "activated",
] as const;

/** One entry per allowlisted setting: the values it may take, and whose id may ride as `subject`. */
const SETTINGS = {
  login_item: { values: ON_OFF },
  end_on_lock: { values: ON_OFF },
  flow_armed: { values: ON_OFF },
  theme: { values: ["system", "light", "dark"] },
  look: { values: ["glass", "flat"] },
  custom_instructions: { values: ["set", "cleared"] },
  narrate_progress: { values: ON_OFF },
  api_provider: { values: ["none"], subject: "provider" },
  api_model: { values: ["changed", "cleared"], subject: "provider" },
  vision_model: { values: ["changed", "cleared"], subject: "provider" },
  api_effort: { values: ["auto", "low", "medium", "high", "xhigh", "max"] },
  ollama_address: { values: ["default", "local", "remote"] },
  agent_hidden: { values: ON_OFF, subject: "agent" },
  provider_key: { values: ["added", "removed"], subject: "provider" },
  agent_model: { values: ["changed"], subject: "agent" },
  language: { values: LANGUAGES },
  stt_family: { values: STT_FAMILIES },
  tts_family: { values: TTS_FAMILIES },
  wait_preset: { values: ["patient", "even", "quick", "custom"] },
  voiceprint: { values: ["off", "label", "gate"] },
  side_talk: { values: ["off", "shadow", "ignore"] },
  allow_restricted: { values: ON_OFF },
  flow_own_brain: { values: ON_OFF },
  flow_brain: { values: ["api", "acp"], subject: "agent" },
  flow_speak_replies: { values: ON_OFF },
  flow_own_wait: { values: ON_OFF },
  flow_quiet_meeting: { values: ON_OFF },
  flow_quiet_mic: { values: ON_OFF },
  flow_quiet_dnd: { values: ON_OFF },
  flow_consent: { values: ON_OFF },
  flow_insertion: { values: ["paste", "type"] },
  flow_idle_window: { values: ["90s", "5m", "30m", "custom"] },
  voice_input_mode: { values: ["hold", "toggle"] },
  ptt_enabled: { values: ON_OFF },
} as const;
type SettingName = keyof typeof SETTINGS;
type SettingValue = (typeof SETTINGS)[SettingName]["values"][number];
const SETTING_NAMES = Object.keys(SETTINGS) as SettingName[];
const SETTING_VALUES = [...new Set(Object.values(SETTINGS).flatMap((s) => s.values))] as SettingValue[];

const COUNTER_KEYS = [
  "n_settings_open", "n_settings_search", "n_palette_open", "n_palette_run", "n_shortcuts_sheet",
  "n_history_open", "n_history_search", "n_history_resume", "n_history_resume_cli_session", "n_flow_history_open",
  "n_flow_history_search", "n_flow_carry_on", "n_mode_to_flow", "n_mode_to_chat", "n_lobby_open", "n_camera_on",
  "n_screen_on", "n_typed_msg", "n_ptt_toggle", "n_not_for_you", "n_send_aside", "n_call_shortcut",
  "n_settings_tab_general", "n_settings_tab_models", "n_settings_tab_voice", "n_settings_tab_engine",
  "n_settings_tab_agents", "n_settings_tab_capabilities", "n_settings_tab_tools", "n_settings_tab_connectors", "n_settings_tab_skills", "n_settings_tab_memory", "n_settings_tab_chat", "n_settings_tab_flow", "n_settings_tab_privacy", "n_settings_tab_about",
] as const;

/** When the app may ask how it is doing, enforced in one place (telemetry/feedback.cjs). Days are whole days, hours whole hours. */
const FEEDBACK = {
  minDaysAfterFirstOpen: 2,
  minDaysBetweenPrompts: 7,
  minDaysBetweenSessionRatings: 7,
  minDaysBetweenNps: 90,
  npsMinActiveDays: 7,
  ignoredInARowForBackoff: 2,
  backoffDays: 30,
  sessionMinAnsweredTurns: 2,
  sessionFreshHours: 12,
} as const;

const FLOW_TOOLS = ["t_insert", "t_words", "t_see", "t_point", "t_keys", "t_window", "t_open", "t_shell", "t_memory"] as const;
const CALL_TOOLS = ["t_look", "t_clipboard", "t_open_url", "t_files", "t_web", "t_plan", "t_memory"] as const;
const FLOW_PERMS = ["perm_asks", "perm_allowed", "perm_denied", "perm_timeout", "perm_auto"] as const;
const CALL_PERMS = ["perm_asks", "perm_allowed", "perm_denied", "perm_timeout"] as const;

// ── shared prop specs ─────────────────────────────────────────────────────
const COUNT = int(999);
const MS = int(600000, { step: 10 });
const SECONDS = int(86400);
const BRAIN_KIND = en(["api", "acp"]);
const BRAIN_ID = en(BRAIN_IDS);
const LAUNCH_KIND = en(["manual", "login"]);
const EXIT_CODE = int(999, { min: -1 });

const brain = { brain_kind: opt(BRAIN_KIND), brain_id: opt(BRAIN_ID) };
const flowEndedBy = en(["gesture", "orb_button", "idle", "disarmed", "sleep_or_lock", "quit", "other"]);
const callEndedBy = en(["end_button", "orb_end", "window_closed", "sleep_or_lock", "start_failed", "switched_chat", "app_quit", "other"]);
const speech = {
  stt_ms_p50: opt(MS), tts_ms_p50: opt(MS), v2v_ms_p50: opt(MS), v2v_turns: opt(COUNT),
  stt_family: opt(en(STT_FAMILIES)), tts_family: opt(en(TTS_FAMILIES)), webgpu: opt(bool),
};
const agentSide = {
  agent_tools: opt(COUNT), agent_tools_failed: opt(COUNT), errors: opt(COUNT),
  ttft_ms_p50: opt(MS), ttft_ms_p95: opt(MS), turn_ms_p50: opt(MS),
  agent_start_ms: opt(MS), agent_restarts: opt(COUNT),
};

const events = {
  app_first_open: {
    props: { origin: en(["fresh", "existing_install"]), launch_kind: LAUNCH_KIND },
    limit: { oncePerInstall: true },
  },
  app_launch: {
    props: {
      launch_kind: LAUNCH_KIND,
      boot_result: en(["ok", "ports_blocked", "servers_timeout"]),
      boot_ms: opt(int(600000, { step: 100 })),
      agent_port_moved: opt(bool),
      prev_exit_clean: opt(bool),
      login_item: opt(bool),
      linux_session: opt(en(LINUX_SESSIONS)),
      look: opt(en(["glass", "flat"])),
      glass_blocked_by: opt(en(["none", "unsupported-os", "no-gpu", "reduce-transparency", "slow"])),
      theme: opt(en(["system", "light", "dark"])),
    },
    limit: { perLaunch: 1 },
  },
  app_active_day: {
    props: { first_surface: en(["main_window", "flow", "call", "tray"]) },
    limit: { perDay: 1 },
  },
  app_updated: {
    props: { from_version: str(VERSION, 20), to_version: str(VERSION, 20) },
    limit: { perLaunch: 1 },
  },
  update_result: {
    props: {
      stage: en(["available", "downloaded", "restart_now", "restart_later", "up_to_date", "failed"]),
      to_version: opt(str(VERSION, 20)),
      manual: opt(bool),
      error_kind: opt(en(["feed_missing", "asset_missing", "signature_invalid", "network", "other"])),
    },
    limit: { perDayPerKey: 1, dayKey: ["stage", "error_kind", "manual"] },
  },
  app_quit: {
    props: {
      via: en(["tray_menu", "app_menu", "update_restart", "no_tray", "os_shutdown", "boot_failed", "other"]),
      uptime_h: opt(dec(999, 1)),
    },
    limit: { perLaunch: 1 },
  },
  flow_session: {
    props: {
      ...brain,
      duration_s: SECONDS,
      ended_by: flowEndedBy,
      opened_by: opt(en(["gesture", "carry_on", "tray_new", "late_speech"])),
      ready: opt(en(["ok", "no_brain", "mic_failed"])),
      ready_ms: opt(MS),
      turns: COUNT,
      acted: bool,
      consent: opt(bool),
      lang: opt(en(LANGUAGES)),
      steered: opt(COUNT),
      quiet_turns: opt(COUNT),
      stops: opt(COUNT),
      barge_ins: opt(COUNT),
      top_quiet_reason: opt(en(QUIET_REASONS)),
      tool_calls: opt(COUNT),
      tool_errors: opt(COUNT),
      ...many(FLOW_TOOLS, opt(COUNT)),
      ...many(FLOW_PERMS, opt(COUNT)),
      perm_by_voice: opt(COUNT),
      failure_cards: opt(COUNT),
      fixes_clicked: opt(COUNT),
      last_failure: opt(en(["none", ...FAILURE_CODES])),
      lost_silence: opt(COUNT),
      lost_link: opt(COUNT),
      link_drops: opt(COUNT),
      mic_lost: opt(COUNT),
      ...agentSide,
      ...speech,
    },
    derive: { acted: ["t_insert", "t_keys", "t_point", "t_window", "t_open", "t_shell"] },
  },
  call_session: {
    props: {
      ...brain,
      duration_s: SECONDS,
      ended_by: callEndedBy,
      start_result: opt(en(["ok", "mic_denied", "start_failed"])),
      start_ms: opt(MS),
      turns: COUNT,
      typed_turns: opt(COUNT),
      interrupted: opt(COUNT),
      barge_ins: opt(COUNT),
      lang: opt(en(LANGUAGES)),
      camera_used: opt(bool),
      screen_used: opt(bool),
      ptt_used: opt(bool),
      has_folder: opt(bool),
      mic_lost: opt(COUNT),
      camera_failed: opt(COUNT),
      screen_failed: opt(COUNT),
      ...many(CALL_TOOLS, opt(COUNT)),
      ...many(CALL_PERMS, opt(COUNT)),
      perm_by_voice: opt(COUNT),
      elicitations: opt(COUNT),
      resumed: opt(en(["none", "resumed", "loaded", "fell_back"])),
      link_drops: opt(COUNT),
      ...agentSide,
      ...speech,
    },
  },
  brain_error: {
    props: {
      surface: en(["flow", "call"]),
      ...brain,
      class: en([
        "no_key", "no_model", "auth", "model_not_found", "quota", "rate_limited", "unreachable", "server_error",
        "bad_request", "stream_error", "other",
        "agent_no_folder", "agent_start_failed", "agent_start_timeout", "agent_no_output", "agent_stalled",
        "agent_crashed", "agent_rejected", "agent_refused",
      ]),
      recovered: opt(bool),
      http_class: opt(en(["4xx", "5xx", "none"])),
    },
    limit: { dedupeMs: 300000, dedupeKey: ["class", "brain_id"] },
  },
  flow_failure_card: {
    props: {
      code: en(FAILURE_CODES),
      origin: opt(en(["health", "turn", "mic", "lost_answer", "link"])),
      ...brain,
    },
    limit: { dedupeMs: 600000, dedupeKey: ["code"] },
  },
  crash_detected: {
    props: {
      source: en(["renderer", "gpu", "utility", "main_previous_run"]),
      reason: en([
        "crashed", "oom", "killed", "abnormal-exit", "launch-failed", "integrity-failure", "memory-eviction",
        "unclean_exit",
      ]),
      target: opt(en(["main_window", "flow_owner", "flow_orb", "cursor_overlay", "splash", "other", "none"])),
      exit_code: opt(EXIT_CODE),
    },
    limit: { perLaunch: 3 },
  },
  service_crashed: {
    props: {
      service: en(["agent", "web"]),
      exit_code: opt(EXIT_CODE),
      respawn_n: opt(int(99)),
      outcome: en(["respawning", "gave_up", "port_taken_by_other"]),
      uptime_s: opt(int(604800)),
    },
    limit: { perLaunch: 12 },
  },
  main_exception: {
    props: { process: en(["main", "agent"]), kind: en(["uncaught", "unhandled_rejection"]) },
    limit: { perLaunch: 3, launchKey: ["process"] },
  },
  voice_engine_fault: {
    props: {
      engine_family: en(ENGINE_FAMILIES),
      kind: en(["worker_crash", "accel_fallback", "bench_timeout", "bench_failed"]),
      provider: opt(en(ACCEL_PROVIDERS)),
    },
    limit: { perLaunch: 3, launchKey: ["engine_family"] },
  },
  voice_bench_result: {
    props: {
      engine_family: en(ENGINE_FAMILIES),
      engine_kind: en(["asr", "tts", "speaker", "addressee"]),
      chosen_provider: en(ACCEL_PROVIDERS),
      cpu_rtf: opt(dec(999, 2)),
      chosen_rtf: opt(dec(999, 2)),
      tier: opt(en(["low", "mid", "high"])),
      apple_silicon: opt(bool),
      providers_available: opt(int(9)),
    },
    limit: { oncePerValueOf: "engine_family" },
  },
  flow_readiness_changed: {
    props: {
      from: en(["unknown", "ready", "stopped", "access", "off"]),
      to: en(["ready", "stopped", "access", "off"]),
      perm_accessibility: opt(bool),
      perm_post_events: opt(bool),
      perm_screen: opt(bool),
      perm_microphone: opt(en(["granted", "denied", "undetermined", "restricted", "unknown"])),
      linux_session: opt(en(LINUX_SESSIONS)),
    },
    limit: { perLaunch: 6 },
  },
  os_permission_request: {
    props: {
      permission: en(["accessibility", "microphone", "screen", "post_events"]),
      granted_now: bool,
      asked_from: opt(en(["onboarding", "flow_settings", "flow_home", "other"])),
    },
    limit: { perDayPerKey: 3, dayKey: ["permission"] },
  },
  onboarding_step: {
    props: {
      step: en([...MAIN_STEPS, ...WEB_STEPS]),
      hours_since_first_open: opt(dec(99999, 1)),
      tour_exit: opt(en(["done", "skipped", "left"])),
      tour_step: opt(int(9, { min: 1 })),
    },
    limit: { oncePerValueOf: "step" },
  },
  flow_consent_result: {
    props: { outcome: en(["granted", "declined", "unanswered"]), brain_kind: opt(BRAIN_KIND) },
    limit: { perDay: 3 },
  },
  setting_changed: {
    props: {
      setting: en(SETTING_NAMES),
      value: en(SETTING_VALUES),
      subject: opt(en([...BRAIN_IDS, "none"])),
      from: opt(en(["onboarding", "settings", "call_setup", "flow_home", "other"])),
    },
    limit: { perDayPerKey: 3, dayKey: ["setting"] },
  },
  tray_action: {
    props: { action: en(["open", "new_flow", "allow_accessibility", "settings", "quit"]) },
  },
  remote_ollama_prompt: {
    props: {
      outcome: en(["accepted", "cancelled", "error"]),
      scheme: opt(en(["http", "https"])),
    },
  },
  agent_action_result: {
    props: {
      agent_id: en(AGENT_IDS),
      action: en(["install", "uninstall", "update", "login", "logout"]),
      result: en([
        "ok", "failed", "terminal_opened", "terminal_launch_failed", "npm_eacces", "error", "signed_in", "wait_timeout",
      ]),
      duration_s: opt(int(3600)),
    },
    limit: { perDayPerKey: 5, dayKey: ["agent_id"] },
  },
  lobby_blocked: {
    props: {
      gap: en([
        "agent_not_installed", "agent_signed_out", "no_api_key", "folder_missing", "folder_unset",
        "models_not_downloaded", "no_mic",
      ]),
      ...brain,
      left_via: opt(en(["back", "settings", "other"])),
    },
    limit: { perDayPerKey: 1, dayKey: ["gap"] },
  },
  voice_models_result: {
    props: {
      trigger: en(["lobby_button", "call_start", "flow_open", "launch_warm", "settings"]),
      result: en(["ok", "failed", "offline"]),
      duration_s: opt(SECONDS),
      mb: opt(int(99990, { step: 10 })),
      stt_family: opt(en(STT_FAMILIES)),
      tts_family: opt(en(TTS_FAMILIES)),
      webgpu: opt(bool),
    },
  },
  renderer_error: {
    props: {
      surface: en(["main", "owner"]),
      kind: en(["render_crash", "uncaught", "unhandled_rejection"]),
      during: opt(en(["call", "flow", "other"])),
    },
    limit: { perLaunch: 3, launchKey: ["surface"], dedupeMs: 600000, dedupeKey: ["kind"] },
  },
  feature_usage: {
    props: many(COUNTER_KEYS, opt(COUNT)),
    limit: { perDay: 3 },
  },
  feedback_given: {
    props: {
      surface: en(["flow", "call", "main"]),
      kind: en(["session_rating", "nps"]),
      outcome: en(["answered", "dismissed", "ignored", "never_again"]),
      rating: opt(en(["up", "down"])),
      score: opt(int(10)),
      reason: opt(en(FEEDBACK_REASONS)),
      ...brain,
      turns_bucket: opt(en(["2", "3_5", "6_10", "11_plus"])),
    },
    limit: { perDay: 1 },
  },
  telemetry_disabled: {
    props: { from: en(["notice", "settings"]), days_since_first_open: int(999) },
  },
} as const;

// ── facts: what is folded into the open Flow or call record ───────────────
// A fact prop names an event prop of the record it folds into. `sum` adds
// deltas, `last` keeps the newest, `or` is a sticky true, `samples` collects
// numbers and emits their percentiles into the named event props.
const facts = {
  flow_owner: {
    event: "flow_session",
    props: {
      opened_by: last(en(["gesture", "carry_on", "tray_new", "late_speech"])),
      ready: last(en(["ok", "no_brain", "mic_failed"])),
      ready_ms: last(MS),
      stops: sum(COUNT),
      barge_ins: sum(COUNT),
      top_quiet_reason: last(en(QUIET_REASONS)),
      failure_cards: sum(COUNT),
      fixes_clicked: sum(COUNT),
      last_failure: last(en(["none", ...FAILURE_CODES])),
      lost_silence: sum(COUNT),
      lost_link: sum(COUNT),
      link_drops: sum(COUNT),
      mic_lost: sum(COUNT),
      perm_by_voice: sum(COUNT),
      stt_ms_p50: last(MS),
      tts_ms_p50: last(MS),
      v2v_ms_p50: last(MS),
      v2v_turns: sum(COUNT),
      stt_family: last(en(STT_FAMILIES)),
      tts_family: last(en(TTS_FAMILIES)),
      webgpu: or(bool),
    },
  },
  call_renderer: {
    event: "call_session",
    props: {
      ended_by: last(callEndedBy),
      start_result: last(en(["ok", "mic_denied", "start_failed"])),
      start_ms: last(MS),
      barge_ins: sum(COUNT),
      typed_turns: sum(COUNT),
      camera_used: or(bool),
      screen_used: or(bool),
      ptt_used: or(bool),
      has_folder: last(bool),
      mic_lost: sum(COUNT),
      camera_failed: sum(COUNT),
      screen_failed: sum(COUNT),
      link_drops: sum(COUNT),
      perm_by_voice: sum(COUNT),
      stt_ms_p50: last(MS),
      tts_ms_p50: last(MS),
      v2v_ms_p50: last(MS),
      v2v_turns: sum(COUNT),
      stt_family: last(en(STT_FAMILIES)),
      tts_family: last(en(TTS_FAMILIES)),
      webgpu: or(bool),
    },
  },
  agent_flow: {
    event: "flow_session",
    props: {
      brain_kind: last(BRAIN_KIND),
      brain_id: last(BRAIN_ID),
      turns: sum(COUNT),
      lang: last(en(LANGUAGES)),
      steered: sum(COUNT),
      quiet_turns: sum(COUNT),
      tool_calls: sum(COUNT),
      tool_errors: sum(COUNT),
      ...many(FLOW_TOOLS, sum(COUNT)),
      agent_tools: sum(COUNT),
      agent_tools_failed: sum(COUNT),
      ...many(FLOW_PERMS, sum(COUNT)),
      errors: sum(COUNT),
      ttft_ms: samples({ p50: "ttft_ms_p50", p95: "ttft_ms_p95" }),
      turn_ms: samples({ p50: "turn_ms_p50" }),
      agent_start_ms: last(MS),
      agent_restarts: sum(COUNT),
      consent: last(bool),
    },
  },
  agent_call: {
    event: "call_session",
    props: {
      brain_kind: last(BRAIN_KIND),
      brain_id: last(BRAIN_ID),
      turns: sum(COUNT),
      interrupted: sum(COUNT),
      lang: last(en(LANGUAGES)),
      camera_used: or(bool),
      screen_used: or(bool),
      ...many(CALL_TOOLS, sum(COUNT)),
      agent_tools: sum(COUNT),
      agent_tools_failed: sum(COUNT),
      ...many(CALL_PERMS, sum(COUNT)),
      elicitations: sum(COUNT),
      resumed: last(en(["none", "resumed", "loaded", "fell_back"])),
      errors: sum(COUNT),
      ttft_ms: samples({ p50: "ttft_ms_p50", p95: "ttft_ms_p95" }),
      turn_ms: samples({ p50: "turn_ms_p50" }),
      agent_start_ms: last(MS),
      agent_restarts: sum(COUNT),
    },
  },
} as const;

const common = {
  app_version: str(VERSION, 20),
  platform: en(["darwin", "win32", "linux"]),
  arch: en(["arm64", "x64"]),
  arch_translated: bool,
  os_major: str("^([0-9]{1,2}|linux)$", 8),
  username: str("^[a-z]{3,12}-[a-z]{3,12}-[0-9a-f]{8}$", 40),
} as const;

export const telemetrySchema = {
  version: 1,
  common,
  events,
  facts,
  settings: SETTINGS,
  subjects: { provider: PROVIDER_IDS, agent: AGENT_IDS },
  counters: COUNTER_KEYS,
  feedback: FEEDBACK,
} as const;

// ── types ─────────────────────────────────────────────────────────────────
type PropValue<S> = S extends { k: "enum"; values: readonly (infer V)[] }
  ? V
  : S extends { k: "bool" }
    ? boolean
    : S extends { k: "int" | "dec" }
      ? number
      : S extends { k: "str" }
        ? string
        : never;
type Flat<T> = { [K in keyof T]: T[K] };
type PropsOf<P> = Flat<
  { [K in keyof P as P[K] extends { opt: true } ? never : K]: PropValue<P[K]> } & {
    [K in keyof P as P[K] extends { opt: true } ? K : never]?: PropValue<P[K]>;
  }
>;

export type TelemetryEventName = keyof typeof events;
/** The props of one event, required and optional as the schema says. The sender adds the common ones. */
export type TelemetryEventProps<E extends TelemetryEventName> = PropsOf<(typeof events)[E]["props"]>;
export type TelemetryFactScope = keyof typeof facts;
/** A delta for the open record. Every prop is optional and folds by the scope's rule. */
export type TelemetryFactProps<S extends TelemetryFactScope> = Partial<{
  [K in keyof (typeof facts)[S]["props"]]: PropValue<(typeof facts)[S]["props"][K]>;
}>;
export type FeatureCounterKey = (typeof COUNTER_KEYS)[number];

/** The shapes the generated JSON is read by, in plain CJS, without types. */
export interface TelemetryEventLimit {
  perLaunch?: number;
  launchKey?: readonly string[];
  perDay?: number;
  perDayPerKey?: number;
  dayKey?: readonly string[];
  dedupeMs?: number;
  dedupeKey?: readonly string[];
  oncePerInstall?: true;
  oncePerValueOf?: string;
}
export const eventLimit = (name: TelemetryEventName): TelemetryEventLimit | undefined =>
  (events[name] as { limit?: TelemetryEventLimit }).limit;
