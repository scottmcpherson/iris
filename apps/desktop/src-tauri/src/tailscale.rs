use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::core_process::probe_iris_ping;

/// A device on the tailnet, normalized for the connection UI.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleNode {
    pub host_name: String,
    /// MagicDNS name with the trailing dot stripped, e.g. "mac-mini.tailnet.ts.net".
    pub dns_name: String,
    pub os: String,
    pub tailscale_ips: Vec<String>,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    /// Whether a `tailscale` CLI was found and could be executed at all.
    pub installed: bool,
    /// Raw BackendState: NoState | NeedsLogin | NeedsMachineAuth | Stopped | Starting | Running.
    pub backend_state: String,
    /// Convenience flag: backend_state == "Running".
    pub running: bool,
    pub magic_dns_suffix: String,
    pub self_node: Option<TailscaleNode>,
    pub peers: Vec<TailscaleNode>,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IrisProbeResult {
    pub ok: bool,
    pub version: String,
}

#[tauri::command]
pub async fn tailscale_status() -> Result<TailscaleStatus, String> {
    tauri::async_runtime::spawn_blocking(status_blocking)
        .await
        .map_err(|err| format!("Tailscale status task failed: {err}"))
}

#[tauri::command]
pub async fn tailscale_probe_iris(host: String, port: u16) -> Result<IrisProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match probe_iris_ping(&host, port, Duration::from_millis(1200)) {
            Ok(version) => IrisProbeResult { ok: true, version },
            Err(_) => IrisProbeResult {
                ok: false,
                version: String::new(),
            },
        }
    })
    .await
    .map_err(|err| format!("Tailscale Iris probe task failed: {err}"))
}

/// Best-effort: bring the Tailscale GUI to the foreground so the user can sign in
/// or turn it on. macOS only.
#[tauri::command]
pub fn tailscale_open_app() -> Result<(), String> {
    Command::new("open")
        .arg("-a")
        .arg("Tailscale")
        .status()
        .map_err(|err| format!("Could not open Tailscale: {err}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("Could not open Tailscale. Is it installed?".to_string())
            }
        })
}

/// Known locations for the `tailscale` CLI across the macOS variants and Homebrew.
fn tailscale_candidates() -> Vec<&'static str> {
    vec![
        "tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
    ]
}

struct CliResult {
    ran: bool,
    stdout: String,
}

fn run_status_json() -> CliResult {
    let mut ran = false;
    for candidate in tailscale_candidates() {
        if candidate.starts_with('/') && !Path::new(candidate).exists() {
            continue;
        }
        match Command::new(candidate).arg("status").arg("--json").output() {
            Ok(output) => {
                ran = true;
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                // `tailscale status --json` prints JSON on stdout even when it exits
                // non-zero (e.g. logged out / stopped), so don't gate on exit status.
                if stdout.trim_start().starts_with('{') {
                    return CliResult { ran: true, stdout };
                }
            }
            Err(_) => continue,
        }
    }
    CliResult {
        ran,
        stdout: String::new(),
    }
}

fn status_blocking() -> TailscaleStatus {
    let result = run_status_json();
    if !result.ran {
        return TailscaleStatus {
            installed: false,
            error: "Tailscale is not installed.".to_string(),
            ..TailscaleStatus::default()
        };
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&result.stdout) else {
        // The CLI exists but produced no parseable status — daemon is likely not running.
        return TailscaleStatus {
            installed: true,
            backend_state: "Stopped".to_string(),
            running: false,
            error: "Tailscale is installed but not running.".to_string(),
            ..TailscaleStatus::default()
        };
    };
    let backend_state = parsed
        .get("BackendState")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let magic_dns_suffix = parsed
        .get("MagicDNSSuffix")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let self_node = parsed.get("Self").and_then(node_from_value);
    let mut peers: Vec<TailscaleNode> = parsed
        .get("Peer")
        .and_then(Value::as_object)
        .map(|map| map.values().filter_map(node_from_value).collect())
        .unwrap_or_default();
    // Online hosts first, then alphabetical by display name, so the UI list is stable.
    peers.sort_by(|a, b| {
        b.online
            .cmp(&a.online)
            .then_with(|| node_label(a).cmp(&node_label(b)))
    });
    TailscaleStatus {
        installed: true,
        running: backend_state == "Running",
        backend_state,
        magic_dns_suffix,
        self_node,
        peers,
        error: String::new(),
    }
}

