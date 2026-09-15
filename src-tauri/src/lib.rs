mod desktop_service;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const USER_AGENT_VALUE: &str = "upstream-balance-tauri/0.1";
const DEFAULT_QUOTA_PER_UNIT: f64 = 500000.0;
const CONFIG_FILE_NAME: &str = "config.v2.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_true")]
    pub remember_secret: bool,
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub paths: String,
    #[serde(default = "default_timeout")]
    pub timeout: f64,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub auto_probe_interval_minutes: u64,
    #[serde(default)]
    pub low_balance_threshold: f64,
    #[serde(default)]
    pub last_alert_level: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAccount {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_true")]
    pub remember_secret: bool,
    pub preset: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub paths: String,
    #[serde(default = "default_timeout")]
    pub timeout: f64,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub auto_probe_interval_minutes: u64,
    #[serde(default)]
    pub low_balance_threshold: f64,
    #[serde(default)]
    pub last_alert_level: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub id: String,
    pub name: String,
    pub preset: String,
    pub ok: bool,
    pub status: String,
    pub balance_number: Option<f64>,
    pub balance_display: String,
    pub unit: String,
    pub http_status: u16,
    pub endpoint: String,
    pub message: String,
    pub raw_summary: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResult {
    pub ok: bool,
    pub http_status: u16,
    pub endpoint: String,
    pub models: Vec<String>,
    pub message: String,
    pub raw_summary: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageTestRequest {
    pub account: Account,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub size: String,
    #[serde(default)]
    pub quality: String,
    #[serde(default = "default_image_count")]
    pub n: u32,
    #[serde(default)]
    pub response_format: String,
    #[serde(default)]
    pub output_format: String,
    #[serde(default)]
    pub background: String,
    #[serde(default = "default_timeout")]
    pub timeout: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageTestResult {
    pub ok: bool,
    pub http_status: u16,
    pub endpoint: String,
    pub model: String,
    pub image_url: Option<String>,
    pub image_b64: Option<String>,
    pub revised_prompt: String,
    pub message: String,
    pub raw_summary: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub accounts: Vec<SavedAccount>,
    #[serde(default)]
    pub email: EmailConfig,
    #[serde(default = "default_threshold")]
    pub threshold: f64,
    #[serde(default)]
    pub alert_levels: AlertLevels,
    #[serde(default = "default_auto_probe_interval")]
    pub auto_probe_interval_minutes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertLevels {
    #[serde(default = "default_alert_level1")]
    pub level1: f64,
    #[serde(default = "default_alert_level2")]
    pub level2: f64,
    #[serde(default = "default_alert_level3")]
    pub level3: f64,
}

impl Default for AlertLevels {
    fn default() -> Self {
        Self {
            level1: default_alert_level1(),
            level2: default_alert_level2(),
            level3: default_alert_level3(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub smtp_host: String,
    #[serde(default = "default_smtp_port")]
    pub smtp_port: u16,
    #[serde(default = "default_true")]
    pub smtp_ssl: bool,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub sender: String,
    #[serde(default)]
    pub recipients: String,
    #[serde(default = "default_cooldown")]
    pub cooldown_minutes: u64,
    #[serde(default)]
    pub last_alert_at: u64,
}

impl Default for EmailConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            smtp_host: String::new(),
            smtp_port: 465,
            smtp_ssl: true,
            username: String::new(),
            password: String::new(),
            sender: String::new(),
            recipients: String::new(),
            cooldown_minutes: 60,
            last_alert_at: 0,
        }
    }
}

fn default_preset() -> String {
    "auto".to_string()
}
fn default_timeout() -> f64 {
    12.0
}
fn default_smtp_port() -> u16 {
    465
}
fn default_true() -> bool {
    true
}
fn default_cooldown() -> u64 {
    60
}
fn default_threshold() -> f64 {
    5.0
}
fn default_alert_level1() -> f64 {
    10.0
}
fn default_alert_level2() -> f64 {
    6.0
}
fn default_alert_level3() -> f64 {
    1.0
}
fn default_auto_probe_interval() -> u64 {
    0
}
fn default_image_count() -> u32 {
    1
}

fn app_config_path() -> PathBuf {
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        return PathBuf::from(profile)
            .join("AppData")
            .join("Roaming")
            .join("UpstreamBalanceRadar")
            .join(CONFIG_FILE_NAME);
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    base.join("UpstreamBalanceRadar").join(CONFIG_FILE_NAME)
}

fn push_unique_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<String>, path: PathBuf) {
    let key = path.display().to_string().to_lowercase();
    if seen.insert(key) {
        paths.push(path);
    }
}

fn config_candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    push_unique_path(&mut paths, &mut seen, app_config_path());
    if let Some(appdata) = std::env::var_os("APPDATA") {
        push_unique_path(
            &mut paths,
            &mut seen,
            PathBuf::from(appdata)
                .join("UpstreamBalanceRadar")
                .join("config.json"),
        );
    }
    if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") {
        push_unique_path(
            &mut paths,
            &mut seen,
            PathBuf::from(local_appdata)
                .join("UpstreamBalanceRadar")
                .join("config.json"),
        );
    }
    if let Ok(current_dir) = std::env::current_dir() {
        push_unique_path(
            &mut paths,
            &mut seen,
            current_dir.join("UpstreamBalanceRadar").join("config.json"),
        );
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            push_unique_path(
                &mut paths,
                &mut seen,
                parent.join("UpstreamBalanceRadar").join("config.json"),
            );
        }
    }
    paths
}

fn legacy_config_candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        push_unique_path(
            &mut paths,
            &mut seen,
            PathBuf::from(profile)
                .join("AppData")
                .join("Roaming")
                .join("UpstreamBalanceRadar")
                .join("config.json"),
        );
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        push_unique_path(
            &mut paths,
            &mut seen,
            PathBuf::from(appdata)
                .join("UpstreamBalanceRadar")
                .join("config.json"),
        );
    }
    if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") {
        push_unique_path(
            &mut paths,
            &mut seen,
            PathBuf::from(local_appdata)
                .join("UpstreamBalanceRadar")
                .join("config.json"),
        );
    }
    paths
}

fn empty_app_config() -> AppConfig {
    AppConfig {
        accounts: Vec::new(),
        email: EmailConfig::default(),
        threshold: default_threshold(),
        alert_levels: AlertLevels::default(),
        auto_probe_interval_minutes: default_auto_probe_interval(),
    }
}

