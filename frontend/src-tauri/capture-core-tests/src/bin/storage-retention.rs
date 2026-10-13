//! Maintenance CLI using the exact production archive/cache implementation.
//! Run with oats saved/closed; never use while a capture or worker is active.
use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use stt_capture_core_tests::{source_archive, storage_retention};

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 { bail!("Use compact|restore|prune-windows <absolute-data-root> <session-or-job-id>"); }
    let root = PathBuf::from(&args[2]);
    if !root.is_absolute() { bail!("Data root must be absolute"); }
    let id = &args[3];
    uuid::Uuid::parse_str(id).context("Invalid source/job identity")?;
    let report = match args[1].as_str() {
        "compact" | "restore" => {
            let _guards = storage_retention::all_worker_guards(&root)?;
            let session = root.join("recordings").join(id);
            if args[1] == "compact" { source_archive::compact(&session)? } else { source_archive::restore(&session)? }
        },
        "prune-windows" => storage_retention::prune_completed_windows(&root.join("jobs").join(id))?,
        _ => bail!("Unknown retention operation"),
    };
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
