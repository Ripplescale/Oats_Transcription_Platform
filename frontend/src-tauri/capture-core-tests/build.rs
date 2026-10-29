// Compile exact non-command workspace items without the Tauri/device graph.
// This is a source-component test, not an application typecheck.
use quote::quote;
use std::{env, fs, path::PathBuf};

fn main() {
    let source = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../src/local_workspace.rs");
    println!("cargo:rerun-if-changed={}", source.display());
    let parsed = syn::parse_file(&fs::read_to_string(source).unwrap()).unwrap();
    let items: Vec<_> = parsed.items.into_iter().filter(|item| match item {
        syn::Item::Fn(function) => !function.attrs.iter().any(|attribute| {
            let names: Vec<_> = attribute.path().segments.iter().map(|s| s.ident.to_string()).collect();
            names == ["tauri", "command"]
        }),
        syn::Item::Use(import) => {
            let tree = &import.tree;
            let name = quote!(#tree).to_string();
            name != "crate :: state :: AppState" && name != "tauri :: Manager"
        }
        _ => true,
    }).collect();
    let output = PathBuf::from(env::var("OUT_DIR").unwrap()).join("workspace_components.rs");
    fs::write(output, quote!(#(#items)*).to_string()).unwrap();
    let transcription = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../src/local_transcription.rs");
    println!("cargo:rerun-if-changed={}", transcription.display());
    let parsed = syn::parse_file(&fs::read_to_string(transcription).unwrap()).unwrap();
    let lifecycle = parsed.items.iter().find(|item| matches!(item, syn::Item::Fn(function) if function.sig.ident == "project_worker_lifecycle")).unwrap();
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("worker_lifecycle.rs"), quote!(#lifecycle).to_string()).unwrap();
    let activity = parsed.items.iter().find(|item| matches!(item, syn::Item::Fn(function) if function.sig.ident == "worker_activity")).unwrap();
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("worker_activity.rs"), quote!(#activity).to_string()).unwrap();
    let checkpoint_helpers: Vec<_> = parsed.items.iter().filter(|item| matches!(item,
        syn::Item::Fn(function) if ["read", "read_transcription_checkpoint", "project_transcription_checkpoint",
            "project_request_metadata", "project_worker_lifecycle", "require_readable_transcription_checkpoint",
            "supervisor_action", "supervisor_decision", "project_supervised_interruption"
        ].contains(&function.sig.ident.to_string().as_str())
    )).collect();
    assert_eq!(checkpoint_helpers.len(), 9, "Checkpoint recovery helpers must be extracted from production source");
    let supervision_constants: Vec<_> = parsed.items.iter().filter(|item| matches!(item,
        syn::Item::Const(value) if ["WORKER_STOP_GRACE", "WORKER_STALL_LIMIT"].contains(&value.ident.to_string().as_str())
    )).collect();
    assert_eq!(supervision_constants.len(),2);
    let checkpoint_tests: Vec<_> = parsed.items.iter().filter_map(|item| match item {
        syn::Item::Mod(module) if module.ident == "tests" => module.content.as_ref().map(|(_, items)| items),
        _ => None,
    }).flatten().filter(|item| matches!(item,
        syn::Item::Fn(function) if ["unreadable_checkpoint_is_failed_only_after_worker_exit_and_never_rewritten",
            "valid_checkpoint_keeps_segments_revision_and_live_teardown_gate",
            "malformed_checkpoint_shape_is_inspectable_instead_of_panicking",
            "absent_checkpoint_keeps_new_worker_startup_and_interrupted_resume_behavior",
            "supervisor_distinguishes_waiting_audio_from_a_stalled_model_and_bounded_stop",
            "interrupted_worker_projection_preserves_checkpoint_and_successful_results"
        ].contains(&function.sig.ident.to_string().as_str())
    )).collect();
    assert_eq!(checkpoint_tests.len(), 6, "Checkpoint recovery assertions must stay linked to production tests");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("transcription_checkpoints.rs"), quote!(#(#supervision_constants)* #(#checkpoint_helpers)* #(#checkpoint_tests)*).to_string()).unwrap();
    let helpers: Vec<_> = parsed.items.iter().filter(|item| matches!(item,
        syn::Item::Fn(function) if ["read", "capture_ready_for_final", "validate_workflow_role", "profile_parts", "validate_final_profile", "local_stt_profiles", "project_request_metadata",
            "runtime_registry", "registry_supports_profile", "require_runtime_profile", "validate_trelis_timing"
        ].contains(&function.sig.ident.to_string().as_str())
    )).collect();
    assert_eq!(helpers.len(), 11, "Automatic-workflow helpers must be extracted from production source");
    let tests: Vec<_> = parsed.items.iter().filter_map(|item| match item {
        syn::Item::Mod(module) if module.ident == "tests" => module.content.as_ref().map(|(_, items)| items),
        _ => None,
    }).flatten().filter(|item| matches!(item,
        syn::Item::Fn(function) if ["automatic_roles_do_not_admit_swapped_models", "final_requires_committed_completion_or_matching_recovery",
            "only_requested_profiles_are_admitted", "final_profile_metadata_admits_only_declared_trelis_profiles",
            "restored_job_preserves_final_profile_metadata_and_legacy_absence", "synthetic_asr_runtime",
            "profile_list_shares_runtime_availability_and_reports_each_duration", "registry_duration_guard_preserves_legacy_and_admits_modern_choices",
            "cpu_trelis_waits_for_verified_saved_capture_while_gpu_can_start_live"
        ].contains(&function.sig.ident.to_string().as_str())
    )).collect();
    assert_eq!(tests.len(), 9, "Automatic-workflow assertions must stay linked to production tests");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("automatic_workflow.rs"), quote!(#(#helpers)* #(#tests)*).to_string()).unwrap();
    let snapshot_helpers: Vec<_> = parsed.items.iter().filter(|item| matches!(item,
        syn::Item::Fn(function) if ["read", "validate_asr_runtime", "ensure_job_runtime_snapshot"].contains(&function.sig.ident.to_string().as_str())
    )).collect();
    assert_eq!(snapshot_helpers.len(), 3, "Runtime snapshot helpers must be extracted from production source");
    let snapshot_tests: Vec<_> = parsed.items.iter().filter_map(|item| match item {
        syn::Item::Mod(module) if module.ident == "tests" => module.content.as_ref().map(|(_, items)| items),
        _ => None,
    }).flatten().filter(|item| matches!(item,
        syn::Item::Fn(function) if ["synthetic_asr_runtime", "asr_runtime_snapshot_keeps_old_runtime_after_global_change",
            "asr_runtime_snapshot_rejects_invalid_or_missing_files_without_replacement",
            "legacy_asr_checkpoint_requires_original_runtime_migration", "concurrent_asr_snapshot_creation_has_one_complete_winner"
        ].contains(&function.sig.ident.to_string().as_str())
    )).collect();
    assert_eq!(snapshot_tests.len(), 5, "Runtime snapshot assertions must stay linked to production tests");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("runtime_snapshots.rs"), quote!(#(#snapshot_helpers)* #(#snapshot_tests)*).to_string()).unwrap();
    let deletion_items: Vec<_> = parsed.items.iter().filter(|item| match item {
        syn::Item::Fn(function) => ["read", "path_key", "reserve_removal_sessions", "stop_meeting_workers_at"].contains(&function.sig.ident.to_string().as_str()),
        syn::Item::Struct(value) => value.ident == "MeetingDeletionLease",
        syn::Item::Impl(value) => matches!(value.self_ty.as_ref(), syn::Type::Path(path) if path.path.is_ident("MeetingDeletionLease")),
        syn::Item::Const(value) => value.ident == "WORKER_STOP_GRACE",
        _ => false,
    }).collect();
    assert_eq!(deletion_items.len(),7,"Deletion reservations must be extracted from production source");
    let deletion_tests: Vec<_> = parsed.items.iter().filter_map(|item| match item {
        syn::Item::Mod(module) if module.ident == "tests" => module.content.as_ref().map(|(_,items)|items), _=>None,
    }).flatten().filter(|item| matches!(item,syn::Item::Fn(function) if function.sig.ident == "deletion_lease_stops_only_matching_owned_worker_and_preserves_checkpoint_and_audio")).collect();
    assert_eq!(deletion_tests.len(),1);
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("worker_deletion.rs"),quote!(#(#deletion_items)* #(#deletion_tests)*).to_string()).unwrap();
}