fn read_config_file(path: &Path) -> Result<Option<AppConfig>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
}

fn merged_config_from_candidates() -> Result<AppConfig, String> {
    if let Some(primary) = read_config_file(&app_config_path())? {
        return Ok(primary);
    }
    let mut configs = Vec::new();
    for path in legacy_config_candidate_paths() {
        if let Some(cfg) = read_config_file(&path)? {
            configs.push(cfg);
        }
    }
    if configs.is_empty() {
        return Ok(empty_app_config());
    }
    configs.sort_by_key(|cfg| std::cmp::Reverse(cfg.accounts.len()));
    let mut merged = configs.remove(0);
    for cfg in configs {
        merged.accounts = merge_saved_accounts(merged.accounts, Some(&cfg), false);
    }
    Ok(merged)
}

fn write_config_file(path: &Path, cfg: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, text).map_err(|e| e.to_string())?;
    if let Err(rename_error) = fs::rename(&temp_path, path) {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(remove_error) if remove_error.kind() == std::io::ErrorKind::NotFound => {}
            Err(remove_error) => return Err(remove_error.to_string()),
        }
        fs::rename(&temp_path, path).map_err(|_| rename_error.to_string())?;
    }
    Ok(())
}

fn account_to_saved(account: &Account) -> SavedAccount {
    SavedAccount {
        id: account.id.clone(),
        name: account.name.clone(),
        base_url: normalize_base_url(&account.base_url),
        api_key: if account.remember_secret {
            account.api_key.clone()
        } else {
            String::new()
        },
        remember_secret: account.remember_secret,
        preset: account.preset.clone(),
        endpoint: account.endpoint.clone(),
        paths: account.paths.clone(),
        timeout: account.timeout,
        user_id: account.user_id.clone(),
        auto_probe_interval_minutes: account.auto_probe_interval_minutes,
        low_balance_threshold: account.low_balance_threshold,
        last_alert_level: account.last_alert_level.min(3),
    }
}

fn merge_saved_accounts(
    mut incoming: Vec<SavedAccount>,
    existing: Option<&AppConfig>,
    allow_account_removal: bool,
) -> Vec<SavedAccount> {
    if allow_account_removal {
        return incoming;
    }
    let Some(existing) = existing else {
        return incoming;
    };
    let mut seen = HashSet::new();
    incoming.retain(|account| seen.insert(account.id.clone()));
    for account in &existing.accounts {
        if seen.insert(account.id.clone()) {
            incoming.push(account.clone());
        }
    }
    incoming
}

fn normalize_base_url(value: &str) -> String {
    let mut raw = value.trim();
    if let Some(open) = raw.find("](") {
        let inner_start = open + 2;
        if let Some(close) = raw[inner_start..].find(')') {
            raw = &raw[inner_start..inner_start + close];
        }
    } else if let Some(start) = raw.find("https://").or_else(|| raw.find("http://")) {
        raw = &raw[start..];
    }
    let cut = ['，', ',', ' ', '\t', '\r', '\n']
        .iter()
        .filter_map(|sep| raw.find(*sep))
        .min()
        .unwrap_or(raw.len());
    raw[..cut]
        .trim()
        .trim_end_matches(|ch| {
            matches!(
                ch,
                '/' | '，' | ',' | '、' | '；' | ';' | '。' | ')' | '）' | ']' | '】'
            )
        })
        .to_string()
}

fn display_name(account: &Account) -> String {
    if !account.name.trim().is_empty() {
        account.name.trim().to_string()
    } else if !account.base_url.trim().is_empty() {
        account.base_url.trim().to_string()
    } else {
        "未命名渠道".to_string()
    }
}

fn format_number(value: Option<f64>) -> String {
    match value {
        None => String::new(),
        Some(v) if v.abs() >= 1000.0 => {
            let s = format!("{:.4}", v);
            trim_float(&s)
        }
        Some(v) => {
            let s = format!("{:.6}", v);
            trim_float(&s)
        }
    }
}

fn trim_float(s: &str) -> String {
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn is_unlimited(unit: &str) -> bool {
    matches!(
        unit.trim().to_ascii_lowercase().as_str(),
        "unlimited" | "unlimited_quota" | "no_limit" | "no limit" | "不限额" | "无限额" | "∞"
    )
}

fn to_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let cleaned = s.replace(',', "");
            let mut buf = String::new();
            let mut started = false;
            for ch in cleaned.chars() {
                if ch.is_ascii_digit()
                    || ch == '.'
                    || ch == '-'
                    || ch == '+'
                    || ch == 'e'
                    || ch == 'E'
                {
                    buf.push(ch);
                    started = true;
                } else if started {
                    break;
                }
            }
            buf.parse::<f64>().ok()
        }
        _ => None,
    }
}

fn path_get<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for part in path.split('.') {
        if part.is_empty() {
            return None;
        }
        if let Some(open) = part.find('[') {
            let key = &part[..open];
            let close = part.find(']')?;
            let idx = part[open + 1..close].parse::<usize>().ok()?;
            current = current.get(key)?.get(idx)?;
        } else {
            current = current.get(part)?;
        }
    }
    Some(current)
}