fn node_from_value(value: &Value) -> Option<TailscaleNode> {
    let host_name = value
        .get("HostName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let dns_name = value
        .get("DNSName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('.')
        .to_string();
    if host_name.is_empty() && dns_name.is_empty() {
        return None;
    }
    let tailscale_ips = value
        .get("TailscaleIPs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|ip| ip.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Some(TailscaleNode {
        host_name,
        dns_name,
        os: value
            .get("OS")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        tailscale_ips,
        online: value.get("Online").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn node_label(node: &TailscaleNode) -> String {
    if !node.host_name.is_empty() {
        node.host_name.to_lowercase()
    } else {
        node.dns_name.to_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "BackendState": "Running",
        "MagicDNSSuffix": "tailnet-abc.ts.net",
        "Self": {
            "HostName": "scott-laptop",
            "DNSName": "scott-laptop.tailnet-abc.ts.net.",
            "OS": "macOS",
            "TailscaleIPs": ["100.110.38.56", "fd7a:115c::1"],
            "Online": true
        },
        "Peer": {
            "nodekey:aaa": {
                "HostName": "mac-mini",
                "DNSName": "mac-mini.tailnet-abc.ts.net.",
                "OS": "macOS",
                "TailscaleIPs": ["100.64.0.7"],
                "Online": true
            },
            "nodekey:bbb": {
                "HostName": "old-box",
                "DNSName": "old-box.tailnet-abc.ts.net.",
                "OS": "linux",
                "TailscaleIPs": ["100.64.0.9"],
                "Online": false
            }
        }
    }"#;

    fn parse(sample: &str) -> TailscaleStatus {
        // Mirror status_blocking's parsing path without invoking the CLI.
        let parsed: Value = serde_json::from_str(sample).unwrap();
        let backend_state = parsed
            .get("BackendState")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let self_node = parsed.get("Self").and_then(node_from_value);
        let mut peers: Vec<TailscaleNode> = parsed
            .get("Peer")
            .and_then(Value::as_object)
            .map(|map| map.values().filter_map(node_from_value).collect())
            .unwrap_or_default();
        peers.sort_by(|a, b| {
            b.online
                .cmp(&a.online)
                .then_with(|| node_label(a).cmp(&node_label(b)))
        });
        TailscaleStatus {
            installed: true,
            running: backend_state == "Running",
            backend_state,
            magic_dns_suffix: parsed
                .get("MagicDNSSuffix")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            self_node,
            peers,
            error: String::new(),
        }
    }

    #[test]
    fn parses_self_and_strips_trailing_dot() {
        let status = parse(SAMPLE);
        assert!(status.running);
        assert_eq!(status.backend_state, "Running");
        let self_node = status.self_node.expect("self node");
        assert_eq!(self_node.dns_name, "scott-laptop.tailnet-abc.ts.net");
        assert_eq!(self_node.tailscale_ips[0], "100.110.38.56");
    }

    #[test]
    fn sorts_online_peers_first_then_by_name() {
        let status = parse(SAMPLE);
        assert_eq!(status.peers.len(), 2);
        assert_eq!(status.peers[0].host_name, "mac-mini");
        assert!(status.peers[0].online);
        assert_eq!(status.peers[1].host_name, "old-box");
        assert!(!status.peers[1].online);
    }

    #[test]
    fn running_only_when_backend_state_is_running() {
        let stopped = SAMPLE.replace("\"Running\"", "\"Stopped\"");
        assert!(!parse(&stopped).running);
    }
}
