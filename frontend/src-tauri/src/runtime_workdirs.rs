//! Repair missing transient package folders before launching an immutable
//! speech worker. Never rewrite the worker config, models or checkpoints.
use std::{fs, path::Path};

pub(crate) fn ensure(root: &Path, configured: &Path, leaf: &str) -> Result<(), String> {
    match fs::metadata(configured) {
        Ok(info) if info.is_dir() => return Ok(()), // Existing legacy locations stay intact.
        Ok(_) => return Err("A file occupies a speech working-folder path; it was preserved.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(format!("Could not read the speech working folder: {error}")),
    }
    if !configured.is_absolute() || !matches!(leaf, "apex" | "openvino")
        || configured.file_name().and_then(|s|s.to_str()) != Some(leaf) {
        return Err("The missing speech working folder needs complete runtime setup.".into());
    }
    let cache = configured.parent().ok_or("Missing cache parent")?;
    let package = cache.parent().ok_or("Missing package parent")?;
    let identity = package.file_name().and_then(|s|s.to_str()).unwrap_or("");
    if cache.file_name().and_then(|s|s.to_str()) != Some("cache")
        || identity.len() != 20 || !identity.bytes().all(|b|b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("The missing working folder is outside a complete speech package.".into());
    }
    // Check the unnormalized path so a junction cannot be hidden by canonicalize.
    for path in configured.ancestors() {
        match fs::symlink_metadata(path) {
            Ok(info) => {
                #[cfg(windows)]
                let linked = { use std::os::windows::fs::MetadataExt; info.file_attributes() & 0x400 != 0 };
                #[cfg(not(windows))]
                let linked = info.file_type().is_symlink();
                if linked { return Err("Linked speech working folders need manual setup; nothing was replaced.".into()); }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
        }
    }
    let parent = package.parent().ok_or("Missing package directory")?.canonicalize().map_err(|e|e.to_string())?;
    let expected = root.join("packages").canonicalize().map_err(|e|e.to_string())?;
    if parent != expected || !package.is_dir() {
        return Err("The missing working folder belongs to a different data location; nothing was changed.".into());
    }
    fs::create_dir_all(configured).map_err(|e|format!("Could not prepare the local speech working folder: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_package_gets_both_required_folders_without_touching_saved_data() {
        let temp=tempfile::tempdir().unwrap(); let root=temp.path();
        let package=root.join("packages/aaaaaaaaaaaaaaaaaaaa"); fs::create_dir_all(&package).unwrap();
        fs::write(root.join("runtime.json"), b"immutable runtime").unwrap();
        fs::write(root.join("recording.wav"), b"original recording").unwrap();
        for leaf in ["openvino","apex"] { let dir=package.join("cache").join(leaf); ensure(root,&dir,leaf).unwrap(); assert!(dir.is_dir()); }
        let cache=package.join("cache/openvino/compiled.blob"); fs::write(&cache,b"keep").unwrap();
        ensure(root,&package.join("cache/openvino"),"openvino").unwrap();
        assert_eq!(fs::read(&cache).unwrap(),b"keep");
        assert_eq!(fs::read(root.join("runtime.json")).unwrap(),b"immutable runtime");
        assert_eq!(fs::read(root.join("recording.wav")).unwrap(),b"original recording");
    }
    #[test]
    fn missing_legacy_or_outside_locations_are_not_created() {
        let temp=tempfile::tempdir().unwrap(); let root=temp.path(); fs::create_dir(root.join("packages")).unwrap();
        for path in [root.join("recordings/apex"),root.join("packages/not-a-package/cache/apex")] { assert!(ensure(root,&path,"apex").is_err()); assert!(!path.exists()); }
        let other=tempfile::tempdir().unwrap(); let package=other.path().join("packages/bbbbbbbbbbbbbbbbbbbb"); fs::create_dir_all(&package).unwrap();
        let path=package.join("cache/apex"); assert!(ensure(root,&path,"apex").is_err()); assert!(!path.exists());
    }
    #[test]
    fn existing_legacy_directories_and_conflicting_files_are_preserved() {
        let temp=tempfile::tempdir().unwrap(); let root=temp.path(); let legacy=root.join("legacy"); fs::create_dir(&legacy).unwrap();
        ensure(root,&legacy,"apex").unwrap();
        let file=root.join("apex"); fs::write(&file,b"preserve").unwrap(); assert!(ensure(root,&file,"apex").is_err()); assert_eq!(fs::read(file).unwrap(),b"preserve");
    }
}