fn first_path<'a, 'p>(value: &'a Value, paths: &'p [&'p str]) -> Option<(&'p str, &'a Value)> {
    for path in paths {
        if let Some(v) = path_get(value, path) {
            if !v.is_null() {
                return Some((*path, v));
            }
        }
    }
    None
}

fn deep_find_key<'a>(value: &'a Value, keys: &[&str], depth: usize) -> Option<(String, &'a Value)> {
    if depth > 7 {
        return None;
    }
    match value {
        Value::Object(map) => {
            for (key, v) in map {
                if keys.iter().any(|wanted| wanted.eq_ignore_ascii_case(key)) && !v.is_null() {
                    return Some((key.clone(), v));
                }
                if let Some(found) = deep_find_key(v, keys, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| deep_find_key(item, keys, depth + 1)),
        _ => None,
    }
}

fn quota_unit_value(data: &Value) -> f64 {
    let paths = [
        "quota_per_unit",
        "data.quota_per_unit",
        "_newapi_status.quota_per_unit",
        "_newapi_status.data.quota_per_unit",
    ];
    for path in paths {
        if let Some(v) = path_get(data, path).and_then(to_number) {
            if v > 0.0 {
                return v;
            }
        }
    }
    DEFAULT_QUOTA_PER_UNIT
}

fn quota_display_type(data: &Value) -> String {
    let paths = [
        "quota_display_type",
        "data.quota_display_type",
        "_newapi_status.quota_display_type",
        "_newapi_status.data.quota_display_type",
    ];
    for path in paths {
        if let Some(Value::String(s)) = path_get(data, path) {
            return s.trim().to_ascii_uppercase();
        }
    }
    "USD".to_string()
}

fn quota_display_value(raw: f64, data: &Value) -> (f64, String, String) {
    let divisor = quota_unit_value(data);
    let dtype = quota_display_type(data);
    let raw_note = format!("原始额度 {} quota", format_number(Some(raw)));
    if dtype == "TOKENS" {
        return (
            raw,
            "quota units".to_string(),
            format!("{}；站点为 TOKENS 展示，未换算", raw_note),
        );
    }
    let usd = raw / divisor;
    if dtype == "CNY" {
        let rate = [
            "usd_exchange_rate",
            "data.usd_exchange_rate",
            "_newapi_status.usd_exchange_rate",
            "_newapi_status.data.usd_exchange_rate",
        ]
        .iter()
        .find_map(|p| path_get(data, p).and_then(to_number))
        .unwrap_or(7.3);
        return (
            usd * rate,
            "CNY eq.".to_string(),
            format!(
                "{}；按 quota_per_unit={}、USD汇率={} 换算",
                raw_note,
                format_number(Some(divisor)),
                format_number(Some(rate))
            ),
        );
    }
    (
        usd,
        "USD eq.".to_string(),
        format!(
            "{}；按 quota_per_unit={} 换算",
            raw_note,
            format_number(Some(divisor))
        ),
    )
}

fn common_balance(data: &Value) -> (Option<f64>, String, String) {
    let paths = [
        "balance",
        "credit",
        "credits",
        "quota",
        "available_balance",
        "availableBalance",
        "remain_quota",
        "remaining_quota",
        "remaining",
        "total_balance",
        "totalBalance",
        "total_available",
        "totalAvailable",
        "data.balance",
        "data.credit",
        "data.credits",
        "data.quota",
        "data.available_balance",
        "data.remaining",
        "data.total_balance",
        "data.total_available",
        "result.balance",
        "result.credit",
        "result.remaining",
    ];
    let found = first_path(data, &paths)
        .map(|(p, v)| (p.to_string(), v))
        .or_else(|| {
            deep_find_key(
                data,
                &[
                    "balance",
                    "credit",
                    "credits",
                    "quota",
                    "available_balance",
                    "availableBalance",
                    "remain_quota",
                    "remaining_quota",
                    "remaining",
                    "total_balance",
                    "totalBalance",
                    "total_available",
                    "totalAvailable",
                ],
                0,
            )
        });
    let unit = [
        "unit",
        "currency",
        "billing_mode",
        "data.unit",
        "data.currency",
        "result.unit",
        "result.currency",
    ]
    .iter()
    .find_map(|p| path_get(data, p).and_then(|v| v.as_str()))
    .unwrap_or("")
    .to_string();
    match found {
        Some((path, v)) => (to_number(v), unit, format!("字段 {}", path)),
        None => (None, unit, "未识别余额字段".to_string()),
    }
}

fn endpoint_candidates(base_url: &str, path_or_url: &str) -> Vec<String> {
    let path = path_or_url.trim();
    if path.starts_with("http://") || path.starts_with("https://") {
        return vec![path.to_string()];
    }
    let base = normalize_base_url(base_url);
    let without_v1 = if base.to_ascii_lowercase().ends_with("/v1") {
        base[..base.len() - 3].trim_end_matches('/').to_string()
    } else {
        base.clone()
    };
    let mut roots = Vec::new();
    if path.starts_with("/api/") {
        roots.push(without_v1);
    } else {
        if base.to_ascii_lowercase().ends_with("/v1") {
            roots.push(without_v1);
        }
        roots.push(base);
    }
    roots
        .into_iter()
        .map(|root| {
            format!(
                "{}{}",
                root.trim_end_matches('/'),
                if path.starts_with('/') {
                    path.to_string()
                } else {
                    format!("/{}", path)
                }
            )
        })
        .collect()
}

async fn request_json(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    timeout_secs: f64,
    extra_headers: &[(&str, String)],
) -> (u16, Value) {
    let mut req = client
        .get(url)
        .timeout(std::time::Duration::from_secs_f64(
            timeout_secs.clamp(3.0, 60.0),
        ))
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, USER_AGENT_VALUE);
    if !api_key.trim().is_empty() {
        req = req.header(AUTHORIZATION, format!("Bearer {}", api_key.trim()));
    }
    for (k, v) in extra_headers {
        req = req.header(*k, v);
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let content_type = resp
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let text = resp.text().await.unwrap_or_default();
            let data = parse_response_json(&text, &content_type, 2000);
            (status, data)
        }
        Err(err) => (0, json!({"error": err.to_string()})),
    }
}

async fn request_post_json(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    timeout_secs: f64,
    body: Value,
    extra_headers: &[(&str, String)],
) -> (u16, Value) {
    let mut req = client
        .post(url)
        .timeout(std::time::Duration::from_secs_f64(
            timeout_secs.clamp(3.0, 180.0),
        ))
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(USER_AGENT, USER_AGENT_VALUE)
        .json(&body);
    if !api_key.trim().is_empty() {
        req = req.header(AUTHORIZATION, format!("Bearer {}", api_key.trim()));
    }
    for (k, v) in extra_headers {
        req = req.header(*k, v);
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let content_type = resp
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let text = resp.text().await.unwrap_or_default();
            let data = parse_response_json(&text, &content_type, 4000);
            (status, data)
        }
        Err(err) => (0, json!({"error": err.to_string()})),
    }
}

fn parse_response_json(text: &str, content_type: &str, max_chars: usize) -> Value {
    if let Ok(data) = serde_json::from_str::<Value>(text) {
        return data;
    }
    let raw = text.chars().take(max_chars).collect::<String>();
    let is_html = looks_like_html(text, content_type);
    json!({
        "error": if is_html { "端点返回 HTML，不是 JSON 余额接口" } else { "端点返回非 JSON 内容" },
        "content_type": content_type,
        "raw": raw,
    })
}

