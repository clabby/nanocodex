use super::*;

#[test]
fn archive_urls_are_restricted_to_the_official_versioned_feed() {
    assert!(
        validate_archive_url(
            "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.917.61114.zip"
        )
        .is_ok()
    );
    assert!(
        validate_archive_url("https://example.com/codex-app-prod/ChatGPT-darwin-arm64-x.zip")
            .is_err()
    );
    assert!(
        validate_archive_url("https://persistent.oaistatic.com/codex-app-prod/appcast.xml")
            .is_err()
    );
    assert!(
        validate_archive_url(
            "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-x.zip?changed=1"
        )
        .is_err()
    );
}

#[test]
fn component_selection_excludes_the_desktop_shell() {
    let prefix = "ChatGPT.app/";
    assert!(!selected_name(
        "Codex.app/Contents/Resources/codex",
        "Codex.app/"
    ));
    assert!(selected_name(
        "Codex.app/Contents/MacOS/Codex",
        "Codex.app/"
    ));
    for name in [
        "ChatGPT.app/Contents/Info.plist",
        "ChatGPT.app/Contents/MacOS/ChatGPT",
        "ChatGPT.app/Contents/_CodeSignature/CodeResources",
        "ChatGPT.app/Contents/Resources/cua_node/bin/node",
        "ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/chrome/scripts/installManifest.mjs",
    ] {
        assert!(selected_name(name, prefix), "{name}");
    }
    for name in [
        "ChatGPT.app/Contents/Resources/codex",
        "ChatGPT.app/Contents/Resources/app.asar",
        "ChatGPT.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
        "ChatGPT.app/Contents/Resources/locales/en.lproj",
    ] {
        assert!(!selected_name(name, prefix), "{name}");
    }
}

#[test]
fn exact_content_range_is_required() {
    assert_eq!(
        content_range(
            b"HTTP/2 206\r\ncontent-range: bytes 10-19/123\r\n\r\n",
            10,
            19
        )
        .unwrap(),
        123
    );
    assert!(content_range(b"HTTP/2 200\r\ncontent-length: 10\r\n", 10, 19).is_err());
    assert!(content_range(b"HTTP/2 206\r\ncontent-range: bytes 0-9/123\r\n", 10, 19).is_err());
}

#[test]
fn parses_bounded_classic_zip_directory() {
    let mut central = vec![0u8; 46];
    central[0..4].copy_from_slice(b"PK\x01\x02");
    central[28..30].copy_from_slice(&8u16.to_le_bytes());
    central[42..46].copy_from_slice(&7u32.to_le_bytes());
    central.extend_from_slice(b"file.txt");
    let entries = zip_entries(&central, 1).unwrap();
    assert_eq!(entries[0].name, "file.txt");
    assert_eq!(entries[0].local, 7);
    assert!(zip_entries(&central, 2).is_err());
}

#[test]
fn launcher_uses_only_headless_upstream_components() {
    let script = launcher(Path::new("/tmp/runtime")).unwrap();
    assert!(!script.contains("Contents/Resources/codex"));
    assert!(script.contains("unset CODEX_CLI_PATH"));
    assert!(!script.contains("export CODEX_CLI_PATH"));
    assert!(
        script
            .contains("${NODE_REPL_UNTRUSTED_ENV_ALLOWLIST:+$NODE_REPL_UNTRUSTED_ENV_ALLOWLIST,}")
    );
    assert!(script.contains("SKY_CUA_SERVICE_PATH,SKY_CUA_SERVICE_NATIVE_PIPE_PATH"));
    assert!(script.contains("cua_node/bin/node"));
    assert!(script.contains("BROWSER_USE_TINYSKY_ENABLED=1"));
    assert!(!script.contains("Contents/MacOS"));
    assert_eq!(HOST_MODULES.len(), 1);
    assert_eq!(HOST_MODULES[0].0, "direct-cua-host.mjs");
    assert!(
        HOST_MODULES
            .iter()
            .all(|(name, _)| !name.contains("app-server"))
    );
}

#[test]
fn node_path_delimiters_are_rejected() {
    assert!(launcher(Path::new("/tmp/invalid:modules")).is_err());
    assert!(launcher(Path::new("/tmp/new\nline")).is_err());
}

