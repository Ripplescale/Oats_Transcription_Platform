//! Verification shared by the native bounded downloader and installer handoff.
use base64::Engine;

pub fn decode_public_key(key: &str) -> Result<minisign_verify::PublicKey, String> {
    if key.len() > 16_384 {
        return Err("The build's updater public key is invalid.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(key)
        .map_err(|_| "The build's updater public key is invalid.")?;
    let text =
        std::str::from_utf8(&bytes).map_err(|_| "The build's updater public key is invalid.")?;
    minisign_verify::PublicKey::decode(text)
        .map_err(|_| "The build's updater public key is invalid.".into())
}

pub fn verify(bytes: &[u8], signature: &str, key: &str, version: &str) -> Result<(), String> {
    if signature.len() > 16_384 {
        return Err("The update signature is invalid.".into());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .map_err(|_| "The update signature is invalid.")?;
    let text = std::str::from_utf8(&decoded).map_err(|_| "The update signature is invalid.")?;
    let signature =
        minisign_verify::Signature::decode(text).map_err(|_| "The update signature is invalid.")?;
    decode_public_key(key)?
        .verify(bytes, &signature, true)
        .map_err(|_| {
            "The update signature could not be verified. The app was not changed.".to_owned()
        })?;
    // The global Minisign signature authenticates this comment. Check it only
    // after verification so unsigned feed metadata cannot relabel an old binary.
    super::policy::signed_version_matches(signature.trusted_comment(), version)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Public-only synthetic fixture produced by released Tauri CLI 2.12.0.
    // Its ephemeral private identity was destroyed; these bytes cannot install.
    const ARTIFACT: &[u8] = b"MZ synthetic signing fixture; not a runnable installer";
    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQ5QUNFMDY3QjdFMjBGMTQKUldRVUQrSzNaK0NzMmRCOXd4TWZiNHowSVVxSGkwVnZ5MW9DcG10TkFOMVdET243c25MU1cyQmsK";
    const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRVUQrSzNaK0NzMlNUVCtaT3hVQXJmc2lJOXN6WUhnczJVZ21Nb0JiTExIcXFTVXcyZVJPeWx3eWJxaEpXcjlTMENaQ3poVktoRjJBMFVUNTZwcWx0a1FHNmVjbFB3RkFnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxODcyNDUyCWZpbGU6b2F0c18wLjguM194NjQtc2V0dXAuZXhlCXZlcnNpb246MC44LjMKRENWdVcxNm4zRWxVMlhyQ3Jic0Q0L3dNYklBekdiRTRhdExCNytHc2hxSnoyN0NLd29NOU1oY245YU1ZT0ozU1ptWnltRTE2YW9vUW9IQndxRk5GRGc9PQo=";

    #[test]
    fn released_cli_versioned_signature_is_accepted() {
        verify(ARTIFACT, SIGNATURE, KEY, "0.8.3").unwrap();
    }
    #[test]
    fn modified_download_bytes_are_rejected() {
        let mut changed = ARTIFACT.to_vec();
        changed[0] ^= 1;
        assert!(verify(&changed, SIGNATURE, KEY, "0.8.3").is_err());
    }
    #[test]
    fn a_valid_old_signature_cannot_be_relabelled_as_a_new_release() {
        assert!(verify(ARTIFACT, SIGNATURE, KEY, "0.8.4").is_err());
    }
    #[test]
    fn editing_the_signed_comment_does_not_authorize_a_new_version() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(SIGNATURE)
            .unwrap();
        let altered = String::from_utf8(bytes)
            .unwrap()
            .replace("version:0.8.3", "version:0.8.4");
        let changed = base64::engine::general_purpose::STANDARD.encode(altered);
        assert!(verify(ARTIFACT, &changed, KEY, "0.8.4").is_err());
    }
}