fn looks_like_html(text: &str, content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    let head = text
        .trim_start()
        .chars()
        .take(160)
        .collect::<String>()
        .to_ascii_lowercase();
    ct.contains("text/html")
        || head.starts_with("<!doctype html")
        || head.starts_with("<html")
        || head.contains("<head")
        || head.contains("<title")
}

fn account_extra_headers(account: &Account) -> Vec<(&'static str, String)> {
    let mut headers = Vec::new();
    if !account.user_id.trim().is_empty() {
        headers.push(("New-Api-User", account.user_id.trim().to_string()));
    }
    headers
}

fn extract_models(data: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(items) = path_get(data, "data").and_then(|v| v.as_array()) {
        for item in items {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                out.push(id.to_string());
            }
        }
    }
    if out.is_empty() {
        if let Some(items) = data.as_array() {
            for item in items {
                if let Some(id) = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .or_else(|| item.as_str())
                {
                    out.push(id.to_string());
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn first_image_payload(data: &Value) -> (Option<String>, Option<String>, String) {
    let item = path_get(data, "data[0]").unwrap_or(data);
    let image_url = item
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            path_get(data, "url")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    let image_b64 = item
        .get("b64_json")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            path_get(data, "b64_json")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    let revised_prompt = item
        .get("revised_prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    (image_url, image_b64, revised_prompt)
}

async fn first_json_endpoint_with_headers(
    client: &reqwest::Client,
    base_url: &str,
    path: &str,
    api_key: &str,
    timeout: f64,
    extra_headers: &[(&str, String)],
) -> (String, u16, Value) {
    let mut last = (String::new(), 0, json!({}));
    let mut preferred: Option<(String, u16, Value)> = None;
    for endpoint in endpoint_candidates(base_url, path) {
        let (code, data) = request_json(client, &endpoint, api_key, timeout, extra_headers).await;
        last = (endpoint.clone(), code, data.clone());
        if code == 200 {
            return last;
        }
        if matches!(code, 400 | 401 | 403) && preferred.is_none() {
            preferred = Some((endpoint, code, data));
        }
    }
    preferred.unwrap_or(last)
}

async fn first_json_endpoint(
    client: &reqwest::Client,
    base_url: &str,
    path: &str,
    api_key: &str,
    timeout: f64,
) -> (String, u16, Value) {
    first_json_endpoint_with_headers(client, base_url, path, api_key, timeout, &[]).await
}

async fn fetch_newapi_status(
    client: &reqwest::Client,
    base_url: &str,
    timeout: f64,
) -> (String, u16, Value) {
    let (endpoint, code, data) =
        first_json_endpoint(client, base_url, "/api/status", "", timeout).await;
    if code == 200 {
        if let Some(inner) = data.get("data") {
            return (endpoint, code, inner.clone());
        }
        return (endpoint, code, data);
    }
    (endpoint, code, json!({}))
}

fn with_status(data: Value, status: Value) -> Value {
    if status.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        return data;
    }
    match data {
        Value::Object(mut map) => {
            map.insert("_newapi_status".into(), status);
            Value::Object(map)
        }
        other => json!({"response": other, "_newapi_status": status}),
    }
}

fn extract_newapi_token_balance(data: &Value) -> (Option<f64>, String, String) {
    if path_get(data, "data.unlimited_quota").and_then(|v| v.as_bool()) == Some(true)
        || path_get(data, "unlimited_quota").and_then(|v| v.as_bool()) == Some(true)
    {
        return (
            None,
            "unlimited".to_string(),
            "该 API Key 在 New API 中开启 unlimited_quota=true，所以没有有限余额上限".to_string(),
        );
    }
    let paths = [
        "data.total_available",
        "total_available",
        "data.remain_quota",
        "remain_quota",
        "data.quota",
        "quota",
    ];
    if let Some((path, v)) = first_path(data, &paths) {
        if let Some(raw) = to_number(v) {
            let (converted, unit, note) = quota_display_value(raw, data);
            return (
                Some(converted),
                unit,
                format!("New API token 字段 {}；{}", path, note),
            );
        }
    }
    common_balance(data)
}

fn extract_sub2api_usage_balance(data: &Value) -> (Option<f64>, String, String) {
    let paths = [
        "remaining_grant",
        "remaining_balance",
        "remaining_usd",
        "remaining",
        "balance",
        "wallet_balance",
        "usage.remaining_grant",
        "usage.remaining_balance",
        "usage.remaining_usd",
        "usage.remaining",
        "usage.balance",
        "subscription.remaining_grant",
        "subscription.remaining",
        "subscription.balance",
        "data.remaining_grant",
        "data.remaining_balance",
        "data.remaining_usd",
        "data.remaining",
        "data.balance",
        "data.wallet_balance",
        "data.usage.remaining_grant",
        "data.usage.remaining",
        "data.subscription.remaining_grant",
        "data.subscription.remaining",
        "quota.remaining",
        "quota.available",
        "data.quota.remaining",
        "data.quota.available",
        "rate_limits.remaining",
        "data.rate_limits.remaining",
    ];
    if let Some((path, value)) = first_path(data, &paths) {
        let unit = path_get(data, "currency")
            .and_then(|v| v.as_str())
            .or_else(|| path_get(data, "unit").and_then(|v| v.as_str()))
            .or_else(|| path_get(data, "usage.currency").and_then(|v| v.as_str()))
            .or_else(|| path_get(data, "usage.unit").and_then(|v| v.as_str()))
            .or_else(|| path_get(data, "data.currency").and_then(|v| v.as_str()))
            .or_else(|| path_get(data, "data.unit").and_then(|v| v.as_str()))
            .unwrap_or("USD")
            .to_string();
        return (to_number(value), unit, format!("字段 {}", path));
    }
    let usage_paths = [
        "total_cost",
        "usage.total_cost",
        "data.total_cost",
        "data.usage.total_cost",
    ];
    if let Some((path, value)) = first_path(data, &usage_paths) {
        if to_number(value).is_some() {
            return (
                None,
                "USD".to_string(),
                format!(
                    "字段 {} 是已消耗金额，不是剩余额度；如需钱包余额请使用 Sub2API 面板 JWT 预设",
                    path
                ),
            );
        }
    }
    let (balance, unit, message) = common_balance(data);
    (balance, unit, message)
}

fn extract_sub2api_dashboard_balance(data: &Value) -> (Option<f64>, String, String) {
    let paths = [
        "balance",
        "available_balance",
        "wallet_balance",
        "credit",
        "credits",
        "data.balance",
        "data.available_balance",
        "data.wallet_balance",
        "data.credit",
        "data.credits",
        "data.user.balance",
        "data.user.available_balance",
        "data.user.wallet_balance",
        "user.balance",
        "user.available_balance",
        "user.wallet_balance",
        "wallet.balance",
        "account.balance",
    ];
    if let Some((path, value)) = first_path(data, &paths) {
        return (
            to_number(value),
            path_get(data, "currency")
                .and_then(|v| v.as_str())
                .or_else(|| path_get(data, "data.currency").and_then(|v| v.as_str()))
                .unwrap_or("USD")
                .to_string(),
            format!("字段 {}", path),
        );
    }
    common_balance(data)
}

fn extract_sub2api_billing_value(data: &Value) -> (Option<f64>, String, String) {
    let paths = [
        "effective_rate_multiplier",
        "rate_multiplier",
        "default_rate_multiplier",
        "data.effective_rate_multiplier",
        "data.rate_multiplier",
        "data.default_rate_multiplier",
        "billing.effective_rate_multiplier",
        "billing.rate_multiplier",
        "pricing.effective_rate_multiplier",
        "pricing.rate_multiplier",
    ];
    if let Some((path, value)) = first_path(data, &paths) {
        return (
            to_number(value),
            "倍率".to_string(),
            format!(
                "字段 {}；此接口返回 Key 的 Sub2API 计费倍率/账单信息，不等同钱包余额",
                path
            ),
        );
    }
    (
        None,
        "倍率".to_string(),
        "未匹配 billing 倍率字段；该接口用于账单诊断，不等同钱包余额".to_string(),
    )
}

fn extract_newapi_profile_balance(data: &Value) -> (Option<f64>, String, String) {
    let direct_paths = [
        "data.balance_usd",
        "data.available_usd",
        "data.remaining_usd",
        "balance_usd",
        "available_usd",
        "remaining_usd",
        "data.balance",
        "data.available_balance",
        "balance",
        "available_balance",
    ];
    if let Some((path, v)) = first_path(data, &direct_paths) {
        if let Some(n) = to_number(v) {
            let unit = path_get(data, "data.currency")
                .and_then(|v| v.as_str())
                .or_else(|| path_get(data, "currency").and_then(|v| v.as_str()))
                .unwrap_or("USD/credits");
            return (Some(n), unit.to_string(), format!("面板账户字段 {}", path));
        }
    }
    let quota_paths = [
        "data.user.quota",
        "data.quota",
        "quota",
        "data.remaining_quota",
        "remaining_quota",
        "data.total_available",
        "total_available",
    ];
    if let Some((path, v)) = first_path(data, &quota_paths) {
        if let Some(raw) = to_number(v) {
            let (converted, unit, note) = quota_display_value(raw, data);
            let used = path_get(data, "data.user.used_quota")
                .and_then(to_number)
                .or_else(|| path_get(data, "data.used_quota").and_then(to_number));
            let used_note = used
                .map(|u| format!("；已用额度 {} quota", format_number(Some(u))))
                .unwrap_or_default();
            return (
                Some(converted),
                unit,
                format!("面板账户字段 {}；{}{}", path, note, used_note),
            );
        }
    }
    common_balance(data)
}

fn frimodel_platform_base(base_url: &str) -> String {
    let base = normalize_base_url(base_url);
    let low = base.to_ascii_lowercase();
    if low.contains("frimodel.com") && !low.contains("platform.frimodel.com") {
        "https://platform.frimodel.com".to_string()
    } else {
        base
    }
}

fn compact_text(input: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut last_space = false;
    for ch in input.chars() {
        if ch.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
        if out.chars().count() >= max_chars {
            out.push('…');
            break;
        }
    }
    out.trim().to_string()
}

fn value_as_message(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let text = compact_text(s, 180);
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Value::Object(_) => [
            "message",
            "msg",
            "detail",
            "error.message",
            "error.msg",
            "data.message",
            "data.msg",
        ]
        .iter()
        .find_map(|path| path_get(value, path).and_then(value_as_message))
        .or_else(|| Some(compact_text(&value.to_string(), 180))),
        Value::Number(_) | Value::Bool(_) => Some(value.to_string()),
        _ => None,
    }
}

fn upstream_error_message(raw: &Value) -> Option<String> {
    let paths = [
        "error",
        "message",
        "msg",
        "detail",
        "error.message",
        "error.msg",
        "data.error",
        "data.message",
        "data.msg",
    ];
    for path in paths {
        if let Some(text) = path_get(raw, path).and_then(value_as_message) {
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    if path_get(raw, "success").and_then(|v| v.as_bool()) == Some(false) {
        return Some("success=false，但响应未提供具体 message".into());
    }
    None
}

fn fallback_http_hint(http_status: u16) -> Option<&'static str> {
    match http_status {
        0 => Some("请求未完成，请检查网络、域名、证书或超时"),
        400 => Some("请求参数不被该端点接受"),
        401 => Some("鉴权失败，Key / PAT / 用户上下文不匹配"),
        403 => Some("权限不足或该 token 没有读取余额权限"),
        404 => Some("接口不存在或该站点未开启此余额端点"),
        405 => Some("请求方法不被该端点接受"),
        429 => Some("触发频率限制，稍后再试"),
        500..=599 => Some("上游服务端返回错误"),
        _ => None,
    }
}

fn final_probe_message(ok: bool, http_status: u16, message: String, raw: &Value) -> String {
    let base = if message.trim().is_empty() {
        "未识别余额字段".to_string()
    } else {
        message.trim().to_string()
    };
    if ok {
        return base;
    }
    if let Some(upstream) = upstream_error_message(raw) {
        if base.contains(&upstream) {
            return base;
        }
        return format!("{}；上游返回：{}", base, upstream);
    }
    if let Some(hint) = fallback_http_hint(http_status) {
        if base.contains(hint) {
            return base;
        }
        return format!("{}；{}", base, hint);
    }
    base
}

#[allow(clippy::too_many_arguments)]
fn build_result(
    account: &Account,
    ok: bool,
    balance: Option<f64>,
    unit: String,
    http_status: u16,
    endpoint: String,
    message: String,
    raw: Value,
    elapsed_ms: u128,
) -> ProbeResult {
    let unlimited = balance.is_none() && is_unlimited(&unit);
    let unit_display = if unlimited {
        "不限额".to_string()
    } else {
        unit
    };
    let balance_display = if unlimited {
        "不限额".to_string()
    } else {
        format_number(balance)
    };
    let status = if !ok {
        "失败"
    } else if unlimited || balance.is_some() {
        "正常"
    } else {
        "未知"
    }
    .to_string();
    let message = final_probe_message(ok, http_status, message, &raw);
    ProbeResult {
        id: account.id.clone(),
        name: display_name(account),
        preset: account.preset.clone(),
        ok,
        status,
        balance_number: balance,
        balance_display,
        unit: unit_display,
        http_status,
        endpoint,
        message,
        raw_summary: redacted_summary(&raw),
        elapsed_ms,
    }
}

fn redacted_summary(raw: &Value) -> String {
    fn redact(v: &Value) -> Value {
        match v {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| {
                        let lk = k.to_ascii_lowercase();
                        if [
                            "token",
                            "secret",
                            "password",
                            "authorization",
                            "api_key",
                            "apikey",
                            "key",
                            "cookie",
                        ]
                        .iter()
                        .any(|s| lk.contains(s))
                        {
                            (k.clone(), Value::String("••••".into()))
                        } else {
                            (k.clone(), redact(v))
                        }
                    })
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().take(20).map(redact).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_string_pretty(&redact(raw)).unwrap_or_else(|_| "{}".to_string())
}

async fn probe_one(client: &reqwest::Client, account: Account) -> ProbeResult {
    let start = Instant::now();
    let timeout = account.timeout.clamp(3.0, 60.0);
    match account.preset.as_str() {
        "usage_token" => {
            let base = frimodel_platform_base(&account.base_url);
            let (status_endpoint, status_code, status) =
                fetch_newapi_status(client, &base, timeout).await;
            let headers = account_extra_headers(&account);
            let (endpoint, code, data) = first_json_endpoint_with_headers(
                client,
                &base,
                "/api/usage/token/",
                &account.api_key,
                timeout,
                &headers,
            )
            .await;
            let merged = with_status(data, status);
            let (balance, unit, mut message) = extract_newapi_token_balance(&merged);
            if status_code == 200 {
                message.push_str(&format!("；已读取状态接口 {}", status_endpoint));
            }
            build_result(
                &account,
                code == 200 && (balance.is_some() || is_unlimited(&unit)),
                balance,
                unit,
                code,
                endpoint,
                message,
                merged,
                start.elapsed().as_millis(),
            )
        }
        "newapi_profile" => {
            if account
                .api_key
                .trim()
                .to_ascii_lowercase()
                .starts_with("sk-")
            {
                let endpoint = endpoint_candidates(&account.base_url, "/api/user/self")
                    .into_iter()
                    .next()
                    .unwrap_or_default();
                return build_result(&account, false, None, "USD/credits".into(), 0, endpoint, "面板余额接口需要 Profile Token / PAT / User.AccessToken；当前像是 sk-API-Key。".into(), json!({}), start.elapsed().as_millis());
            }
            let base = frimodel_platform_base(&account.base_url);
            let (status_endpoint, status_code, status) =
                fetch_newapi_status(client, &base, timeout).await;
            let headers = account_extra_headers(&account);
            let (endpoint, code, data) = first_json_endpoint_with_headers(
                client,
                &base,
                "/api/user/self",
                &account.api_key,
                timeout,
                &headers,
            )
            .await;
            let merged = with_status(data, status);
            let (balance, unit, mut message) = extract_newapi_profile_balance(&merged);
            if code == 401 || code == 403 {
                message = "面板余额鉴权失败：请填 Profile Token / PAT / User.AccessToken；如果站点要求用户上下文，请同时填写 New-Api-User".into();
            } else if status_code == 200 {
                message.push_str(&format!("；已读取状态接口 {}", status_endpoint));
            }
            build_result(
                &account,
                code == 200 && balance.is_some(),
                balance,
                unit,
                code,
                endpoint,
                message,
                merged,
                start.elapsed().as_millis(),
            )
        }
        "sub2api_usage" => {
            let headers = account_extra_headers(&account);
            let mut response = first_json_endpoint_with_headers(
                client,
                &account.base_url,
                "/v1/usage",
                &account.api_key,
                timeout,
                &headers,
            )
            .await;
            if response.1 == 404 || response.1 == 0 {
                response = first_json_endpoint_with_headers(
                    client,
                    &account.base_url,
                    "/usage",
                    &account.api_key,
                    timeout,
                    &headers,
                )
                .await;
            }
            let (endpoint, code, data) = response;
            let (balance, unit, message) = extract_sub2api_usage_balance(&data);
            build_result(
                &account,
                code == 200 && balance.is_some(),
                balance,
                if unit.is_empty() { "USD".into() } else { unit },
                code,
                endpoint,
                format!("Sub2API /v1/usage；{}", message),
                data,
                start.elapsed().as_millis(),
            )
        }
        "sub2api_dashboard" => {
            let headers = account_extra_headers(&account);
            let mut response = first_json_endpoint_with_headers(
                client,
                &account.base_url,
                "/api/v1/auth/me",
                &account.api_key,
                timeout,
                &headers,
            )
            .await;
            if response.1 == 404 || response.1 == 0 {
                response = first_json_endpoint_with_headers(
                    client,
                    &account.base_url,
                    "/api/v1/user/profile",
                    &account.api_key,
                    timeout,
                    &headers,
                )
                .await;
            }
            let (endpoint, code, data) = response;
            let (balance, unit, mut message) = extract_sub2api_dashboard_balance(&data);
            if code == 401 || code == 403 {
                message = "Sub2API 面板余额接口需要登录后的 JWT/Access Token；API Key 请用 Sub2API /v1/usage 预设".into();
            }
            build_result(
                &account,
                code == 200 && balance.is_some(),
                balance,
                if unit.is_empty() { "USD".into() } else { unit },
                code,
                endpoint,
                format!("Sub2API 面板余额；{}", message),
                data,
                start.elapsed().as_millis(),
            )
        }
        "sub2api_billing" => {
            let headers = account_extra_headers(&account);
            let (endpoint, code, data) = first_json_endpoint_with_headers(
                client,
                &account.base_url,
                "/v1/sub2api/billing",
                &account.api_key,
                timeout,
                &headers,
            )
            .await;
            let (balance, unit, message) = extract_sub2api_billing_value(&data);
            build_result(
                &account,
                code == 200 && balance.is_some(),
                balance,
                unit,
                code,
                endpoint,
                format!("Sub2API billing 诊断；{}", message),
                data,
                start.elapsed().as_millis(),
            )
        }
        "ccswitch_usage" => {
            let headers = account_extra_headers(&account);
            let (endpoint, code, data) = first_json_endpoint_with_headers(
                client,
                &account.base_url,
                "/v1/usage",
                &account.api_key,
                timeout,
                &headers,
            )
            .await;
            let (balance, unit, message) = common_balance(&data);
            build_result(
                &account,
                code == 200 && balance.is_some(),
                balance,
                if unit.is_empty() { "USD".into() } else { unit },
                code,
                endpoint,
                format!("CC Switch /v1/usage；{}", message),
                data,
                start.elapsed().as_millis(),
            )
        }
        "custom" => {
            let path = if account.endpoint.trim().is_empty() {
                "/v1/balance"
            } else {
                account.endpoint.trim()
            };
            let headers = account_extra_headers(&account);
            let (endpoint, code, data) = first_json_endpoint_with_headers(
                client,
                &account.base_url,
                path,
                &account.api_key,
                timeout,
                &headers,
            )
            .await;
            let path_list: Vec<&str> = if account.paths.trim().is_empty() {
                vec![
                    "balance",
                    "data.balance",
                    "total_available",
                    "data.total_available",
                    "credit",
                    "data.credit",
                ]
            } else {
                account
                    .paths
                    .split([',', ';', ' '])
                    .filter(|s| !s.trim().is_empty())
                    .collect()
            };
            let found = first_path(&data, &path_list);
            let balance = found.and_then(|(_, v)| to_number(v));
            let unit = path_get(&data, "unit")
                .and_then(|v| v.as_str())
                .or_else(|| path_get(&data, "data.unit").and_then(|v| v.as_str()))
                .or_else(|| path_get(&data, "currency").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            let msg = found
                .map(|(p, _)| format!("字段 {}", p))
                .unwrap_or_else(|| "未匹配自定义路径".into());
            build_result(
                &account,
                code == 200 && balance.is_some(),
                balance,
                unit,
                code,
                endpoint,
                msg,
                data,
                start.elapsed().as_millis(),
            )
        }
        _ => {
            let tries = [
                "newapi_profile",
                "sub2api_dashboard",
                "sub2api_usage",
                "ccswitch_usage",
                "usage_token",
            ];
            let mut last = None;
            for preset in tries {
                let mut next = account.clone();
                next.preset = preset.into();
                let r = Box::pin(probe_one(client, next)).await;
                if r.ok {
                    return ProbeResult {
                        preset: format!("auto / {}", r.preset),
                        message: format!("自动识别成功：{}；{}", r.preset, r.message),
                        ..r
                    };
                }
                last = Some(r);
            }
            last.unwrap_or_else(|| {
                build_result(
                    &account,
                    false,
                    None,
                    String::new(),
                    0,
                    String::new(),
                    "自动识别未产生请求".into(),
                    json!({}),
                    start.elapsed().as_millis(),
                )
            })
        }
    }
}

#[tauri::command]
async fn probe_accounts(accounts: Vec<Account>) -> Result<Vec<ProbeResult>, String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for account in accounts {
        out.push(probe_one(&client, account).await);
    }
    Ok(out)
}

#[tauri::command]
fn load_config() -> Result<AppConfig, String> {
    let cfg = merged_config_from_candidates()?;
    write_config_file(&app_config_path(), &cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn save_config(
    accounts: Vec<Account>,
    email: EmailConfig,
    threshold: f64,
    alert_levels: AlertLevels,
    auto_probe_interval_minutes: u64,
    allow_account_removal: Option<bool>,
) -> Result<(), String> {
    let existing = Some(merged_config_from_candidates()?);
    let mut saved_email = email;
    saved_email.password.clear();
    let saved_accounts = accounts.iter().map(account_to_saved).collect();
    let cfg = AppConfig {
        accounts: merge_saved_accounts(
            saved_accounts,
            existing.as_ref(),
            allow_account_removal.unwrap_or(false),
        ),
        email: saved_email,
        threshold: if threshold.is_finite() {
            threshold
        } else {
            alert_levels.level1
        },
        alert_levels,
        auto_probe_interval_minutes,
    };
    for path in config_candidate_paths() {
        if path == app_config_path() || path.exists() {
            write_config_file(&path, &cfg)?;
        }
    }
    Ok(())
}

fn parse_recipients(value: &str) -> Vec<String> {
    value
        .split(|c: char| c == ',' || c == ';' || c.is_whitespace())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect()
}

#[tauri::command]
fn send_email(config: EmailConfig, subject: String, body: String) -> Result<(), String> {
    let recipients = parse_recipients(&config.recipients);
    if recipients.is_empty() {
        return Err("请填写收件邮箱".into());
    }
    if config.smtp_host.trim().is_empty() {
        return Err("请填写 SMTP 服务器".into());
    }
    let sender = if config.sender.trim().is_empty() {
        config.username.trim()
    } else {
        config.sender.trim()
    };
    if sender.is_empty() {
        return Err("请填写发件邮箱".into());
    }
    let mut builder = Message::builder()
        .from(sender.parse::<Mailbox>().map_err(|e| e.to_string())?)
        .subject(subject);
    for recipient in recipients {
        builder = builder.to(recipient.parse::<Mailbox>().map_err(|e| e.to_string())?);
    }
    let message = builder.body(body).map_err(|e| e.to_string())?;
    let creds = Credentials::new(config.username.clone(), config.password.clone());
    let mailer = if config.smtp_ssl {
        SmtpTransport::relay(config.smtp_host.trim())
            .map_err(|e| e.to_string())?
            .port(config.smtp_port)
            .credentials(creds)
            .build()
    } else {
        SmtpTransport::builder_dangerous(config.smtp_host.trim())
            .port(config.smtp_port)
            .credentials(creds)
            .build()
    };
    mailer.send(&message).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn list_models(account: Account) -> Result<ModelListResult, String> {
    let start = Instant::now();
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|e| e.to_string())?;
    let timeout = account.timeout.clamp(3.0, 60.0);
    let headers = account_extra_headers(&account);
    let mut last = (String::new(), 0, json!({}));
    for endpoint in endpoint_candidates(&account.base_url, "/v1/models") {
        let (code, data) =
            request_json(&client, &endpoint, &account.api_key, timeout, &headers).await;
        last = (endpoint.clone(), code, data.clone());
        if code == 200 {
            let models = extract_models(&data);
            let message = if models.is_empty() {
                "接口成功，但响应里没有识别到模型 id".to_string()
            } else {
                format!("已获取 {} 个模型", models.len())
            };
            return Ok(ModelListResult {
                ok: !models.is_empty(),
                http_status: code,
                endpoint,
                models,
                message,
                raw_summary: redacted_summary(&data),
                elapsed_ms: start.elapsed().as_millis(),
            });
        }
    }
    let models = extract_models(&last.2);
    Ok(ModelListResult {
        ok: false,
        http_status: last.1,
        endpoint: last.0,
        models,
        message: "获取模型失败：请检查 Base URL 与 API Key / PAT".into(),
        raw_summary: redacted_summary(&last.2),
        elapsed_ms: start.elapsed().as_millis(),
    })
}

#[tauri::command]
async fn generate_image_test(request: ImageTestRequest) -> Result<ImageTestResult, String> {
    let start = Instant::now();
    if request.model.trim().is_empty() {
        return Err("请选择或填写生图模型".into());
    }
    if request.prompt.trim().is_empty() {
        return Err("请填写生图提示词".into());
    }
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|e| e.to_string())?;
    let mut body = json!({
        "model": request.model.trim(),
        "prompt": request.prompt.trim(),
        "n": request.n.clamp(1, 4),
    });
    if let Some(map) = body.as_object_mut() {
        if !request.size.trim().is_empty() && request.size.trim() != "auto" {
            map.insert(
                "size".into(),
                Value::String(request.size.trim().to_string()),
            );
        }
        if !request.quality.trim().is_empty() && request.quality.trim() != "auto" {
            map.insert(
                "quality".into(),
                Value::String(request.quality.trim().to_string()),
            );
        }
        if !request.output_format.trim().is_empty() && request.output_format.trim() != "auto" {
            map.insert(
                "output_format".into(),
                Value::String(request.output_format.trim().to_string()),
            );
        }
        if !request.background.trim().is_empty() && request.background.trim() != "auto" {
            map.insert(
                "background".into(),
                Value::String(request.background.trim().to_string()),
            );
        }
        if !request.response_format.trim().is_empty() && request.response_format.trim() != "auto" {
            map.insert(
                "response_format".into(),
                Value::String(request.response_format.trim().to_string()),
            );
        }
    }
    let timeout = request.timeout.clamp(10.0, 180.0);
    let headers = account_extra_headers(&request.account);
    let mut last = (String::new(), 0, json!({}));
    for endpoint in endpoint_candidates(&request.account.base_url, "/v1/images/generations") {
        let (code, data) = request_post_json(
            &client,
            &endpoint,
            &request.account.api_key,
            timeout,
            body.clone(),
            &headers,
        )
        .await;
        last = (endpoint.clone(), code, data.clone());
        if code == 200 {
            let (image_url, image_b64, revised_prompt) = first_image_payload(&data);
            let ok = image_url.is_some() || image_b64.is_some();
            let message = if ok {
                "生图接口调用成功"
            } else {
                "接口返回成功，但没有识别到 url 或 b64_json 图片字段"
            };
            return Ok(ImageTestResult {
                ok,
                http_status: code,
                endpoint,
                model: request.model,
                image_url,
                image_b64,
                revised_prompt,
                message: message.into(),
                raw_summary: redacted_summary(&data),
                elapsed_ms: start.elapsed().as_millis(),
            });
        }
    }
    let (image_url, image_b64, revised_prompt) = first_image_payload(&last.2);
    Ok(ImageTestResult {
        ok: false,
        http_status: last.1,
        endpoint: last.0,
        model: request.model,
        image_url,
        image_b64,
        revised_prompt,
        message: "生图测试失败：请检查模型、Key、额度和渠道转发规则".into(),
        raw_summary: redacted_summary(&last.2),
        elapsed_ms: start.elapsed().as_millis(),
    })
}
#[tauri::command]
fn config_path() -> String {
    let path = app_config_path();
    let count = read_config_file(&path)
        .ok()
        .flatten()
        .map(|cfg| cfg.accounts.len())
        .unwrap_or(0);
    format!("{}（{} 个渠道）", path.display(), count)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {desktop_service::start(app)?; Ok(())})
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![desktop_service::radar_connection])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app,event|{if matches!(event,tauri::RunEvent::Exit){use tauri::Manager;app.state::<desktop_service::Service>().stop();}});
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved_account(id: &str, base_url: &str, api_key: &str) -> SavedAccount {
        SavedAccount {
            id: id.to_string(),
            name: base_url.to_string(),
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
            remember_secret: true,
            preset: "newapi_profile".to_string(),
            endpoint: "/api/user/self".to_string(),
            paths: "data.user.quota,data.quota,quota".to_string(),
            timeout: 12.0,
            user_id: String::new(),
            auto_probe_interval_minutes: 1,
            low_balance_threshold: 0.0,
            last_alert_level: 0,
        }
    }

    #[test]
    fn merge_preserves_existing_channels_when_removal_is_not_explicit() {
        let existing = AppConfig {
            accounts: vec![
                saved_account("a", "https://api.808relay.com", "secret-a"),
                saved_account("b", "https://platform.frimodel.com", "secret-b"),
            ],
            email: EmailConfig::default(),
            threshold: default_threshold(),
            alert_levels: AlertLevels::default(),
            auto_probe_interval_minutes: 0,
        };
        let incoming = vec![saved_account("a", "https://api.808relay.com", "")];

        let merged = merge_saved_accounts(incoming, Some(&existing), false);

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, "a");
        assert_eq!(merged[0].api_key, "");
        assert_eq!(merged[1].id, "b");
        assert_eq!(merged[1].api_key, "secret-b");
    }

    #[test]
    fn merge_allows_account_removal_when_requested() {
        let existing = AppConfig {
            accounts: vec![
                saved_account("a", "https://api.808relay.com", "secret-a"),
                saved_account("b", "https://platform.frimodel.com", "secret-b"),
            ],
            email: EmailConfig::default(),
            threshold: default_threshold(),
            alert_levels: AlertLevels::default(),
            auto_probe_interval_minutes: 0,
        };
        let incoming = vec![saved_account("a", "https://api.808relay.com", "secret-a")];

        let merged = merge_saved_accounts(incoming, Some(&existing), true);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].id, "a");
    }
}