#[test]
fn removes_only_the_unsealed_legacy_browser_config() {
    let directory = Staging {
        path: std::env::temp_dir().join(format!("nanocodex-browser-config-test-{}", nonce())),
        cleanup: true,
    };
    let app = directory.path.join("Codex.app");
    let relative = legacy_browser_config_relative();
    let config = app.join("Contents").join(&relative);
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, b"{\"generated\":true}").unwrap();

    remove_unsealed_legacy_browser_config(&app, &HashMap::new()).unwrap();
    assert!(!config.exists());

    fs::write(&config, b"{\"upstream\":true}").unwrap();
    let mut seals = HashMap::new();
    seals.insert(
        relative.to_string_lossy().replace('\\', "/"),
        Seal::Hash([0; 32]),
    );
    remove_unsealed_legacy_browser_config(&app, &seals).unwrap();
    assert!(config.is_file());
}

#[test]
fn browser_bridge_uses_an_immutable_host_copy() {
    use std::os::unix::fs::PermissionsExt as _;

    let directory = Staging {
        path: std::env::temp_dir().join(format!("nanocodex-browser-host-test-{}", nonce())),
        cleanup: true,
    };
    let root = directory.path.join("runtime");
    let version = directory.path.join("version");
    for (source, relative) in browser_assets(&version) {
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, relative.to_string_lossy().as_bytes()).unwrap();
        if relative == PathBuf::from("browser").join(browser_extension_host()) {
            fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    let host = ensure_host(&root, &version, &[("host.mjs", "export default true;")]).unwrap();
    for (source, relative) in browser_assets(&version) {
        assert_eq!(
            fs::read(source).unwrap(),
            fs::read(host.join(relative)).unwrap()
        );
    }
    assert!(
        !version
            .join(APP)
            .join("Contents")
            .join(legacy_browser_config_relative())
            .exists()
    );

    assert!(
        fs::symlink_metadata(host.join("cua-policy-host"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111
            != 0
    );
    let updated = ensure_host(&root, &version, &[("host.mjs", "export default false;")]).unwrap();
    assert_ne!(host, updated);
    assert_eq!(
        fs::read(host.join("host.mjs")).unwrap(),
        b"export default true;"
    );
    assert_eq!(
        fs::read(updated.join("host.mjs")).unwrap(),
        b"export default false;"
    );

    let copied_installer = host.join("browser/scripts/installManifest.mjs");
    fs::write(&copied_installer, b"modified").unwrap();
    let error = ensure_host(&root, &version, &[("host.mjs", "export default true;")]).unwrap_err();
    assert!(
        error.contains("managed browser host asset is modified"),
        "{error}"
    );
}

#[derive(Default)]
struct RecordingCommands {
    calls: Vec<(String, Vec<OsString>)>,
    bad_identity: bool,
}
impl Commands for RecordingCommands {
    fn run(&mut self, program: &str, args: &[OsString]) -> Result<String, String> {
        self.calls.push((program.to_owned(), args.to_vec()));
        if program.ends_with("codesign") && args.iter().any(|arg| arg == "--display") {
            if self.bad_identity {
                return Ok(format!("TeamIdentifier=NOT_OPENAI\nIdentifier={BUNDLE}\n"));
            }
            return Ok(format!("TeamIdentifier={TEAM}\nIdentifier={BUNDLE}\n"));
        }
        if program.ends_with("PlistBuddy") {
            return Ok(
                if args.iter().any(|arg| arg == "Print :CFBundleIdentifier") {
                    BUNDLE.to_owned()
                } else {
                    "9922".to_owned()
                },
            );
        }
        Ok(String::new())
    }
}

fn test_directory(label: &str) -> Staging {
    let directory = Staging {
        path: std::env::temp_dir().join(format!("nanocodex-{label}-{}", nonce())),
        cleanup: true,
    };
    fs::create_dir_all(&directory.path).unwrap();
    directory
}

fn lean_fixture(app: &Path) {
    let contents = app.join("Contents");
    let files = [
        "Resources/cua_node/bin/node".to_owned(),
        "Resources/cua_node/bin/node_repl".into(),
        format!("Resources/{MODULES}/{ENTRY}"),
        format!("Resources/{MODULES}/@oai/sky/package.json"),
        format!("Resources/{MODULES}/@oai/browser-desktop/package.json"),
        format!("Resources/{MODULES}/{SKY}/Contents/MacOS/SkyComputerUseService"),
        format!("Resources/{BROWSER_PLUGIN}/scripts/installManifest.mjs"),
        format!("Resources/{BROWSER_PLUGIN}/scripts/check-extension-installed.js"),
        format!("Resources/{BROWSER_PLUGIN}/scripts/browser-client.mjs"),
        format!(
            "Resources/{BROWSER_PLUGIN}/{}",
            browser_extension_host().display()
        ),
    ];
    let mut manifest = String::from("<plist><dict><key>files2</key><dict>");
    for relative in files {
        let path = contents.join(&relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"original signed bytes").unwrap();
        let seal = base64::engine::general_purpose::STANDARD
            .encode(Sha256::digest(b"original signed bytes"));
        manifest.push_str(&format!(
            "<key>{relative}</key><dict><key>hash2</key><data>{seal}</data></dict>"
        ));
    }
    manifest.push_str("</dict></dict></plist>");
    fs::create_dir_all(contents.join("_CodeSignature")).unwrap();
    fs::write(contents.join("_CodeSignature/CodeResources"), manifest).unwrap();
    fs::write(contents.join("Info.plist"), b"original metadata").unwrap();
}

#[test]
fn lean_verification_preserves_signed_component_checks_without_codex() {
    let directory = test_directory("lean-verification");
    let app = directory.path.join(APP);
    lean_fixture(&app);
    let mut commands = RecordingCommands::default();
    assert_eq!(verify(&app, &mut commands).unwrap(), "9922");
    assert!(
        commands
            .calls
            .iter()
            .any(|(_, args)| args.iter().any(|arg| arg == "--ignore-resources"))
    );
    assert!(
        commands
            .calls
            .iter()
            .any(|(_, args)| args.iter().any(|arg| arg == TEAM_REQUIREMENT))
    );
    assert!(!commands.calls.iter().any(|(_, args)| {
        args.iter()
            .any(|arg| arg.to_string_lossy().ends_with("Resources/codex"))
    }));
    let mut wrong_signer = RecordingCommands {
        bad_identity: true,
        ..Default::default()
    };
    assert!(
        verify(&app, &mut wrong_signer)
            .unwrap_err()
            .contains("not the signed OpenAI")
    );
    let node = app.join(RESOURCES).join("cua_node/bin/node");
    fs::write(&node, b"tampered").unwrap();
    assert!(
        verify(&app, &mut commands)
            .unwrap_err()
            .contains("signed SHA-256 seal")
    );
    fs::remove_file(node).unwrap();
    assert!(
        verify(&app, &mut commands)
            .unwrap_err()
            .contains("incomplete")
    );
}

#[test]
fn old_selected_generation_requires_refresh_without_mutation() {
    let directory = test_directory("immutable-migration");
    let root = directory.path.join("runtimes/openai-cua");
    let app = root.join("versions/old").join(APP);
    fs::create_dir_all(app.join(RESOURCES)).unwrap();
    let codex = app.join(RESOURCES).join("codex");
    fs::write(&codex, b"old running CLI").unwrap();
    std::os::unix::fs::symlink("versions/old", root.join("current")).unwrap();
    fs::write(root.join("provider.json"), b"old complete receipt").unwrap();
    let config = app.join("Contents").join(legacy_browser_config_relative());
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, b"old live browser config").unwrap();
    for refresh in [false, true] {
        let mut commands = RecordingCommands::default();
        assert!(cached(&root, &mut commands, refresh).unwrap().is_none());
        assert!(commands.calls.is_empty());
        assert_eq!(fs::read(&codex).unwrap(), b"old running CLI");
        assert_eq!(fs::read(&config).unwrap(), b"old live browser config");
        assert_eq!(
            fs::read(root.join("provider.json")).unwrap(),
            b"old complete receipt"
        );
        assert_eq!(
            fs::read_link(root.join("current")).unwrap(),
            Path::new("versions/old")
        );
    }
}

#[test]
fn warm_verification_cache_cannot_authorize_a_codex_bearing_layout() {
    let directory = test_directory("lean-cache");
    let app = directory.path.join(APP);
    lean_fixture(&app);
    let codex = app.join(RESOURCES).join("codex");
    fs::write(&codex, b"old CLI").unwrap();
    let fingerprint = crate::startup_cache::fingerprint(&app).unwrap();
    for format in [1, 2] {
        crate::startup_cache::write(
            &directory
                .path
                .join(format!(".startup-cache/verification-v{format}.json")),
            &VerificationRecord {
                format,
                verified_at: crate::startup_cache::now(),
                fingerprint: fingerprint.clone(),
                build: "9922".into(),
            },
        )
        .unwrap();
    }
    let mut commands = RecordingCommands::default();
    assert!(
        verified_cached(&directory.path, &app, &mut commands, false)
            .unwrap_err()
            .contains("fresh no-Codex")
    );
    assert!(commands.calls.is_empty());
    fs::remove_file(&codex).unwrap();
    fs::create_dir(&codex).unwrap();
    assert!(verify_lean_layout(&app).is_err());
    fs::remove_dir(&codex).unwrap();
    std::os::unix::fs::symlink("missing", &codex).unwrap();
    assert!(verify_lean_layout(&app).is_err());
}

#[test]
fn legacy_browser_config_is_migrated_without_deleting_the_live_file() {
    let directory = test_directory("browser-config-migration");
    let app = directory.path.join(APP);
    lean_fixture(&app);
    let config = app.join("Contents").join(legacy_browser_config_relative());
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, b"live unsealed config").unwrap();
    assert!(requires_fresh_generation(&app).unwrap());
    assert_eq!(fs::read(&config).unwrap(), b"live unsealed config");
}

#[test]
fn direct_host_wrappers_have_no_official_cli_or_app_server_target() {
    let version = Path::new("/private/runtime/versions/build");
    let root = Path::new("/private/runtime/runtimes/openai-cua");
    let host = Path::new("/private/runtime/hosts/HASH");
    let wrapper = host_launcher(root, version, host, "HASH").unwrap();
    for variable in [
        "NANOCODEX_CUA_NATIVE_APP",
        "NANOCODEX_CUA_NATIVE_PROVIDER",
        "NANOCODEX_CUA_POLICY_HOST",
        "NANOCODEX_CUA_NATIVE_STATE",
    ] {
        assert!(wrapper.contains(variable));
    }
    assert!(wrapper.contains("direct-cua-host.mjs"));
    assert!(wrapper.contains("/private/runtime/s"));
    assert!(wrapper.contains("${NANOCODEX_CUA_APP_CONSENT:-allow}"));
    assert!(!wrapper.contains("Resources/codex"));
    assert!(!wrapper.contains("app-server"));
    let policy = policy_launcher(version, host).unwrap();
    assert!(policy.contains("direct-cua-host.mjs' --policy \"$@\""));
    assert!(executable_host_asset("cua-policy-host"));
}

#[test]
fn system_drains_both_full_pipes_and_reports_exit_status() {
    let cancellation = Cancellation::new();
    let mut system = System::new(cancellation.flag());
    let text = system
        .run(
            "/bin/sh",
            &[
                "-c".into(),
                "i=0; while [ \"$i\" -lt 8192 ]; do printf 'out-line-0123456789\\n'; printf 'err-line-0123456789\\n' >&2; i=$((i + 1)); done".into(),
            ],
        )
        .unwrap();
    assert_eq!(
        text,
        format!(
            "{}{}",
            "out-line-0123456789\n".repeat(8192),
            "err-line-0123456789\n".repeat(8192)
        )
    );
    let error = system
        .run(
            "/bin/sh",
            &["-c".into(), "printf expected-failure >&2; exit 7".into()],
        )
        .unwrap_err();
    assert!(
        error.contains('7') && error.contains("expected-failure"),
        "{error}"
    );
}

#[tokio::test]
async fn dropping_setup_cancels_the_owned_process_group() {
    let directory = Staging {
        path: std::env::temp_dir().join(format!("nanocodex-cancellation-test-{}", nonce())),
        cleanup: true,
    };
    fs::create_dir(&directory.path).unwrap();
    let pid_file = directory.path.join("owned-pids");
    let child_file = pid_file.clone();
    let (completed, result) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let cancellation = Cancellation::new();
        let mut system = System::new(cancellation.flag());
        tokio::task::spawn_blocking(move || {
            let result = system.run(
                "/bin/sh",
                &[
                    "-c".into(),
                    "sleep 60 & descendant=$!; printf '%s %s\\n' \"$$\" \"$descendant\" > \"$1\"; wait \"$descendant\"".into(),
                    "owned-cancel-test".into(),
                    child_file.into_os_string(),
                ],
            );
            let _ = completed.send(result);
        })
        .await
        .unwrap();
        drop(cancellation);
    });
    let pids = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(text) = fs::read_to_string(&pid_file) {
                let pids: Vec<libc::pid_t> = text
                    .split_whitespace()
                    .map(|pid| pid.parse().unwrap())
                    .collect();
                if pids.len() == 2 {
                    break pids;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(unsafe { libc::getpgid(pids[0]) }, pids[0]);
    assert_eq!(unsafe { libc::getpgid(pids[1]) }, pids[0]);
    assert_ne!(unsafe { libc::getpgrp() }, pids[0]);

    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let error = tokio::time::timeout(std::time::Duration::from_secs(1), result)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error, CANCELLED);
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(pids[0], &mut status, libc::WNOHANG) },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        if unsafe { libc::kill(pids[1], 0) } == -1 {
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
            break;
        }
        #[cfg(target_os = "linux")]
        if fs::read_to_string(format!("/proc/{}/stat", pids[1])).is_ok_and(|stat| {
            stat.rsplit_once(") ")
                .is_some_and(|(_, tail)| tail.starts_with("Z "))
        }) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "descendant {} survived cancellation",
            pids[1]
        );
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}
